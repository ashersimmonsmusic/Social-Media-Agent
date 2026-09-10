import type { KnowledgeCategory } from "@prisma/client";
import type { KnowledgeDraft } from "./knowledge.service.js";

export const VALID_CATEGORIES: KnowledgeCategory[] = [
  "ARTIST_BIO",
  "MUSIC_CATALOGUE",
  "BRAND",
  "PERSONAL_STORY",
  "ACHIEVEMENTS",
  "PRESS",
  "LIVE_HISTORY",
  "COLLABORATORS",
  "BUSINESS",
  "LINKS",
  "IMPORTANT_FACTS",
];

/**
 * Parses the model's JSON array of knowledge drafts, discarding anything
 * malformed rather than trusting it. Kept free of AI/database dependencies so
 * it stays directly testable.
 */
export function parseDrafts(raw: string): KnowledgeDraft[] {
  const jsonText = stripCodeFences(raw).trim();
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const drafts: KnowledgeDraft[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { category, title, content } = entry as Record<string, unknown>;
    if (typeof title !== "string" || typeof content !== "string") continue;
    if (!title.trim() || !content.trim()) continue;
    const validCategory = VALID_CATEGORIES.find((c) => c === category);
    drafts.push({
      category: validCategory ?? "IMPORTANT_FACTS",
      title: title.trim(),
      content: content.trim(),
    });
  }
  return drafts;
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}
