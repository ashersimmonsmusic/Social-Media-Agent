# SETUP.md — Local development

## Prerequisites

- Node.js 20+ (Node 22 recommended)
- Docker (for a local Postgres) — or any Postgres 14+ you already have running
- A Telegram bot token and your Telegram chat id — see [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md)
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

## 1. Install dependencies

```bash
npm install
```

## 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

- `DATABASE_URL` — leave as-is if you use the provided `docker-compose.yml`.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID` — see `TELEGRAM_SETUP.md`.
- `ANTHROPIC_API_KEY` — from the Anthropic console.
- `ADMIN_API_KEY` — any long random string (e.g. `openssl rand -hex 32`).

Every variable is documented with a comment in `.env.example`. `DRY_RUN` defaults to
`true` — leave it there until real social/outreach integrations exist (Phase 3+); it has
no effect yet in Phase 1 since nothing performs a real external action.

## 3. Start Postgres

```bash
docker compose up -d
```

This starts a local Postgres 16 container matching the default `DATABASE_URL`. If you'd
rather use an existing Postgres instance, just point `DATABASE_URL` at it instead.

## 4. Run database migrations

```bash
npx prisma migrate dev
```

This creates all Phase 1 tables (see `prisma/schema.prisma` / `ARCHITECTURE.md` §4).

## 5. Run the bot

```bash
npm run dev
```

This starts the bot in long-polling mode (no public URL needed) plus a small HTTP server
on `PORT` (default 3000) with a `/health` endpoint. Message your bot on Telegram — it will
only respond from the chat id set in `TELEGRAM_ALLOWED_CHAT_ID`.

## Other useful commands

```bash
npm run typecheck      # TypeScript, no emit
npm test               # run the test suite (unit tests; DB calls are mocked)
npm run build           # compile to dist/
npm start                # run the compiled build (production mode)
npx prisma studio        # browse the database in a GUI
```

## Running with a real Postgres for integration testing

The test suite mocks Prisma so it runs without a database. If you want to exercise the
real database layer, run the app against the Docker Postgres above and use `/start`,
`/caption`, file uploads, etc. from Telegram directly — `npx prisma studio` lets you inspect
the resulting rows (Asset, Approval, AuditLog, AIUsageLog).

## Production (Railway or another host)

See `ARCHITECTURE.md` §11 and `Dockerfile` — set the same environment variables in your
host's dashboard (never commit real secrets), provision a Postgres add-on, and run
`prisma migrate deploy` before starting the app (the `Dockerfile`'s `CMD` already does this).

### Railway specifics

1. Add a Postgres service to the project: **+ New → Database → Add PostgreSQL**.
2. On the **app** service → Variables, set `DATABASE_URL` to the reference
   `${{Postgres.DATABASE_URL}}` (substituting your database service's actual name if it
   isn't `Postgres`). Use the reference rather than pasting the connection string —
   Railway rotates those credentials and a pasted copy goes stale silently.
   **Do not use the `localhost` value from `.env.example`** — on Railway that points at
   the app's own container, where no database is running.
3. Set the other required variables on the app service too, or startup will fail (it
   validates everything up front and logs exactly what's missing): `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_ALLOWED_CHAT_ID`, `ANTHROPIC_API_KEY`, `ADMIN_API_KEY`, plus
   `NODE_ENV=production`.
4. Leave `TELEGRAM_USE_WEBHOOK` unset — long-polling needs no public URL. Only switch to
   webhook mode once you also set `PUBLIC_BASE_URL` (your Railway domain) and
   `TELEGRAM_WEBHOOK_SECRET`.

A healthy deploy logs the `20250101000000_init` migration being applied, then
`telegram.polling_started` and `http.listening`.
