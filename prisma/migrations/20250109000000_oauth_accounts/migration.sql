DO $$ BEGIN
  CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "OAuthAccount" (
  "id"           TEXT NOT NULL,
  "provider"     "OAuthProvider" NOT NULL,
  "accountEmail" TEXT,
  "accessToken"  TEXT NOT NULL,
  "refreshToken" TEXT,
  "expiresAt"    TIMESTAMP(3),
  "scopes"       TEXT[] DEFAULT ARRAY[]::TEXT[],
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "connectedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OAuthAccount_provider_key" ON "OAuthAccount"("provider");
