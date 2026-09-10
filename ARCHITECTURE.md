# ARCHITECTURE.md — Asher Simmons AI Artist & Social Media Agent

## 0. Repository state at start of this build

This repository was **completely empty** (no commits, no branches, no files) when this
build began. Everything described below is a greenfield design — there was no existing
stack, schema, or code to inspect or reuse. This document is written *before* the Phase 1
implementation, per the build brief's requirement to plan before coding.

Because the full brief (76 sections) describes a multi-year product, this document plans
the **whole system's shape** but only *implements* Phase 1 (Foundation). Every later phase
is designed for, not deferred out of the architecture — new modules slot into the same
patterns without rewriting Phase 1.

---

## 1. Product philosophy (drives every architectural choice)

- **Asher is the operator, the agent is the staff.** The system prepares, drafts, and
  recommends. It never publishes, sends, spends, or deletes anything real without an
  explicit, unambiguous approval action — never an inferred "sounds good".
- **Never invent facts.** Anything the AI outputs about Asher's life, career, achievements,
  credits, or relationships must trace back to stored, sourced knowledge. When it doesn't
  know, it says so.
- **Low cognitive load.** Asher has ADHD. Telegram is the primary surface: short messages,
  clear buttons, ranked priorities — not a dashboard he has to dig through.
- **Modular over monolithic.** Every external integration (social platform, email, AI
  provider, storage backend) sits behind a small interface so it can be swapped or added
  without touching business logic.
