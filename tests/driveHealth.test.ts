import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  connection: null as { id: string } | null,
  accessTokenError: null as unknown,
};
const sent: string[] = [];

class GoogleReauthRequiredError extends Error {
  constructor(detail: string) {
    super(`Google has stopped accepting my saved permission (${detail}).`);
    this.name = "GoogleReauthRequiredError";
  }
}

// The watchdog now consults the service-account path, which reads env on import.
vi.mock("../src/config/env.js", () => ({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: undefined } }));

vi.mock("../src/modules/oauth/google.service.js", () => ({
  GoogleReauthRequiredError,
  getConnection: async () => state.connection,
  getAccessToken: async () => {
    if (state.accessTokenError) throw state.accessTokenError;
    return "token";
  },
}));

vi.mock("../src/telegram/notify.js", () => ({
  sendPlainMessage: async (_telegram: unknown, text: string) => {
    sent.push(text);
  },
}));

const { checkDriveAccess, resetDriveWarning } = await import("../src/modules/drive/driveHealth.js");

const telegram = {} as never;

beforeEach(() => {
  sent.length = 0;
  state.connection = { id: "conn-1" };
  state.accessTokenError = null;
  resetDriveWarning();
});

describe("checkDriveAccess", () => {
  it("says nothing while access is working", async () => {
    expect(await checkDriveAccess(telegram)).toBe("ok");
    expect(sent).toHaveLength(0);
  });

  it("does nothing at all when Drive was never connected", async () => {
    state.connection = null;
    expect(await checkDriveAccess(telegram)).toBe("not-connected");
    expect(sent).toHaveLength(0);
  });

  it("tells Asher when Google has expired the permission, and what to do", async () => {
    state.accessTokenError = new GoogleReauthRequiredError("expired");

    expect(await checkDriveAccess(telegram)).toBe("lapsed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/\/drive/);
    expect(sent[0]).toMatch(/7 days/);
  });

  it("warns once, not on every check", async () => {
    state.accessTokenError = new GoogleReauthRequiredError("expired");

    await checkDriveAccess(telegram);
    await checkDriveAccess(telegram);
    await checkDriveAccess(telegram);

    expect(sent).toHaveLength(1);
  });

  it("warns again after a lapse is fixed and then recurs", async () => {
    state.accessTokenError = new GoogleReauthRequiredError("expired");
    await checkDriveAccess(telegram);

    state.accessTokenError = null;
    expect(await checkDriveAccess(telegram)).toBe("ok");

    state.accessTokenError = new GoogleReauthRequiredError("expired again");
    await checkDriveAccess(telegram);

    expect(sent).toHaveLength(2);
  });

  it("stays quiet about a network blip, which is not a lapsed permission", async () => {
    // Crying wolf here would train him to ignore the message that matters.
    state.accessTokenError = new Error("fetch failed");

    expect(await checkDriveAccess(telegram)).toBe("ok");
    expect(sent).toHaveLength(0);
  });
});

describe("with a service account", () => {
  it("has nothing to watch, because a service account cannot lapse", async () => {
    const { env } = await import("../src/config/env.js");
    (env as Record<string, unknown>).GOOGLE_SERVICE_ACCOUNT_JSON = '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"x"}';
    try {
      // Would otherwise report a lapse — the service account path never gets there.
      state.accessTokenError = new GoogleReauthRequiredError("expired");
      expect(await checkDriveAccess(telegram)).toBe("ok");
      expect(sent).toHaveLength(0);
    } finally {
      (env as Record<string, unknown>).GOOGLE_SERVICE_ACCOUNT_JSON = undefined;
    }
  });
});
