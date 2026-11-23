/**
 * Where files live. The CMS keeps a row per file (`cms_assets`) and talks to
 * the bucket through a `StorageAdapter`; `./storage-s3` is the adapter for
 * S3-compatible storage. Files go from the browser straight to the storage
 * with signed URLs, so the app server never carries their bytes.
 *
 * This file also holds the rules about names and file types, which are the
 * same for every adapter.
 */

import type { AssetKind } from "./types";

export interface StoredObject {
  key: string;
  size: number;
  mime: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface PutOptions {
  mime: string;
  /** `Content-Disposition` to store with the object (e.g. `attachment; filename="a.zip"`). */
  disposition?: string | null;
  cacheControl?: string | null;
}

export interface SignedRequest {
  url: string;
  /** Headers the uploader must send with the request, exactly. */
  headers: Record<string, string>;
}

export interface StoragePart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface StorageList {
  objects: StoredObject[];
  /** Sub-folders (with a trailing slash) when a delimiter was given. */
  prefixes: string[];
  cursor: string | null;
}

export interface StorageAdapter {
  /**
   * `false`: this storage takes a file in one request only, whatever its
   * size. The CMS then never asks for parts, and a failed upload starts again
   * instead of carrying on. Leave out when parts work (S3-compatible storage).
   */
  readonly multipart?: boolean;
  /**
   * The origins the browser sends files to itself (the signed upload URLs), e.g. `["https://bucket.s3.eu-west-1.amazonaws.com"]`.
   * The bundled admin (`serve`, `dev`) lists them in its Content-Security-Policy (`connect-src`). When left out,
   * nothing is added (the server warns at start): set `media.stores.<name>.browserOrigins` or `server.connectSrc`.
   */
  readonly browserOrigins?: readonly string[];
  /** A URL the browser can PUT the whole file to. `size`: the size the uploader declared, for storage that can hold it to that. */
  presignPut(key: string, o: PutOptions & { expires: number; size?: number }): Promise<SignedRequest>;
  /** Server-side upload (small files: thumbnails, imports, folder markers). */
  put(key: string, body: Uint8Array, o: PutOptions): Promise<void>;
  createMultipart(key: string, o: PutOptions): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expires: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<StoragePart[]>;
  completeMultipart(key: string, uploadId: string, parts: readonly Pick<StoragePart, "partNumber" | "etag">[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<StoredObject | null>;
  /** The first `bytes` bytes of the object (to check what it really is). */
  readStart(key: string, bytes: number): Promise<Uint8Array | null>;
  /** A short-lived URL to read the object. `download`: file name to save as. */
  presignGet(key: string, o: { expires: number; download?: string | null }): Promise<string>;
  /** The object's public address, when the bucket is public. */
  publicUrl(key: string): string | null;
  copy(from: string, to: string): Promise<void>;
  /**
   * Called once for a file a browser uploaded, after it passed the checks and
   * before it joins the library. For storage that has to finish something
   * from the server (leave out otherwise).
   */
  settle?(key: string, o: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(o: { prefix?: string; delimiter?: string; cursor?: string | null; limit?: number }): Promise<StorageList>;
}

// ── file types ──────────────────────────────────────────────────────────────

/** Extension → MIME type for the types the CMS knows. */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  exe: "application/vnd.microsoft.portable-executable",
};

/**
 * What a store takes when nothing is configured: images, video, sound, PDF,
 * office documents, plain text and ZIP. HTML and programs are not in it; a
 * developer who wants them lists them in `media.accept`.
 */
export const DEFAULT_ACCEPT: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "application/pdf",
  MIME_BY_EXT.docx,
  MIME_BY_EXT.xlsx,
  MIME_BY_EXT.pptx,
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/zip",
];

export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 ** 3;
/** Files up to this size go up in one request; larger ones in parts of this size. */
export const PART_SIZE = 16 * 1024 * 1024;
export const THUMB_PREFIX = "_cms/thumbs/";
export const RESERVED_FOLDER = "_cms";
/** Resized copies of images (`media.transforms`): `_cms/derived/<id>/<size>-<stamp>.<ext>`. */
export const DERIVED_PREFIX = "_cms/derived/";
/** New content on its way to replace a file: `_cms/replace/<id>/<upload id>.<ext>`. */
export const REPLACE_PREFIX = "_cms/replace/";

/**
 * A JPEG without what cameras and phones write into it: where and when it
 * was taken, the device, comments, editing history (Exif, XMP, IPTC). The
 * picture itself, its colour profile and its orientation stay. Returns the
 * same array when there is nothing to remove or the bytes are not a JPEG.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const keep: [number, number][] = [];
  let orientation = 1;
  let dropped = false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break; // the picture starts here
    if (m === 0xff) {
      i++; // padding
      continue;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      keep.push([i, i + 2]);
      i += 2;
      continue;
    }
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end < i + 4 || end > b.length) return b; // not a file to take apart
    // APP1 holds Exif and XMP, APP13 IPTC and Photoshop data, COM a comment.
    if (m === 0xe1 || m === 0xed || m === 0xfe) {
      dropped = true;
      if (m === 0xe1 && end - i >= 18 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) orientation = exifOrientation(b.subarray(i + 10, end)) ?? orientation;
    } else keep.push([i, end]);
    i = end;
  }
  if (!dropped) return b;
  // Without its orientation a photo taken sideways would lie on its side: keep that one value.
  const turn = orientation >= 2 && orientation <= 8 ? Uint8Array.of(0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0) : new Uint8Array();
  const out = new Uint8Array(2 + turn.length + keep.reduce((n, [a, z]) => n + z - a, 0) + b.length - i);
  out.set(b.subarray(0, 2));
  out.set(turn, 2);
  let at = 2 + turn.length;
  for (const [a, z] of keep) {
    out.set(b.subarray(a, z), at);
    at += z - a;
  }
  out.set(b.subarray(i), at);
  return out;
}

/** The Orientation tag (1..8) of a TIFF block, or null. */
function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 14) return null;
  const le = t[0] === 0x49;
  const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const ifd = le ? t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24) : ((t[4] << 24) | (t[5] << 16) | (t[6] << 8) | t[7]) >>> 0;
  if (ifd < 8 || ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let k = 0; k < n && ifd + 2 + (k + 1) * 12 <= t.length; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

export const extOf = (name: string) => {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
};

/** The MIME type to store: the extension decides when it is a known one. */
export function mimeOf(name: string, declared?: string | null): string {
  const known = MIME_BY_EXT[extOf(name)];
  if (known) return known;
  const d = (declared ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(d) ? d : "application/octet-stream";
}

/** False when the browser's declared type is a different kind of file than the extension says. */
export function declaredMatches(name: string, declared?: string | null): boolean {
  const known = MIME_BY_EXT[extOf(name)];
  const d = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (!known || !d || d === "application/octet-stream" || d === known) return true;
  const top = (m: string) => m.split("/")[0];
  // Browsers name the same file differently (audio/x-m4a, application/x-zip-compressed, text/x-markdown).
  if (top(d) === top(known) && top(known) !== "application") return true;
  if (known === "application/zip" && /zip/.test(d)) return true;
  if (top(known) === "text" && (d === "application/csv" || d === "application/vnd.ms-excel")) return true;
  const office = /officedocument|msword|ms-excel|ms-powerpoint/;
  if (office.test(known) && office.test(d)) return true;
  return false;
}

/** Does `rules` (MIME types, groups such as `image/*`, extensions such as `.pdf`, or the wildcard) take this file? */
export function acceptsFile(rules: readonly string[], file: { name: string; mime: string }): boolean {
  const ext = extOf(file.name);
  const mime = file.mime.toLowerCase();
  return rules.some((raw) => {
    const r = raw.trim().toLowerCase();
    if (r === "*/*" || r === "*") return true;
    if (r.startsWith(".")) return r.slice(1) === ext;
    if (r.endsWith("/*")) return mime.startsWith(r.slice(0, -1));
    return r === mime;
  });
}

export function kindOf(mime: string): Exclude<AssetKind, "folder"> {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/") || /officedocument|msword|ms-excel|ms-powerpoint|opendocument/.test(mime)) return "document";
  return "other";
}

/** Shown in the page (image, video, sound, PDF) or saved as a download (everything else). */
export const servedInline = (mime: string) => mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || mime === "application/pdf";

export function dispositionFor(name: string, mime: string, forceDownload = false): string | null {
  if (!forceDownload && servedInline(mime)) return null;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

type Family = "jpeg" | "png" | "gif" | "webp" | "iso" | "webm" | "pdf" | "zip" | "mp3" | "wav" | "ogg" | "program" | "html" | "svg" | "text";

const FAMILY_BY_MIME: Record<string, Family> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "iso",
  "image/heic": "iso",
  "image/svg+xml": "svg",
  "video/mp4": "iso",
  "video/quicktime": "iso",
  "audio/mp4": "iso",
  "video/webm": "webm",
  "video/x-matroska": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/zip": "zip",
  [MIME_BY_EXT.docx]: "zip",
  [MIME_BY_EXT.xlsx]: "zip",
  [MIME_BY_EXT.pptx]: "zip",
  "text/html": "html",
  "text/plain": "text",
  "text/csv": "text",
  "text/markdown": "text",
  "application/json": "text",
  "text/javascript": "text",
  [MIME_BY_EXT.exe]: "program",
};

/** What the first bytes of a file say it is (`null`: an unknown binary format). */
export function sniff(b: Uint8Array): Family | null {
  const at = (i: number, ...sig: number[]) => sig.every((v, k) => b[i + k] === v);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(4, 4) === "ftyp") return "iso";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (ascii(0, 5) === "%PDF-") return "pdf";
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return "zip";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && b.length > 2)) return "mp3";
  if (ascii(0, 2) === "MZ" || at(0, 0x7f, 0x45, 0x4c, 0x46) || at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xca, 0xfe, 0xba, 0xbe) || ascii(0, 2) === "#!") return "program";
  // Text: no NUL bytes in what we read.
  if (b.length && !b.includes(0)) {
    const head = new TextDecoder("utf-8", { fatal: false }).decode(b).replace(/^\uFEFF/, "").trimStart().toLowerCase();
    if (/^(<!doctype html|<html|<head|<body|<script|<iframe)/.test(head)) return "html";
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(head)) return "svg";
    return "text";
  }
  return null;
}

