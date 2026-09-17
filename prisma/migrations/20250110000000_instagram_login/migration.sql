-- Instagram publishes through two different APIs with different hosts, and a
-- stored token gives no clue which it belongs to. Existing rows are Page tokens
-- from the Facebook Login flow, so that is the default.
CREATE TYPE "SocialAuthType" AS ENUM ('FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN');

ALTER TABLE "SocialAccount"
  ADD COLUMN "refreshToken" TEXT,
  ADD COLUMN "authType" "SocialAuthType" NOT NULL DEFAULT 'FACEBOOK_LOGIN';
