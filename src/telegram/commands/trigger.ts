/**
 * Telegraf matches command names case-sensitively (`new RegExp('^name$')`),
 * but phone keyboards routinely capitalise the first letter after the slash,
 * so a typed `/Caption` would silently miss its handler. Match case-insensitively.
 */
export function commandTrigger(...names: string[]): RegExp[] {
  return names.map((name) => new RegExp(`^${name}$`, "i"));
}

/** Every command the bot answers to, used for matching and for Telegram's command menu. */
export const COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "Welcome message and command list" },
  { command: "whatsimportant", description: "What needs your attention right now" },
  { command: "library", description: "Recent items in your content library" },
  { command: "pending", description: "Anything awaiting your approval" },
  { command: "brand", description: "Your Brand Bible summary" },
  { command: "caption", description: "Draft caption options for review" },
  { command: "learn", description: "Learn facts about you from a web page" },
  { command: "knowledge", description: "What I currently know about you" },
  { command: "reset", description: "Start a fresh conversation" },
  { command: "rules", description: "Your standing instructions for how I behave" },
  { command: "diag", description: "Check which AI models your key can reach" },
  { command: "spend", description: "What the AI has cost this month" },
  { command: "connect", description: "Link your Instagram account for posting" },
  { command: "accounts", description: "Which accounts are linked, and recent posts" },
  { command: "disconnect", description: "Unlink Instagram so nothing can post" },
  { command: "website", description: "What I can add to your website" },
  { command: "newsletter", description: "Email list status, and send one" },
  { command: "stats", description: "How things are going — posts, subscribers, sales" },
  { command: "scheduled", description: "Posts queued to go out later" },
  { command: "cancel", description: "Cancel a scheduled post" },
];
