import { env } from "../../config/env.js";

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY aren't set in Railway, so I can't read subscriber or sales figures.",
    );
    this.name = "SupabaseNotConfiguredError";
  }
}

export function isSupabaseConfigured(): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Reads a table through PostgREST.
 *
 * The service role key is required rather than optional: newsletter_subscribers
 * has an insert-only RLS policy and no read policy at all, so an anon key sees
 * an empty list rather than an error — which would quietly report zero
 * subscribers forever.
 */
export async function selectRows(
  table: string,
  params: Record<string, string>,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  if (!isSupabaseConfigured()) throw new SupabaseNotConfiguredError();

  const url = new URL(`${env.SUPABASE_URL!.replace(/\/$/, "")}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
      // Asks PostgREST for the total row count in the Content-Range header,
      // so a count doesn't mean pulling every row back.
      prefer: "count=exact",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase refused to read ${table} (${response.status}): ${text.slice(0, 200)}`);
  }

  // Content-Range looks like "0-24/1337"; the total is after the slash.
  const total = Number(response.headers.get("content-range")?.split("/")[1] ?? NaN);
  const rows = JSON.parse(text) as Record<string, unknown>[];
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}