/** True when the file's first bytes fit the type it was stored as. */
export function contentMatches(mime: string, start: Uint8Array): boolean {
  const want = FAMILY_BY_MIME[mime];
  const got = sniff(start);
  // A program or a web page under another name is never what it claims.
  if ((got === "program" || got === "html") && want !== got) return false;
  if (!want) return true; // a type we cannot check
  if (want === "text") return got === "text" || got === "svg" || start.length === 0;
  if (want === "svg") return got === "svg";
  return got === want;
}

// ── names ───────────────────────────────────────────────────────────────────

const clean = (s: string) =>
  s
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .replace(/^[.\s]+/, "")
    .trim();

/** A safe file name: keeps Korean and spaces, drops control characters, slashes and leading dots; 200 characters at most. */
export function cleanName(name: string): string {
  let n = clean(name);
  if (!n) n = "file";
  if (n.length > 200) {
    const ext = extOf(n);
    n = ext ? `${n.slice(0, 199 - ext.length)}.${ext}` : n.slice(0, 200);
  }
  return n;
}

/** A safe folder path ("" = top level): no empty, `.` or `..` parts, nothing under `_cms`. `null` when it is not allowed. */
export function cleanFolder(folder: string | null | undefined): string | null {
  const parts = String(folder ?? "")
    .split("/")
    .map(clean)
    .filter((p) => p && p !== "." && p !== "..");
  if (parts[0] === RESERVED_FOLDER) return null;
  const out = parts.join("/");
  return out.length > 400 ? null : out;
}

