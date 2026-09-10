# USER_GUIDE.md — Asher's day-to-day guide (Phase 1)

Everything happens in your Telegram chat with the bot. This is what works today.

## Just talk to it

You can have a normal conversation with the bot — no commands needed. Ask it things like:

- "What should I post this week?"
- "What content have I got that I haven't used?"
- "Write me something for the new single"
- "What do you actually know about me?"

It remembers the conversation, can look things up (your content library, what it knows
about you, your brand, what's awaiting approval), and can write drafts. `/reset` starts a
fresh conversation if it's gone off track.

**What it can't do:** publish, post, send emails or DMs, spend money, or read analytics.
Not "won't" — it has no ability to. Anything meant to go out into the world comes back to
you as an approval card with buttons first.

## Sending content in

Send the bot a photo, video, voice note, audio file, or document — it files it straight
into your content library and tells you what it filed it as. Send a bare link and it files
it as a reference.

If you type something that's clearly content rather than a message to it — a quote, a
lyric, an idea — it'll save it to the library and tell you it has. If you're not sure it
understood, just say "save that" and it will.

## Commands

- `/start` — see the welcome message and command list.
- `/library` — your 10 most recent content library items.
- `/pending` — anything currently waiting on your approval.
- `/whatsimportant` — a quick read on what needs attention (pending approvals, unused
  content). **Note:** this is a partial view in Phase 1 — it can't see release deadlines,
  campaigns, or industry opportunities yet, because those parts of the system aren't built
  yet (see `ARCHITECTURE.md` for the roadmap). It will tell you so rather than pretend
  otherwise.
- `/brand` — a summary of your stored Brand Bible (colours, motifs, voice preferences,
  active rules).
- `/caption <what this post is about>` — e.g. `/caption new single Brighter Days out today`.
  The bot drafts caption options with Claude and sends them back as an approval card.

## Approving things

Whenever the bot has something ready for you, it sends a message with buttons. **Nothing
happens until you press a button** — replying "looks good" in the chat does nothing; only
the buttons count. Depending on what it is, you'll see some combination of:

- **✅ Approve** — accepts the draft (Phase 1 doesn't yet publish anything automatically on
  approve; that lands with the social integrations in Phase 3).
- **✏️ Edit** — the bot asks you to reply with your correction, then updates the draft in
  place.
- **🔄 Regenerate** — asks Claude to redraft it and shows you the new version.
- **❌ Reject** — closes the item out as rejected.
- For anything higher-stakes (Level 3, once those actions exist — e.g. spending money),
  you'll see a distinctly-worded **⚠️ Confirm** button rather than a plain Approve, and a
  **Cancel**. This is a deliberate extra step and is never a plain "yes".

## What this can't do yet

No real posting to Instagram/TikTok/etc, no real emails or outreach, no music/contact/
campaign management, no analytics, no weekly report. These are all on the roadmap
(`ARCHITECTURE.md` §9) — Phase 1 is the foundation everything else builds on.
