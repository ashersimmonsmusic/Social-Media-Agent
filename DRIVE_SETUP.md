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

Google has moved this, and it is not on the screen you just finished. Go to
**Google Auth Platform** → **Audience** in the left menu. Near the top is
**Publishing status: Testing**, with a **Publish app** button. Click it.

While the status is Testing, Google expires the whole authorisation **7 days
after you approve it** — the bot loses access every week for no visible
reason. Publishing removes that.

**Publishing is probably not worth it, and you can skip this step.** To
publish, Google wants a privacy policy and terms of service hosted on a domain
you have verified in Search Console, linked from the Branding page — and
because `drive.readonly` is a restricted scope, it may still require a full
review afterwards. That process exists for apps with thousands of users.

Staying on Testing costs you one `/drive` every seven days, which takes about
fifteen seconds. **The bot checks its own Drive access four times a day and
messages you when it lapses**, so you are told rather than finding out when a
clip fails to appear. That is the better trade for one person reading their
own Drive.

Either way the approval page in Step 7 warns that "Google hasn't verified this
app". That's expected. It's your app.

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

## The permanent alternative: a service account

Everything above uses *your* Google account, and Google expires that every
seven days while the app is on Testing. A service account removes that for
good. It is a robot with its own email address: you share a folder with it
exactly as you would with a person, and it signs its own tokens from a key
that never expires.

Nothing to approve, nothing to renew, no consent screen, no publishing status,
no privacy policy. It can only ever see what you explicitly share with it —
which is the reach you wanted anyway.

**Takes about five minutes.** Steps 1–3 above (project, Drive API) still apply;
steps 4–7 become unnecessary.

1. **console.cloud.google.com** → **IAM & Admin** → **Service Accounts** →
   **Create service account**
2. Name it `asher-bot` → **Create and continue** → skip the optional
   permissions → **Done**
3. Click the account you just made → **Keys** tab → **Add key** →
   **Create new key** → **JSON** → **Create**

   A `.json` file downloads. **That file is a key** — treat it like a password.
   It goes into Railway and nowhere else.

4. Open it in a text editor and copy **all** of it, from the first `{` to the
   last `}`.
5. Railway → **Variables** → **New Variable**:
   - Name: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Value: the whole contents of that file
6. Back in the service account page, copy its **email address** — the value in
   the **Email** column, which contains your own project's id and is unique to
   you. It has the shape `NAME@PROJECT-ID.iam.gserviceaccount.com`.

   **Copy the real one from the console or from the `client_email` line of the
   key file.** Do not type it out from the shape above — an address that does
   not exist is refused by Drive with "they do not have a Google Account",
   which reads like the service account is broken when it is only misspelled.

   Easiest way to get it exactly right: once `GOOGLE_SERVICE_ACCOUNT_JSON` is
   set in Railway, send `/drive` in Telegram and the bot prints the address for
   you to copy.

   It is not a secret — it's an address you share a folder with.
7. In Drive, open your videos folder → **Share** → paste that address → set it
   to **Viewer** → Send. Untick "Notify people" if you'd rather not email a
   robot.
8. Send `/drive` in Telegram. It should say it's connected through a service
   account.

Once `GOOGLE_SERVICE_ACCOUNT_JSON` is set, the bot uses it and ignores the
consent flow entirely. You can `/drivedisconnect` the old connection; it makes
no difference either way.

### "They do not have a Google Account"

Drive is telling you that address does not exist. Either the service account
hasn't been created yet, or the address has a typo — most often the project id
left as a placeholder. Send `/drive` to get the exact string.

### If `/videos` is empty afterwards

You almost certainly haven't shared the folder with the service account's
address, or shared a different folder than the one in
`GOOGLE_DRIVE_FOLDER_ID`. Drive reports "not shared with me" and "empty"
identically, so the bot can't tell them apart — it will remind you of the
address to share with.

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
- The folder is genuinely empty. Subfolders are fine — the bot looks inside
  them too, six levels deep.
- The folder ID has part of the URL attached. It's only the bit after
  `/folders/`, nothing else.

**"Google has stopped accepting my saved permission"** — run `/drive` and
approve again. If it happens weekly, your app is still on **Testing**; go back
to the end of Step 4 and publish it.

**Starting over** — `/drivedisconnect` unlinks it. To remove the bot's access
from Google's side too, go to **myaccount.google.com/permissions**.
