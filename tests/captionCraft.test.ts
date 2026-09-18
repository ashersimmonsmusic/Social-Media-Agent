import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/ai/AIService.js", () => ({ aiService: { generate: async () => ({ text: "{}" }) } }));
vi.mock("../src/modules/brand/brand.service.js", () => ({ listActiveBrandRules: async () => [] }));
vi.mock("../src/modules/knowledge/knowledge.service.js", () => ({ searchKnowledge: async () => [] }));

const { craftBrief, NEVER, HOOK_RULES, VOICE } = await import("../src/modules/content/craft.js");
const { parseCaptionOptions, renderCaption } = await import("../src/modules/content/caption.service.js");

describe("the craft brief", () => {
  it("forbids the conventions that make an artist's feed read like an advert", () => {
    const brief = craftBrief().toLowerCase();
    // Each of these is a specific failure the rules exist to prevent.
    expect(brief).toContain("comment below");
    expect(brief).toContain("stop scrolling");
    expect(brief).toContain("tag someone");
    expect(brief).toContain("journey");
    expect(brief).toContain("dropping");
  });

  it("stops him praising his own work", () => {
    expect(craftBrief()).toMatch(/cannot say it's good|proud of this one/i);
  });

  it("sets British spelling, since he is in Bristol", () => {
    expect(craftBrief()).toMatch(/British English/);
  });

  it("requires a hook to be specific rather than intriguing", () => {
    const hooks = HOOK_RULES.join(" ").toLowerCase();
    expect(hooks).toContain("specific");
    expect(hooks).toContain("must be true");
  });

  it("carries every rule into the brief, so none can be quietly dropped", () => {
    const brief = craftBrief();
    for (const rule of [...NEVER, ...HOOK_RULES, ...VOICE]) {
      expect(brief).toContain(rule);
    }
  });

  it("ends on the test a line has to pass", () => {
    expect(craftBrief()).toMatch(/would he say this out loud/i);
  });
});

describe("parseCaptionOptions", () => {
  it("reads three options", () => {
    const options = parseCaptionOptions(
      '{"options":[{"hook":"a","body":"b","hashtags":["bristol"]},{"hook":"c","body":"d","hashtags":[]},{"hook":"e","body":"f","hashtags":[]}]}',
    );
    expect(options).toHaveLength(3);
    expect(options[0]!.hashtags).toEqual(["bristol"]);
  });

  it("strips a leading hash, so rendering doesn't double it", () => {
    const options = parseCaptionOptions('{"options":[{"hook":"a","body":"b","hashtags":["#bristol"]}]}');
    expect(renderCaption(options[0]!)).toContain("#bristol");
    expect(renderCaption(options[0]!)).not.toContain("##");
  });

  it("survives a fenced or chatty response", () => {
    const options = parseCaptionOptions('Here you go:\n```json\n{"options":[{"hook":"a","body":"b"}]}\n```');
    expect(options).toHaveLength(1);
  });

  it("drops an entry with nothing in it rather than rendering a blank caption", () => {
    const options = parseCaptionOptions('{"options":[{"hook":"","body":""},{"hook":"real","body":"x"}]}');
    expect(options).toHaveLength(1);
    expect(options[0]!.hook).toBe("real");
  });

  it("returns nothing for junk instead of throwing", () => {
    expect(parseCaptionOptions("no json")).toEqual([]);
    expect(parseCaptionOptions('{"options":"not an array"}')).toEqual([]);
  });
});

describe("renderCaption", () => {
  it("puts the hook first and the hashtags last", () => {
    const text = renderCaption({ hook: "Four notes, three days.", body: "The bassline.", hashtags: ["bristol", "keys"] });
    expect(text).toBe("Four notes, three days.\n\nThe bassline.\n\n#bristol #keys");
  });

  it("leaves out hashtags entirely when there are none", () => {
    expect(renderCaption({ hook: "A line.", body: "", hashtags: [] })).toBe("A line.");
  });
});
