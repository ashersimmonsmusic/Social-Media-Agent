import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * The signed, expiring value carried through an OAuth round trip.
 *
 * A callback route is public — the provider redirects a browser to it — so this
 * is the only thing proving the flow began in Asher's own chat rather than from
 * someone who guessed the URL. Namespaced per provider so a state minted for one
 * can never be replayed against another.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

function sign(namespace: string, issuedAt: number): string {
  const secret = env.SOCIAL_TOKEN_KEY ?? env.ADMIN_API_KEY;
  return createHmac("sha256", `${namespace}:${secret}`).update(String(issuedAt)).digest("hex");
}

export function createState(namespace: string): string {
  const issuedAt = Date.now();
  return `${issuedAt}.${sign(namespace, issuedAt)}`;
}

export function verifyState(namespace: string, state: string): boolean {
  const [issuedRaw, provided] = state.split(".");
  const issuedAt = Number(issuedRaw);
  if (!issuedRaw || !provided || !Number.isFinite(issuedAt)) return false;
  // The future check catches a clock-skewed or hand-made state, not a real one.
  if (Date.now() - issuedAt > STATE_TTL_MS || issuedAt > Date.now() + 60_000) return false;

  const expected = Buffer.from(sign(namespace, issuedAt), "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
