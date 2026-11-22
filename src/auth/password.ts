/**
 * Password hashing and rules. scrypt from Node (no dependency), with the
 * parameters written into the hash so they can be raised later: a hash made
 * with weaker ones is replaced at the next sign-in.
 *
 *   scrypt$<log2 N>$<r>$<p>$<salt b64url>$<hash b64url>
 *
 * OWASP's scrypt minimum is N=2^17, r=8, p=1 (128 MiB). argon2id would be the
 * first choice but needs a native package.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { COMMON_PASSWORDS } from "./common-passwords";

export interface HashParams {
  /** log2 of N. */
  logN: number;
  r: number;
  p: number;
}

export const DEFAULT_HASH: HashParams = { logN: 17, r: 8, p: 1 };
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const KEY_LEN = 32;

function scrypt(password: string, salt: Buffer, o: HashParams): Promise<Buffer> {
  const opts: ScryptOptions = { N: 2 ** o.logN, r: o.r, p: o.p, maxmem: 256 * 2 ** o.logN * o.r + 1024 * 1024 };
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFKC"), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

const b64 = (b: Buffer) => b.toString("base64url");

export async function hashPassword(password: string, o: HashParams = DEFAULT_HASH): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, o);
  return `scrypt$${o.logN}$${o.r}$${o.p}$${b64(salt)}$${b64(key)}`;
}

function parse(hash: string): (HashParams & { salt: Buffer; key: Buffer }) | null {
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  const logN = Number(m[1]);
  if (logN < 10 || logN > 22) return null;
  return { logN, r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4], "base64url"), key: Buffer.from(m[5], "base64url") };
}

/** A made-up hash used when there is no account, so both answers take the same time. */
let dummy: Promise<string> | null = null;

/**
 * Checks a password. With `hash` null (no such account, or an account
 * without a password) a hash is still computed, so the time does not tell
 * whether the account exists.
 */
export async function verifyPassword(password: string, hash: string | null | undefined, o: HashParams = DEFAULT_HASH): Promise<{ ok: boolean; rehash: boolean }> {
  const p = hash ? parse(hash) : null;
  if (!p) {
    dummy ??= hashPassword("not the password", o);
    const d = parse(await dummy)!;
    await scrypt(password, d.salt, d);
    return { ok: false, rehash: false };
  }
  const key = await scrypt(password, p.salt, p);
  const ok = key.length === p.key.length && timingSafeEqual(key, p.key);
  return { ok, rehash: ok && (p.logN < o.logN || p.r < o.r || p.p < o.p) };
}

/** Why a new password is refused, or null when it is fine. */
export function passwordProblem(password: string, about: { email?: string | null; name?: string | null } = {}): { code: "password_weak" | "password_common"; min: number } | null {
  const chars = [...password];
  if (chars.length < PASSWORD_MIN || chars.length > PASSWORD_MAX) return { code: "password_weak", min: PASSWORD_MIN };
  const lower = password.toLowerCase();
  // One character repeated, or a run like "abcdefghijkl" / "123456789012".
  if (new Set(chars).size <= 3) return { code: "password_common", min: PASSWORD_MIN };
  if (isRun(lower)) return { code: "password_common", min: PASSWORD_MIN };
  const local = about.email?.split("@")[0]?.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9가-힣]/g, "");
  if (local && local.length >= 4 && squashed.replace(/\d+$/, "") === local.replace(/[^a-z0-9]/g, "")) return { code: "password_common", min: PASSWORD_MIN };
  const name = about.name?.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  if (name && name.length >= 4 && squashed.replace(/\d+$/, "") === name) return { code: "password_common", min: PASSWORD_MIN };
  if (isCommon(lower)) return { code: "password_common", min: PASSWORD_MIN };
  return null;
}

let common: Set<string> | null = null;

/** "Dragon2026!!" → "dragon", then looked up; also a common word written twice ("monkeymonkey"). */
export function isCommon(password: string): boolean {
  common ??= new Set(COMMON_PASSWORDS.split(" "));
  const base = password.toLowerCase().replace(/[\d!@#$%^&*._\s-]+$/, "").replace(/^[\d!@#$%^&*._\s-]+/, "");
  if (common.has(base)) return true;
  const half = base.length / 2;
  if (Number.isInteger(half) && base.slice(0, half) === base.slice(half) && common.has(base.slice(0, half))) return true;
  return false;
}

function isRun(s: string): boolean {
  const codes = [...s].map((c) => c.codePointAt(0)!);
  let up = 0;
  let down = 0;
  for (let i = 1; i < codes.length; i++) {
    if (codes[i] - codes[i - 1] === 1) up++;
    if (codes[i] - codes[i - 1] === -1) down++;
  }
  return up >= codes.length - 2 || down >= codes.length - 2 || /^(qwertyuiop|asdfghjkl|zxcvbnm|1qaz2wsx3edc)/.test(s);
}
