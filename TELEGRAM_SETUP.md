# TELEGRAM_SETUP.md

## 1. Create the bot

1. Open Telegram and message **@BotFather**.
2. Send `/newbot` and follow the prompts (pick a name and a username ending in `bot`).
3. BotFather gives you a token like `123456789:AAF...` — put this in `.env` as
   `TELEGRAM_BOT_TOKEN`. Treat it as a secret (whoever has it can control the bot).

## 2. Find your chat id

The bot only ever responds to **one** Telegram chat — Asher's — set as
`TELEGRAM_ALLOWED_CHAT_ID`. This is the entire authentication model for Phase 1, so it's
worth getting right.

Easiest way:
1. Message **@userinfobot** on Telegram — it replies with your numeric id.
2. Put that number (as a string) in `.env` as `TELEGRAM_ALLOWED_CHAT_ID`.

(Alternative: temporarily set `TELEGRAM_ALLOWED_CHAT_ID` to anything, run the app, message
your bot, and check the server logs — every blocked message logs the chat id it saw, e.g.
`{"level":"warn","message":"telegram.blocked_chat","meta":{"chatId":"..."}}`. Copy that
value in and restart.)

## 3. Long-polling vs. webhook

**Long-polling (default, recommended for local dev and small deployments):** leave
`TELEGRAM_USE_WEBHOOK=false`. No public URL needed — the bot just asks Telegram for
updates. This is what `npm run dev` uses out of the box.

**Webhook mode (useful once deployed somewhere with a stable public URL):**
1. Set `TELEGRAM_USE_WEBHOOK=true`.
2. Set `PUBLIC_BASE_URL` to your deployed app's URL (e.g. your Railway domain).
3. Set `TELEGRAM_WEBHOOK_SECRET` to a random string — the app verifies every incoming
   webhook request carries this secret before processing it.

The app registers the webhook with Telegram automatically on startup when
`TELEGRAM_USE_WEBHOOK=true` — you don't need to call Telegram's API by hand.

## 4. Say hello

Once the app is running, message your bot `/start`. You should see a welcome message
listing the available commands. If nothing happens, check the server logs for
`telegram.blocked_chat` (wrong chat id) or `fatal_startup_error` (bad token / bad env).