export const joinKey = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** `name`, `name-2`, `name-3`… before the extension. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const ext = extOf(name);
  return ext ? `${name.slice(0, -(ext.length + 1))}-${n}.${ext}` : `${name}-${n}`;
}

/** 12 lowercase letters and digits. */
export function newAssetId(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((x) => abc[x % abc.length]).join("");
}

export const ASSET_ID_RE = /^[a-z0-9]{12}$/;

// ── a storage in memory (tests, demos) ──────────────────────────────────────

interface MemObject {
  body: Uint8Array;
  mime: string;
  disposition: string | null;
  cacheControl?: string | null;
  at: string;
}

/**
 * A storage that lives in memory. Signed URLs look like
 * `memory://<name>/<key>?…`; `send(url, body)` plays the browser's part.
 */
export class MemoryStorage implements StorageAdapter {
  objects = new Map<string, MemObject>();
  uploads = new Map<string, { key: string; o: PutOptions; parts: Map<number, Uint8Array> }>();
  private pending = new Map<string, PutOptions>();
  private n = 0;
  /** Nothing outside the server: its addresses are `memory://…`. */
  readonly browserOrigins: readonly string[] = [];
  constructor(private o: { name?: string; publicUrl?: string | null } = {}) {}

  private base() {
    return `memory://${this.o.name ?? "store"}/`;
  }
  private store(key: string, body: Uint8Array, o: PutOptions) {
    this.objects.set(key, { body, mime: o.mime, disposition: o.disposition ?? null, cacheControl: o.cacheControl ?? null, at: new Date().toISOString() });
  }
  private meta(key: string, v: MemObject): StoredObject {
    return { key, size: v.body.length, mime: v.mime, etag: `"m${v.body.length}"`, lastModified: v.at };
  }

