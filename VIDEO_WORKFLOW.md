# Posting video three times a week

What the bot can do with video, what it can't, and the routine that makes three
posts a week take about half an hour of your time.

---

## The short version

1. Drop clips into your Drive folder as you shoot them.
2. Once a week, ask the bot what's in there.
3. Pick three. It makes each one vertical and sends it to you to watch.
4. You say yes or no, it writes the captions, you approve, it schedules them.
5. They go out on their own on Monday, Wednesday and Friday.

The only part that needs you is step 3 and 4, and it happens once a week.

---

## What "intelligently resize" actually means here

You upload a 16:9 clip. Instagram wants 9:16. Something has to give, and there
are only two honest answers:

**Crop in.** Take a tall slice out of the middle and throw the sides away. Looks
great — a proper full-frame vertical — but only if whatever matters stays inside
that slice. If you walk across the shot, you walk out of frame.

**Keep the whole frame.** Put the full 16:9 picture in the middle of a vertical
canvas and fill the space above and below with a blurred, enlarged copy of
itself. Nothing is lost. The picture is smaller.

The bot chooses between them by looking. It pulls six stills out of the clip,
sends them to the model, and asks one question per frame: where is the subject,
left to right? Then:

- Subject stays roughly put across all six → **crop**, centred on where it
  actually is, not blindly on the middle.
- Subject drifts more than about a fifth of the frame → **blurred fill**, because
  a fixed crop would lose it partway through.
- No clear single subject (wide shot, crowd, scenery) → **blurred fill**.
- Can't reach the model at all → **blurred fill**.

That last one matters: every fallback lands on the option that cannot go
embarrassingly wrong. The worst case is a clip that looks plainer than it could
have. There is no path where it silently cuts your head off.

It tells you which it chose and why, every time. Override it with
`/reel <id> crop` or `/reel <id> blur` if you disagree.

Already-vertical footage is left alone.

---

## Subtitles

Most Reels are watched with the sound off, so words on screen are usually the
difference between someone watching and someone scrolling.

```
/reel <id> subs
```

Or just ask — *"do that one with subtitles"*.

It pulls the audio out, has it transcribed, and burns the words onto the picture
before rendering. Plain white text with a heavy outline, low in the frame and
clear of Instagram's own buttons. No bouncing, no colour changes, no
word-by-word highlighting — those date fast and read as a template.

**What it costs:** about 0.2 pence for a minute-long clip. Three reels a week is
roughly 5p a month.

**What you need:** an ElevenLabs API key in Railway as `ELEVENLABS_API_KEY`.
Their free plan has no commercial usage rights, so it isn't an option for your
account — but pay-as-you-go at $0.22 an hour means your actual bill is pennies.

If there's no speech in the clip, or transcription fails, **you still get the
clip** — it just arrives without subtitles and says why.

## Music

There are two completely different things people mean by "add music to a post",
and only one of them is possible for a bot.

**Instagram's music library is off limits.** Trending sounds, licensed tracks,
the whole catalogue — the publishing API has no parameter for any of it, and
that's a licensing decision on Meta's side rather than a gap someone forgot.
Every scheduling tool hits the same wall. If a post needs a trending sound, that
post gets made on your phone.

**Music inside the file works fine.** Instagram doesn't care where audio came
from once it's in the MP4, and since the music is yours, that's the right answer
anyway.

```
/music              → lists the tracks in your Drive; tap one
/music off          → stop using it, but remember which track
/music on           → start again
/music level -10    → how loud it sits (0 loudest, -40 barely there)
/music start 32     → begin 32 seconds into the track, not at the top
/music forget       → clear it entirely
```

Put your tracks in a Drive folder and set `GOOGLE_DRIVE_MUSIC_FOLDER_ID` in
Railway to that folder's id — the long code in its address bar. Share it with
the bot the same way you shared the video folder.

Once a track is set, **every clip the bot renders gets it**, including the ones
the clipping pipeline cuts out of a long video. It's mixed in at -14dB by
default, which is well under a speaking voice, and it's **ducked automatically**
— pulled down about another 10dB whenever you're talking, and let back up in the
gaps. It fades in over three quarters of a second and out over one and a half, so
it doesn't start or stop dead. A track shorter than the clip loops.

If the footage is silent, the bed comes up to -4dB instead and becomes the whole
soundtrack, because -14dB of music over silence sounds like a mistake.

To skip it for one clip: `/reel <id> nomusic`.

### Naming the audio

`INSTAGRAM_AUDIO_NAME` in Railway — set it to your artist name. When the bot
publishes a Reel it tells Instagram what the Reel's own audio is called, which is
what turns it into a tappable audio page other people can post with, rather than
an unnamed blob. With a music bed the label becomes *"Track title · Your name"*;
without one it's just your name.

