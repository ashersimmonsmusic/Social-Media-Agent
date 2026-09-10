import { beforeEach, describe, expect, it, vi } from "vitest";

const brandProfileState = {
  id: "brand_1",
  name: "Asher Simmons",
  colors: {},
  visualMotifs: {},
  voice: { wordsAvoided: ["blessed and highly favoured"] } as Record<string, unknown>,
  identityBoundaries: {},
  importedFrom: null as string | null,
};

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    brandProfile: {
      findFirst: vi.fn(async () => brandProfileState),
      create: vi.fn(async () => brandProfileState),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(brandProfileState, args.data);
        return brandProfileState;
      }),
    },
    brandRule: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("../src/modules/audit/audit.service.js", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

const { checkBrandCompliance } = await import("../src/modules/brand/brand.service.js");

describe("checkBrandCompliance", () => {
  beforeEach(() => {
    brandProfileState.voice = { wordsAvoided: ["blessed and highly favoured"] };
  });

  it("flags text containing a word/phrase Asher wants avoided", async () => {
    const result = await checkBrandCompliance("Feeling blessed and highly favoured today!");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.reason).toMatch(/blessed and highly favoured/i);
  });

  it("passes clean text with no flags", async () => {
    const result = await checkBrandCompliance("New single out now — link in bio.");
    expect(result.flags).toHaveLength(0);
  });
});
