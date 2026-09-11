import { describe, expect, it } from "vitest";
import { buildDocument, InvalidDocumentError, slugify } from "../src/modules/website/documents.js";

describe("event documents", () => {
  it("builds a valid gig matching the Sanity schema", () => {
    const { doc, summary } = buildDocument("event", {
      name: "Brighter Days Launch",
      date: "2026-05-03T20:00:00Z",
      venue: "The Louisiana",
      city: "Bristol",
      ticketUrl: "https://tickets.example.com/abc",
    });
    expect(doc._type).toBe("event");
    expect(doc.date).toBe("2026-05-03T20:00:00.000Z");
    expect(doc.status).toBe("confirmed");
    expect(summary).toContain("The Louisiana");
  });

  it("refuses a gig missing the fields the schema requires", () => {
    expect(() => buildDocument("event", { name: "Gig" })).toThrow(InvalidDocumentError);
    expect(() => buildDocument("event", { name: "G", venue: "V", city: "C", date: "sometime" })).toThrow(/date and time/i);
  });

  it("rejects a status outside the schema's list", () => {
    expect(() =>
      buildDocument("event", { name: "G", venue: "V", city: "C", date: "2026-05-03T20:00:00Z", status: "maybe" }),
    ).toThrow(/confirmed/);
  });
});

describe("pressMention documents", () => {
  it("builds from a quote alone", () => {
    const { doc } = buildDocument("pressMention", { outlet: "Clash", quote: "A remarkable voice." });
    expect(doc).toEqual({ _type: "pressMention", outlet: "Clash", quote: "A remarkable voice." });
  });

  it("needs something to actually show", () => {
    expect(() => buildDocument("pressMention", { outlet: "Clash" })).toThrow(/quote or a link/i);
  });
});

describe("article documents", () => {
  it("generates the slug the schema requires", () => {
    const { doc } = buildDocument("article", { title: "Bristol's Brightest: Asher Simmons", publication: "Clash" });
    expect(doc.slug).toEqual({ _type: "slug", current: "bristol-s-brightest-asher-simmons" });
  });

  it("stores a date-only value, since the schema field is a date not a datetime", () => {
    const { doc } = buildDocument("article", { title: "T", date: "2026-03-14T12:00:00Z" });
    expect(doc.date).toBe("2026-03-14");
  });

  it("omits optional fields rather than writing empty strings", () => {
    const { doc } = buildDocument("article", { title: "T" });
    expect(Object.keys(doc).sort()).toEqual(["_type", "slug", "title"]);
  });
});

describe("slugify", () => {
  it("produces url-safe slugs", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
  });
});
