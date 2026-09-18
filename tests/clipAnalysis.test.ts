import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { system: string; prompt: string }[] = [];
const replies: string[] = [];

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock("../src/ai/AIService.js", () => ({
  aiService: {
    generate: async (_task: string, prompt: string, options: { system?: string }) => {
      calls.push({ system: options.system ?? "", prompt });
      return { text: replies.shift() ?? "{}" };
    },
  },
}));

const { analyseTranscript } = await import("../src/modules/clipping/detect.service.js");

/** Twenty-five minutes of speech — long enough to need more than one window. */
const cues = Array.from({ length: 750 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.8, text: `line ${i}` }));

beforeEach(() => {
  calls.length = 0;
  replies.length = 0;
});

describe("analyseTranscript", () => {
  it("reads the whole transcript then ranks what it found", async () => {
    // Two windows find one moment each; the ranking pass keeps both.
    replies.push(
      '{"candidates":[{"start":100,"end":150,"title":"Almost quit","reason":"complete story","topic":"career"}]}',
      '{"candidates":[{"start":700,"end":750,"title":"Finding the sound","reason":"a lesson","topic":"craft"}]}',
      '{"candidates":[]}',
      '{"clips":[{"index":1,"score":94,"scores":{"hook":96},"reason":"strong story","platforms":["instagram"]},' +
        '{"index":2,"score":81,"scores":{"hook":80},"reason":"useful","platforms":["instagram","youtube"]}]}',
    );

    const progress: string[] = [];
    const clips = await analyseTranscript(cues, async (detail) => {
      progress.push(detail);
    });

    expect(clips).toHaveLength(2);
    // Ranked, so the best is first.
    expect(clips[0]!.title).toBe("Almost quit");
    expect(clips[0]!.score).toBe(94);
    expect(progress.some((line) => line.includes("Reading part"))).toBe(true);
    expect(progress.some((line) => line.includes("Ranking"))).toBe(true);
  });

  it("scores in a single pass over everything, so scores are relative", async () => {
    replies.push(
      '{"candidates":[{"start":100,"end":150,"title":"One"}]}',
      '{"candidates":[{"start":700,"end":750,"title":"Two"}]}',
      '{"candidates":[]}',
      '{"clips":[{"index":1,"score":90},{"index":2,"score":60}]}',
    );

    await analyseTranscript(cues);

    const scoring = calls.at(-1)!;
    // Both candidates in one prompt is the only way "stronger than" means anything.
    expect(scoring.prompt).toContain("One");
    expect(scoring.prompt).toContain("Two");
    expect(scoring.system).toMatch(/ranking candidate clips/i);
  });

  it("carries on when one window fails, rather than losing the hour", async () => {
    const failing = vi.fn();
    replies.push('{"candidates":[{"start":100,"end":150,"title":"Survived"}]}');
    // Second window throws; third and the scoring pass still run.
    const { aiService } = await import("../src/ai/AIService.js");
    const original = aiService.generate;
    let call = 0;
    (aiService as { generate: unknown }).generate = async (task: string, prompt: string, options: { system?: string }) => {
      call += 1;
      if (call === 2) {
        failing();
        throw new Error("model unavailable");
      }
      if (call >= 4) return { text: '{"clips":[{"index":1,"score":77}]}' };
      return original(task, prompt, options);
    };

    try {
      const clips = await analyseTranscript(cues);
      expect(failing).toHaveBeenCalled();
      expect(clips).toHaveLength(1);
      expect(clips[0]!.title).toBe("Survived");
    } finally {
      (aiService as { generate: unknown }).generate = original;
    }
  });

  it("returns nothing, without scoring, when there is nothing worth cutting", async () => {
    replies.push('{"candidates":[]}', '{"candidates":[]}', '{"candidates":[]}');

    expect(await analyseTranscript(cues)).toEqual([]);
    // No scoring call: an empty list is a real answer and costs nothing more.
    expect(calls.every((call) => !call.system.includes("ranking candidate"))).toBe(true);
  });

  it("does nothing at all with an empty transcript", async () => {
    expect(await analyseTranscript([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
