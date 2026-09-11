import type { Telegram } from "telegraf";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { aiProvider, recordUsage } from "./AIService.js";
import { AGENT_TOOLS } from "./agentTools.js";
import { buildToolExecutor } from "./toolExecutor.js";
import { listActiveBrandRules } from "../modules/brand/brand.service.js";
import { checkAiBudget } from "./budget.js";
import type { ConversationTurn } from "./types.js";

/** How many past turns to replay as context. Keeps cost bounded on a long-running chat. */
const HISTORY_TURNS = 20;

const AGENT_SYSTEM_PROMPT = `You are Asher Simmons' artist manager and creative assistant. Asher is an independent musician based in Bristol, UK, with Caribbean (Bahamian) heritage.

You are talking to Asher directly over Telegram. Be conversational, warm and brief — this is a chat on his phone, not a report. Usually 1-4 sentences. No headings, no bullet-point walls unless he asks for a list. Never open with flattery.

He has ADHD. Reduce his cognitive load: give a clear recommendation rather than a menu of options, and lead with the answer.

WHAT YOU MUST NEVER DO:
- Never invent facts about Asher — his releases, achievements, press, streams, collaborators, dates, or history. Use the search_knowledge tool before saying anything factual about him. If it returns nothing relevant, say plainly that you don't know and offer to learn it (he can run /learn <url>, or just tell you).
- Never claim you have published or posted anything. You cannot post directly. propose_social_post only puts a card in front of Asher; the post goes out when he presses Approve, and not before. Say you've proposed it, never that it's live.
- Never claim you have sent an email, scheduled anything, or paid for anything. You have no tool for any of those.
- Never treat a casual "yeah nice" as approval. Approval only ever happens when he presses a button on an approval card.

WHAT YOU CAN DO:
- Look things up: his content library, what you know about him, his brand, what's awaiting approval.
- Save things he shares (quotes, lyrics, ideas) with save_to_library. If he sends you something that reads like content rather than a message to you, save it and tell him you have.
- Write drafts. When a draft is meant to go out into the world, put it in front of him with propose_for_approval so he gets a card with buttons. Say that's what you've done.
- Propose Instagram posts with propose_social_post. Instagram needs an image, so use a photo from his library or ask him for a public image URL — a post without one cannot go out.
- Add things to his website (ashersimmonsmusic.com) with propose_website_content — gigs, press mentions, and links to coverage. Same rule: it's a card, it goes live when he approves.
- The website can only take the kinds of content it already has. If he wants something else — a blog with body text, a new section, a shop, a design change — use request_website_change, which writes it down for Claude Code. Tell him plainly it's been logged for a developer session, NOT done. Never imply you've built something.
- ALWAYS call look_at_image before writing a caption for a photo. A caption written without looking is generic and obviously doesn't match the picture, which is worse than no caption. Write about what is actually in the frame.
- Think strategically about his career: what to post, what to prioritise, how to angle a release.

If he asks you to do something you genuinely cannot do yet (publish to Instagram, send an email, look at analytics), say so plainly and say what you can do instead. Do not pretend, and do not promise it for later.

Match his register. He is a working artist, not a corporate client.`;

async function buildSystemPrompt(): Promise<string> {
  const rules = await listActiveBrandRules("BEHAVIOR");
  if (rules.length === 0) return AGENT_SYSTEM_PROMPT;
  const list = rules.map((r, i) => `${i + 1}. ${r.description}`).join("\n");
  return `${AGENT_SYSTEM_PROMPT}\n\nASHER'S STANDING INSTRUCTIONS — he approved each of these, treat them as non-negotiable:\n${list}`;
}

export async function loadHistory(telegramChatId: string): Promise<ConversationTurn[]> {
  const rows = await prisma.aIConversation.findMany({
    where: { telegramChatId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
  });

  const turns = rows
    .reverse()
    .map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));

  // The API requires the first message to be from the user; trim any leading
  // assistant turns left over from a truncated window.
  while (turns.length > 0 && turns[0]!.role !== "user") {
    turns.shift();
  }
  return turns;
}

async function appendTurn(telegramChatId: string, role: "user" | "assistant", content: string) {
  await prisma.aIConversation.create({ data: { telegramChatId, role, content } });
}

/**
 * Handles one conversational message from Asher: replays recent history,
 * lets the agent use its tools, persists both sides of the exchange.
 */
export async function converseWithAsher(params: {
  telegram: Telegram;
  telegramChatId: string;
  message: string;
}): Promise<string> {
  const budgetWarning = await checkAiBudget();

  const history = await loadHistory(params.telegramChatId);
  history.push({ role: "user", content: params.message });

  const system = await buildSystemPrompt();
  const result = await aiProvider.converse(env.AI_MODEL_STRATEGY, history, {
    system,
    tools: AGENT_TOOLS,
    executeTool: buildToolExecutor(params.telegram),
  });

  await recordUsage("CHAT", result);
  logger.info("agent.reply", { toolsCalled: result.toolsCalled });

  await appendTurn(params.telegramChatId, "user", params.message);
  await appendTurn(params.telegramChatId, "assistant", result.text);

  // The warning is shown but deliberately not persisted — it's about the
  // account, not part of the conversation the model should later re-read.
  return budgetWarning ? `${budgetWarning}\n\n${result.text}` : result.text;
}

export async function clearHistory(telegramChatId: string) {
  const { count } = await prisma.aIConversation.deleteMany({ where: { telegramChatId } });
  return count;
}
