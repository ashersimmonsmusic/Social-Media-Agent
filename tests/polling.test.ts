import { describe, expect, it, vi } from "vitest";

const { runPolling, isPollingConflict } = await import("../src/telegram/polling.js");

/** A 409 as Telegraf surfaces it, and as the raw Bot API returns it. */
const telegrafConflict = Object.assign(new Error("409: Conflict: terminated by other getUpdates request"), {
  code: 409,
});
const rawConflict = Object.assign(new Error("Conflict"), { response: { error_code: 409 } });

/** No real waiting: the retry schedule is asserted, not endured. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("isPollingConflict", () => {
  it("recognises the conflict in both shapes", () => {
    expect(isPollingConflict(telegrafConflict)).toBe(true);
    expect(isPollingConflict(rawConflict)).toBe(true);
  });

  it("does not mistake other failures for it", () => {
    expect(isPollingConflict(Object.assign(new Error("Unauthorized"), { code: 401 }))).toBe(false);
    expect(isPollingConflict(new Error("network down"))).toBe(false);
    expect(isPollingConflict(null)).toBe(false);
    expect(isPollingConflict(undefined)).toBe(false);
  });
});

describe("runPolling", () => {
  it("waits out the conflict a deploy causes instead of dying", async () => {
    const clock = fakeClock();
    // Two containers overlapping, then the old one goes away.
    const launch = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(telegrafConflict)
      .mockRejectedValueOnce(telegrafConflict)
      .mockResolvedValueOnce(undefined);

    await runPolling(launch, { retryMs: 1000, maxWaitMs: 60_000, sleep: clock.sleep, now: clock.now });

    expect(launch).toHaveBeenCalledTimes(3);
  });

  it("gives up with an actionable message if the conflict never clears", async () => {
    const clock = fakeClock();
    const launch = vi.fn<[], Promise<void>>().mockRejectedValue(telegrafConflict);

    await expect(
      runPolling(launch, { retryMs: 30_000, maxWaitMs: 60_000, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/another instance/i);
  });

  it("does not retry a failure that retrying cannot fix", async () => {
    const clock = fakeClock();
    const unauthorized = Object.assign(new Error("401: Unauthorized"), { code: 401 });
    const launch = vi.fn<[], Promise<void>>().mockRejectedValue(unauthorized);

    await expect(runPolling(launch, { sleep: clock.sleep, now: clock.now })).rejects.toThrow(/unauthorized/i);
    // A bad token is not a race — one attempt, then report it.
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("returns quietly when polling stops on purpose", async () => {
    const launch = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    await expect(runPolling(launch)).resolves.toBeUndefined();
  });

  it("surfaces the rejection rather than leaving it unhandled", async () => {
    // The original bug: bot.launch() was called bare, so this rejection reached
    // nobody and Node terminated the process without logging a reason.
    const launch = vi.fn<[], Promise<void>>().mockRejectedValue(new Error("boom"));
    const caught = await runPolling(launch).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
  });
});
