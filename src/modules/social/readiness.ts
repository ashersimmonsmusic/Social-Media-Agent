import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";

const run = promisify(execFile);

/**
 * Whether a post can actually reach Instagram, and what stops it if not.
 *
 * Posting depends on four things kept in four different places — a row in the
 * database, two Railway variables, and a permission granted by Meta — and a
 * missing one only shows up as a failure at the moment of publishing, phrased
 * in whichever system noticed. This asks all of them at once, before he has
 * spent any effort on a post.
 */

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  /** What to do about it. Empty when the check passed. */
  remedy?: string;
}

export interface Readiness {
  /** True when a post would genuinely leave the server. */
  canPost: boolean;
  dryRun: boolean;
  checks: ReadinessCheck[];
  /** Video needs more than a photo does; reported separately so it can't block a photo. */
  videoChecks: ReadinessCheck[];
}

/**
 * Whether ffprobe is installed, asked once.
 *
 * It cannot change while the process is running — it is either in the image or
 * it isn't — so spawning it on every check buys nothing and makes an otherwise
 * instant command wait on process startup.
 */
let ffmpegPresent: boolean | null = null;

async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegPresent !== null) return ffmpegPresent;
  try {
    await run("ffprobe", ["-version"], { timeout: 10_000 });
    ffmpegPresent = true;
  } catch {
    ffmpegPresent = false;
  }
  return ffmpegPresent;
}

/** Exposed so a test starts from a known state. */
export function resetToolCheck() {
  ffmpegPresent = null;
}

/** Confirms Meta still accepts the stored token, which nothing else reveals until publish time. */
async function tokenWorks(platformAccountId: string, accessToken: string): Promise<{ ok: boolean; detail?: string }> {
  const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${platformAccountId}`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url);
    const json = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) return { ok: false, detail: json.error?.message ?? `HTTP ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkPostingReadiness(): Promise<Readiness> {
  const checks: ReadinessCheck[] = [];

  const account = await prisma.socialAccount.findFirst({ where: { platform: "INSTAGRAM", isActive: true } });
  checks.push({
    name: "Instagram account linked",
    ok: Boolean(account),
    remedy: account ? undefined : "Run /connect with your Instagram business account id and token.",
  });

  const hasKey = Boolean(env.SOCIAL_TOKEN_KEY);
  checks.push({
    name: "Token encryption key set",
    ok: hasKey,
    remedy: hasKey ? undefined : "Set SOCIAL_TOKEN_KEY in Railway — without it I can't read the stored token.",
  });

  const hasBaseUrl = Boolean(env.PUBLIC_BASE_URL);
  checks.push({
    name: "Public address set",
    ok: hasBaseUrl,
    // The one that fails silently: Instagram fetches media over the internet,
    // so with no address there is no link to give it and no post can carry one.
    remedy: hasBaseUrl
      ? undefined
      : "Set PUBLIC_BASE_URL in Railway. Instagram fetches photos and video from a link, and I can't build one without it.",
  });

  if (account && hasKey) {
    let live: { ok: boolean; detail?: string };
    try {
      live = await tokenWorks(account.platformAccountId, decryptToken(account.accessToken));
    } catch (error) {
      live = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    checks.push({
      name: "Instagram still accepts my token",
      ok: live.ok,
      remedy: live.ok ? undefined : `Meta said: ${live.detail}. Reconnect with /connect if the token has expired.`,
    });
  }

  const hasFfmpeg = await ffmpegAvailable();
  const videoChecks: ReadinessCheck[] = [
    {
      name: "Video tools installed",
      ok: hasFfmpeg,
      remedy: hasFfmpeg ? undefined : "ffmpeg is missing from the deployment — /reel can't work without it.",
    },
  ];

  return {
    canPost: checks.every((check) => check.ok) && !env.DRY_RUN,
    dryRun: env.DRY_RUN,
    checks,
    videoChecks,
  };
}

export function formatReadiness(readiness: Readiness): string {
  const lines = ["CAN I POST?", ""];

  for (const check of readiness.checks) {
    lines.push(`${check.ok ? "✅" : "❌"} ${check.name}`);
    if (check.remedy) lines.push(`   ${check.remedy}`);
  }

  lines.push("", "For video:");
  for (const check of readiness.videoChecks) {
    lines.push(`${check.ok ? "✅" : "❌"} ${check.name}`);
    if (check.remedy) lines.push(`   ${check.remedy}`);
  }

  lines.push("");
  const blocked = readiness.checks.filter((check) => !check.ok);

  if (blocked.length > 0) {
    lines.push(`Not ready — ${blocked.length} thing${blocked.length === 1 ? "" : "s"} above to fix first.`);
  } else if (readiness.dryRun) {
    lines.push(
      "Everything's set up, but DRY_RUN is ON — I'll go through the whole process and stop short of posting, " +
        "recording what I would have sent. Set DRY_RUN=false in Railway when you want it live.",
    );
  } else {
    lines.push("Ready. An approved post goes to Instagram for real.");
  }

  // Said plainly because it is the one blocker nothing here can detect: Meta
  // grants the permission, and it only surfaces as a refusal at publish time.
  lines.push(
    "",
    "One thing I can't check from here: whether Meta has approved instagram_content_publish for your app. " +
      "Until they have, publishing is refused no matter what the list above says. " +
      "Check App Review in the Meta developer console.",
  );

  return lines.join("\n");
}
