ALTER TYPE "SocialPostStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "SocialPostStatus" ADD VALUE IF NOT EXISTS 'PUBLISHING';

ALTER TABLE "SocialPost" ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SocialPost_status_scheduledFor_idx"
  ON "SocialPost"("status", "scheduledFor");
