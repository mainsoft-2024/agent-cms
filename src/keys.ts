/** API keys: `sgk_` + 40 random base62 chars. Only a sha256 hash is stored. */

import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_PREFIX = "sgk_";
const KEY_CHARS = 40;
/** Largest multiple of 62 below 256: bytes at or above it are dropped so every char is equally likely. */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/** `random` is injectable for tests; it must return uniformly random bytes. */
export function generateKey(random: (n: number) => Uint8Array = randomBytes): string {
  let s = "";
  while (s.length < KEY_CHARS) {
    for (const b of random(KEY_CHARS)) {
      if (b >= UNBIASED_LIMIT) continue; // rejection sampling, no modulo bias
      s += ALPHABET[b % ALPHABET.length];
      if (s.length === KEY_CHARS) break;
    }
  }
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

/** `Authorization: Bearer sgk_…` (also accepts Payload's `… API-Key sgk_…`). */
export function keyFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^(?:Bearer|[A-Za-z-]+\s+API-Key)\s+(\S+)$/i.exec(header.trim());
  const raw = m?.[1] ?? null;
  return looksLikeKey(raw) ? raw : null;
}
