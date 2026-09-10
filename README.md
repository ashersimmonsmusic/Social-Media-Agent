# Asher Simmons — AI Artist & Social Media Agent

An AI-powered artist business & marketing agent for independent artist Asher Simmons,
controlled through Telegram. Asher stays in control: the agent drafts, organises, and
recommends — it never publishes, sends, spends, or deletes anything real without an
explicit approval action.

This repository currently implements **Phase 1 — Foundation**. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design and the roadmap for
Phases 2–7.

## What's here right now

- A Telegram bot (only responds to Asher's own chat) that:
  - Files any photo/video/audio/voice note/document you send it into a **Content Library**,
    auto-classifying what it is.
  - Files pasted text/quotes/URLs the same way.
  - Stores and reports on Asher's **Brand Bible** (`/brand`).
  - Drafts caption options with Claude and puts them up for **approval** rather than
    posting anything (`/caption <idea>`), with Approve / Edit / Regenerate / Reject buttons.
  - Reports on pending approvals and unused content (`/whatsimportant`, `/library`, `/pending`).
- A generic **Approval** system (Level 1/2/3, per the brief) rendered as Telegram messages
  with inline buttons — approval is only ever an explicit button press, never inferred from
  a chat reply.
- An append-only **Audit Log** of every AI/Asher/system action.
- An **AI service** abstraction (provider-agnostic; Claude implemented) with per-call usage
  and estimated-cost logging.
- A Postgres schema (Prisma) for all of the above.

## Quick start

See [`SETUP.md`](./SETUP.md) for full instructions. In short:

```bash
cp .env.example .env        # fill in the values — see SETUP.md
docker compose up -d        # local Postgres
npm install
npx prisma migrate dev
npm run dev
```

Then message your bot on Telegram with `/start`.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system design, data model, phases, security model.
- [`SETUP.md`](./SETUP.md) — local development setup.
- [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md) — creating and configuring the Telegram bot.
- [`USER_GUIDE.md`](./USER_GUIDE.md) — how Asher uses the bot day-to-day.