- **Build in phases.** Phase 1 only, in this pass. Nothing in Phase 2+ is implemented yet;
  where a Phase 1 module clearly anticipates a later phase (e.g. `Asset.campaignId` as a
  nullable FK to a `Campaign` table that doesn't exist yet), that's noted explicitly rather
  than silently deferred.

---

## 2. Technology stack (chosen for this greenfield repo)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (Node.js 22) | Type safety across a system with many entities and external contracts (Telegram payloads, AI responses, future platform APIs). |
| HTTP layer | Express | Thin, well understood, no framework magic to fight when the codebase grows across many future integrations. |
| Bot layer | [Telegraf](https://telegraf.js.org/) | Mature Telegram bot framework with first-class inline-keyboard/callback-query support, which the approval workflow depends on heavily. |
| ORM / DB | Prisma + PostgreSQL | Real relational schema (per brief §50), migrations, type-safe queries. Postgres is supported natively on Railway. |
| AI | Anthropic SDK (`@anthropic-ai/sdk`) behind an `AIProvider` interface | Brief §48 explicitly requires the system not be hard-coded to one model/provider. Claude is the default and only implemented provider in Phase 1; OpenAI or others can be added later behind the same interface. |
| File storage | Local disk in dev, behind a `StorageProvider` interface | Keeps Phase 1 dependency-free; an S3/R2 provider can be added later without touching callers. |
| Testing | Vitest | Fast, native ESM/TS support, minimal config. |
| Process manager / deploy | Railway (Node buildpack) or Docker | Matches brief §73; `Dockerfile` included as a portable fallback. |

No frontend/dashboard is built in Phase 1 — Telegram *is* the Phase 1 UI, per brief §3/§61.
A web dashboard (brief §25) is a Phase 2+/6 concern once there's data worth visualising.

---

## 3. High-level system architecture

```
                         ┌───────────────────────────────┐
                         │           Asher (user)         │
                         └───────────────┬────────────────┘
                                         │ Telegram
                                         ▼
                         ┌───────────────────────────────┐
                         │        Telegram Bot Layer      │
                         │  (telegraf: commands, uploads,  │
                         │   inline-keyboard approvals)    │
                         └───────────────┬────────────────┘
                                         │
                 ┌───────────────────────┼────────────────────────┐
                 ▼                       ▼                        ▼
       ┌─────────────────┐    ┌──────────────────┐      ┌───────────────────┐
       │ Ingestion Module │    │ Approval Module   │      │ AI Service Layer   │
       │ (classify files) │    │ (levels 1/2/3,     │      │ (provider-agnostic, │
       │                  │    │  audit trail)      │      │  model routing)     │
       └────────┬─────────┘    └────────┬───────────┘      └─────────┬──────────┘
                │                       │                            │
                ▼                       ▼                            ▼
       ┌─────────────────┐    ┌──────────────────┐      ┌───────────────────┐
       │ Content Library  │    │   Audit Log       │      │  Brand Bible        │
       │ (Asset module)   │    │   (every external  │      │  (voice/visual rules,│
       │                  │    │    action recorded)│      │   compliance checks) │
       └────────┬─────────┘    └────────┬───────────┘      └─────────┬──────────┘
                 └───────────────────────┴──────────────────────────┘
                                         │
                                         ▼
                         ┌───────────────────────────────┐
                         │        PostgreSQL (Prisma)     │
                         └───────────────────────────────┘

Future phases attach here without changing the above:
  Social adapters (Instagram/TikTok/YouTube/X/…) ── behind SocialPlatform interface
  Outreach/Email adapters                        ── behind OutreachChannel interface
  Music/Campaign/Contact CRM modules              ── new Prisma models + modules
  Analytics ingestion + Content Intelligence      ── new module reading SocialPost stats
```

### Module layout (implemented in Phase 1)

```
/src
  index.ts                    Express app + Telegraf bot bootstrap
  config/env.ts                Typed environment loader/validator
  db/prisma.ts                 Prisma client singleton
  lib/logger.ts                Structured logger

  ai/
    types.ts                   AIProvider interface, TaskType enum
    ClaudeProvider.ts           Anthropic implementation
    AIService.ts                Routing (strategy/fast/vision) + usage logging + dry-run awareness

  storage/
    types.ts                   StorageProvider interface
    LocalStorageProvider.ts      Dev-mode disk storage

  modules/
    assets/                    Content Library (ingestion, classification, CRUD, search)
    brand/                     Brand Bible (profile, rules, compliance check stub)
    approvals/                 Approval levels, lifecycle, Telegram rendering
    audit/                     Audit log writer + query helpers
    ideas/                     ContentIdea CRUD (minimal, feeds "what should I post" later)

  telegram/
    bot.ts                      Telegraf instance, allowlist middleware
    commands/                   /start, /whatsimportant (stub), /brand, text + upload handlers
    approvals.render.ts          Renders Approval records as Telegram messages + buttons
    callbacks.ts                 Handles inline button presses → approval.service

  http/
    router.ts                   Health check + (future) webhook endpoints

/prisma/schema.prisma
/tests/                          Vitest specs
```

---

## 4. Data model (Phase 1)

Design principle from brief §50: proper relational entities, not one unstructured table.
Below is Phase 1's schema. Nullable foreign keys to not-yet-built tables (e.g.
`Asset.campaignId`) are intentionally omitted rather than stubbed with dangling references
— they'll be added as real FKs when Phase 2/5 introduce `Campaign`.

- **User** — a human operator. Phase 1 has exactly one real user (Asher), modelled properly
  so multi-user (e.g. a future manager/assistant login) isn't a rewrite. Fields: `id`,
  `telegramChatId` (unique, the allowlisted chat), `email`, `name`, `role`
  (`ARTIST`/`ADMIN`), timestamps.
- **BrandProfile** — the singleton Brand Bible root: `colors` (json), `visualMotifs` (json),
  `voice` (json: tone, words used/avoided, humour, profanity policy, spiritual-language
  policy, caption-length preference), `identityBoundaries` (json — e.g. "spirituality yes,
  'Christian' label no"), `importedFrom` (raw brand-book text/source), timestamps.
- **BrandRule** — individual, atomic rules extracted from the brand book or learned from
  Asher's corrections over time. Fields: `category` (`VISUAL`/`VOICE`/`SAFETY`), `kind`
  (`FACT`/`PREFERENCE`/`OPINION`/`ONE_TIME_EDIT`/`PERMANENT_PREFERENCE`/`UNCONFIRMED`) —
  directly implements brief §40/§42's fact-vs-preference distinction — `description`,
  `source` (`BRAND_BOOK_IMPORT`/`ASHER_CORRECTION`/`MANUAL`), `isActive`, `relatedRuleId`
  (self-relation, so a one-time edit later confirmed as permanent links to its origin).
- **Asset** — the Content Library entry (brief §6). Fields: `filename`, `storageKey`,
  `mimeType`, `assetType` (`PHOTO`/`VIDEO`/`AUDIO`/`MUSIC`/`DOCUMENT`/`TEXT`/`URL`/`OTHER` —
  auto-classified on ingestion per brief §5), `description`, `tags` (string[]), `status`
  (`UNPROCESSED`/`PROCESSED`/`PUBLISHED`/`ARCHIVED`), `source`, `sourceUrl`, `rawTextContent`
  (for quotes/lyrics/text drops), `metadata` (json — extracted EXIF/ID3/etc, extensible),
  `usageRights`, timestamps. Deliberately has **no** `campaignId`/`releaseId` FK yet (those
  tables don't exist until Phase 2/5); a future migration adds them.
- **ContentIdea** — lightweight backlog entry (brief §64): `title`, `description`,
  `sourceAssetId` (optional FK to `Asset`), `pillar` (string, matches configurable content
  pillars from brief §9), `status` (`NEW`/`DRAFTED`/`USED`/`DISCARDED`).
- **Approval** — the generic approval envelope (brief §2/§4), used by every future action
  type (social post, outreach, spend, etc. — the `type`/`level` fields, not new tables, are
  how new approval types are added). Fields: `type` (`GENERIC` in Phase 1; `SOCIAL_POST`,
  `OUTREACH`, etc. reserved for later phases), `level` (`1`/`2`/`3`), `status`
  (`PENDING`/`APPROVED`/`REJECTED`/`EDITED`/`EXPIRED`/`CANCELLED`), `payload` (json — the
  draft content being approved), `telegramChatId`, `telegramMessageId` (so button presses
  can edit the original message), `requestedAt`, `resolvedAt`, `resolvedBy`.
- **AuditLog** — append-only record of every external/important action (brief §44):
  `action`, `entityType`, `entityId`, `actorType` (`AI`/`ASHER`/`SYSTEM`), `actorId`,
  `details` (json), `createdAt`. Indexed on `entityType`+`entityId` for search (brief §51).
- **AIConversation** — rolling Telegram chat memory per chat: `telegramChatId`, `role`
  (`user`/`assistant`), `content`, `createdAt`. Deliberately simple in Phase 1 (no vector
  store yet) — enough for short-term context, not a full knowledge base (that's §40, later).
- **AIUsageLog** — cost control groundwork (brief §49): `provider`, `model`, `taskType`,
  `promptTokens`, `completionTokens`, `estimatedCostUsd`, `createdAt`.

All models use cuid primary keys, `createdAt`/`updatedAt` timestamps, and live in one
`schema.prisma` with explicit relations — see file for exact types.

### Entities deliberately deferred (named here so later phases attach cleanly)

`Campaign`, `MusicRelease`/`Track`, `Contact`/`ContactPermission`, `Outreach`,
`Opportunity`, `SocialAccount`/`SocialPost`, `PressRelease`, `EPK`, `Notification`,
`AIInstruction` (beyond `BrandRule`). These map 1:1 onto brief §50 and get added as their
owning phase is built, per §70.

---

## 5. AI architecture

```
AIService
  .generate(taskType, prompt, opts)         → routes to a model tier
  .analyzeImage(taskType, imageRef, opts)     → vision-tier call (Phase 2+, interface only)
  .transcribe(audioRef)                       → audio-tier call (Phase 2+, interface only)
  every call → AIUsageLog row (provider, model, tokens, estimated cost)

AIProvider (interface)
  └── ClaudeProvider   (Phase 1: implemented)
  └── OpenAIProvider   (later: same interface, not built yet)
```

- **Model routing** (brief §48): `TaskType` enum (`STRATEGY`, `CAPTION`, `CLASSIFY`,
  `VISION`, `TRANSCRIBE`, `CHAT`) maps to a model tier in config (`AI_MODEL_STRATEGY`,
  `AI_MODEL_FAST`, `AI_MODEL_VISION`). Phase 1 wires `STRATEGY`/`CHAT` → the strategy model
  and `CAPTION`/`CLASSIFY` → the fast model; vision/transcription are stubbed (interface
  present, throws `NotImplemented` until Phase 2 wires real image/audio input).
- **Cost control** (brief §49): every provider call is wrapped by `AIService`, which logs
  actual token usage and a computed estimated cost to `AIUsageLog`. A monthly-budget check
  and caching layer are noted as Phase 2+ (not built yet — Phase 1 just guarantees every
  call is *recorded*, which is the prerequisite for budgeting).
- **Never invent facts** (brief §41/§65): every prompt built by a Phase 1 feature (caption
  drafting) is required to pass only *known* structured data (Asset metadata, BrandProfile,
  explicit user text) into the prompt, plus a standing system instruction that the model
  must say "I don't have that information" rather than fabricate biography, achievements,
  or relationships. This is a prompting/system-instruction discipline enforced in
  `AIService`, not something an LLM can be perfectly guaranteed to obey — flagged as a
  known limitation below.

---

## 6. Integration architecture (social/outreach — designed now, built later)

Per brief §16/§47, every external platform sits behind the same adapter shape so adding
one later never touches business logic:

```ts
interface SocialPlatformAdapter {
  authenticate(): Promise<void>;
  validate(post: DraftPost): Promise<ValidationResult>;
  createDraft(post: DraftPost): Promise<PlatformDraftRef>;
  publish(post: DraftPost): Promise<PublishResult>;
  schedule(post: DraftPost, at: Date): Promise<ScheduleResult>;
  getAnalytics(postRef: PlatformDraftRef): Promise<AnalyticsSnapshot>;
  handleWebhook(payload: unknown): Promise<void>;
  disconnect(): Promise<void>;
}
```

None of `InstagramAdapter`/`TikTokAdapter`/`YouTubeAdapter`/`XAdapter`/`LinkedInAdapter` are
implemented in Phase 1 (that's Phase 3) — the interface is documented here so Phase 3 has a
contract to build against and so Phase 1's `Approval` payload shape (§4) already anticipates
carrying a `DraftPost`-shaped object for `type: SOCIAL_POST`.

**Dry Run Mode** (brief §46): a `DRY_RUN` env flag is read by `config/env.ts` and exposed as
`config.dryRun`. No Phase 1 module performs a real external action yet, so nothing branches
on it today — but every future adapter's `publish`/`schedule`/outreach-send method is
required to check it first and, when true, write an `AuditLog` entry describing what *would*
have happened instead of calling the real API. This is a hard rule for all future phases,
stated here so it isn't skipped later under time pressure.

---

## 7. Security model

- **Secrets**: all credentials (Telegram bot token, Anthropic API key, DB URL, future
  platform tokens) live only in environment variables, never in source. `.env` is
  git-ignored; `.env.example` documents every variable with no real values.
- **Telegram allowlist**: the bot only responds to `TELEGRAM_ALLOWED_CHAT_ID` (Asher's
  chat). Every update from any other chat is logged and dropped — this is the entire
  authentication model for Phase 1 (there is no web login surface yet, so there's nothing
  else to authenticate against). An `ADMIN_API_KEY` guards the health/internal HTTP routes.
- **Webhook verification**: if Telegram is run in webhook mode (vs. long-polling), the
  secret-token header Telegram sends is verified before any update is processed.
- **Input validation**: uploaded file mimetypes/sizes are checked before ingestion;
  Prisma's parameterised queries prevent SQL injection by construction; no raw SQL is used.
- **Rate limiting**: a basic per-chat rate limit on the Telegram bot prevents runaway usage
  (and runaway AI cost) from a compromised or misbehaving client.
- **Audit log**: every approval decision and every module action that touches external
  state (once built) writes an `AuditLog` row — see §4/§8.
- **Encryption**: Postgres connections use TLS in production (Railway default); no
  additional at-rest encryption is implemented in Phase 1 beyond the DB provider's own
  (this is a known limitation — see §12).

---

## 8. Approval model

Three levels, implemented as a single generic `Approval` entity (not three tables) so new
action types (outreach, spend, deletion) just pick a `level`/`type` rather than needing new
schema:

- **Level 1 — Automatic**: no `Approval` row created. Modules just run (e.g. classify an
  upload, draft a caption, extract metadata) and write an `AuditLog` row with
  `actorType: AI` so the action is still visible/searchable, just not blocking.
- **Level 2 — Approval required**: module creates an `Approval` row (`status: PENDING`),
  renders it to Telegram with an inline keyboard (`APPROVE`/`EDIT`/`REGENERATE`/`REJECT`,
  matching brief §4's mockups). A button press is a callback query carrying the `Approval`
  id; the handler updates `status`, writes `AuditLog` (`actorType: ASHER`), and only *then*
  is the underlying action allowed to proceed (in Phase 1, nothing yet performs a real
  external action on approval — Phase 3+ modules will call the adapter here).
- **Level 3 — Explicit confirmation**: same `Approval` flow, but the rendered message and
  the button are distinguished (`CONFIRM SEND £X` style, not a bare `APPROVE`) and a second,
  differently-worded button is required — never a free-text "yes"/"looks good". The bot
  explicitly does not treat freeform replies as approval for any `Approval` row, at any
  level; only a button press against that specific message resolves it. This is enforced in
  `callbacks.ts`, not left to prompt-level judgement.

---

## 9. Development phases

Phase 1 is implemented in this pass. Phases 2–7 are designed for (interfaces/schema notes
above) but not built — building everything at once was explicitly ruled out by the brief.

1. **Foundation** *(this build)* — project architecture, database, Telegram integration,
   file ingestion, content library, Brand Bible, AI service abstraction, approval system,
   audit logs.
2. **Content Engine** — caption generator (multi-option, per-platform), content ideation,
   repurposing engine, typography/quote-art generator, content calendar, richer asset
   management (crops, thumbnails).
3. **Social** — Instagram/Facebook/YouTube/TikTok/X adapters, scheduling, publishing,
   analytics ingestion. Built against the `SocialPlatformAdapter` interface from §6.
4. **Music Industry CRM** — Contact/ContactPermission/Outreach models, follow-up sequences,
   EPK, press/radio/playlist pitching.
5. **Campaign Manager** — Campaign/CampaignTask/MusicRelease/Track models, release timelines,
   campaign memory, analytics-informed recommendations.
6. **Business Intelligence** — Opportunity database, funding/sync/live tracking, revenue
   opportunity engine, weekly management report.
7. **Advanced AI** — predictive recommendations, content-performance learning loop,
   relationship intelligence, automated campaign optimisation.

---

## 10. Environment variables

All documented (with no real values) in `.env.example`. Summary:

| Variable | Required in Phase 1 | Purpose |
|---|---|---|
| `NODE_ENV` | yes | `development` / `production` |
| `PORT` | yes | HTTP server port (health check + future webhooks) |
| `DATABASE_URL` | yes | Postgres connection string (Prisma) |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | yes | Asher's Telegram chat id — the entire auth model |
| `TELEGRAM_WEBHOOK_SECRET` | only if using webhook mode | Verifies incoming Telegram webhook requests |
| `TELEGRAM_USE_WEBHOOK` | no (default: long-polling) | `true` to run webhook mode instead of polling |
| `PUBLIC_BASE_URL` | only if using webhook mode | Public URL Telegram posts webhooks to |
| `ANTHROPIC_API_KEY` | yes | Claude API access |
| `AI_MODEL_STRATEGY` | no (has default) | Claude model id for strategy/chat tasks |
| `AI_MODEL_FAST` | no (has default) | Claude model id for caption/classification tasks |
| `ADMIN_API_KEY` | yes | Guards internal HTTP routes |
| `STORAGE_DRIVER` | no (default: `local`) | `local` in Phase 1; reserved values for future S3/R2 |
| `STORAGE_LOCAL_PATH` | no (default: `./uploads`) | Where local storage keeps files in dev |
| `DRY_RUN` | no (default: `true`) | When true, no future integration performs real external actions |
| `AI_MONTHLY_BUDGET_USD` | no | Reserved for Phase 2 budget alerts; recorded but not enforced yet |

---

## 11. Deployment architecture

- **Dev**: `npm run dev` (ts-node-dev/tsx) against a local/dev Postgres (docker-compose
  provided) and long-polling Telegram (no public URL needed).
- **Staging/Production**: Railway. `DATABASE_URL` provided by a Railway Postgres plugin;
  `PUBLIC_BASE_URL` set to the Railway domain if webhook mode is used; secrets set via
  Railway's environment variable UI, never committed. A `Dockerfile` is included so the same
  image can run on any container platform if Railway isn't the final choice.
- **Migrations**: `prisma migrate deploy` runs as a release step before the app boots.
- **Environments are separated**: `.env` (dev, git-ignored) vs. Railway environment
  variables (staging/prod) — production credentials are never used locally, per brief §73.

---

## 12. APIs/credentials needed, legal limitations, and what's out of scope for Phase 1

**Needed now (Phase 1):**
- A Telegram bot token (@BotFather) + Asher's numeric chat id.
- An Anthropic API key.
- A Postgres database (local Docker for dev; Railway plugin for prod).

**Needed later, not requested yet (documented so Asher can plan ahead):**
- Instagram/Facebook: Meta Graph API app review + a connected Facebook Page/Instagram
  Business account (Phase 3). Meta's API does not support personal Instagram accounts or
  arbitrary DM automation — outreach via Instagram DM has real platform restrictions;
  the compliant alternative is Graph API messaging within Meta's allowed use cases only.
- TikTok: Content Posting API requires app review and has stricter scopes for unaudited
  apps (e.g. draft-only upload until audited). Phase 3 will target the compliant tier first.
- YouTube: Data API v3, OAuth consent screen verification for public use, daily quota limits.
- X (Twitter): API v2 posting requires a paid tier for meaningful volume — a real cost
  decision for Asher, flagged rather than assumed.
- LinkedIn: Marketing API access is gated by partnership approval for most use cases —
  likely the last platform to become available, or may stay manual.
- Email/newsletter: any real sending needs a transactional provider (e.g. Postmark/SES) and
  domain authentication (SPF/DKIM) to avoid spam-folder delivery — not just an API key.
- None of these are implemented in Phase 1. No fabricated adapters or placeholder "fake
  success" behaviour exists anywhere in this codebase — an unimplemented integration says so.

**Explicitly out of scope / cannot be automated:**
- Scraping platforms that lack an official API for the needed action (brief §16 rules this
  out on principle, not just difficulty).
- Automatically applying to opportunities, sending outreach, spending money, or publishing
  without a human approval action (brief §2 Level 3) — no code path exists for this and none
  should ever be added.
- Guaranteeing an LLM never fabricates — this is mitigated (grounded prompting, explicit
  "say you don't know" system instructions, brand-compliance flagging before publish) but
  not something software can make impossible. Flagged as an ongoing risk to review, not
  solved.

---

## 13. MVP (Phase 1) vs. later

**Built in this pass:** project scaffold, Postgres schema, Telegram bot (allowlisted,
long-polling by default), file upload → automatic content-type classification → Content
Library entry, Brand Bible storage + a basic compliance-check stub, generic Approval
lifecycle with Telegram inline-keyboard rendering, append-only Audit Log, AI service
abstraction with a working Claude-backed caption-draft feature (Level 1, automatic) as the
first real end-to-end AI capability, usage logging for cost tracking.

**Not built yet (by design):** any real social publishing, any real outreach sending, the
music/campaign/contact CRM, opportunity tracking, analytics ingestion, the weekly report,
the web dashboard, typography/image generation, vision/audio AI calls. These are Phases 2–7.
