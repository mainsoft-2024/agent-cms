/**
 * Time-based one-time codes (RFC 6238 over RFC 4226): SHA-1, 6 digits, 30
 * seconds, which is what every authenticator app reads from an
 * `otpauth://` address. One step either side is accepted for clock drift,
 * and a step that was used once is refused after that.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one time step (HOTP with the step as the counter). */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const off = mac[mac.length - 1] & 0xf;
  const n = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

export function totpStep(at: number, period = 30): number {
  return Math.floor(at / 1000 / period);
}

export function totp(secretB32: string, at: number, period = 30): string {
  return hotp(base32Decode(secretB32), totpStep(at, period));
}

/**
 * Checks a code. Returns the step it matched (store it, and pass it back as
 * `lastStep` next time so the same code cannot be used twice), or null.
 */
export function verifyTotp(secretB32: string, code: string, at: number, lastStep: number | null = null, window = 1): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(at);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (lastStep !== null && step <= lastStep) continue;
    const want = Buffer.from(hotp(key, step));
    if (timingSafeEqual(want, Buffer.from(digits))) return step;
  }
  return null;
}

/** The address an authenticator app reads (usually from a QR code). */
export function otpauthUrl(o: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`);
  return `otpauth://totp/${label}?secret=${o.secret}&issuer=${encodeURIComponent(o.issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Ten recovery codes like `k7m2-9xq4-pw3t`: no 0/o, 1/l to misread. */
export function newRecoveryCodes(n = 10): string[] {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(12);
    const s = [...b].map((x) => chars[x % chars.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  });
}

/** Recovery codes are compared without case, spaces or dashes. */
export function normalizeRecovery(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}
