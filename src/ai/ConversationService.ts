import type { Telegram } from "telegraf";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { aiProvider, recordUsage } from "./AIService.js";
import { AGENT_TOOLS } from "./agentTools.js";
import { buildToolExecutor } from "./toolExecutor.js";
import { listActiveBrandRules } from "../modules/brand/brand.service.js";
import type { ConversationTurn } from "./types.js";

/** How many past turns to replay as context. Keeps cost bounded on a long-running chat. */
const HISTORY_TURNS = 20;

const AGENT_SYSTEM_PROMPT = `You are Asher Simmons' artist manager and creative assistant. Asher is an independent musician based in Bristol, UK, with Caribbean (Bahamian) heritage.

You are talking to Asher directly over Telegram. Be conversational, warm and brief — this is a chat on his phone, not a report. Usually 1-4 sentences. No headings, no bullet-point walls unless he asks for a list. Never open with flattery.

He has ADHD. Reduce his cognitive load: give a clear recommendation rather than a menu of options, and lead with the answer.

WHAT YOU MUST NEVER DO:
- Never invent facts about Asher — his releases, achievements, press, streams, collaborators, dates, or history. Use the search_knowledge tool before saying anything factual about him. If it returns nothing relevant, say plainly that you don't know and offer to learn it (he can run /learn <url>, or just tell you).
- Never claim you have published, posted, sent, scheduled, or paid for anything. You cannot do any of those things. You have no tool that touches the outside world.
- Never treat a casual "yeah nice" as approval. Approval only ever happens when he presses a button on an approval card.

WHAT YOU CAN DO:
- Look things up: his content library, what you know about him, his brand, what's awaiting approval.
- Save things he shares (quotes, lyrics, ideas) with save_to_library. If he sends you something that reads like content rather than a message to you, save it and tell him you have.
- Write drafts. When a draft is meant to go out into the world, put it in front of him with propose_for_approval so he gets a card with buttons. Say that's what you've done.
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

  return result.text;
}

export async function clearHistory(telegramChatId: string) {
  const { count } = await prisma.aIConversation.deleteMany({ where: { telegramChatId } });
  return count;
}
