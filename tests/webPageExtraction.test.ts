import { describe, expect, it } from "vitest";
import { extractLinks, extractText, extractTitle, normaliseUrl, PageFetchError } from "../src/modules/knowledge/webPage.service.js";
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
