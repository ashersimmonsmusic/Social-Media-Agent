-- Long-video analysis. Progress lives here rather than in memory because
-- analysing an hour of footage takes tens of minutes and must survive a deploy.
CREATE TYPE "SourceVideoStatus" AS ENUM (
  'QUEUED', 'DOWNLOADING', 'EXTRACTING_AUDIO', 'TRANSCRIBING',
  'ANALYSING', 'CUTTING', 'COMPLETE', 'FAILED'
);
CREATE TYPE "ClipDecision" AS ENUM ('PENDING', 'SELECTED', 'REJECTED');

CREATE TABLE "SourceVideo" (
  "id" TEXT NOT NULL,
  "driveFileId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "durationSeconds" DOUBLE PRECISION,
  "width" INTEGER,
  "height" INTEGER,
  "sizeBytes" BIGINT,
  "status" "SourceVideoStatus" NOT NULL DEFAULT 'QUEUED',
  "statusDetail" TEXT,
  "failureReason" TEXT,
  "transcript" JSONB,
  "transcriptText" TEXT,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SourceVideo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Clip" (
  "id" TEXT NOT NULL,
  "sourceVideoId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "startSeconds" DOUBLE PRECISION NOT NULL,
  "endSeconds" DOUBLE PRECISION NOT NULL,
  "transcript" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "scores" JSONB NOT NULL DEFAULT '{}',
  "rank" INTEGER NOT NULL,
  "topic" TEXT,
  "suggestedPlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "decision" "ClipDecision" NOT NULL DEFAULT 'PENDING',
  "decidedAt" TIMESTAMP(3),
  "assetId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourceVideo_driveFileId_key" ON "SourceVideo"("driveFileId");
CREATE INDEX "SourceVideo_status_createdAt_idx" ON "SourceVideo"("status", "createdAt");
CREATE INDEX "Clip_sourceVideoId_rank_idx" ON "Clip"("sourceVideoId", "rank");
CREATE INDEX "Clip_decision_idx" ON "Clip"("decision");

ALTER TABLE "Clip" ADD CONSTRAINT "Clip_sourceVideoId_fkey"
  FOREIGN KEY ("sourceVideoId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
