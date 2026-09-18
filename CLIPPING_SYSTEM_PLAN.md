# AI clipping system — audit and proposal

Response to the 26-point brief. §26 asks for this before code.

---

## 1. What already exists and can be reused

About 70% of the pipeline in the brief is already built. The parts below are
working and tested, not plans.

| Brief asks for | Already built | Where |
|---|---|---|
| Audio extraction | Yes — mono 16kHz MP3, cut to any start/duration | `video/ffmpeg.ts` |
| Transcription | Yes — word-level timings via ElevenLabs Scribe, behind a provider interface | `transcription/` |
| Burned-in captions | Yes — ASS, styled, timed, verified on real encodes | `video/subtitles.ts` |
| Vertical reframing | Yes — subject-aware crop or blurred fill, decided from sampled frames | `video/reframe.service.ts` |
| Frame sampling for visual analysis | Yes | `video/ffmpeg.ts` |
| Caption/hook writing to a house style | Yes — voice rules, prohibitions, three angles | `content/craft.ts` |
| Human approval before anything publishes | Yes — three-level approval, nothing reaches a platform without a button press | `approvals/` |
| Telegram review with buttons | Yes — `/videos` lists clips as tappable buttons | `telegram/commands/drive.ts` |
| Background processing on timers | Yes — four services already run this way | scheduler, retention, token refresh, Drive health |
| Storage abstraction | Yes — swappable provider interface | `storage/` |
| Cost control | Yes — per-call cost tracking, monthly budget with a hard stop | `ai/budget.ts` |
| Video ingestion from Drive | Yes — including whole folder trees | `drive/` |
| Instagram publishing | Yes — Reels, container polling, scheduling | `social/` |

**Nothing needs rewriting.** This is an extension, as §22 asks.

---

## 2. The blocker, before anything else

**The Railway volume is 0.4GB. A one-hour video is 2–6GB.**

This feature cannot run at all until that changes. It is not a code problem and
no amount of clever engineering works around it: ffmpeg needs the file on disk,
and it needs room for the clips it cuts out of it.

Realistic sizing for a one-hour source:

| | Space |
|---|---|
| Source video | 2–6GB |
| Extracted audio | ~30MB |
| 8 rendered clips | ~250MB |
| Working headroom | ~500MB |
| **Total** | **~3–7GB** |

**Minimum viable: Railway Hobby, 5GB volume.** That covers a one-hour 1080p
source. Longer or 4K footage needs Pro.

Everything below assumes this is solved first.

---

## 3. What is genuinely new

Five things the brief needs that don't exist yet.

### 3a. A long-video pipeline with state (§2, §21, §22)

Current video work is synchronous: one clip, start to finish, in one call. An
hour-long analysis takes 10–30 minutes and must survive a deploy.

Needs: `SourceVideo` and `Clip` tables, a status machine matching the progress
states in §22, and a worker that picks up unfinished jobs on boot — the same
pattern as the post scheduler, which already claims work atomically so two
containers can't process the same thing twice.

### 3b. Moment detection (§3, §4, §6, §7, §8, §9)

The heart of it. Once there's a timestamped transcript, this is a language
problem rather than a video problem, which is the good news.

Approach: pass the transcript in overlapping windows to the model, ask it to
find self-contained moments with reasons, then a second pass to score, dedupe
semantically, and rank. Visual checks only on the sections that survive — which
is what keeps §23's cost control honest.

The music-specific intelligence in §4 belongs in a craft file like the caption
rules: readable, arguable, testable, not buried in a prompt.

### 3c. Precise cutting (§5, §6)

Word-level timings already exist, so sentence boundaries and pauses are
available. Cutting on them rather than on round numbers is straightforward.
Re-encoding each clip from the source is the accurate route; stream-copy is
faster but only cuts on keyframes, which is how clips end up starting
mid-syllable.

### 3d. A review surface (§12, §13, §19)

Telegram can carry the list with buttons and send each clip as a video. What it
cannot do well is the sortable dashboard in §12–13.

Two options:
- **Telegram only** — quicker, works on a phone, fits what's built. Sorting
  becomes commands rather than columns.
- **A web page on the existing Express app** — matches §12 properly, needs
  authentication, more work.

I'd start with Telegram and add the page if the list gets unwieldy. This is your
call.

### 3e. Learning from decisions (§20)

Every select, reject and publish recorded, then fed back as examples — "clips he
kept looked like this" — rather than as a rule. Cheap to store, only useful
after a few dozen decisions, so it should be built early and consulted late.

