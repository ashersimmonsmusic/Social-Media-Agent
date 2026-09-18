/**
 * What counts as a clip worth cutting from one of Asher's videos.
 *
 * Held as data for the same reason the caption rules are: this is the judgement
 * the whole feature rests on, and it needs to be readable and arguable rather
 * than buried in a prompt string. It will be wrong at first and edited often.
 *
 * The brief's own principle, kept at the top because everything else follows
 * from it: the question is not "where are the interesting timestamps" but "what
 * would stand on its own as a piece of content".
 */

export const PRINCIPLE =
  "A clip has to work for someone who has never seen the video it came from, will watch it muted, " +
  "and will decide within two seconds whether to keep watching. If it needs context you cannot give " +
  "it in the first line, it is not a clip.";

/** What makes a moment worth taking. Concepts, not phrases to match on. */
export const LOOK_FOR = [
  "A complete thought: something set up, developed and landed. A person watching the end should not need the part you cut off.",
  "A story with a shape — a problem and what happened, a mistake and what it taught him, a decision and its consequence.",
  "A statement he clearly means. Conviction reads on camera and carries a clip further than cleverness does.",
  "Something specific enough to be surprising: a number, a piece of gear, a name, a length of time, a thing that went wrong.",
  "A moment of craft being explained — how a sound was made, why a take worked, what he was listening for.",
  "Genuine performance: a vocal take, a freestyle, a part being played well. These need no words to work.",
  "A reaction that is real — surprise, laughter, a wince at his own playing.",
  "Something he says about music, faith, Bristol, Caribbean heritage or the business that he would say the same way off camera.",
];

/** Reasons to reject a candidate outright, before scoring. */
export const REJECT = [
  "It starts mid-sentence, or ends before the thought is finished.",
  "It only makes sense if you watched what came before it.",
  "It is mostly filler — 'erm', restarts, thinking out loud without arriving anywhere.",
  "There is a long silence in it that is not doing any work.",
  "The audio is unusable: clipping, wind, someone talking over him, a room with no treatment.",
  "It is a worse version of another moment in the same video. Keep the better one.",
  "It is him being polite, or admin — greetings, sign-offs, 'let me just move this mic'.",
  "It is interesting to him and not to anyone else. Gear talk with no point is the usual case.",
  "Nothing actually happens. A wide shot of a room is not a clip.",
];

/**
 * What is scored, and what each one means.
 *
 * Deliberately not framed as a prediction of performance. The scores exist to
 * rank candidates against each other so the best ones surface first — a clip
 * scoring 91 is not 91% likely to do anything.
 */
export const CRITERIA = [
  ["hook", "Does the first line earn the second? Would someone stop scrolling for it?"],
  ["story", "Is it complete? Setup, development, payoff — or at minimum a thought that lands."],
  ["value", "Is there something in it worth someone's time — a lesson, a method, an insight, a laugh?"],
  ["emotion", "Does it carry anything: warmth, frustration, conviction, humour? Flat is the enemy."],
  ["independence", "Does it work with no knowledge of the source video? This is the one that kills most candidates."],
  ["visual", "Is there something to watch? Playing, moving, reacting — rather than a static talking head."],
  ["audio", "Is the sound clean enough to publish? Clipping, wind and room noise all count against it."],
  ["voice", "Does it sound like him? Understated, specific, dry. Not a man performing for an algorithm."],
] as const;

export type CriterionKey = (typeof CRITERIA)[number][0];

/** Titles name the content. The brief is explicit and it is right. */
export const TITLE_RULES = [
  "Describe what is actually in the clip, so he can tell them apart in a list.",
  "Under about eight words.",
  "No clickbait, no ellipsis, no 'you won't believe'. It is a label, not a thumbnail.",
  "Plain sentence case. It is for him, not for a feed.",
];

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** The brief every stage of the analysis shares, so none of them drift apart. */
export function clippingBrief(): string {
  return [
    "WHAT MAKES A CLIP WORTH CUTTING",
    "",
    PRINCIPLE,
    "",
    "Look for:",
    bullets(LOOK_FOR),
    "",
    "Reject outright:",
    bullets(REJECT),
    "",
    "Judge each candidate on:",
    CRITERIA.map(([key, meaning]) => `- ${key}: ${meaning}`).join("\n"),
    "",
    "Scores rank candidates against each other. They are not a prediction that anything will perform, " +
      "and should never be described as one.",
  ].join("\n");
}

export function titleBrief(): string {
  return ["TITLES", bullets(TITLE_RULES)].join("\n");
}
