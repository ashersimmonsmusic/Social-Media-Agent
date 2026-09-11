/**
 * Builders for the Sanity document types on ashersimmonsmusic.com.
 *
 * These mirror sanity/schemas/*.ts in the website repo. Sanity will accept
 * almost any shape, so a document that misses a required field or misspells one
 * lands silently broken in the CMS rather than erroring — hence validating here
 * before anything is written.
 */

export type WebsiteContentType = "event" | "pressMention" | "article";

export const WEBSITE_CONTENT_TYPES: WebsiteContentType[] = ["event", "pressMention", "article"];

/** Matches the status list on the event schema. */
const EVENT_STATUSES = ["confirmed", "postponed", "cancelled", "sold-out"];

export interface BuiltDocument {
  /** The `_type` Sanity stores it under. */
  doc: Record<string, unknown>;
  /** Human-readable one-liner for the approval card. */
  summary: string;
}

export class InvalidDocumentError extends Error {
  constructor(problems: string[]) {
    super(problems.join(" "));
    this.name = "InvalidDocumentError";
  }
}

/** Sanity slugs are lowercase, hyphenated, and must be stable for routing. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

export function buildDocument(type: WebsiteContentType, input: Record<string, unknown>): BuiltDocument {
  switch (type) {
    case "event":
      return buildEvent(input);
    case "pressMention":
      return buildPressMention(input);
    case "article":
      return buildArticle(input);
  }
}

function buildEvent(input: Record<string, unknown>): BuiltDocument {
  const name = str(input, "name");
  const date = str(input, "date");
  const venue = str(input, "venue");
  const city = str(input, "city");
  const ticketUrl = str(input, "ticketUrl");
  const status = str(input, "status") || "confirmed";

  const problems: string[] = [];
  if (!name) problems.push("A gig needs a name.");
  if (!venue) problems.push("A gig needs a venue.");
  if (!city) problems.push("A gig needs a city.");

  // The schema field is a datetime, so a bare date would store as an invalid value.
  const parsed = date ? new Date(date) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    problems.push("A gig needs a date and time I can read, e.g. 2026-05-03T20:00:00Z.");
  }
  if (!EVENT_STATUSES.includes(status)) {
    problems.push(`Status must be one of ${EVENT_STATUSES.join(", ")}.`);
  }
  if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) problems.push("The ticket link must be a full URL.");
  if (problems.length > 0) throw new InvalidDocumentError(problems);

  return {
    doc: {
      _type: "event",
      name,
      date: parsed!.toISOString(),
      venue,
      city,
      status,
      ...(ticketUrl ? { ticketUrl } : {}),
    },
    summary: `${name} — ${venue}, ${city} on ${parsed!.toDateString()}`,
  };
}

function buildPressMention(input: Record<string, unknown>): BuiltDocument {
  const outlet = str(input, "outlet");
  const quote = str(input, "quote");
  const url = str(input, "url");

  const problems: string[] = [];
  if (!outlet) problems.push("A press mention needs the outlet's name.");
  if (!quote && !url) problems.push("A press mention needs a quote or a link — otherwise there's nothing to show.");
  if (url && !/^https?:\/\//i.test(url)) problems.push("The link must be a full URL.");
  if (problems.length > 0) throw new InvalidDocumentError(problems);

  return {
    doc: { _type: "pressMention", outlet, ...(quote ? { quote } : {}), ...(url ? { url } : {}) },
    summary: quote ? `${outlet}: "${quote.slice(0, 80)}"` : `${outlet} — ${url}`,
  };
}

function buildArticle(input: Record<string, unknown>): BuiltDocument {
  const title = str(input, "title");
  const publication = str(input, "publication");
  const date = str(input, "date");
  const excerpt = str(input, "excerpt");
  const url = str(input, "url");

  const problems: string[] = [];
  if (!title) problems.push("An article needs a title.");
  if (url && !/^https?:\/\//i.test(url)) problems.push("The link must be a full URL.");
  // The schema field is a date, not a datetime — Sanity wants YYYY-MM-DD.
  let isoDate = "";
  if (date) {
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) problems.push("I couldn't read that date — use YYYY-MM-DD.");
    else isoDate = parsed.toISOString().slice(0, 10);
  }
  if (problems.length > 0) throw new InvalidDocumentError(problems);

  return {
    doc: {
      _type: "article",
      title,
      slug: { _type: "slug", current: slugify(title) },
      ...(publication ? { publication } : {}),
      ...(isoDate ? { date: isoDate } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(url ? { url } : {}),
    },
    summary: publication ? `${title} (${publication})` : title,
  };
}