  /** What a browser does with a signed PUT URL. Returns the HTTP status. */
  async send(url: string, body: Uint8Array): Promise<number> {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const uploadId = u.searchParams.get("uploadId");
    if (uploadId) {
      const up = this.uploads.get(uploadId);
      if (!up || up.key !== key) return 404;
      up.parts.set(Number(u.searchParams.get("partNumber")), body);
      return 200;
    }
    const o = this.pending.get(key);
    if (!o) return 403;
    this.store(key, body, o);
    return 200;
  }

  async presignPut(key: string, o: PutOptions & { expires: number }) {
    this.pending.set(key, o);
    const headers: Record<string, string> = { "content-type": o.mime };
    if (o.disposition) headers["content-disposition"] = o.disposition;
    return { url: `${this.base()}${encodeURI(key)}?put=1`, headers };
  }
  async put(key: string, body: Uint8Array, o: PutOptions) {
    this.store(key, body, o);
  }
  async createMultipart(key: string, o: PutOptions) {
    const id = `up${++this.n}`;
    this.uploads.set(id, { key, o, parts: new Map() });
    return id;
  }
  async presignPart(key: string, uploadId: string, partNumber: number) {
    return `${this.base()}${encodeURI(key)}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }
  async listParts(_key: string, uploadId: string) {
    const up = this.uploads.get(uploadId);
    if (!up) return [];
    return [...up.parts].sort((a, b) => a[0] - b[0]).map(([partNumber, body]) => ({ partNumber, etag: `"p${partNumber}"`, size: body.length }));
  }
  async completeMultipart(key: string, uploadId: string, parts: readonly Pick<StoragePart, "partNumber">[]) {
    const up = this.uploads.get(uploadId);
    if (!up) throw new Error("no such upload");
    const bodies = parts.map((p) => up.parts.get(p.partNumber) ?? new Uint8Array());
    const all = new Uint8Array(bodies.reduce((s, x) => s + x.length, 0));
    let at = 0;
    for (const x of bodies) {
      all.set(x, at);
      at += x.length;
    }
    this.store(key, all, up.o);
    this.uploads.delete(uploadId);
  }
  async abortMultipart(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async head(key: string) {
    const v = this.objects.get(key);
    return v ? this.meta(key, v) : null;
  }
  async readStart(key: string, bytes: number) {
    const v = this.objects.get(key);
    return v ? v.body.slice(0, bytes) : null;
  }
  async presignGet(key: string, o: { expires: number; download?: string | null }) {
    return `${this.base()}${encodeURI(key)}?expires=${o.expires}${o.download ? `&download=${encodeURIComponent(o.download)}` : ""}`;
  }
  publicUrl(key: string) {
    return this.o.publicUrl ? `${this.o.publicUrl.replace(/\/+$/, "")}/${encodeURI(key)}` : null;
  }
  async copy(from: string, to: string) {
    const v = this.objects.get(from);
    if (!v) throw new Error("no such object");
    this.objects.set(to, { ...v, at: new Date().toISOString() });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(o: { prefix?: string; delimiter?: string; cursor?: string | null; limit?: number } = {}) {
    const prefix = o.prefix ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const objects: StoredObject[] = [];
    const prefixes = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const cut = o.delimiter ? rest.indexOf(o.delimiter) : -1;
      if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
      else objects.push(this.meta(k, this.objects.get(k)!));
    }
    const start = o.cursor ? Number(o.cursor) : 0;
    const limit = o.limit ?? 1000;
    return { objects: objects.slice(start, start + limit), prefixes: [...prefixes], cursor: start + limit < objects.length ? String(start + limit) : null };
  }
}
