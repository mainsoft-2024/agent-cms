// A small zip writer (stored entries, no compression: media is already
// compressed). Enough for "download these files as one zip"; no dependency.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the zip ("folder/name.jpg"). */
  name: string;
  data: Uint8Array;
  date?: Date;
}

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** Names made unique ("a.jpg", "a (2).jpg") and safe (no leading "/", no ".."). */
export function zipNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw) => {
    const clean =
      raw
        .replace(/\\/g, "/")
        .split("/")
        .filter((p) => p && p !== "." && p !== "..")
        .join("/") || "file";
    let name = clean;
    for (let i = 2; seen.has(name.toLowerCase()); i++) {
      const dot = clean.lastIndexOf(".");
      name = dot > clean.lastIndexOf("/") + 0 && dot > 0 ? `${clean.slice(0, dot)} (${i})${clean.slice(dot)}` : `${clean} (${i})`;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

/** One zip file from the entries (UTF-8 names). */
export function makeZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const [time, date] = dosTime(e.date ?? new Date());
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Read a zip made by `makeZip` (stored entries only). For tests and imports. */
export function readZip(zip: Uint8Array): ZipEntry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    if (v.getUint16(p + 10, true) !== 0) throw new Error("compressed zip entries are not supported");
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.push({ name, data: zip.slice(start, start + size) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/**
 * Read any ordinary zip (stored or deflated entries), e.g. a Notion or WordPress export or an
 * agent-cms export zipped by hand (0.17.0). Folders are left out. `maxBytes` caps the unpacked
 * total (a zip bomb stops with an error).
 */
export async function unzip(zip: Uint8Array, o: { maxBytes?: number; maxEntries?: number; budget?: { bytes: number; entries: number } } = {}): Promise<ZipEntry[]> {
  // One budget for a zip and the zips inside it (pass the same `budget` along).
  const budget = o.budget ?? { bytes: o.maxBytes ?? 512 * 1024 * 1024, entries: o.maxEntries ?? 20_000 };
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const raw = zip.subarray(p + 46, p + 46 + nameLen);
    // Bit 11: UTF-8 names. Older tools write CP437; ASCII reads the same either way.
    const name = flags & 0x800 ? dec.decode(raw) : dec.decode(raw);
    p += 46 + nameLen + extra + comment;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`${name}: encrypted zip entries are not supported`);
    if (name.split("/").some((seg) => seg === "..") || name.startsWith("/")) throw new Error(`${name}: unsafe path in zip`);
    if (--budget.entries < 0) throw new Error("the zip has too many files");
    if (size > budget.bytes) throw new Error("the zip unpacks to more than the limit");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const body = zip.subarray(start, start + csize);
    let data: Uint8Array;
    if (start + csize > zip.length) throw new Error(`${name}: entry runs past the end of the zip`);
    if (method === 0) {
      if (csize !== size) throw new Error(`${name}: sizes do not match`);
      data = body.slice();
    } else if (method === 8) {
      // Counted while it inflates: stops at the real size, whatever the header says.
      const reader = new Blob([body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > size || got > budget.bytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`${name}: unpacks to more than it says`);
        }
        parts.push(value);
      }
      data = new Uint8Array(got);
      let at = 0;
      for (const part of parts) {
        data.set(part, at);
        at += part.length;
      }
      if (got !== size) throw new Error(`${name}: unpacked size does not match`);
    } else throw new Error(`${name}: zip method ${method} is not supported (stored and deflate are)`);
    budget.bytes -= data.length;
    out.push({ name, data });
  }
  return out;
}
