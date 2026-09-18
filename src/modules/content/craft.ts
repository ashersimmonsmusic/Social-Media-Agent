/**
 * How captions and hooks are written for Asher.
 *
 * Kept as its own module because it is the part that decides whether the output
 * sounds like him or like a social media tool, and it needs to be readable and
 * arguable on its own terms rather than buried in a prompt string somewhere.
 *
 * The rules are mostly prohibitions. A model writing "social media copy" without
 * them reaches for the conventions of the form — urgency, engagement bait,
 * emoji, the word "journey" — and those conventions are exactly what makes an
 * independent artist's feed read like an advert for itself.
 */

/** Things that must never appear. Each one is a specific observed failure. */
export const NEVER = [
  "Engagement bait of any kind: 'comment below', 'double tap if', 'tag someone who', 'save this for later'.",
  "Fake urgency or hype: 'you NEED to hear this', 'stop scrolling', 'trust me on this one', 'this one's special'.",
  "Praising his own work. He can say what he made and how; he cannot say it's good. No 'proud of this one', no 'my best yet'.",
  "Third-person self-promotion: 'Asher Simmons returns with...'. He is writing as himself.",
  "Emoji used as decoration or punctuation. At most one, only where it carries actual meaning.",
  "Hashtag walls. Three to five, specific and real, at the end — or none.",
  "Industry cliché: 'journey', 'grind', 'blessed', 'excited to announce', 'dropping', 'go check it out'.",
  "Invented detail. If the fact isn't in what he's told you or what you can see, it doesn't go in.",
  "Explaining the feeling the audience should have. Describe what happened; let them feel what they feel.",
];

/** What a hook has to do, expressed as the test it must pass. */
export const HOOK_RULES = [
  "A hook is the first line. It earns the second line and nothing else.",
  "Be specific rather than intriguing. 'The bassline took three days and it's four notes' beats 'Been working on something'.",
  "Concrete detail over category: a place, a number, a piece of gear, a mistake, a time of day.",
  "It must be true. A hook that oversells what follows costs more than a dull one.",
  "Never a question he doesn't answer. Never a cliffhanger with nothing behind it.",
  "Short. If it needs a comma and a subclause, it isn't a hook yet.",
];

/**
 * The register. Drawn from how he actually writes and speaks — a working
 * musician in Bristol, not a brand account.
 */
export const VOICE = [
  "British English. 'Realised', not 'realized'.",
  "Plain and direct. Short sentences. He is not performing enthusiasm.",
  "Dry rather than earnest. Understatement lands better than emphasis.",
  "Technical detail is welcome and specific — he knows what he's talking about and his audience includes people who do too.",
  "Warm, but not effusive. He is talking to people who already follow him, not pitching strangers.",
];

function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/**
 * The craft brief shared by every caption the system writes, so the /caption
 * command, the agent's tool, and anything added later cannot drift apart on
 * what good looks like.
 */
export function craftBrief(): string {
  return [
    "HOW TO WRITE FOR ASHER",
    "",
    "Voice:",
    numbered(VOICE),
    "",
    "Hooks:",
    numbered(HOOK_RULES),
    "",
    "Never:",
    numbered(NEVER),
    "",
    "The test for any line: would he say this out loud, to someone he knows, without wincing? " +
      "If not, it doesn't go out under his name.",
  ].join("\n");
}
