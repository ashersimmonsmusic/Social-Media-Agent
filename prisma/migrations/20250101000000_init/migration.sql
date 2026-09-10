-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ARTIST', 'ADMIN');

-- CreateEnum
CREATE TYPE "BrandRuleCategory" AS ENUM ('VISUAL', 'VOICE', 'SAFETY');

-- CreateEnum
CREATE TYPE "BrandRuleKind" AS ENUM ('FACT', 'PREFERENCE', 'OPINION', 'ONE_TIME_EDIT', 'PERMANENT_PREFERENCE', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "BrandRuleSource" AS ENUM ('BRAND_BOOK_IMPORT', 'ASHER_CORRECTION', 'MANUAL');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'MUSIC', 'DOCUMENT', 'TEXT', 'URL', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('UNPROCESSED', 'PROCESSED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentIdeaStatus" AS ENUM ('NEW', 'DRAFTED', 'USED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('GENERIC', 'SOCIAL_POST', 'OUTREACH');

-- CreateEnum
CREATE TYPE "ApprovalLevel" AS ENUM ('LEVEL_1', 'LEVEL_2', 'LEVEL_3');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EDITED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('AI', 'ASHER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AIMessageRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramChatId" TEXT,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ARTIST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Asher Simmons',
    "colors" JSONB NOT NULL DEFAULT '{}',
    "visualMotifs" JSONB NOT NULL DEFAULT '{}',
    "voice" JSONB NOT NULL DEFAULT '{}',
    "identityBoundaries" JSONB NOT NULL DEFAULT '{}',
    "importedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandRule" (
    "id" TEXT NOT NULL,
    "brandProfileId" TEXT NOT NULL,
    "category" "BrandRuleCategory" NOT NULL,
    "kind" "BrandRuleKind" NOT NULL,
    "description" TEXT NOT NULL,
    "source" "BrandRuleSource" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "relatedRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "assetType" "AssetType" NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AssetStatus" NOT NULL DEFAULT 'UNPROCESSED',
    "source" TEXT,
    "sourceUrl" TEXT,
    "rawTextContent" TEXT,
    "usageRights" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIdea" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "pillar" TEXT,
    "status" "ContentIdeaStatus" NOT NULL DEFAULT 'NEW',
    "sourceAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "type" "ApprovalType" NOT NULL DEFAULT 'GENERIC',
    "level" "ApprovalLevel" NOT NULL DEFAULT 'LEVEL_2',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "telegramChatId" TEXT,
    "telegramMessageId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIConversation" (
    "id" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "role" "AIMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsageLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "BrandRule_brandProfileId_category_isActive_idx" ON "BrandRule"("brandProfileId", "category", "isActive");

-- CreateIndex
CREATE INDEX "Asset_assetType_status_idx" ON "Asset"("assetType", "status");

-- CreateIndex
CREATE INDEX "ContentIdea_status_pillar_idx" ON "ContentIdea"("status", "pillar");

-- CreateIndex
CREATE INDEX "Approval_status_type_idx" ON "Approval"("status", "type");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AIConversation_telegramChatId_createdAt_idx" ON "AIConversation"("telegramChatId", "createdAt");

-- CreateIndex
CREATE INDEX "AIUsageLog_createdAt_idx" ON "AIUsageLog"("createdAt");

-- AddForeignKey
ALTER TABLE "BrandRule" ADD CONSTRAINT "BrandRule_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRule" ADD CONSTRAINT "BrandRule_relatedRuleId_fkey" FOREIGN KEY ("relatedRuleId") REFERENCES "BrandRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

