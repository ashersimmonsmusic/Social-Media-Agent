import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/audit.service.js";
import { buildDocument, type WebsiteContentType } from "./documents.js";

export class WebsiteNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} isn't set in Railway, so I can't reach the website. Nothing has changed.`);
    this.name = "WebsiteNotConfiguredError";
  }
}

export class WebsiteWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsiteWriteError";
  }
}

export interface PublishedDocument {
  id: string;
  type: WebsiteContentType;
  summary: string;
  dryRun: boolean;
}

/**
 * Writes a document into Sanity, which is what the site actually reads — the
 * Next.js app renders from the CMS, so content added here appears without a
 * deploy. Only called from the approved-action handler.
 */
export async function publishToWebsite(
  type: WebsiteContentType,
  input: Record<string, unknown>,
): Promise<PublishedDocument> {
  const { doc, summary } = buildDocument(type, input);

  if (env.DRY_RUN) {
    await recordAudit({
      action: "website.publish_dry_run",
      entityType: "SanityDocument",
      actorType: "SYSTEM",
      details: { type, summary, doc },
    });
    logger.info("website.publish_dry_run", { type });
    return { id: `dry-run-${Date.now()}`, type, summary, dryRun: true };
  }

  const projectId = env.SANITY_PROJECT_ID;
  const token = env.SANITY_WRITE_TOKEN;
  if (!projectId) throw new WebsiteNotConfiguredError("SANITY_PROJECT_ID");
  if (!token) throw new WebsiteNotConfiguredError("SANITY_WRITE_TOKEN");

  const url = `https://${projectId}.api.sanity.io/v${env.SANITY_API_VERSION}/data/mutate/${env.SANITY_DATASET}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ mutations: [{ create: doc }] }),
    });
  } catch (error) {
    throw new WebsiteWriteError(`Couldn't reach Sanity: ${error instanceof Error ? error.message : error}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new WebsiteWriteError(`Sanity refused the write (${response.status}): ${text.slice(0, 300)}`);
  }

  let id = "";
  try {
    const json = JSON.parse(text) as { results?: { id?: string }[] };
    id = json.results?.[0]?.id ?? "";
  } catch {
    // A 2xx with an unparseable body still means it was written; carry on without an id.
  }

  await recordAudit({
    action: "website.published",
    entityType: "SanityDocument",
    entityId: id || undefined,
    actorType: "ASHER",
    details: { type, summary },
  });

  return { id: id || "(no id returned)", type, summary, dryRun: false };
}

/**
 * Files an issue on the website repo. This is how a request that needs real code
 * — a new section, a new content type, a design change — reaches Claude Code,
 * rather than the agent attempting something it has no ability to do.
 */
export async function requestWebsiteChange(input: { title: string; body: string }): Promise<string> {
  const repo = env.WEBSITE_REPO;
  const token = env.GITHUB_TOKEN;
  if (!repo) throw new WebsiteNotConfiguredError("WEBSITE_REPO");
  if (!token) throw new WebsiteNotConfiguredError("GITHUB_TOKEN");

  if (env.DRY_RUN) {
    await recordAudit({
      action: "website.issue_dry_run",
      entityType: "GitHubIssue",
      actorType: "SYSTEM",
      details: { repo, title: input.title },
    });
    return `DRY RUN — would have filed "${input.title}" on ${repo}.`;
  }

  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: input.title, body: input.body, labels: ["from-asher-bot"] }),
    });
  } catch (error) {
    throw new WebsiteWriteError(`Couldn't reach GitHub: ${error instanceof Error ? error.message : error}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new WebsiteWriteError(`GitHub refused to file the issue (${response.status}): ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as { html_url?: string; number?: number };
  await recordAudit({
    action: "website.change_requested",
    entityType: "GitHubIssue",
    entityId: json.number ? String(json.number) : undefined,
    actorType: "ASHER",
    details: { repo, title: input.title },
  });

  return json.html_url ?? `Filed on ${repo}.`;
}
