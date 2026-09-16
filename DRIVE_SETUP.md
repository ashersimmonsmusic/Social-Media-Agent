# Connecting Google Drive

One-off setup so the bot can see your video. Takes about 15 minutes.

You're telling Google "this app of mine is allowed to *read* my Drive." The
permission is read-only — the bot can look at your files and never change,
move or delete one.

**Nothing here is a key except the two values in Step 5.** Those go straight
into Railway and nowhere else.

---

## Step 1 — Get your app's address

You need this before anything else, and everything else refers back to it.

In Railway, open the bot service → **Settings** → **Networking** → **Public
Networking**. You'll see a domain like:

```
social-media-agent-production.up.railway.app
```

If there's no domain there, click **Generate Domain**.

Write it down with `https://` on the front:

```
https://social-media-agent-production.up.railway.app
```

That's your **app address**. It's not a secret.

---

## Step 2 — Make a Google project

1. Go to **console.cloud.google.com**
2. Top of the page, click the project dropdown → **New Project**
3. Name it something you'll recognise — `Asher Bot` is fine
4. **Create**, then make sure it's the selected project

This is just a container. Nothing is live yet.

---

## Step 3 — Turn on the Drive API

1. Left menu → **APIs & Services** → **Library**
2. Search **Google Drive API**
3. Click it → **Enable**

Without this, everything else appears to work and then fails at the last step.

---

## Step 4 — The consent screen

This is the page you'll see when you approve access.

1. **APIs & Services** → **OAuth consent screen**
2. User type: **External** → Create
3. Fill in the required bits:
   - App name: `Asher Bot`
   - User support email: your own
   - Developer contact email: your own
4. Save and continue
5. On **Scopes**, click **Add or remove scopes**, and find:
   ```
   .../auth/drive.readonly
   ```
   Tick it, **Update**, then Save and continue.
6. On **Test users**, add your own Gmail address.
7. Save and continue to the end.

### Then do this, or you'll be reconnecting every week

Back on the **OAuth consent screen** page there's a **Publishing status**,
currently **Testing**. Click **PUBLISH APP** and confirm.

Google gives apps in Testing a permission that **expires after 7 days**.
Publishing makes it last indefinitely. You don't need Google to verify
anything — you're the only user.

Because it's unverified, the approval page in Step 7 will warn you that
"Google hasn't verified this app". That's expected. It's your app.

---

## Step 5 — Create the credentials

1. **APIs & Services** → **Credentials** → **Create Credentials** →
   **OAuth client ID**
2. Application type: **Web application**
3. Name: `Asher Bot`
4. Under **Authorised redirect URIs**, click **Add URI** and paste your app
   address from Step 1 with `/oauth/google/callback` on the end:

   ```
   https://social-media-agent-production.up.railway.app/oauth/google/callback
   ```

   This must match **exactly** — no trailing slash, `https` not `http`. A
   mismatch here is the single most common failure, and Google's error says
   `redirect_uri_mismatch`.

5. **Create**

You now get a **Client ID** and a **Client Secret**.

**The Client Secret is a key.** Long random string. It goes into Railway and
nowhere else — not into a chat, not into a note, not into a search box.

---

## Step 6 — Put them in Railway

Bot service → **Variables** → **New Variable**, three times. Name in the name
box, value in the value box — never the whole `NAME=value` line in one box.

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from Step 5 |
| `GOOGLE_CLIENT_SECRET` | the Client Secret from Step 5 |
| `PUBLIC_BASE_URL` | your app address from Step 1 |

Railway redeploys automatically. Wait for it to go green.

---

## Step 7 — Connect it

In Telegram, send:

```
/drive
```

You get a link. Open it, pick your Google account, click through the
"unverified app" warning (**Advanced** → **Go to Asher Bot**), and approve.

The page will say **Google Drive connected as you@gmail.com**. Send `/drive`
again any time to check which account it's on.

---

## Step 8 — Point it at one folder

Without this the bot can see every video anywhere in your Drive. Narrowing it
means its reach is exactly what you choose to put in one place.

1. Make a folder in Drive — `Bot Videos` or similar
2. Open it and look at the address bar:

   ```
   drive.google.com/drive/folders/1a2B3cD4efGH5ijKLmn6
                                  └──────────────────┘
                                      the folder ID
   ```

3. Railway → **Variables** → **New Variable**:
   - Name: `GOOGLE_DRIVE_FOLDER_ID`
   - Value: just the ID

4. Wait for the redeploy, then send `/videos`

A folder ID is a label, not a key. Safe to share.

---

## Using it

Drop clips into that folder. Then:

```
/videos          what's in there
/reel <id>       make one vertical, sent back for you to watch
```

`VIDEO_WORKFLOW.md` covers the rest.

---

## When it doesn't work

**"Google isn't set up yet"** — one of the three variables in Step 6 is
missing or misspelled. Check for a stray space at the end of a value.

**`redirect_uri_mismatch`** — Step 5's URI doesn't match Step 6's
`PUBLIC_BASE_URL` exactly. Compare them character by character. Usually a
trailing slash or `http` instead of `https`.

**`/videos` comes back empty** —
- The folder belongs to a different Google account than the one you connected.
  `/drive` tells you which account it's on.
- Your clips are in a *subfolder*. The bot reads files sitting directly in the
  folder, not nested inside it. Keep it flat.
- The folder ID has part of the URL attached. It's only the bit after
  `/folders/`, nothing else.

**"Google has stopped accepting my saved permission"** — run `/drive` and
approve again. If it happens weekly, your app is still on **Testing**; go back
to the end of Step 4 and publish it.

**Starting over** — `/drivedisconnect` unlinks it. To remove the bot's access
from Google's side too, go to **myaccount.google.com/permissions**.
