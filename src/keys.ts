/** API keys: `sgk_` + 40 random base62 chars. Only a sha256 hash is stored. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_PREFIX = "sgk_";

export function generateKey(): string {
  const bytes = randomBytes(40);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return KEY_PREFIX + s;
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

/** What the admin list shows: `sgk_…9f2a`. */
export function displayPrefix(raw: string): string {
  return `${KEY_PREFIX}…${raw.slice(-4)}`;
}

export function looksLikeKey(raw: string | null | undefined): raw is string {
  return !!raw && raw.startsWith(KEY_PREFIX) && raw.length >= KEY_PREFIX.length + 20;
}

/** Constant-time compare of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Authorization: Bearer sgk_…` (also accepts Payload's `… API-Key sgk_…`). */
export function keyFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^(?:Bearer|[A-Za-z-]+\s+API-Key)\s+(\S+)$/i.exec(header.trim());
  const raw = m?.[1] ?? null;
  return looksLikeKey(raw) ? raw : null;
}
