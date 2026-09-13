# Video + social content system — implementation plan

Response to the content-assistant spec. Section 27 of that spec asks for an audit
and a plan before major code; this is it.

---

## 1. What already exists

Much of the spec is built. Reuse rather than rewrite:

| Spec section | Status |
|---|---|
| §8 Approval states | **Built.** `Approval` + handler registry; nothing publishes without a button press |
| §10 Content library | **Built.** `Asset` with type, description, tags, status, source |
| §20 Publishing log | **Built.** `SocialPost` records platform, id, time, caption, failure reason |
| §22 Token encryption | **Built.** AES-256-GCM at rest, never logged |
| §24 No fake capabilities | **Built.** `DRY_RUN` defaults on; dry runs are labelled as such |
| §18 My voice | **Partly.** Brand Bible + standing rules exist; the knowledge base is thin |
| §9 Autonomous mode | **Partly.** `DRY_RUN` is the off switch; no per-rule autonomy |
| §6 Publishing | **Partly.** Instagram adapter built, pending Meta App Review |
| §12 Content intelligence | **No.** `/stats` reports own-data only; no platform metrics |
| §1–5, §15–17 Video | **No.** Nothing video exists |
| §22 OAuth | **No.** `/connect` pastes a token — contradicts the spec, see §4 below |

Current stack: Node 22 / TypeScript, Prisma + Postgres, Telegraf, Anthropic
(`claude-opus-5` / `claude-haiku-4-5`), local disk storage on a Railway volume,
Docker on `node:22-slim` (Debian bookworm, `apt` available).

---

## 2. The constraint that reshapes the whole video spec

**The Claude API accepts images and PDFs. It does not accept video or audio.**
Its published capability set is `image_input` and `pdf_input`; there is no video
input and no speech-to-text.

So "analyse the actual contents of a video" is real, but not by handing Claude an
MP4. It decomposes into:

```
video ──ffmpeg──> sampled frames ──> Claude vision ──> what is happening visually
      └─ffmpeg──> audio track ─────> ASR provider ──> transcript with timestamps
                                          └─────────> Claude ──> analysis, clips, captions
```

Frame sampling plus transcript gets most of what the spec describes. What it
cannot do is follow continuous motion — it sees stills, not movement. Worth
knowing before judging the output.

**Transcription needs a provider Claude doesn't supply.** Whisper, Deepgram and
AssemblyAI are the realistic options; all are paid, per-minute. This is a
decision only Asher can make, and it gates Phase 2.

---

## 3. Hard blockers, in the order they will bite

1. **Telegram bots cannot download files larger than 20MB.** This kills video
   upload through Telegram for anything beyond a short clip. A phone-shot minute
   of 4K is far past it. Intake therefore needs a different path — a signed
   upload page on the bot's own domain, or reading from cloud storage links.
   Nothing else in the video plan works until this is solved.
2. **Storage.** Video is two orders of magnitude larger than the photos in the
   library today. The Railway volume has a fixed size and the bill scales with
   it; object storage (R2/S3) is the honest answer before much video lands.
3. **Processing cost.** ffmpeg installs cleanly via `apt` in the existing
   Dockerfile, but transcoding and burning in subtitles are CPU-heavy. A
   ten-minute video is minutes of CPU, on a container also serving Telegram.
4. **Per-platform reality**, which the spec's §24 requires stating plainly:
   - **Instagram** — Reels publishing exists; blocked on the App Review already
     in flight.
   - **YouTube** — upload works; default quota is ~6 uploads/day.
   - **TikTok** — until the app passes audit, posts can only land as private
     drafts, not public.
   - **X** — meaningful write access is a paid tier.

---

## 4. OAuth

Spec §22 says never paste credentials. Today `/connect` does exactly that, which
was the fastest route to a working Instagram path but is the wrong end state.

Proper OAuth needs a redirect URL per platform, a callback route on the bot, and
refresh handling. The encryption and disconnect parts already exist. This is
worth doing once, shared across all four adapters — not four times.

---

## 5. Revised build order

The spec's phases are right. Reordered only where a dependency forces it.

| Phase | Work | Status / blocked by |
|---|---|---|
| **0** | Import Asher's knowledge base (below) | Not started — still the highest-value item |
| **1** | Video intake | **Done** — Google Drive, not an upload page |
| **2** | ffmpeg in the image; probe duration/dimensions | **Done** |
| **2b** | Vertical reframing (subject-aware crop, blurred fill) | **Done** — see `VIDEO_WORKFLOW.md` |
| **2c** | Reels publishing: REELS container, status polling, range-serving media | **Done** — gated on App Review |
| **3** | Audio extraction + transcription with timestamps | **ASR provider decision** (ElevenLabs Scribe at $0.22/hr is the current front-runner; Whisper self-hosted is free but slower and more to run) |
| **4** | Frame sampling → Claude vision → full video analysis | Partly done: frames are sampled for the reframe decision, but only to locate a subject, not to understand content |
| **5** | Clip identification: best moments, hooks, why | 3, 4 |
| **6** | Cutting between shots, burned-in subtitles | 2 — deliberately not built; CapCut does this free on a phone |
| **7** | Platform-specific caption generation | 5 |
| **8** | Extend the library + approval flow to video | **Done** |
| **9** | Shared OAuth layer | Partly done — Google OAuth built, Meta still uses a pasted token |
| **10** | YouTube adapter | 9 |
| **11** | TikTok adapter | 9, audit |
| **12** | X adapter | 9, paid tier |
| **13** | Platform analytics ingestion | 9 |
| **14** | Content intelligence over that data | 13 |

**What phase 2b does not do.** The reframe looks at six stills to find the
subject. It does not know what happens in the clip, what is said, or where the
good bit is — those need phase 3 and 4. Until then a caption for a video depends
on Asher saying what's in it.

**Phase 0 is new and should happen first.** Asher has written a detailed artist
knowledge base — heritage, genre, spirituality, voice rules, what never to say,
release facts. Right now there is no way to get it in: `/learn` takes a URL, and
the knowledge base holds 25 short facts. Every caption, post and newsletter the
system writes is worse until that document is loaded. It is an afternoon's work
and improves output across every feature already built.

---

## 6. What this will cost to run

Rough, monthly, at modest volume:

- Transcription: pennies per video-minute, provider-dependent
- Frame analysis: a few cents per video (each frame is an image)
- Clip encoding: CPU time on the existing container
- Object storage: pounds, not tens of pounds, until the library is large

The existing `AI_MONTHLY_BUDGET_USD` brake covers model spend but not storage or
ASR. Those need their own ceiling before Phase 3.