This can only be set **once per Reel**, at the moment it's published. There is no
fixing it afterwards from here, so check it on a dry run first: it's recorded in
the audit log as `audioName`.

### The catch worth knowing about

Instagram's content-ID system may still flag or mute your own music. Artists get
this on their own accounts regularly. The fix isn't technical — claim your
catalogue through your distributor's rights-management tool so Instagram's system
knows the account is yours. Do that before you rely on this, or you'll be
debugging the render when the problem was paperwork.

## What it can't do

Say these out loud now so they're not a surprise later:

- **It can't watch your video.** It sees six stills. That's enough to decide
  where to crop and nothing else. It doesn't know what you say, what happens, or
  how it ends — so it can't write a caption about the content unless you tell it
  what's in there.
- **It can't hear audio** beyond transcribing it for subtitles (below). It still
  doesn't know what the clip *means*, so a caption depends on you saying so.
- **It can't edit.** No cutting between shots, no effects, no transitions. It
  makes one clip vertical, can start it later than zero, can burn subtitles on,
  and can lay one music track underneath. Anything beyond that is still a CapCut
  or phone job.
- **It can't use Instagram's music.** Only music baked into the file — see
  **Music** above.
- **90 seconds maximum.** Instagram's API won't publish a longer Reel. For longer
  footage, tell it where to start: `/reel <id> 45` begins 45 seconds in.
- **Instagram only.** No TikTok, no YouTube, no Stories, no carousels.

---

## Requirements for the source clip

- **MP4 or MOV**, H.264 video. Straight off a phone or out of CapCut is fine.
- **Under 2GB** (`VIDEO_MAX_SOURCE_MB`). Raise it further if you need to — the
  real limit is the disk on your Railway volume, and the bot checks there's
  room before it downloads anything rather than filling the disk and failing
  half way.
- Anything else Instagram rejects at the upload stage with a useless error code,
  so the bot re-encodes every clip to what Instagram accepts regardless of what
  went in.

---

## The weekly routine

**Through the week — capture, don't edit.** Clips go into the Drive folder —
subfolders are fine, the bot looks inside them. Don't tidy them, don't rename
them, don't decide whether they're any good. That
decision is for later; deciding now is what stops people filming.

**Once a week, 30 minutes:**

```
/videos                  what's in the folder
/reel <id>               make one vertical — watch what comes back
```

Then talk to it: *"caption for that one, it's me tracking the bassline for the
new single"* — it needs that sentence, because it can't see what's happening.
It writes the caption, you get an approval card, you press Approve.

For the three-a-week rhythm, schedule them in the same sitting:

> *"schedule that for Monday at 6pm"*

It checks what day it actually is, queues the post, and confirms the slot.
`/scheduled` shows the queue, `/cancel <id>` pulls one back.

Three posts, one sitting, done by Sunday evening.

---

## Disk, and clearing up after itself

Rendered clips are the only big thing this stores. A Railway volume on the Hobby
plan tops out at 5GB, so they can't just pile up.

They don't. **A week after a clip's post has gone out, its file is deleted.**
Nothing is lost when that happens: Instagram has the post, Drive has the
original footage, and the library entry stays so your history and `/stats` still
show what went out and when — it just no longer has a file behind it.

Anything still scheduled, awaiting approval, or drafted is never touched, even
if the same clip was posted once before.

Change the window with `VIDEO_RETENTION_DAYS` in Railway, or set it to `0` to
keep everything forever.

**Sizing the volume:** budget about 1.5× your largest clip for working space,
plus room for a week of finished ones. 5GB is comfortable for 1080p. If you
shoot 4K regularly you'll want Railway's Pro plan, which raises the ceiling
considerably.

## Why it still asks before posting

You could have it post unattended. You shouldn't, and it isn't built that way.

An automatic crop is a judgement call made by a machine that has seen six frames
of your footage. Nine times in ten it's right. The tenth time it's a clip of you
with your head cut off, live on your own feed, and you find out from a comment.

So the clip comes to you in Telegram before anything else happens. You watch it —
a few seconds — and approve or don't. **That is the whole cost of the safeguard,
once a week.** Everything after your approval is automatic: the posting itself
happens on Monday, Wednesday and Friday without you.

Automatic scheduling, manual approval. You approve once, it posts three times.

---

## Before any of this posts for real

Two switches, both outside this code:

1. **Your Instagram account needs a role on your Meta app.** Add it as an
   Instagram Tester and accept the invite from inside Instagram. App Review is
   not needed to post to your own account — see `SOCIAL_SETUP.md`.
2. **`DRY_RUN=false`** in Railway. It defaults to `true`, which means everything
   works end to end and records what it *would* have posted without posting it.

Leave `DRY_RUN=true` until you've watched a few clips come back and you're happy
with the framing. Nothing reaches Instagram until both of those are done.
