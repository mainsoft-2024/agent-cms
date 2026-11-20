/**
 * Fetching an address someone else chose (an agent importing a file by URL)
 * without letting it reach the app's own network: https only, every address
 * the host resolves to must be public, and each redirect is checked again.
 *
 * Known limit: the check resolves the name and `fetch` resolves it again, so
 * a DNS answer that changes in between is not caught. Put the app behind an
 * egress rule if that matters to you.
 */

export class FetchGuardError extends Error {
  constructor(
    readonly reason: "blocked" | "too_large" | "failed",
    message: string
  ) {
    super(message);
    this.name = "FetchGuardError";
  }
}

function v4Public(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && p[2] === 0))) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** True for an address on the public internet (not loopback, private, link-local, …). */
export function isPublicAddress(ip: string): boolean {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!s.includes(":")) return v4Public(s);
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Public(mapped[1]);
  if (s === "::" || s === "::1" || s.startsWith("::ffff:") || s.startsWith("64:ff9b:")) return false;
  const first = parseInt(s.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0) return false;
  return true;
}

export type ResolveHost = (host: string) => Promise<string[]>;

const defaultResolve: ResolveHost = async (host) => {
  const dns = await import("node:dns/promises");
  return (await dns.lookup(host, { all: true })).map((a) => a.address);
};

export interface GuardedFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
}

/** GET `url` and return its bytes, or throw a `FetchGuardError`. */
/** The check `guardedFetch` does before each request, on its own: https, no credentials, a public address. */
export async function assertPublicUrl(url: string, o: { resolveHost?: ResolveHost } = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchGuardError("blocked", "not a URL");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new FetchGuardError("blocked", "only https addresses without credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  let addrs: string[];
  try {
    addrs = literal ? [host] : await (o.resolveHost ?? defaultResolve)(host);
  } catch {
    throw new FetchGuardError("failed", "the host name does not resolve");
  }
  if (!addrs.length || !addrs.every(isPublicAddress)) throw new FetchGuardError("blocked", "the address is not on the public internet");
  return u;
}

export async function guardedFetch(url: string, o: GuardedFetchOptions): Promise<{ bytes: Uint8Array; mime: string | null; url: string }> {
  const doFetch = o.fetch ?? fetch;
  const resolve = o.resolveHost ?? defaultResolve;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 30_000);
  let current = url;
  for (let hop = 0; hop <= (o.maxRedirects ?? 3); hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new FetchGuardError("blocked", "not a URL");
    }
    if (u.protocol !== "https:" || u.username || u.password) throw new FetchGuardError("blocked", "only https addresses without credentials");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const literal = /^[\d.]+$/.test(host) || host.includes(":");
    let addrs: string[];
    try {
      addrs = literal ? [host] : await resolve(host);
    } catch {
      throw new FetchGuardError("failed", "the host name does not resolve");
    }
    if (!addrs.length || !addrs.every(isPublicAddress)) throw new FetchGuardError("blocked", "the address is not on the public internet");
    let res: Response;
    try {
      res = await doFetch(u, { redirect: "manual", signal, headers: { accept: "*/*" } });
    } catch (e) {
      throw new FetchGuardError("failed", e instanceof Error && e.name === "TimeoutError" ? "timed out" : "the request failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next) throw new FetchGuardError("failed", "redirect without a location");
      current = new URL(next, u).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new FetchGuardError("failed", `status ${res.status}`);
    }
    if (Number(res.headers.get("content-length") ?? 0) > o.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new FetchGuardError("too_large", "too large");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > o.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new FetchGuardError("too_large", "too large");
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof FetchGuardError) throw e;
      throw new FetchGuardError("failed", "the download broke off");
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { bytes, mime: res.headers.get("content-type"), url: u.toString() };
  }
  throw new FetchGuardError("failed", "too many redirects");
}

// ── image size from the file's first bytes ──────────────────────────────────

/** Width and height of a PNG, GIF, JPEG or WebP, read from its bytes. `null` when it cannot tell. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  try {
    if (b[0] === 0x89 && ascii(1, 3) === "PNG" && b.length >= 24) return { width: v.getUint32(16), height: v.getUint32(20) };
    if (ascii(0, 3) === "GIF" && b.length >= 10) return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP" && b.length >= 30) {
      const kind = ascii(12, 4);
      if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (kind === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
      if (kind === "VP8L") {
        const n = v.getUint32(21, true);
        return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
      }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1];
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
          i += marker === 0xff ? 1 : 2;
          continue;
        }
        i += 2 + v.getUint16(i + 2);
      }
    }
  } catch {
    // ran past the bytes we have
  }
  return null;
}
