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

## What it can't do

Say these out loud now so they're not a surprise later:

- **It can't watch your video.** It sees six stills. That's enough to decide
  where to crop and nothing else. It doesn't know what you say, what happens, or
  how it ends — so it can't write a caption about the content unless you tell it
  what's in there.
- **It can't hear audio.** No transcription.
- **It can't edit.** No cutting between shots, no burned-in captions, no music,
  no effects. It makes one clip vertical and can start it later than zero. That's
  it. Cutting is still a CapCut or phone job.
- **90 seconds maximum.** Instagram's API won't publish a longer Reel. For longer
  footage, tell it where to start: `/reel <id> 45` begins 45 seconds in.
- **Instagram only.** No TikTok, no YouTube, no Stories, no carousels.

---

## Requirements for the source clip

- **MP4 or MOV**, H.264 video. Straight off a phone or out of CapCut is fine.
- **Under 300MB** (`VIDEO_MAX_SOURCE_MB`). Export at 1080p, not 4K.
- Anything else Instagram rejects at the upload stage with a useless error code,
  so the bot re-encodes every clip to what Instagram accepts regardless of what
  went in.

---

## The weekly routine

**Through the week — capture, don't edit.** Clips go into the Drive folder. Don't
tidy them, don't rename them, don't decide whether they're any good. That
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

1. **App Review.** Instagram publishing needs `instagram_content_publish`
   approved on your Meta app. Until it is, publishing fails no matter what the
   bot does.
2. **`DRY_RUN=false`** in Railway. It defaults to `true`, which means everything
   works end to end and records what it *would* have posted without posting it.

Leave `DRY_RUN=true` until you've watched a few clips come back and you're happy
with the framing. Nothing reaches Instagram until both of those are done.
