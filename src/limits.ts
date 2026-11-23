/**
 * Request limits: how many requests a key (or an address without a key) may make per minute.
 * Counting is a fixed one-minute window. One process counts in memory; several servers share a
 * count through `rateLimit.store` (Redis `INCR` + `EXPIRE` is all a store needs).
 *
 *   createCms({ rateLimit: { perMinute: 600, anonymousPerMinute: 120 } })
 *
 * A key can carry its own number (`createKey({ rateLimit: 60 })`), which wins over the default.
 */

export interface RateLimitStore {
  /** Add one to the bucket's counter for this window and return the new count. The store may forget the bucket after `ttlMs`. */
  hit(bucket: string, ttlMs: number): number | Promise<number>;
}

export interface RateLimitOptions {
  /** Requests per minute for each API key. Default: no limit. */
  perMinute?: number;
  /** Requests per minute for each address that sends no key and no session. Default: no limit. */
  anonymousPerMinute?: number;
  /** Where counts live. Default: this process's memory. */
  store?: RateLimitStore;
}

export interface RateVerdict {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window ends. */
  retryAfter: number;
}

export const WINDOW_MS = 60_000;

/** Counts in memory. Old windows are dropped as new ones start. */
export class MemoryRateLimitStore implements RateLimitStore {
  private counts = new Map<string, { n: number; until: number }>();
  private swept = 0;
  constructor(private now: () => number = Date.now) {}
  hit(bucket: string, ttlMs: number): number {
    const t = this.now();
    if (t - this.swept > WINDOW_MS) {
      this.swept = t;
      for (const [k, v] of this.counts) if (v.until <= t) this.counts.delete(k);
    }
    const cur = this.counts.get(bucket);
    if (cur && cur.until > t) return ++cur.n;
    this.counts.set(bucket, { n: 1, until: t + ttlMs });
    return 1;
  }
  get size() {
    return this.counts.size;
  }
}

export function createLimiter(o: { store?: RateLimitStore; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const store = o.store ?? new MemoryRateLimitStore(now);
  return {
    /** Count one request for `who`. `perMinute` of 0 or less means no limit. */
    async check(who: string, perMinute: number | null | undefined): Promise<RateVerdict> {
      const t = now();
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (t % WINDOW_MS)) / 1000));
      if (!perMinute || perMinute <= 0) return { ok: true, limit: 0, remaining: 0, retryAfter };
      const n = await store.hit(`${who}:${Math.floor(t / WINDOW_MS)}`, WINDOW_MS);
      return { ok: n <= perMinute, limit: perMinute, remaining: Math.max(0, perMinute - n), retryAfter };
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;

/** The caller's address: the first entry of `X-Forwarded-For`, else `X-Real-IP`. Null when neither is there. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip")?.trim() || null;
}

/**
 * For servers behind `proxies` proxies that each APPEND the address they saw to
 * `X-Forwarded-For` (most load balancers, Vercel, Cloudflare in front of one more): the entry that
 * many places from the end, which the sender cannot forge. `X-Real-IP` and the first entry are not
 * used. Null when the header has fewer entries.
 *
 *   createCmsHandler({ cms, clientIp: clientIpBehind(1) })
 *   createCms({ forms: { clientIp: clientIpBehind(1) } })
 */
export function clientIpBehind(proxies: number): (req: Request) => string | null {
  const n = Math.max(1, Math.floor(proxies));
  return (req) => {
    const list = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length >= n ? list[list.length - n] : null;
  };
}

/** "203.0.113.7", "203.0.113.0/24", "2001:db8::/32". Null when it is not an address or range. */
function parseRange(s: string): { bytes: number[]; bits: number } | null {
  const [addr, prefix] = s.trim().split("/");
  const bytes = ipBytes(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  const bits = prefix === undefined ? max : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { bytes, bits };
}

function ipBytes(addr: string): number[] | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const parts = addr.split(".").map(Number);
    return parts.every((p) => p <= 255) ? parts : null;
  }
  if (!addr.includes(":")) return null;
  // IPv6, with one "::" and an optional IPv4 tail.
  let a = addr.replace(/^\[|\]$/g, "");
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (v4) {
    const b = ipBytes(v4[1]);
    if (!b) return null;
    a = a.slice(0, -v4[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

/** Is this a list of addresses and ranges the CMS understands? Returns the entries that are not. */
export function badRanges(list: readonly string[]): string[] {
  return list.filter((s) => !parseRange(s));
}

/** True when `ip` is inside one of the ranges. An IPv4 address also matches its IPv6-mapped form. */
export function ipAllowed(ip: string | null, ranges: readonly string[]): boolean {
  if (!ranges.length) return true;
  if (!ip) return false;
  let bytes = ipBytes(ip.trim());
  if (!bytes) return false;
  // ::ffff:203.0.113.7 is the same host as 203.0.113.7.
  if (bytes.length === 16 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) bytes = bytes.slice(12);
  return ranges.some((r) => {
    const range = parseRange(r);
    if (!range || range.bytes.length !== bytes!.length) return false;
    for (let i = 0; i < range.bits; i++) {
      const mask = 1 << (7 - (i % 8));
      if ((range.bytes[i >> 3] & mask) !== (bytes![i >> 3] & mask)) return false;
    }
    return true;
  });
}
