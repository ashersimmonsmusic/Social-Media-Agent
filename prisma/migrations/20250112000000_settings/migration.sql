-- Small pieces of state set from Telegram that have to survive a redeploy.
CREATE TABLE "Setting" (
  "key"       TEXT NOT NULL,
  "value"     JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
