import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SocialAuthType } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { diskReport } from "../video/ffmpeg.js";

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
  /** Which login the stored token came from — the advice differs by path. */
  authType?: SocialAuthType;
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

/**
 * Confirms Meta still accepts the stored token, which nothing else reveals until
 * publish time.
 *
 * Which host to ask is not a detail: an Instagram Login token sent to
 * graph.facebook.com comes back "Cannot parse access token", which reads as a
 * broken credential rather than a question put to the wrong server.
 */
async function tokenWorks(
  account: { platformAccountId: string; authType: SocialAuthType },
  accessToken: string,
): Promise<{ ok: boolean; detail?: string }> {
  const instagramLogin = account.authType === "INSTAGRAM_LOGIN";
  const url = instagramLogin
    ? new URL(`https://graph.instagram.com/${env.META_GRAPH_API_VERSION}/me`)
    : new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${account.platformAccountId}`);
  url.searchParams.set("fields", instagramLogin ? "user_id,username" : "id,username");
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
      live = await tokenWorks(account, decryptToken(account.accessToken));
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

  // Named rather than merely measured: "not enough space" and "measuring the
  // wrong disk because the volume isn't mounted here" produce the same number,
  // and only the path tells them apart.
  const disk = await diskReport();
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  if (!disk.known) {
    videoChecks.push({
      name: `Working disk (${disk.dir})`,
      ok: true,
      remedy: "I couldn't measure it, so I'll attempt a render and find out the hard way.",
    });
  } else {
    // Enough for a middling clip; below this most renders refuse before starting.
    const comfortable = disk.freeBytes > 1024 ** 3;
    videoChecks.push({
      name: `Working disk: ${gb(disk.freeBytes)}GB free of ${gb(disk.totalBytes)}GB on ${disk.dir}`,
      ok: comfortable,
      remedy: comfortable
        ? undefined
        : `That's tight — most clips need about 0.4GB more than their own size. ` +
          `Grow the volume in Railway → Settings → Volumes. If ${disk.dir} isn't your volume's mount path, ` +
          `set VIDEO_WORK_DIR to it so I work there instead.`,
    });
  }

  return {
    canPost: checks.every((check) => check.ok) && !env.DRY_RUN,
    dryRun: env.DRY_RUN,
    authType: account?.authType,
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
  // Advice that applies to the other login path is worse than none: it sends him
  // to fix something that has no bearing on how this token was obtained.
  if (readiness.authType === "INSTAGRAM_LOGIN") {
    lines.push(
      "",
      "Connected through Instagram directly, so there's no Facebook Page or App Review in the way. " +
        "The token lasts 60 days and I renew it on my own before it runs out.",
    );
  } else {
    lines.push(
      "",
      "One thing I can't check from here: whether your Instagram account holds a role on your Meta app. " +
        "Posting to your own account needs that rather than App Review — add it as an Instagram Tester under " +
        "App Roles, accept the invite at instagram.com/accounts/manage_access, then generate the token. " +
        "An unaccepted invite looks exactly like a missing permission.",
    );
  }

  return lines.join("\n");
}
