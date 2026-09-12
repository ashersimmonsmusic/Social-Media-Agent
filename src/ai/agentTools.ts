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
  {
    name: "look_at_image",
    description:
      "Look at a photo in Asher's library and get a description of what's actually in it. Use this BEFORE writing any " +
      "caption about a photo — without it you are writing blind and will produce something generic that doesn't match " +
      "the image. Takes the asset id from search_content_library.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string", description: "Asset id of the image to look at." } },
      required: ["assetId"],
    },
  },
  {
    name: "propose_social_post",
    description:
      "Put a social post in front of Asher as an approval card. This is the ONLY route anything takes to Instagram, " +
      "Call look_at_image first whenever the post has a photo, so the caption is about what is actually in it. " +
      "Pass scheduledFor to have it go out later instead of straight away. " +
      "and it posts only after he presses Approve — calling this does not publish. Instagram requires an image, so " +
      "pass assetId for a photo from his library (preferred) or mediaUrl for a public image; without either the post " +
      "cannot go out and you should say so.",
    inputSchema: {
      type: "object",
      properties: {
        caption: { type: "string", description: "The full caption exactly as it should appear, hashtags included." },
        assetId: {
          type: "string",
          description:
            "Id of an image in Asher's content library to post, from search_content_library. Preferred over mediaUrl — " +
            "a public link is generated for it automatically.",
        },
        mediaUrl: {
          type: "string",
          description: "Public https URL of an image, for something not in the library. Use assetId when you can.",
        },
        scheduledFor: {
          type: "string",
          description:
            "ISO 8601 time to post it, e.g. 2026-05-03T18:00:00+01:00. Omit to post as soon as he approves. " +
            "Call current_time first so you resolve 'Friday at 6' against the real date.",
        },
        rationale: { type: "string", description: "One line on why this post, for Asher to weigh up." },
      },
      required: ["caption"],
    },
  },
  {
    name: "propose_newsletter",
    description:
      "Put an email newsletter in front of Asher as an approval card. It goes to everyone subscribed on his website, " +
      "and only after he presses Approve. Email cannot be recalled once sent, so never imply it has gone out — say " +
      "you've put it to him. Write the body as plain prose; an unsubscribe footer is added automatically.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Subject line. Concrete and specific, not clickbait." },
        body: { type: "string", description: "The email as plain prose. Blank lines separate paragraphs." },
        rationale: { type: "string", description: "One line on what this is and why now." },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "get_stats",
    description:
      "Get Asher's actual numbers: posts published and scheduled, newsletter subscribers, paid sales, library size, " +
      "AI spend. Use this before answering anything about how he's doing, rather than guessing. It cannot see " +
      "Instagram reach or Spotify streams — say so plainly if he asks for those.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "current_time",
    description:
      "Get the current date and time in Asher's timezone. Call this BEFORE scheduling anything — you do not otherwise " +
      "know what day it is, so you cannot work out what 'Friday' or 'tomorrow at 6' means without it.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "propose_website_content",
    description:
      "Put something on Asher's website in front of him as an approval card. Handles the content types the site " +
      "already has: 'event' (a gig), 'pressMention' (a quote or review), 'article' (a link to coverage about him). " +
      "It is written to the site only after he presses Approve. If he wants something the site has no type for — a " +
      "blog with body text, a new section, a shop — use request_website_change instead, do NOT force it into these.",
    inputSchema: {
      type: "object",
      properties: {
        contentType: { type: "string", enum: ["post", "event", "pressMention", "article"] },
        fields: {
          type: "object",
          description:
            "The document's fields. post: title, body (plain prose; blank lines separate paragraphs, a line starting " +
            "'## ' becomes a subheading), excerpt?, publishedAt?. event: name, date (ISO datetime), venue, city, " +
            "ticketUrl?, status?. pressMention: outlet, quote?, url?. article: title, publication?, date?, excerpt?, url?.",
        },
        rationale: { type: "string", description: "One line on what this is, for Asher to weigh up." },
      },
      required: ["contentType", "fields"],
    },
  },
  {
    name: "request_website_change",
    description:
      "File a request with Claude Code for website work you cannot do yourself — a new section, a new kind of " +
      "content the site has no type for, a design or layout change, or a bug on the site. This opens an issue on the " +
      "website repository for a developer session to pick up; it does NOT change the site. Say that plainly to Asher: " +
      "it's been written down, not done. Include everything he said about what he wants, in his words.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short summary of the request, as an issue title." },
        details: {
          type: "string",
          description: "What Asher wants and why, in enough detail to act on without asking him again.",
        },
      },
      required: ["title", "details"],
    },
  },
  {
    name: "propose_behavior_rule",
    description:
      "Propose a standing instruction for Asher to approve — use ONLY when he explicitly tells you to change how you " +
      "respond: 'stop doing X', 'always lead with Y', 'I prefer when you Z'. Once approved the rule is loaded into " +
      "every future conversation as a permanent instruction. Never call this unprompted or for a one-off request.",
    inputSchema: {
      type: "object",
      properties: {
        rule: {
          type: "string",
          description: "The rule as a clear, actionable instruction. E.g. 'Always lead with TikTok when suggesting platforms, not Instagram.'",
        },
        rationale: {
          type: "string",
          description: "One sentence on what behaviour this changes and why Asher asked for it.",
        },
      },
      required: ["rule", "rationale"],
    },
  },
];
