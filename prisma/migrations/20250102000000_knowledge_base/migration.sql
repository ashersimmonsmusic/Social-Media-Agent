-- CreateEnum
CREATE TYPE "KnowledgeCategory" AS ENUM ('ARTIST_BIO', 'MUSIC_CATALOGUE', 'BRAND', 'PERSONAL_STORY', 'ACHIEVEMENTS', 'PRESS', 'LIVE_HISTORY', 'COLLABORATORS', 'BUSINESS', 'LINKS', 'IMPORTANT_FACTS');

-- CreateEnum
CREATE TYPE "KnowledgeConfidence" AS ENUM ('FACT', 'PREFERENCE', 'OPINION', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('WEBSITE', 'ASHER', 'DOCUMENT', 'MANUAL');

-- AlterEnum
ALTER TYPE "ApprovalType" ADD VALUE 'KNOWLEDGE_IMPORT';

-- CreateTable
CREATE TABLE "KnowledgeItem" (
    "id" TEXT NOT NULL,
    "category" "KnowledgeCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" "KnowledgeConfidence" NOT NULL DEFAULT 'UNCONFIRMED',
    "sourceType" "KnowledgeSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "sourceDetail" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeItem_category_isActive_idx" ON "KnowledgeItem"("category", "isActive");

