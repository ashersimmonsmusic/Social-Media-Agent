export interface FetchedPage {
  url: string;
  title?: string;
  text: string;
  /** Links found on the page, useful for discovering sub-pages and streaming/social profiles. */
  links: string[];
  /**
   * Facts the page declares about itself in JSON-LD and meta tags, rendered as
   * readable lines. Often the only usable content on a site whose prose is
   * rendered client-side, and cleaner than scraped prose even when both exist.
   */
  structured: string;
}

export class PageFetchError extends Error {}

const MAX_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetches a page and reduces it to readable text plus whatever it declares
 * about itself in structured form.
 *
 * No JavaScript is executed. Most sites that render their prose client-side
 * still emit JSON-LD and OpenGraph tags into the initial HTML — for music and
 * events that structured data is usually richer and more reliable than the
 * prose would have been, so reading it recovers most of what running a
 * browser would buy, at no cost. A page offering neither still surfaces as an
 * honest "not enough readable content" rather than a silent empty import.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  const url = normaliseUrl(rawUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Some hosts serve a stripped page or block requests without these.
        "user-agent": "AsherSimmonsAgent/1.0 (+artist content assistant)",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (error) {
    throw new PageFetchError(
      controller.signal.aborted ? `Timed out fetching ${url}` : `Could not reach ${url}: ${String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new PageFetchError(`${url} returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text")) {
    throw new PageFetchError(`${url} is ${contentType || "an unknown type"}, not a web page`);
  }

  const html = (await response.text()).slice(0, MAX_BYTES);

  return {
    url,
    title: extractTitle(html),
    text: extractText(html),
    links: extractLinks(html, url),
    structured: summariseStructuredData(html),
  };
}

export function normaliseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();

  // Only treat the input as already-schemed when it carries an authority
  // ("scheme://"), so a bare "example.com" or "localhost:3000" still gets
  // https:// prepended while "file://…" keeps its own scheme and is rejected
  // below rather than being silently rewritten into an https URL.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new PageFetchError(`That doesn't look like a web address: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PageFetchError(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() || undefined : undefined;
}

/** Strips scripts, styles and tags, leaving readable text with collapsed whitespace. */
export function extractText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Keep block boundaries as newlines so headings/paragraphs don't run together.
  const withBreaks = withoutNoise
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  return decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1]!;
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
    try {
      links.add(new URL(href, baseUrl).toString());
    } catch {
      // Ignore malformed hrefs rather than failing the whole page.
    }
  }
  return [...links];
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
  };
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole);
}

/**
 * Pulls out JSON-LD blocks. Must run before extractText, which strips every
 * script tag — including these.
 */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]!.trim());
      // A page may publish one object, an array, or a schema.org @graph.
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) {
        blocks.push(...(parsed as { "@graph": unknown[] })["@graph"]);
      } else if (parsed) blocks.push(parsed);
    } catch {
      // One malformed block shouldn't lose the others.
    }
  }
  return blocks;
}

/** Reads OpenGraph and standard meta tags, which nearly every site emits. */
export function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const pattern = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1]!;
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (!name || !content) continue;
    const key = name.toLowerCase();
    if (key === "description" || key.startsWith("og:") || key.startsWith("music:") || key.startsWith("article:")) {
      meta[key] = decodeEntities(content).trim();
    }
  }
  return meta;
}

/** Values worth surfacing from a JSON-LD node, in the order they read best. */
const JSON_LD_FIELDS = [
  "name",
  "headline",
  "description",
  "datePublished",
  "startDate",
  "endDate",
  "genre",
  "byArtist",
  "performer",
  "location",
  "address",
  "url",
  "sameAs",
];

function renderValue(value: unknown, depth = 0): string | null {
  if (value == null || depth > 2) return null;
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map((item) => renderValue(item, depth + 1)).filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const node = value as Record<string, unknown>;
    // Nested nodes are usually a named thing — a venue, an artist, a place.
    return renderValue(node.name ?? node.headline ?? node.address ?? null, depth + 1);
  }
  return null;
}

export function summariseStructuredData(html: string): string {
  const lines: string[] = [];

  for (const node of extractJsonLd(html)) {
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const type = renderValue(record["@type"]);
    const parts: string[] = [];
    for (const field of JSON_LD_FIELDS) {
      const rendered = renderValue(record[field]);
      if (rendered) parts.push(`${field}: ${rendered}`);
    }
    if (parts.length > 0) lines.push(`[${type ?? "item"}] ${parts.join(" | ")}`);
  }

  const meta = extractMeta(html);
  const metaLines = Object.entries(meta)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`);
  if (metaLines.length > 0) lines.push(...metaLines);

  return lines.join("\n").trim();
}
