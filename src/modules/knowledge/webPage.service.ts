export interface FetchedPage {
  url: string;
  title?: string;
  text: string;
  /** Links found on the page, useful for discovering sub-pages and streaming/social profiles. */
  links: string[];
}

export class PageFetchError extends Error {}

const MAX_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetches a page and reduces it to readable text.
 *
 * This reads server-rendered HTML only. A site that renders its content
 * purely client-side will yield little or no text, which `extractText`
 * surfaces as an honest "not enough readable text" rather than a silent
 * empty import.
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
