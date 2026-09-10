import type { AgentTool } from "./types.js";

/**
 * The agent's tool surface.
 *
 * Deliberately contains nothing that publishes, sends, spends, or deletes.
 * Anything with real-world consequences goes through an Approval that Asher
 * confirms with a button — so the agent literally has no way to act on the
 * outside world by talking itself into it (brief §2).
 */
export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "search_content_library",
    description:
      "Search Asher's content library (photos, videos, audio, documents, saved text/quotes) by keyword. " +
      "Use when he asks what content he has, or when looking for something to post.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keyword to search for. Omit to list the most recent items." } },
      required: [],
    },
  },
  {
    name: "list_unused_content",
    description:
      "List content assets that have never been used in anything. Use when Asher asks what he could post, " +
      "or wants to get value from existing material rather than making something new.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_knowledge",
    description:
      "Search confirmed facts about Asher (bio, music catalogue, achievements, press, links). " +
      "ALWAYS use this before stating anything factual about him. If it returns nothing, say you don't know.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up. Omit to list everything known." } },
      required: [],
    },
  },
  {
    name: "get_brand_bible",
    description: "Get Asher's brand voice, colours, visual motifs and active brand rules. Use before writing anything in his voice.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_pending_approvals",
    description: "List everything currently waiting for Asher's approval.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_to_library",
    description:
      "Save a piece of text — a quote, lyric, idea, or note — into the content library. " +
      "Use when Asher shares something he wants kept, rather than asking a question.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact text to save, unchanged." },
        description: { type: "string", description: "Optional short note on what this is." },
      },
      required: ["text"],
    },
  },
  {
    name: "propose_for_approval",
    description:
      "Put something in front of Asher as an approval card with buttons — the ONLY way to move anything toward " +
      "being published or sent. Use for draft posts, captions, or outreach you've written. Nothing happens until he approves.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short heading, e.g. 'Instagram caption for Brighter Days'." },
        summary: { type: "string", description: "One line of context on what this is." },
        content: { type: "string", description: "The full draft being proposed." },
      },
      required: ["title", "summary", "content"],
    },
  },
];
