import { describe, expect, it } from "vitest";
import { extractLinks, extractText, extractTitle, normaliseUrl, PageFetchError , summariseStructuredData, extractMeta, extractJsonLd } from "../src/modules/knowledge/webPage.service.js";
import { parseDrafts } from "../src/modules/knowledge/parseDrafts.js";

describe("extractText", () => {
  it("strips tags and returns readable text", () => {
    const html = "<html><body><h1>Asher Simmons</h1><p>Bristol-based artist.</p></body></html>";
    expect(extractText(html)).toBe("Asher Simmons\nBristol-based artist.");
  });

  it("drops script and style content entirely", () => {
    const html = "<body><script>var secret = 'x';</script><style>.a{color:red}</style><p>Real text</p></body>";
    const text = extractText(html);
    expect(text).toBe("Real text");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color");
  });

  it("decodes HTML entities", () => {
    expect(extractText("<p>Rock &amp; roll &mdash; live</p>")).toBe("Rock & roll — live");
    expect(extractText("<p>&#65;&#x42;</p>")).toBe("AB");
  });

  it("keeps block elements on separate lines", () => {
    expect(extractText("<div>One</div><div>Two</div>")).toBe("One\nTwo");
  });

  it("returns near-empty text for a JavaScript-only page, so callers can detect it", () => {
    const html = "<html><body><div id='root'></div><script>renderApp()</script></body></html>";
    expect(extractText(html).length).toBeLessThan(50);
  });
});

describe("extractTitle", () => {
  it("reads the title tag", () => {
    expect(extractTitle("<head><title>Asher Simmons | Music</title></head>")).toBe("Asher Simmons | Music");
  });

  it("returns undefined when there is no title", () => {
    expect(extractTitle("<head></head>")).toBeUndefined();
  });
});

describe("extractLinks", () => {
  it("resolves relative links against the base URL and skips anchors and mailto", () => {
    const html = `<a href="/about">About</a><a href="#top">Top</a><a href="mailto:a@b.com">Mail</a><a href="https://open.spotify.com/x">Spotify</a>`;
    expect(extractLinks(html, "https://example.com/")).toEqual([
      "https://example.com/about",
      "https://open.spotify.com/x",
    ]);
  });
});

describe("normaliseUrl", () => {
  it("adds https when the scheme is missing", () => {
    expect(normaliseUrl("ashersimmonsmusic.com")).toBe("https://ashersimmonsmusic.com/");
  });

  it("rejects non-http schemes rather than rewriting them into an https URL", () => {
    expect(() => normaliseUrl("file:///etc/passwd")).toThrow(PageFetchError);
    expect(() => normaliseUrl("ftp://example.com/x")).toThrow(PageFetchError);
  });

  it("rejects scheme-like input that isn't a web address", () => {
    expect(() => normaliseUrl("javascript:alert(1)")).toThrow(PageFetchError);
    expect(() => normaliseUrl("data:text/html,<script>")).toThrow(PageFetchError);
  });

  it("still accepts a bare host with a port", () => {
    expect(normaliseUrl("localhost:3000")).toBe("https://localhost:3000/");
  });

  it("preserves an explicit http scheme", () => {
    expect(normaliseUrl("http://example.com/about")).toBe("http://example.com/about");
  });
});

describe("parseDrafts", () => {
  it("parses a well-formed JSON array", () => {
    const raw = '[{"category":"ARTIST_BIO","title":"Based in Bristol","content":"Asher is based in Bristol."}]';
    expect(parseDrafts(raw)).toEqual([
      { category: "ARTIST_BIO", title: "Based in Bristol", content: "Asher is based in Bristol." },
    ]);
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n[{"category":"PRESS","title":"T","content":"C"}]\n```';
    expect(parseDrafts(raw)).toHaveLength(1);
  });

  it("falls back to IMPORTANT_FACTS for an unrecognised category", () => {
    const raw = '[{"category":"NONSENSE","title":"T","content":"C"}]';
    expect(parseDrafts(raw)[0]!.category).toBe("IMPORTANT_FACTS");
  });

  it("discards entries missing a title or content rather than storing blanks", () => {
    const raw = '[{"category":"PRESS","title":"","content":"C"},{"category":"PRESS","title":"T"}]';
    expect(parseDrafts(raw)).toEqual([]);
  });

  it("returns an empty array for unparseable output instead of throwing", () => {
    expect(parseDrafts("I could not find anything.")).toEqual([]);
    expect(parseDrafts("[{broken json")).toEqual([]);
  });
});

describe("structured data from client-rendered pages", () => {
  it("reads JSON-LD that extractText would have thrown away", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"MusicRecording","name":"Brighter Days","datePublished":"2025-03-14","genre":"Soul"}
    </script></head><body><div id="root"></div></body></html>`;

    // The prose really is empty — this is the client-rendered case.
    expect(extractText(html)).toBe("");
    const structured = summariseStructuredData(html);
    expect(structured).toContain("Brighter Days");
    expect(structured).toContain("2025-03-14");
    expect(structured).toContain("[MusicRecording]");
  });

  it("flattens a schema.org @graph", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"MusicGroup","name":"Asher Simmons"},
        {"@type":"Event","name":"Live at the Louisiana","startDate":"2026-05-03T20:00:00Z"}
      ]}
    </script>`;
    const structured = summariseStructuredData(html);
    expect(structured).toContain("Asher Simmons");
    expect(structured).toContain("Live at the Louisiana");
  });

  it("resolves a nested node to its name, not [object Object]", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Event","name":"Gig","location":{"@type":"Place","name":"The Louisiana"}}
    </script>`;
    expect(summariseStructuredData(html)).toContain("The Louisiana");
    expect(summariseStructuredData(html)).not.toContain("object Object");
  });

  it("keeps the other blocks when one is malformed", () => {
    const html = `<script type="application/ld+json">{not json</script>
      <script type="application/ld+json">{"@type":"Article","headline":"Survived"}</script>`;
    expect(summariseStructuredData(html)).toContain("Survived");
  });

  it("reads OpenGraph tags, which almost every site emits", () => {
    const html = `<meta property="og:title" content="Asher Simmons — Brighter Days">
      <meta name="description" content="The new single.">
      <meta property="og:image" content="https://example.com/a.jpg">`;
    const meta = extractMeta(html);
    expect(meta["og:title"]).toBe("Asher Simmons — Brighter Days");
    expect(meta["description"]).toBe("The new single.");
  });

  it("ignores unrelated meta tags rather than dumping the whole head", () => {
    const html = `<meta name="viewport" content="width=device-width"><meta name="theme-color" content="#000">`;
    expect(extractMeta(html)).toEqual({});
  });

  it("returns empty for a page with neither, so the caller can say so honestly", () => {
    expect(summariseStructuredData("<html><body><p>Just words.</p></body></html>")).toBe("");
  });

  it("ignores a script that merely mentions ld+json in its code", () => {
    const html = `<script>const type = "application/ld+json"; steal();</script>`;
    expect(extractJsonLd(html)).toEqual([]);
  });
});
