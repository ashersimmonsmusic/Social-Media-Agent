import { describe, expect, it } from "vitest";
import { parseAttachmentAnalysis } from "../src/modules/knowledge/parseDrafts.js";

describe("parseAttachmentAnalysis", () => {
  it("reads a summary and facts out of a clean response", () => {
    const result = parseAttachmentAnalysis(
      JSON.stringify({
        summary: "One-sheet for the single Brighter Days.",
        facts: [
          { category: "MUSIC_CATALOGUE", title: "Brighter Days", content: "Single released 14 March 2025." },
          { category: "PRESS", title: "BBC Introducing", content: "Playlisted on BBC Introducing West." },
        ],
      }),
    );
    expect(result.summary).toBe("One-sheet for the single Brighter Days.");
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]!.category).toBe("MUSIC_CATALOGUE");
  });

  it("survives code fences and surrounding prose", () => {
    const result = parseAttachmentAnalysis(
      'Here you go:\n```json\n{"summary": "A live photo.", "facts": []}\n```\nHope that helps.',
    );
    expect(result.summary).toBe("A live photo.");
    expect(result.facts).toEqual([]);
  });

  it("keeps the summary when a bracket appears inside it", () => {
    // parseDrafts scans for the outermost array and would mis-slice this.
    const result = parseAttachmentAnalysis(
      '{"summary": "Poster [Bristol, 2025] with a date", "facts": [{"category":"LIVE_HISTORY","title":"Gig","content":"Bristol, 3 May 2025."}]}',
    );
    expect(result.summary).toBe("Poster [Bristol, 2025] with a date");
    expect(result.facts).toHaveLength(1);
  });

  it("treats a photograph with nothing to state as no facts, not a failure", () => {
    const result = parseAttachmentAnalysis('{"summary": "Close-up portrait, no text visible.", "facts": []}');
    expect(result.facts).toEqual([]);
    expect(result.summary).toContain("portrait");
  });

  it("discards malformed facts rather than trusting them", () => {
    const result = parseAttachmentAnalysis(
      '{"summary":"x","facts":[{"title":"no content"},{"content":"no title"},{"category":"PRESS","title":"ok","content":"kept"}]}',
    );
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.title).toBe("ok");
  });

  it("falls back to IMPORTANT_FACTS for an unknown category", () => {
    const result = parseAttachmentAnalysis(
      '{"summary":"x","facts":[{"category":"INVENTED","title":"t","content":"c"}]}',
    );
    expect(result.facts[0]!.category).toBe("IMPORTANT_FACTS");
  });

  it("returns empty rather than throwing on junk", () => {
    expect(parseAttachmentAnalysis("not json at all")).toEqual({ summary: "", facts: [] });
    expect(parseAttachmentAnalysis("")).toEqual({ summary: "", facts: [] });
    expect(parseAttachmentAnalysis("{broken")).toEqual({ summary: "", facts: [] });
  });
});