---

## 4. What the brief asks for that I can't fully deliver

Stated plainly rather than discovered later.

**Dynamic crop following speakers (§15).** Per-clip reframing works today. Crop
that *moves* to follow whoever is talking needs face detection on every frame —
a real ML dependency, heavy on CPU, and Railway is not a good place for it. I'd
do per-clip static reframing and be honest that this is the gap.

**Speaker detection (§2).** Scribe supports diarisation; it's a flag. It labels
"speaker 1/2", not names.

**YouTube ingestion (§1).** YouTube's official API does not provide downloads.
The practical tool is `yt-dlp`, which is against YouTube's terms of service even
for your own videos. Cleanest legitimate route: download from YouTube Studio,
put it in Drive, and the existing Drive pipeline takes it from there. I'd rather
say that than quietly ship something that breaks a platform's rules on your
behalf.

**Other platforms (§14).** Only Instagram exists. TikTok, YouTube Shorts,
Facebook and X are each a separate integration with their own approval process —
and you've just seen what one of those costs in an evening. The system can
*recommend* platforms per clip immediately; publishing to them is later work.

**"Audio quality" and "copyright-sensitive material" scoring (§8, §7).** Loudness
and clipping are measurable with ffmpeg. Judging whether music is
copyright-sensitive is not something I can do reliably, and a confident wrong
answer there is worse than no answer. I'd drop that criterion.

---

## 5. Dependencies and services

**New npm packages: none.** Everything needed is already there or is ffmpeg,
which is in the image.

**Services:** ElevenLabs (already chosen, pay-as-you-go) and Anthropic (already
in use). No new accounts.

**Infrastructure:** the volume. That's the whole list.

---

## 6. What it costs to run

Per one-hour video:

| | Cost |
|---|---|
| Transcription | $0.22 |
| Moment detection (transcript, ~2 passes) | $0.15–0.40 |
| Visual checks on surviving candidates | $0.05–0.15 |
| Titles, hooks, captions | $0.05 |
| **Per video** | **roughly $0.50–0.80** |

Four long videos a month is about $3. It fits inside the existing budget brake,
which will stop it if it doesn't.

Railway CPU time for rendering is the other cost and is harder to predict —
cutting and re-encoding eight clips from an hour-long source is real work.

---

## 7. Build order

Each step is usable on its own, which matters: if you stop after step 3 you
still have something better than today.

1. **Volume** — yours, not mine. Nothing runs without it.
2. **`SourceVideo` and `Clip` tables, status machine, resumable worker.** No
   intelligence yet; proves long videos survive a deploy.
3. **Transcribe a long video and store timestamped segments.** First point it
   does something you couldn't do before.
4. **Moment detection and scoring.** The actual feature. Testable against a
   transcript with no video at all, which makes it cheap to iterate on.
5. **Cutting on sentence boundaries** — reuses everything in `video/`.
6. **Telegram review: ranked list, previews, select and reject.**
7. **Titles, hooks, captions per clip** — reuses `content/craft.ts`.
8. **Feed selected clips into the existing approval and publishing flow.** No
   new publishing code; it becomes a `propose_social_post` with an asset.
9. **Decision tracking**, built early, consulted once there's enough of it.
10. **Platform recommendation**, then adapters if and when you want them.

---

## 8. Progress

| Step | State |
|---|---|
| 1. Volume at 5GB | Done — yours |
| 2. Tables, status machine, resumable worker | Done |
| 3. Transcribe a long video, store segments | Done |
| 4. Moment detection, scoring, dedupe, ranking | Done |
| 5. Cutting on sentence boundaries | Done |
| 6. Telegram review — list, previews, select, reject | Done |
| 7. Titles, hooks, captions per clip | Next |
| 8. Selected clips into the publishing flow | Next |
| 9. Decision tracking | Recording now, not yet read |
| 10. Platform recommendation | Done — per clip, from the ranking pass |

### Answered

- Volume: grown to 5GB.
- Review surface: Telegram.
- YouTube: export from Studio into Drive, no automated downloading.

## 9. Original questions

1. **Grow the volume to 5GB** (or tell me the plan won't allow it).
2. **Telegram-only review, or a web dashboard too?** Recommend Telegram first.
3. **Confirm the YouTube position** — Studio export into Drive, rather than
   automated downloading.

Answer those three and I'll start at step 2.
