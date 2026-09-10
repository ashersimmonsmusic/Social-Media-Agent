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
];
