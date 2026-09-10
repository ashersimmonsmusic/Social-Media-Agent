-- Social accounts & posting (ARCHITECTURE.md §6)

DO $$ BEGIN
  CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'X', 'TIKTOK', 'YOUTUBE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'PUBLISHED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "SocialAccount" (
  "id"                TEXT NOT NULL,
  "platform"          "SocialPlatform" NOT NULL,
  "platformAccountId" TEXT NOT NULL,
  "username"          TEXT,
  "accessToken"       TEXT NOT NULL,
  "tokenExpiresAt"    TIMESTAMP(3),
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "connectedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialAccount_platform_platformAccountId_key"
  ON "SocialAccount"("platform", "platformAccountId");
CREATE INDEX IF NOT EXISTS "SocialAccount_platform_isActive_idx"
  ON "SocialAccount"("platform", "isActive");

CREATE TABLE IF NOT EXISTS "SocialPost" (
  "id"              TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "caption"         TEXT NOT NULL,
  "assetId"         TEXT,
  "status"          "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
  "platformPostId"  TEXT,
  "publishedAt"     TIMESTAMP(3),
  "failureReason"   TEXT,
  "dryRun"          BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SocialPost_status_createdAt_idx" ON "SocialPost"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_socialAccountId_fkey"
    FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
