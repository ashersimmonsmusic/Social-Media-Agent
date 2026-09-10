import type { BrandRuleCategory, BrandRuleKind, BrandRuleSource } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { recordAudit } from "../audit/audit.service.js";

export interface BrandVoice {
  toneWords?: string[];
  wordsUsed?: string[];
  wordsAvoided?: string[];
  humourStyle?: string;
  profanityPolicy?: string;
  spiritualLanguagePolicy?: string;
  captionLengthPreference?: string;
}

/** There is exactly one BrandProfile for Asher in Phase 1 — created on first access. */
export async function getOrCreateBrandProfile() {
  const existing = await prisma.brandProfile.findFirst();
  if (existing) return existing;
  return prisma.brandProfile.create({ data: {} });
}

export async function updateBrandProfile(fields: {
  colors?: Record<string, unknown>;
  visualMotifs?: Record<string, unknown>;
  voice?: BrandVoice;
  identityBoundaries?: Record<string, unknown>;
}) {
  const profile = await getOrCreateBrandProfile();
  const updated = await prisma.brandProfile.update({
    where: { id: profile.id },
    data: {
      colors: fields.colors as never,
      visualMotifs: fields.visualMotifs as never,
      voice: fields.voice as never,
      identityBoundaries: fields.identityBoundaries as never,
    },
  });
  await recordAudit({ action: "brand.profile_updated", entityType: "BrandProfile", entityId: profile.id, actorType: "ASHER" });
  return updated;
}

/**
 * Imports a brand book as raw text (brief §10). Phase 1 stores it verbatim
 * against the profile and does NOT attempt to auto-extract structured
 * rules from free text — that requires an AI extraction pass Asher should
 * review before rules go live, which is Phase 2 work. Individual rules are
 * added deliberately via `addBrandRule` in the meantime.
 */
export async function importBrandBook(rawText: string) {
  const profile = await getOrCreateBrandProfile();
  const updated = await prisma.brandProfile.update({
    where: { id: profile.id },
    data: { importedFrom: rawText },
  });
  await recordAudit({
    action: "brand.book_imported",
    entityType: "BrandProfile",
    entityId: profile.id,
    actorType: "ASHER",
    details: { length: rawText.length },
  });
  return updated;
}

export async function addBrandRule(input: {
  category: BrandRuleCategory;
  kind: BrandRuleKind;
  description: string;
  source: BrandRuleSource;
}) {
  const profile = await getOrCreateBrandProfile();
  const rule = await prisma.brandRule.create({
    data: { brandProfileId: profile.id, ...input },
  });
  await recordAudit({
    action: "brand.rule_added",
    entityType: "BrandRule",
    entityId: rule.id,
    actorType: input.source === "MANUAL" ? "SYSTEM" : "ASHER",
    details: input,
  });
  return rule;
}

/**
 * Records a correction Asher makes to AI output (brief §42). This is
 * created as UNCONFIRMED by default — a one-time edit is NOT automatically
 * turned into a permanent rule. It must be explicitly promoted via
 * `confirmPermanentPreference`, which the Telegram layer should only do
 * after asking Asher directly when it's ambiguous whether the correction
 * is a one-off or a standing preference.
 */
export async function recordCorrection(description: string, category: BrandRuleCategory = "VOICE") {
  return addBrandRule({ category, kind: "UNCONFIRMED", description, source: "ASHER_CORRECTION" });
}

export async function confirmPermanentPreference(ruleId: string) {
  const rule = await prisma.brandRule.update({ where: { id: ruleId }, data: { kind: "PERMANENT_PREFERENCE" } });
  await recordAudit({ action: "brand.rule_confirmed_permanent", entityType: "BrandRule", entityId: ruleId, actorType: "ASHER" });
  return rule;
}

export async function markOneTimeEdit(ruleId: string) {
  const rule = await prisma.brandRule.update({ where: { id: ruleId }, data: { kind: "ONE_TIME_EDIT", isActive: false } });
  await recordAudit({ action: "brand.rule_marked_one_time", entityType: "BrandRule", entityId: ruleId, actorType: "ASHER" });
  return rule;
}

export async function listActiveBrandRules(category?: BrandRuleCategory) {
  const profile = await getOrCreateBrandProfile();
  return prisma.brandRule.findMany({
    where: { brandProfileId: profile.id, isActive: true, category },
    orderBy: { createdAt: "desc" },
  });
}

export interface ComplianceFlag {
  rule: string;
  reason: string;
}

export interface ComplianceResult {
  /** Mechanical failures — the content should not be presented for approval until reviewed. */
  flags: ComplianceFlag[];
  /** Active SAFETY rules to keep in mind — informational, not a failure on their own. */
  remindersForReview: string[];
}

/**
 * Brand compliance check stub (brief §11). Phase 1 implements the
 * mechanical checks that don't require judgement (banned words, "avoid"
 * voice rules); the subjective checks ("does this sound like Asher?",
 * "is the tone right?") are noted as requiring the strategy-model AI pass
 * built in Phase 2's caption/publishing pipeline, not implemented here.
 */
export async function checkBrandCompliance(text: string): Promise<ComplianceResult> {
  const flags: ComplianceFlag[] = [];
  const profile = await getOrCreateBrandProfile();
  const voice = (profile.voice as BrandVoice) ?? {};

  for (const avoided of voice.wordsAvoided ?? []) {
    if (avoided && text.toLowerCase().includes(avoided.toLowerCase())) {
      flags.push({ rule: "voice.wordsAvoided", reason: `Contains avoided word/phrase: "${avoided}"` });
    }
  }

  const activeSafetyRules = await listActiveBrandRules("SAFETY");
  return { flags, remindersForReview: activeSafetyRules.map((rule) => rule.description) };
}
