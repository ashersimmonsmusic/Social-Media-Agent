-- AlterEnum: agent-proposed behavior rules need their own category so they are
-- loaded into the conversation system prompt separately from visual/voice rules.
ALTER TYPE "BrandRuleCategory" ADD VALUE IF NOT EXISTS 'BEHAVIOR';

-- AlterEnum: track that a rule was proposed by the agent (as opposed to manually
-- entered or imported from a brand book) so the audit trail is unambiguous.
ALTER TYPE "BrandRuleSource" ADD VALUE IF NOT EXISTS 'AGENT_PROPOSED';

-- AlterEnum: dedicated approval type so the action handler can find and store
-- behavior rules without inspecting payload shape.
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'BEHAVIOR_RULE';
