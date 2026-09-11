# Connecting Instagram

Posting access can't be granted from code — you have to create a Meta developer app
and authorize it against your own account. This is that walkthrough.

Budget real time for it. The app itself takes an hour; **App Review takes days**, and
Meta rejects vague submissions. Nothing here is optional — Instagram has no
posting path that skips review.

---

## What you need before starting

1. **An Instagram Business or Creator account.** A personal account cannot post via
   the API at all. Convert in the Instagram app: Settings → Account type and tools →
   Switch to professional account.
2. **A Facebook Page**, linked to that Instagram account. Instagram's API works
   through the Page. Link it in Instagram: Settings → Business tools and controls →
   Connected accounts.
3. **A Meta developer account** at <https://developers.facebook.com>.

If your Instagram isn't a Business/Creator account linked to a Page, nothing below
will work — start there.

---

## Step 1 — Create the app

1. <https://developers.facebook.com/apps> → **Create app**
2. Use case: **Other** → type: **Business**
3. Add the **Instagram** product to the app.

## Step 2 — Get your Instagram Business account ID

In the Graph API Explorer (<https://developers.facebook.com/tools/explorer>):

1. Select your app, then generate a user token. For this step you only need
   `pages_show_list` and `instagram_basic` — `instagram_content_publish` is for
   posting later and is gated behind App Review, so don't get stuck if it isn't
   offered yet. It only appears once the Instagram product is added to the app.
2. Query `me/accounts` to find your Page, and copy its `id`.
3. Query `<page-id>?fields=instagram_business_account`.

The `instagram_business_account.id` it returns is what `/connect` wants — a long
number starting `1784…`. **Not** your @handle.

## Step 3 — Get a long-lived token

Tokens from the Explorer expire in about an hour, which is useless for a bot.

1. Exchange your short-lived user token for a long-lived one (~60 days) using the
   `fb_exchange_token` grant.
2. Then fetch the **Page access token** from `me/accounts` using that long-lived
   token. A Page token obtained this way does not expire while the app and Page
   remain in good standing.

Use the Page access token with `/connect`. Meta's own
["Access Tokens"](https://developers.facebook.com/docs/facebook-login/guides/access-tokens)
guide has the exact request shapes, which change more often than this file will.

## Step 4 — App Review

`instagram_content_publish` requires App Review before it works on a live account.
Submit with a screencast showing your own flow: a draft appearing in Telegram, you
pressing Approve, the post appearing on your Instagram. Reviewers reject submissions
that don't show the actual publishing path.

Until review passes, you can only publish to accounts with a role on the app
(yours, as the developer). That's enough to test.

---

## Step 5 — Configure Railway

Add three variables:

```
SOCIAL_TOKEN_KEY=<output of: openssl rand -hex 32>
META_GRAPH_API_VERSION=v21.0
PUBLIC_BASE_URL=https://<your-app>.up.railway.app
```

`PUBLIC_BASE_URL` is your Railway public domain, with no trailing path. It's how
Instagram reaches images from your library; without it you can only post image
URLs that are already public elsewhere.

`SOCIAL_TOKEN_KEY` encrypts stored tokens, so a database dump doesn't hand over
posting access. If you change it later, stored tokens become undecryptable and
you'll reconnect the account.

Check the current Graph API version in the Meta console and set
`META_GRAPH_API_VERSION` to match — versions are deprecated on a schedule, and a
retired one fails with a confusing error.

Leave `DRY_RUN=true` for now.

---

## Step 6 — Connect

In Telegram:

```
/connect 17841400000000000 EAAB...your-page-token accountname
```

The bot deletes that message straight away, since it carries a token that can post
as you. If it replies that it couldn't, delete it yourself — that means Telegram
refused, and the token is still sitting in your history.

Check it worked with `/accounts`.

---

## Step 7 — Test before going live

With `DRY_RUN=true`, ask the bot to draft a post. Approve it. You'll get a
`DRY RUN — nothing was actually posted` confirmation, and the whole path is
exercised without touching Instagram. `/accounts` lists it as a dry run.

When you're satisfied, set `DRY_RUN=false` in Railway. **From that point an
approved post is a real, public post.**

---

## How posting actually works

- The bot can *propose* a post. It cannot publish one. `propose_social_post` only
  raises an approval card.
- Publishing happens in exactly one place, reached only by the approval handler
  when you press Approve.
- Instagram requires an image on every post — there is no text-only post. The
  caption is validated (2200 characters, 30 hashtags) before a card is raised, so
  you don't approve something that then fails.
- Instagram fetches the image from a **public HTTPS URL**; it doesn't accept
  uploaded bytes. Photos in your library are served from `/media/<asset-id>` on a
  signed link that expires after an hour, minted at the moment you approve. The
  signature covers the asset id and expiry, so a guessed, edited or stale link
  gets nothing, and only images are ever served — never contracts or audio.
  This needs `PUBLIC_BASE_URL` set to your Railway domain. You can also pass any
  already-public image URL instead.

## If something fails

`/accounts` shows recent posts with their status and the failure reason. Common ones:

- *"Media URL unreachable"* — Instagram couldn't fetch your image. It must be
  public, HTTPS, and not behind Cloudflare bot protection.
- *"no text-only post"* — no image was given. Name a photo from your library, or
  pass a public image URL.
- *Permission errors* — App Review hasn't passed, or the token lacks
  `instagram_content_publish`.
- *Token expired* — reconnect with a fresh Page token via `/connect`.
