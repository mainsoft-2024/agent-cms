/**
 * The media library: files in a storage, a row per file, and the rules about
 * who may do what. `createCms({ media })` turns it on; `cms.assets` is this.
 *
 * Bytes never pass through here on the normal path: the browser asks for a
 * signed address (`requestUpload`), sends the file to the storage itself, and
 * says when it is done (`completeUpload`), at which point the server checks
 * what actually arrived.
 */

import { z } from "zod";
import type { AnyCollection } from "./cms";
import type { CmsErrorCode, CmsErrorOptions, Diagnostic, ErrorParams } from "./errors";
import { assetUses, externalImages } from "./markdown";
import { FetchGuardError, guardedFetch, imageSize, type ResolveHost } from "./net-guard";
import { docsById, type AssetSort, type CmsRepo } from "./repo";
import { makeZip, zipNames } from "./zip";
import {
  acceptsFile,
  ASSET_ID_RE,
  cleanFolder,
  cleanName,
  contentMatches,
  declaredMatches,
  DEFAULT_ACCEPT,
  DEFAULT_MAX_FILE_SIZE,
  dispositionFor,
  extOf,
  joinKey,
  kindOf,
  mimeOf,
  MIME_BY_EXT,
  newAssetId,
  numberedName,
  PART_SIZE,
  RESERVED_FOLDER,
  sniff,
  type StorageList,
  THUMB_PREFIX,
  DERIVED_PREFIX,
  REPLACE_PREFIX,
  stripJpegMetadata,
  type StorageAdapter,
} from "./storage";
import type { Actor, AssetKind, AuditAction, CmsAsset, CmsDoc, DocContent } from "./types";

export interface MediaStoreConfig {
  /** Name shown in the admin. Default: the store's key. */
  label?: string;
  /** `public`: anyone with the address can read. `private`: opened through the CMS after a permission check. */
  visibility: "public" | "private";
  adapter: StorageAdapter;
  /** Replace the default rule for one action. Default: see `canAsset`. */
  access?: Partial<Record<"read" | "write" | "delete" | "browse", (a: { actor: Actor; store: string }) => boolean>>;
  /** File types this store takes (replaces `media.accept` for this store). */
  accept?: readonly string[];
  /** Largest file in bytes (replaces `media.maxFileSize` for this store). */
  maxFileSize?: number;
}

export interface ScanFile {
  store: string;
  key: string;
  name: string;
  mime: string;
  size: number;
  url: string | null;
  bytes?: Uint8Array;
}

export type ImageFormat = "webp" | "avif" | "jpeg" | "png";

/** One named size of an image. With both sides and `fit: "cover"` the picture is cropped around its focal point. */
export interface ImagePreset {
  width?: number;
  height?: number;
  /** `inside` (default): fits within the box, never enlarged. `cover`: fills the box exactly, cropping what sticks out. */
  fit?: "inside" | "cover";
  format?: ImageFormat;
  /** 1..100. Default: the library's own for the format. */
  quality?: number;
}

export interface ImageJob {
  width: number | null;
  height: number | null;
  fit: "inside" | "cover";
  format: ImageFormat;
  quality: number | null;
  focal: { x: number; y: number } | null;
}

/** What makes resized copies (`sharpTransforms()` from `./image-sharp`, or your own). */
export interface ImageTransforms {
  presets: Record<string, ImagePreset>;
  /** The format of sizes that do not name one. */
  format: ImageFormat;
  make(bytes: Uint8Array, job: ImageJob): Promise<{ bytes: Uint8Array; width: number; height: number }>;
  /** Originals above this many bytes are served as they are. Default 40MB. */
  maxInputBytes?: number;
  /** Copies made at the same time. Default 4. */
  concurrency?: number;
  /** A request waits this long for a copy, then gets the original. Default 10000. */
  timeoutMs?: number;
}

export interface MediaOptions {
  /** The first one is the default store. */
  stores: Record<string, MediaStoreConfig>;
  /** File types every store takes unless it says otherwise. Default `DEFAULT_ACCEPT`. */
  accept?: readonly string[];
  /** Largest file in bytes. Default 5GB. */
  maxFileSize?: number;
  /** Turn an image address into a resized one (your CDN, an image proxy, `/_next/image`). */
  imageUrl?: (o: { url: string; width: number; asset: AssetInfo }) => string;
  /**
   * Named image sizes made on the server: `sharpTransforms({ presets })`
   * from `@mainsoft/agent-cms/image-sharp`. A size is made the first time
   * `/files/<id>/<name>?size=<name>` is asked for and kept in the store.
   */
  transforms?: ImageTransforms;
  /**
   * Remove what cameras write into JPEG photos (location, time, device)
   * before they are stored. The admin does it in the browser, so the data
   * never leaves the person's computer; imports are cleaned on the server.
   * Default false.
   */
  stripMetadata?: boolean;
  /** How long a link to a private file works, in seconds. Default 300. */
  linkTtlSeconds?: number;
  /** Largest file an agent may import by URL, in bytes. Default 50MB. */
  importMaxBytes?: number;
  /**
   * Your own check of every file that arrives (a virus scanner, a content
   * policy). Called once when an upload completes, a file is imported or
   * stored by the server, or a file already in the bucket is registered.
   * `url` is a signed address that works for 10 minutes (null when the file
   * is not stored yet; then `bytes` is set). Return `false` or
   * `{ ok: false, reason }` to refuse; throwing refuses too. A refused file
   * is deleted (a registered one is left alone) and the caller gets
   * `asset_rejected`.
   */
  scan?: (file: ScanFile) => boolean | void | { ok: boolean; reason?: string } | Promise<boolean | void | { ok: boolean; reason?: string }>;
  /** Where the CMS route serves files. Default `/api/cms/files`. */
  filesUrl?: string;
  /** For tests and unusual networks: how `import` fetches and resolves host names. */
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
}

/** A file as callers see it: the row plus where to get it. */
export interface AssetView extends CmsAsset {
  visibility: "public" | "private";
  /** Address through the CMS route (permission-checked, works for both kinds of store). */
  href: string;
  /** Direct address when the store is public and has one. */
  publicUrl: string | null;
  thumbHref: string | null;
}

/** What a page needs to show a file (`cms.assetsFor(doc)`). */
export interface AssetInfo {
  id: string;
  name: string;
  kind: AssetKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  alt: string;
  url: string;
  visibility: "public" | "private";
  /** The point to keep in view when cropping (`object-position: ${x * 100}% ${y * 100}%`), or null. */
  focal: { x: number; y: number } | null;
}

export interface AssetUsage {
  collection: string;
  slug: string;
  title: string;
  status: CmsDoc["status"];
  inDraft: boolean;
  inPublished: boolean;
}

export type UploadInstructions =
  | { kind: "single"; url: string; headers: Record<string, string> }
  | { kind: "multipart"; partSize: number; partCount: number };

export interface UploadRequest {
  name: string;
  /** What the browser says the file is. The extension decides when it is a known one. */
  mime?: string | null;
  size: number;
  folder?: string | null;
  store?: string | null;
  alt?: string;
  tags?: string[];
  /** Uploading for one field: its `accept` and `maxFileSize` apply too. */
  field?: { collection: string; path: string } | null;
  /** New content for this file: same id, same address, same type. Folder, store, alt and tags are the file's own. */
  replace?: string | null;
}

export interface AssetListOptions {
  store?: string | null;
  /** This folder and everything under it ("" or missing: the whole store). */
  folder?: string | null;
  kinds?: readonly AssetKind[];
  q?: string;
  tag?: string;
  /** Only files no document uses. */
  unused?: boolean;
  /** Only images without alt text. */
  missingAlt?: boolean;
  /** Default "new". */
  sort?: AssetSort;
  cursor?: string | null;
  limit?: number;
}

export interface AssetsContext {
  repo: CmsRepo;
  media: MediaOptions | undefined;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  diag: (path: string, code: CmsErrorCode, params: ErrorParams, severity: Diagnostic["severity"]) => Diagnostic;
  audit: (actor: Actor, action: AuditAction, o?: { outcome?: "ok" | "denied" | "failed"; detail?: Record<string, unknown> }) => void;
  nowIso: () => string;
  actorRef: (actor: Actor) => { kind: "user" | "key" | "system"; id: string | null; label: string; agent: string | null };
  collection: (slug: string) => AnyCollection;
  /**
   * The copy of a document `actor` may see (0.18.0): the working copy when they may edit it, the
   * published copy when they may read that, else null.
   */
  docViewFor: (actor: Actor, doc: CmsDoc) => { doc: CmsDoc; draft: boolean } | null;
  /** A role's word on a store (`media:<store>` target, 0.17.0); undefined when the person has no roles. */
  roleAllows?: (actor: Actor, store: string, what: "write" | "delete") => boolean | undefined;
  warn: (key: string, message: string) => void;
  ready: () => Promise<void> | void;
  /** Days a deleted file stays in the trash (0: deleted at once). */
  trashDays?: number;
}

const SIGN_SECONDS = 3600;
const MAX_THUMB_BYTES = 512 * 1024;
const TAG_MAX = 30;
const IMAGE_EXT: Record<ImageFormat, string> = { webp: "webp", avif: "avif", jpeg: "jpg", png: "png" };
const FOREVER = "public, max-age=31536000, immutable";

/** A short stable name for a set of values (FNV-1a). */
function stamp(v: unknown): string {
  let h = 0x811c9dc5;
  for (const c of JSON.stringify(v)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(36);
}
/** A replaced file keeps its address; `?v=` makes caches fetch it again. */
const withRev = (url: string, rev: number) => (rev > 0 ? `${url}${url.includes("?") ? "&" : "?"}v=${rev}` : url);
const focalOf = (a: Pick<CmsAsset, "focalX" | "focalY">) => (a.focalX !== null && a.focalY !== null ? { x: a.focalX, y: a.focalY } : null);
/** Pictures a resizer can take: not vector drawings, not animations. */
const resizable = (a: Pick<CmsAsset, "kind" | "mime">) => a.kind === "image" && a.mime !== "image/svg+xml" && a.mime !== "image/gif";

/** A field that holds a media library file: `fields: z.object({ cover: assetId().optional() })` with `admin.fields.cover.widget: "image"`. */
export const assetId = () => z.string().regex(ASSET_ID_RE, "not a file id");

export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

const cleanTags = (tags: unknown): string[] => [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, TAG_MAX);
const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

/** The asset fields of a collection: path, widget and rules (from `admin.fields`). */
export function assetFields(cfg: AnyCollection): { path: string; widget: "image" | "file"; accept: readonly string[] | null; maxFileSize: number | null; store: string | null }[] {
  return Object.entries(cfg.admin?.fields ?? {})
    .filter(([, f]) => f.widget === "image" || f.widget === "file")
    .map(([path, f]) => ({ path, widget: f.widget as "image" | "file", accept: f.accept ?? (f.widget === "image" ? ["image/*"] : null), maxFileSize: f.maxFileSize ?? null, store: f.store ?? null }));
}

export function createAssets(ctx: AssetsContext) {
  const { repo, media, fail } = ctx;
  const names = Object.keys(media?.stores ?? {});
  const filesUrl = (media?.filesUrl ?? "/api/cms/files").replace(/\/+$/, "");
  const ttl = media?.linkTtlSeconds ?? 300;
  const transforms = media?.transforms ?? null;

  for (const n of names) {
    const s = media!.stores[n];
    const rules = s.accept ?? media!.accept ?? DEFAULT_ACCEPT;
    if (s.visibility === "public" && acceptsFile(rules, { name: "x.html", mime: "text/html" })) ctx.warn(`media-html-${n}`, `the public store "${n}" accepts HTML files: anyone who can upload can publish a web page under its address`);
  }

  function storeOf(name?: string | null): { name: string; cfg: MediaStoreConfig } {
    if (!media || !names.length) throw fail("media_disabled");
    const n = name || names[0];
    const cfg = media.stores[n];
    if (!cfg) throw fail("unknown_store", { store: n });
    return { name: n, cfg };
  }

  /**
   * Default rules. Read (list, info, open a private file): signed-in people
   * and valid keys. Write (upload, import, alt, tags, new folder): admins and
   * keys with `write`. Delete (move, rename, delete): admins and keys with
   * `publish`. A store's `access` replaces any of the three.
   */
  function canAsset(actor: Actor, store: string, what: "read" | "write" | "delete"): boolean {
    const cfg = media?.stores[store];
    if (!cfg) return false;
    if (actor.kind === "system") return true;
    const own = cfg.access?.[what];
    if (own) return own({ actor, store });
    if (actor.kind === "anonymous") return false;
    if (what === "read") return true;
    if (actor.kind === "user") return actor.isAdmin || (ctx.roleAllows?.(actor, store, what) ?? false);
    return actor.scopes.includes("admin") || actor.scopes.includes(what === "write" ? "write" : "publish");
  }
  function need(actor: Actor, store: string, what: "read" | "write" | "delete") {
    if (canAsset(actor, store, what)) return;
    if (actor.kind !== "anonymous" && what !== "read") ctx.audit(actor, "access.denied", { outcome: "denied", detail: { store, need: `asset.${what}` } });
    throw actor.kind === "anonymous" ? fail("unauthorized") : fail("forbidden_media", { store });
  }

  const rulesOf = (cfg: MediaStoreConfig) => ({ accept: cfg.accept ?? media?.accept ?? DEFAULT_ACCEPT, maxFileSize: cfg.maxFileSize ?? media?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE });

  function view(a: CmsAsset): AssetView {
    const cfg = media?.stores[a.store];
    const href = `${filesUrl}/${a.id}/${encodeURIComponent(a.name)}`;
    const direct = cfg?.visibility === "public" ? cfg.adapter.publicUrl(a.key) : null;
    return { ...a, visibility: cfg?.visibility ?? "private", href, publicUrl: direct ? withRev(direct, a.rev) : null, thumbHref: a.thumbKey ? `${href}?thumb=1${a.rev ? `&v=${a.rev}` : ""}` : null };
  }
  const info = (a: CmsAsset): AssetInfo => {
    const v = view(a);
    return { id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size, width: a.width, height: a.height, duration: a.duration, alt: a.alt, url: v.publicUrl ?? v.href, visibility: v.visibility, focal: focalOf(a) };
  };

  async function load(id: string, o: { pending?: boolean } = {}): Promise<CmsAsset> {
    const a = ASSET_ID_RE.test(id) ? await repo.findAsset(id) : null;
    if (!a || !media?.stores[a.store] || (a.status !== "ready" && !o.pending)) throw fail("asset_not_found", { id });
    return a;
  }

  /** A key nothing uses yet: `name`, then `name-2`, `name-3`… */
  async function freeKey(store: { name: string; cfg: MediaStoreConfig }, folder: string, name: string, skipId?: string): Promise<{ key: string; name: string }> {
    for (let n = 1; n <= 200; n++) {
      const candidate = numberedName(name, n);
      const key = joinKey(folder, candidate);
      const row = await repo.findAssetByKey(store.name, key);
      if (row && row.id !== skipId) continue;
      // Files that got into the bucket some other way are not overwritten either.
      if (!row && (await store.cfg.adapter.head(key))) continue;
      return { key, name: candidate };
    }
    throw fail("invalid", { reason: "too many files with this name" });
  }

  /** Name, folder, type and size checks shared by every way a file comes in. */
  function admit(store: { name: string; cfg: MediaStoreConfig }, input: { name: string; mime?: string | null; size: number; folder?: string | null; field?: UploadRequest["field"] }) {
    const name = cleanName(input.name);
    const folder = cleanFolder(input.folder);
    if (folder === null) throw fail("invalid_folder", { folder: String(input.folder) });
    if (!Number.isInteger(input.size) || input.size <= 0) throw fail("invalid", { reason: "size" });
    if (!declaredMatches(name, input.mime)) throw fail("asset_type_mismatch", { name, mime: String(input.mime) });
    const mime = mimeOf(name, input.mime);
    const rules = rulesOf(store.cfg);
    let max = rules.maxFileSize;
    let ok = acceptsFile(rules.accept, { name, mime });
    let allowed = rules.accept;
    if (input.field) {
      const f = assetFields(ctx.collection(input.field.collection)).find((x) => x.path === input.field!.path);
      if (f?.accept) {
        ok = ok && acceptsFile(f.accept, { name, mime });
        allowed = f.accept;
      }
      if (f?.maxFileSize) max = Math.min(max, f.maxFileSize);
    }
    if (!ok) throw fail("asset_type_not_allowed", { name, mime, allowed: [...allowed] });
    if (input.size > max) throw fail("asset_too_large", { size: input.size, max: humanSize(max), maxBytes: max }, { status: 413 });
    return { name, folder, mime };
  }

  async function requestUpload(actor: Actor, input: UploadRequest): Promise<{ asset: AssetView; upload: UploadInstructions }> {
    await ctx.ready();
    const target = input.replace ? await replaceable(actor, input.replace, input) : null;
    const store = storeOf(target ? target.store : input.store);
    need(actor, store.name, "write");
    const a = target ? admit(store, { name: target.name, mime: target.mime, size: input.size, folder: target.folder }) : admit(store, input);
    const id = newAssetId();
    // New content waits beside the library until it is checked; only then does it take the file's place.
    const free = target ? { key: `${REPLACE_PREFIX}${target.id}/${id}${extOf(target.name) ? `.${extOf(target.name)}` : ""}`, name: target.name } : await freeKey(store, a.folder, a.name);
    const put = { mime: a.mime, disposition: dispositionFor(free.name, a.mime) };
    const who = ctx.actorRef(actor);
    let upload: UploadInstructions;
    let uploadId: string | null = null;
    if (input.size <= PART_SIZE || store.cfg.adapter.multipart === false) {
      const signed = await store.cfg.adapter.presignPut(free.key, { ...put, expires: SIGN_SECONDS, size: input.size });
      upload = { kind: "single", url: signed.url, headers: signed.headers };
    } else {
      uploadId = await store.cfg.adapter.createMultipart(free.key, put);
      upload = { kind: "multipart", partSize: PART_SIZE, partCount: Math.ceil(input.size / PART_SIZE) };
    }
    const row = await repo.insertAsset({
      id,
      store: store.name,
      key: free.key,
      folder: a.folder,
      name: free.name,
      kind: kindOf(a.mime),
      mime: a.mime,
      size: input.size,
      width: null,
      height: null,
      duration: null,
      alt: (input.alt ?? "").trim().slice(0, 500),
      tags: cleanTags(input.tags),
      thumbKey: null,
      status: "pending",
      uploadId,
      createdBy: who.label,
      createdByKind: who.kind,
      createdByAgent: who.agent,
      createdAt: ctx.nowIso(),
      updatedAt: ctx.nowIso(),
    });
    return { asset: view(row), upload };
  }

  /** Signed addresses for parts of a large upload (1-based part numbers). */
  async function partUrls(actor: Actor, id: string, parts: readonly number[]): Promise<{ partNumber: number; url: string }[]> {
    const a = await load(id, { pending: true });
    need(actor, a.store, "write");
    if (a.status !== "pending" || !a.uploadId) throw fail("asset_not_found", { id });
    const count = Math.ceil(a.size / PART_SIZE);
    const wanted = [...new Set(parts)].filter((n) => Number.isInteger(n) && n >= 1 && n <= count).slice(0, 200);
    const adapter = storeOf(a.store).cfg.adapter;
    return Promise.all(wanted.map(async (partNumber) => ({ partNumber, url: await adapter.presignPart(a.key, a.uploadId!, partNumber, SIGN_SECONDS) })));
  }

  /** Where an unfinished upload stands (to carry on after a broken connection). */
  async function uploadStatus(actor: Actor, id: string): Promise<{ asset: AssetView; partSize: number; partCount: number; done: number[] }> {
    const a = await load(id, { pending: true });
    need(actor, a.store, "write");
    const done = a.status === "pending" && a.uploadId ? (await storeOf(a.store).cfg.adapter.listParts(a.key, a.uploadId)).map((p) => p.partNumber) : [];
    return { asset: view(a), partSize: PART_SIZE, partCount: Math.ceil(a.size / PART_SIZE), done };
  }

  async function discard(a: CmsAsset) {
    const adapter = media?.stores[a.store]?.adapter;
    if (adapter) {
      if (a.uploadId) await adapter.abortMultipart(a.key, a.uploadId).catch(() => {});
      await adapter.delete(a.key).catch(() => {});
      if (a.thumbKey) await adapter.delete(a.thumbKey).catch(() => {});
      await dropDerived(a);
    }
    await repo.deleteAsset(a.id);
  }

  // ── replacing a file's content ────────────────────────────────────────────

  /** The file `id` when this actor may replace it with what `input` describes. */
  async function replaceable(actor: Actor, id: string, input: { name: string; mime?: string | null }): Promise<CmsAsset> {
    const t = await load(id);
    need(actor, t.store, "delete");
    // The address ends in the old extension, so the new content must be the same kind of file.
    if (t.kind === "folder" || mimeOf(cleanName(input.name), input.mime) !== t.mime) throw fail("asset_replace_type", { name: input.name, mime: t.mime });
    return t;
  }

  /** The new content is at the file's address: forget what was made from the old one and record the change. */
  async function replaced(actor: Actor, t: CmsAsset, now: { size: number; width: number | null; height: number | null; duration: number | null }): Promise<CmsAsset> {
    const adapter = storeOf(t.store).cfg.adapter;
    if (t.thumbKey) await adapter.delete(t.thumbKey).catch(() => {});
    await dropDerived(t);
    const row = (await repo.updateAsset(t.id, { ...now, thumbKey: null, rev: t.rev + 1, updatedAt: ctx.nowIso() }))!;
    ctx.audit(actor, "asset.replace", { detail: { id: t.id, store: t.store, key: t.key, size: now.size, was: t.size } });
    return row;
  }

  /** Replace a file's content with bytes the server holds. Same id, same address; documents need no change. */
  async function replace(actor: Actor, id: string, input: { bytes: Uint8Array; mime?: string | null; width?: number | null; height?: number | null; duration?: number | null }): Promise<AssetView> {
    await ctx.ready();
    const t = await replaceable(actor, id, { name: (await load(id)).name, mime: input.mime });
    const store = storeOf(t.store);
    const bytes = media?.stripMetadata && t.mime === "image/jpeg" ? stripJpegMetadata(input.bytes) : input.bytes;
    admit(store, { name: t.name, mime: t.mime, size: bytes.length, folder: t.folder });
    if (!contentMatches(t.mime, bytes.subarray(0, 4096))) throw fail("asset_type_mismatch", { name: t.name, mime: t.mime });
    await scanned(actor, { store: t.store, key: t.key, name: t.name, mime: t.mime, size: bytes.length, bytes }, null);
    await store.cfg.adapter.put(t.key, bytes, { mime: t.mime, disposition: dispositionFor(t.name, t.mime) });
    const given = dims(input);
    const read = t.kind === "image" && !given.width ? imageSize(bytes) : null;
    return view(await serverThumb(await replaced(actor, t, { size: bytes.length, width: given.width ?? read?.width ?? null, height: given.height ?? read?.height ?? null, duration: given.duration }), bytes));
  }

  // ── image sizes ───────────────────────────────────────────────────────────

  const made = new Set<string>();
  const making = new Map<string, Promise<string | null>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  const jobOf = (a: Pick<CmsAsset, "focalX" | "focalY">, p: ImagePreset): ImageJob => ({ width: p.width ?? null, height: p.height ?? null, fit: p.fit ?? "inside", format: p.format ?? transforms!.format, quality: p.quality ?? null, focal: focalOf(a) });

  /**
   * The key of an image at a named size, made now when it is not there yet.
   * Null means "serve the original": the file is not a picture a resizer
   * takes, it is too large, or making the copy failed or took too long.
   */
  async function sized(a: CmsAsset, size: string): Promise<string | null> {
    const preset = transforms?.presets[size];
    if (!transforms || !preset) throw fail("unknown_image_size", { size });
    if (!resizable(a) || a.size > (transforms.maxInputBytes ?? 40 * 1024 * 1024)) return null;
    const job = jobOf(a, preset);
    // The name changes with the content, the focal point and the size's own settings, so an old copy is never served for a new picture.
    const key = `${DERIVED_PREFIX}${a.id}/${size}-${stamp([a.rev, a.size, job])}.${IMAGE_EXT[job.format]}`;
    if (made.has(key)) return key;
    let work = making.get(key);
    if (!work) {
      work = (async () => {
        const adapter = storeOf(a.store).cfg.adapter;
        if (await adapter.head(key)) return key;
        if (active >= (transforms.concurrency ?? 4)) await new Promise<void>((go) => waiting.push(go));
        else active++;
        try {
          const bytes = await adapter.readStart(a.key, a.size);
          if (!bytes) return null;
          const out = await transforms.make(bytes, job);
          await adapter.put(key, out.bytes, { mime: `image/${job.format}`, cacheControl: FOREVER });
          return key;
        } finally {
          const next = waiting.shift();
          if (next) next(); // the slot goes straight to whoever waited longest
          else active--;
        }
      })()
        .then((k) => (k && made.add(k), k))
        .catch((e) => (ctx.warn(`image-size-${a.id}-${size}`, `could not make size "${size}" of ${a.key}: ${e instanceof Error ? e.message : String(e)}`), null))
        .finally(() => making.delete(key));
      making.set(key, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), transforms.timeoutMs ?? 10_000)));
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Remove the resized copies of a file (it is going away, or its content changed). */
  async function dropDerived(a: Pick<CmsAsset, "id" | "store">): Promise<void> {
    const adapter = media?.stores[a.store]?.adapter;
    if (!adapter || !transforms) return;
    try {
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof adapter.list>> = await adapter.list({ prefix: `${DERIVED_PREFIX}${a.id}/`, cursor, limit: 200 });
        for (const o of page.objects) {
          await adapter.delete(o.key).catch(() => {});
          made.delete(o.key);
        }
        cursor = page.cursor;
      } while (cursor);
    } catch {
      // Leftover copies cost a little space; they never show for the new content (their names differ).
    }
  }

  /** A list picture for a file the server stored itself (an import): nobody's browser made one. */
  async function serverThumb(row: CmsAsset, bytes: Uint8Array): Promise<CmsAsset> {
    if (!transforms || !resizable(row) || bytes.length > (transforms.maxInputBytes ?? 40 * 1024 * 1024)) return row;
    try {
      const out = await transforms.make(bytes, { width: 480, height: 480, fit: "inside", format: "webp", quality: null, focal: null });
      const key = `${THUMB_PREFIX}${row.id}.webp`;
      await storeOf(row.store).cfg.adapter.put(key, out.bytes, { mime: "image/webp", cacheControl: FOREVER });
      return (await repo.updateAsset(row.id, { thumbKey: key })) ?? row;
    } catch {
      return row;
    }
  }

  const dims = (o: { width?: unknown; height?: unknown; duration?: unknown }) => {
    const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v) : null);
    return { width: int(o.width), height: int(o.height), duration: typeof o.duration === "number" && Number.isFinite(o.duration) && o.duration >= 0 ? o.duration : null };
  };

  /** The browser says the bytes are in the storage. Check what arrived and make the file usable. */
  async function completeUpload(actor: Actor, id: string, meta: { width?: number | null; height?: number | null; duration?: number | null } = {}): Promise<AssetView> {
    const a = await load(id, { pending: true });
    need(actor, a.store, "write");
    if (a.status === "ready") return view(a);
    const adapter = storeOf(a.store).cfg.adapter;
    if (a.uploadId) {
      const parts = await adapter.listParts(a.key, a.uploadId);
      const count = Math.ceil(a.size / PART_SIZE);
      const have = new Set(parts.map((p) => p.partNumber));
      const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !have.has(n));
      if (missing.length || parts.reduce((s, p) => s + p.size, 0) !== a.size) throw fail("upload_incomplete", { missing: missing.slice(0, 50).join(",") });
      await adapter.completeMultipart(a.key, a.uploadId, parts);
    }
    const head = await adapter.head(a.key);
    if (!head) throw fail("upload_incomplete", {});
    if (head.size !== a.size) {
      await discard({ ...a, uploadId: null });
      throw fail("upload_incomplete", { size: head.size, expected: a.size });
    }
    const start = (await adapter.readStart(a.key, 4096)) ?? new Uint8Array();
    if (!contentMatches(a.mime, start)) {
      await discard({ ...a, uploadId: null });
      throw fail("asset_type_mismatch", { name: a.name, mime: a.mime });
    }
    await scanned(actor, { store: a.store, key: a.key, name: a.name, mime: a.mime, size: head.size }, adapter).catch(async (e) => {
      await discard({ ...a, uploadId: null });
      throw e;
    });
    const given = dims(meta);
    const read = a.kind === "image" && !given.width ? imageSize(start) : null;
    const settle = (key: string, name: string) => adapter.settle?.(key, { mime: a.mime, disposition: dispositionFor(name, a.mime) });
    if (a.key.startsWith(REPLACE_PREFIX)) {
      const t = await repo.findAsset(a.key.slice(REPLACE_PREFIX.length).split("/")[0]);
      if (!t || t.status !== "ready" || !canAsset(actor, t.store, "delete")) {
        await discard({ ...a, uploadId: null });
        throw fail("asset_not_found", { id });
      }
      await adapter.copy(a.key, t.key);
      await settle(t.key, t.name);
      await discard({ ...a, uploadId: null });
      return view(await replaced(actor, t, { size: head.size, width: given.width ?? read?.width ?? null, height: given.height ?? read?.height ?? null, duration: given.duration }));
    }
    await settle(a.key, a.name);
    const row = (await repo.updateAsset(a.id, { status: "ready", uploadId: null, width: given.width ?? read?.width ?? null, height: given.height ?? read?.height ?? null, duration: given.duration, updatedAt: ctx.nowIso() }))!;
    ctx.audit(actor, "asset.upload", { detail: { id: a.id, store: a.store, key: a.key, size: a.size } });
    return view(row);
  }

  async function abortUpload(actor: Actor, id: string): Promise<void> {
    const a = await load(id, { pending: true });
    need(actor, a.store, "write");
    if (a.status === "pending") await discard(a);
  }

  /** A small picture of the file for lists (made by the browser, or by the app). */
  async function setThumb(actor: Actor, id: string, bytes: Uint8Array): Promise<AssetView> {
    const a = await load(id);
    need(actor, a.store, "write");
    const family = sniff(bytes);
    if (!bytes.length || bytes.length > MAX_THUMB_BYTES || !(family === "webp" || family === "jpeg" || family === "png")) throw fail("asset_type_not_allowed", { name: "thumbnail", mime: String(family), allowed: ["image/webp", "image/jpeg", "image/png"] });
    const ext = family === "jpeg" ? "jpg" : family;
    const key = `${THUMB_PREFIX}${a.id}.${ext}`;
    await storeOf(a.store).cfg.adapter.put(key, bytes, { mime: `image/${family}`, cacheControl: "public, max-age=31536000, immutable" });
    if (a.thumbKey && a.thumbKey !== key) await storeOf(a.store).cfg.adapter.delete(a.thumbKey).catch(() => {});
    return view((await repo.updateAsset(a.id, { thumbKey: key, updatedAt: ctx.nowIso() }))!);
  }

  /** Store bytes the server already holds (imports, scripts, tests). */
  async function put(actor: Actor, input: Omit<UploadRequest, "size"> & { bytes: Uint8Array; width?: number | null; height?: number | null; duration?: number | null }): Promise<AssetView> {
    await ctx.ready();
    const store = storeOf(input.store);
    need(actor, store.name, "write");
    if (media?.stripMetadata && mimeOf(cleanName(input.name), input.mime) === "image/jpeg") input = { ...input, bytes: stripJpegMetadata(input.bytes) };
    const a = admit(store, { ...input, size: input.bytes.length });
    if (!contentMatches(a.mime, input.bytes.subarray(0, 4096))) throw fail("asset_type_mismatch", { name: a.name, mime: a.mime });
    const free = await freeKey(store, a.folder, a.name);
    await scanned(actor, { store: store.name, key: free.key, name: free.name, mime: a.mime, size: input.bytes.length, bytes: input.bytes }, null);
    await store.cfg.adapter.put(free.key, input.bytes, { mime: a.mime, disposition: dispositionFor(free.name, a.mime) });
    const who = ctx.actorRef(actor);
    const given = dims(input);
    const kind = kindOf(a.mime);
    const read = kind === "image" && !given.width ? imageSize(input.bytes) : null;
    const row = await repo.insertAsset({
      id: newAssetId(),
      store: store.name,
      key: free.key,
      folder: a.folder,
      name: free.name,
      kind,
      mime: a.mime,
      size: input.bytes.length,
      width: given.width ?? read?.width ?? null,
      height: given.height ?? read?.height ?? null,
      duration: given.duration,
      alt: (input.alt ?? "").trim().slice(0, 500),
      tags: cleanTags(input.tags),
      thumbKey: null,
      status: "ready",
      uploadId: null,
      createdBy: who.label,
      createdByKind: who.kind,
      createdByAgent: who.agent,
      createdAt: ctx.nowIso(),
      updatedAt: ctx.nowIso(),
    });
    ctx.audit(actor, "asset.upload", { detail: { id: row.id, store: row.store, key: row.key, size: row.size } });
    return view(await serverThumb(row, input.bytes));
  }

  /** Fetch a file from the public internet and store it (https only; private addresses are refused). */
  async function importFromUrl(actor: Actor, input: { url: string; name?: string | null; folder?: string | null; store?: string | null; alt?: string; tags?: string[] }): Promise<AssetView> {
    const store = storeOf(input.store);
    need(actor, store.name, "write");
    const maxBytes = Math.min(media?.importMaxBytes ?? 50 * 1024 * 1024, rulesOf(store.cfg).maxFileSize);
    let got: Awaited<ReturnType<typeof guardedFetch>>;
    try {
      got = await guardedFetch(input.url, { maxBytes, fetch: media?.fetch, resolveHost: media?.resolveHost });
    } catch (e) {
      if (!(e instanceof FetchGuardError)) throw e;
      if (e.reason === "too_large") throw fail("asset_too_large", { max: humanSize(maxBytes), maxBytes }, { status: 413 });
      throw e.reason === "blocked" ? fail("import_blocked", { reason: e.message }) : fail("import_failed", { reason: e.message });
    }
    let fromUrl = "";
    try {
      fromUrl = decodeURIComponent(new URL(got.url).pathname.split("/").pop() ?? "");
    } catch {
      // keep the default name
    }
    return put(actor, { name: input.name?.trim() || fromUrl || "file", mime: got.mime, bytes: got.bytes, folder: input.folder, store: store.name, alt: input.alt, tags: input.tags });
  }

  async function list(actor: Actor, o: AssetListOptions = {}): Promise<{ assets: AssetView[]; cursor: string | null; counts: Record<"all" | "image" | "video" | "audio" | "document" | "other", number> }> {
    await ctx.ready();
    const store = storeOf(o.store);
    need(actor, store.name, "read");
    const under = cleanFolder(o.folder) ?? "";
    const limit = Math.min(Math.max(o.limit ?? 48, 1), 200);
    const sort = o.sort && o.sort !== "new" ? o.sort : undefined;
    const offset = sort && o.cursor?.startsWith("o:") ? Math.max(0, Number(o.cursor.slice(2)) || 0) : 0;
    const rows = await repo.listAssets({ store: store.name, under, status: "ready", notKinds: ["folder"], kinds: o.kinds?.length ? o.kinds : undefined, q: o.q, tag: o.tag, unused: o.unused || undefined, missingAlt: o.missingAlt || undefined, sort, offset, before: sort ? null : (o.cursor ?? null), limit: limit + 1 });
    const page = rows.slice(0, limit);
    const counts = { all: 0, image: 0, video: 0, audio: 0, document: 0, other: 0 };
    for (const c of await repo.countAssets(store.name)) {
      if (c.kind === "folder" || !(under === "" || c.folder === under || c.folder.startsWith(`${under}/`))) continue;
      counts[c.kind] += c.n;
      counts.all += c.n;
    }
    const last = page[page.length - 1];
    const cursor = rows.length > limit && last ? (sort ? `o:${offset + limit}` : `${last.createdAt}|${last.id}`) : null;
    return { assets: page.map(view), cursor, counts };
  }

  /** The stores this actor may read, each with its folders and how many files are in and under them. */
  async function folders(actor: Actor): Promise<{ store: string; label: string; visibility: "public" | "private"; total: number; folders: { path: string; count: number }[] }[]> {
    await ctx.ready();
    if (!media) throw fail("media_disabled");
    const out = [];
    for (const name of names) {
      if (!canAsset(actor, name, "read")) continue;
      const cfg = media.stores[name];
      const count = new Map<string, number>();
      let total = 0;
      for (const c of await repo.countAssets(name)) {
        const parts = c.folder ? c.folder.split("/") : [];
        // A file counts for its folder and every folder above it.
        for (let i = 1; i <= parts.length; i++) {
          const p = parts.slice(0, i).join("/");
          count.set(p, (count.get(p) ?? 0) + (c.kind === "folder" ? 0 : c.n));
        }
        if (c.kind !== "folder") total += c.n;
      }
      for (const f of await repo.listAssets({ store: name, kinds: ["folder"], status: "ready", limit: 2000 })) {
        const p = joinKey(f.folder, f.name);
        if (!count.has(p)) count.set(p, 0);
      }
      out.push({ store: name, label: cfg.label ?? name, visibility: cfg.visibility, total, folders: [...count].map(([path, n]) => ({ path, count: n })).sort((a, b) => a.path.localeCompare(b.path)) });
    }
    return out;
  }

  async function createFolder(actor: Actor, input: { store?: string | null; path: string }): Promise<{ store: string; path: string }> {
    await ctx.ready();
    const store = storeOf(input.store);
    need(actor, store.name, "write");
    const path = cleanFolder(input.path);
    if (!path) throw fail("invalid_folder", { folder: String(input.path) });
    const key = `${path}/`;
    if (!(await repo.findAssetByKey(store.name, key))) {
      const parts = path.split("/");
      const who = ctx.actorRef(actor);
      // An empty folder is a marker object, as S3 consoles do it.
      await store.cfg.adapter.put(key, new Uint8Array(), { mime: "application/x-directory" });
      await repo.insertAsset({ id: newAssetId(), store: store.name, key, folder: parts.slice(0, -1).join("/"), name: parts[parts.length - 1], kind: "folder", mime: "application/x-directory", size: 0, width: null, height: null, duration: null, alt: "", tags: [], thumbKey: null, status: "ready", uploadId: null, createdBy: who.label, createdByKind: who.kind, createdByAgent: who.agent });
    }
    return { store: store.name, path };
  }

  /** Remove an empty folder. */
  async function deleteFolder(actor: Actor, input: { store?: string | null; path: string }): Promise<void> {
    const store = storeOf(input.store);
    need(actor, store.name, "delete");
    const path = cleanFolder(input.path);
    if (!path) throw fail("invalid_folder", { folder: String(input.path) });
    const inside = await repo.listAssets({ store: store.name, under: path, limit: 2 });
    if (inside.length) throw fail("folder_not_empty", { folder: path });
    const row = await repo.findAssetByKey(store.name, `${path}/`);
    await store.cfg.adapter.delete(`${path}/`).catch(() => {});
    if (row) await repo.deleteAsset(row.id);
  }

  async function usage(actor: Actor, a: CmsAsset): Promise<{ documents: AssetUsage[]; hidden: number }> {
    const documents: AssetUsage[] = [];
    let hidden = 0;
    const refs = await repo.listAssetRefs(a.id);
    const docs = await docsById(repo, refs.map((r) => r.documentId));
    for (const r of refs) {
      const d = docs.get(r.documentId);
      if (!d) continue;
      // Documents the actor may not see are counted, not named. A reader sees the published copy:
      // its title, and only whether that copy uses the file.
      const seen = ctx.docViewFor(actor, d);
      if (!seen || (!seen.draft && !r.inPublished)) hidden++;
      else documents.push({ collection: d.collection, slug: d.slug, title: seen.doc.title, status: seen.draft ? d.status : "published", inDraft: seen.draft ? r.inDraft : false, inPublished: r.inPublished });
    }
    return { documents, hidden };
  }

  async function get(actor: Actor, id: string): Promise<AssetView & { usage: AssetUsage[]; usageHidden: number }> {
    await ctx.ready();
    const a = await load(id);
    need(actor, a.store, "read");
    const u = await usage(actor, a);
    return { ...view(a), usage: u.documents, usageHidden: u.hidden };
  }

  /** Several files as one zip (stored, not compressed). At most 200 files and 200MB. */
  async function zip(actor: Actor, ids: readonly string[], o: { maxCount?: number; maxBytes?: number } = {}): Promise<{ data: Uint8Array; name: string; files: number }> {
    await ctx.ready();
    const maxCount = o.maxCount ?? 200;
    const maxBytes = o.maxBytes ?? 200 * 1024 * 1024;
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) throw fail("invalid", { message: "ids: give at least one file" });
    const rows = [];
    for (const id of unique) {
      const a = await load(id);
      need(actor, a.store, "read");
      rows.push(a);
    }
    const total = rows.reduce((n, a) => n + a.size, 0);
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
    if (rows.length > maxCount || total > maxBytes) throw fail("zip_too_large", { count: rows.length, size: mb(total), maxCount, maxSize: mb(maxBytes) });
    const names = zipNames(rows.map((a) => (a.folder ? `${a.folder}/${a.name}` : a.name)));
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      const data = await storeOf(a.store).cfg.adapter.readStart(a.key, a.size);
      if (!data) throw fail("asset_not_found", { id: a.id });
      entries.push({ name: names[i], data, date: new Date(a.updatedAt) });
    }
    ctx.audit(actor, "asset.download", { detail: { files: rows.length, bytes: total } });
    return { data: makeZip(entries), name: `files-${new Date().toISOString().slice(0, 10)}.zip`, files: rows.length };
  }

  async function update(actor: Actor, id: string, patch: { alt?: string; tags?: string[]; focal?: { x: number; y: number } | null }): Promise<AssetView> {
    const a = await load(id);
    need(actor, a.store, "write");
    const unit = (v: number) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 1000) / 1000;
    const focal = patch.focal === undefined ? {} : patch.focal === null || a.kind !== "image" ? { focalX: null, focalY: null } : { focalX: unit(patch.focal.x), focalY: unit(patch.focal.y) };
    const row = await repo.updateAsset(a.id, { ...(patch.alt !== undefined ? { alt: String(patch.alt).trim().slice(0, 500) } : {}), ...(patch.tags !== undefined ? { tags: cleanTags(patch.tags) } : {}), ...focal, updatedAt: ctx.nowIso() });
    // Cropped sizes were cut around the old point.
    if ("focalX" in focal && (focal.focalX !== a.focalX || focal.focalY !== a.focalY)) await dropDerived(a);
    return view(row!);
  }

  /** Move to another folder and/or rename. Documents keep working: they point at the id. */
  async function move(actor: Actor, id: string, to: { folder?: string | null; name?: string | null }): Promise<AssetView> {
    const a = await load(id);
    need(actor, a.store, "delete");
    const store = storeOf(a.store);
    const folder = to.folder === undefined || to.folder === null ? a.folder : cleanFolder(to.folder);
    if (folder === null) throw fail("invalid_folder", { folder: String(to.folder) });
    let name = to.name ? cleanName(to.name) : a.name;
    // A rename keeps the kind of file: the extension stays.
    const ext = extOf(name);
    if (extOf(a.name) && ext !== extOf(a.name) && MIME_BY_EXT[ext] !== a.mime) name = cleanName(`${name}.${extOf(a.name)}`);
    if (folder === a.folder && name === a.name) return view(a);
    const free = await freeKey(store, folder, name, a.id);
    await store.cfg.adapter.copy(a.key, free.key);
    const row = (await repo.updateAsset(a.id, { key: free.key, folder, name: free.name, updatedAt: ctx.nowIso() }))!;
    await store.cfg.adapter.delete(a.key).catch(() => {});
    ctx.audit(actor, "asset.move", { detail: { id: a.id, store: a.store, from: a.key, to: free.key } });
    return view(row);
  }

  /** Delete a file. When documents use it, this fails with `asset_in_use` and their list unless `confirm` is set. */
  async function remove(actor: Actor, id: string, o: { confirm?: boolean } = {}): Promise<void> {
    const a = await load(id);
    need(actor, a.store, "delete");
    const u = await usage(actor, a);
    const count = u.documents.length + u.hidden;
    if (count && !o.confirm) throw fail("asset_in_use", { count, documents: u.documents.map((d) => `${d.collection}/${d.slug}`) }, { current: { documents: u.documents, hidden: u.hidden } });
    // With a trash only the row is marked: the object stays in the store (a
    // public address keeps answering) until the file is purged.
    const trash = (ctx.trashDays ?? 0) > 0 && a.kind !== "folder";
    if (trash) await repo.updateAsset(a.id, { deletedAt: ctx.nowIso(), deletedBy: ctx.actorRef(actor).label });
    else await discard(a);
    ctx.audit(actor, "asset.delete", { detail: { id: a.id, store: a.store, key: a.key, usedBy: count, trash } });
  }

  /** Files in the trash, in the stores this actor may read. */
  async function trashed(actor: Actor): Promise<CmsAsset[]> {
    await ctx.ready();
    return (await repo.listAssets({ trashed: true, limit: 1000 })).filter((a) => !!media?.stores[a.store] && canAsset(actor, a.store, "read"));
  }

  async function inTrash(id: string): Promise<CmsAsset> {
    const a = ASSET_ID_RE.test(id) ? await repo.findAsset(id, { trashed: true }) : null;
    if (!a?.deletedAt || !media?.stores[a.store]) throw fail("trash_not_found", { id });
    return a;
  }

  /** Take a file out of the trash. */
  async function untrash(actor: Actor, id: string): Promise<AssetView> {
    await ctx.ready();
    const a = await inTrash(id);
    need(actor, a.store, "delete");
    const out = (await repo.updateAsset(a.id, { deletedAt: null, deletedBy: null }))!;
    ctx.audit(actor, "asset.restore", { detail: { id: a.id, store: a.store, key: a.key } });
    return view(out);
  }

  /** Delete a trashed file for good: the object, its thumbnail and the row. False when it was not in the trash. */
  async function purge(actor: Actor, id: string): Promise<boolean> {
    const a = ASSET_ID_RE.test(id) ? await repo.findAsset(id, { trashed: true }) : null;
    if (!a?.deletedAt) return false;
    await discard(a);
    ctx.audit(actor, "asset.delete", { detail: { id: a.id, store: a.store, key: a.key, purge: true } });
    return true;
  }

  /** Purge every file that went to the trash at or before `cutoff`. */
  async function purgeOlder(cutoff: string): Promise<number> {
    let n = 0;
    for (const a of await repo.listAssets({ trashed: true, limit: 1000 })) {
      if (!a.deletedAt || a.deletedAt > cutoff) continue;
      await discard(a);
      n++;
    }
    return n;
  }

  /** Where to send someone who asks for the file: checks permission, then a public or a short-lived address. */
  async function open(actor: Actor, id: string, o: { thumb?: boolean; download?: boolean; size?: string | null } = {}): Promise<{ url: string; visibility: "public" | "private"; ttl: number }> {
    await ctx.ready();
    const a = await load(id);
    const store = storeOf(a.store);
    if (store.cfg.visibility === "private" || store.cfg.access?.read) need(actor, a.store, "read");
    const key = o.thumb && a.thumbKey ? a.thumbKey : o.size && !o.thumb ? ((await sized(a, o.size)) ?? a.key) : a.key;
    const plain = store.cfg.visibility === "public" && !o.download ? store.cfg.adapter.publicUrl(key) : null;
    const direct = plain && !key.startsWith(DERIVED_PREFIX) ? withRev(plain, a.rev) : plain;
    return { url: direct ?? (await store.cfg.adapter.presignGet(key, { expires: ttl, download: o.download ? a.name : null })), visibility: store.cfg.visibility, ttl };
  }

  /** Remove uploads that were started and never finished (default: older than 24 hours). */
  async function cleanup(o: { olderThanMs?: number } = {}): Promise<{ removed: number }> {
    if (!media) return { removed: 0 };
    const before = new Date(Date.parse(ctx.nowIso()) - (o.olderThanMs ?? 24 * 3600 * 1000)).toISOString();
    const stale = await repo.listAssets({ status: "pending", createdBefore: before, limit: 500 });
    for (const a of stale) await discard(a);
    return { removed: stale.length };
  }

  // ── documents ─────────────────────────────────────────────────────────────

  /** Ids of every file a piece of content uses (body and asset fields). */
  function idsIn(cfg: AnyCollection, c: Pick<DocContent, "body" | "fields">): Set<string> {
    const ids = new Set(assetUses(c.body).map((u) => u.id));
    for (const f of assetFields(cfg)) {
      const v = getPath(c.fields, f.path);
      if (typeof v === "string" && ASSET_ID_RE.test(v)) ids.add(v);
    }
    return ids;
  }

  /** Problems with the files a document uses. `known`: ids the saved document already had (a file deleted since is a warning there, not an error). */
  async function checkDoc(cfg: AnyCollection, c: DocContent, known: ReadonlySet<string> = new Set(), r: CmsRepo = repo): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    const uses = assetUses(c.body);
    const fields = assetFields(cfg);
    const fieldValues = fields.map((f) => ({ f, v: getPath(c.fields, f.path) })).filter((x): x is { f: (typeof fields)[number]; v: string } => typeof x.v === "string" && x.v !== "");
    const altSeverity = cfg.media?.requireAlt ? "error" : "warning";
    for (const e of externalImages(c.body)) if (!e.alt) out.push(ctx.diag("body", "asset_alt_missing", { line: e.line }, altSeverity));
    if (!uses.length && !fieldValues.length) return out;
    const ids = [...new Set([...uses.map((u) => u.id), ...fieldValues.map((x) => x.v)])];
    const rows = new Map((media ? await r.findAssets(ids.filter((i) => ASSET_ID_RE.test(i))) : []).filter((a) => a.status === "ready" && a.kind !== "folder").map((a) => [a.id, a]));
    const missing = (path: string, id: string, extra: ErrorParams = {}) => out.push(ctx.diag(path, "asset_missing", { id, ...extra }, known.has(id) ? "warning" : "error"));
    const isPublic = cfg.visibility === "public";
    const flagged = new Set<string>();
    const privateCheck = (path: string, a: CmsAsset) => {
      if (isPublic && media?.stores[a.store]?.visibility === "private" && !flagged.has(a.id)) {
        flagged.add(a.id);
        out.push(ctx.diag(path, "asset_private_in_public", { id: a.id, name: a.name }, "warning"));
      }
    };
    for (const u of uses) {
      const a = rows.get(u.id);
      if (!a) {
        missing("body", u.id, { line: u.line });
        continue;
      }
      if (u.as !== "file" && a.kind === "image" && !u.alt && !a.alt) out.push(ctx.diag("body", "asset_alt_missing", { line: u.line, id: a.id }, altSeverity));
      privateCheck("body", a);
    }
    for (const { f, v } of fieldValues) {
      const path = `fields.${f.path}`;
      const a = rows.get(v);
      if (!a) {
        missing(path, v);
        continue;
      }
      const fits = (f.widget !== "image" || a.kind === "image") && (!f.accept || acceptsFile(f.accept, { name: a.name, mime: a.mime })) && (!f.store || f.store === a.store);
      if (!fits) out.push(ctx.diag(path, "asset_wrong_kind", { id: a.id, name: a.name }, "error"));
      else if (f.maxFileSize && a.size > f.maxFileSize) out.push(ctx.diag(path, "asset_too_large", { size: a.size, max: humanSize(f.maxFileSize), maxBytes: f.maxFileSize }, "error"));
      else if (a.kind === "image" && !a.alt) out.push(ctx.diag(path, "asset_alt_empty", { id: a.id }, altSeverity));
      privateCheck(path, a);
    }
    return out;
  }

  /**
   * Throw the first file error of `next`. Files the saved document already
   * used do not block a save. Inside a transaction pass its `r`: a second
   * connection would wait for the first one forever on single-connection
   * databases.
   */
  async function assertDoc(cfg: AnyCollection, next: DocContent, prev?: DocContent | null, r: CmsRepo = repo): Promise<void> {
    if (prev && next.body === prev.body && JSON.stringify(next.fields) === JSON.stringify(prev.fields)) return;
    const errors = (await checkDoc(cfg, next, prev ? idsIn(cfg, prev) : undefined, r)).filter((d) => d.severity === "error");
    if (errors.length) throw fail(errors[0].code, errors[0].params, { diagnostics: errors });
  }

  /** Record which files `doc` uses, in its working copy and in what is published. */
  async function syncRefs(r: CmsRepo, doc: CmsDoc): Promise<void> {
    if (!media) return;
    const cfg = ctx.collection(doc.collection);
    const draft = idsIn(cfg, doc);
    const published = doc.published && doc.publishedVersion !== null ? idsIn(cfg, doc.published) : new Set<string>();
    await r.setAssetRefs(doc.id, [...new Set([...draft, ...published])].map((assetId) => ({ assetId, inDraft: draft.has(assetId), inPublished: published.has(assetId) })));
  }

  /** The files a document uses, by id, with what a page needs to show them. */
  async function assetsFor(doc: Pick<CmsDoc, "collection" | "body" | "fields">): Promise<Record<string, AssetInfo>> {
    if (!media) return {};
    const ids = [...idsIn(ctx.collection(doc.collection), doc)];
    const rows = ids.length ? await repo.findAssets(ids) : [];
    return Object.fromEntries(rows.filter((a) => a.status === "ready" && media.stores[a.store]).map((a) => [a.id, info(a)]));
  }

  /**
   * The address of an image at a named size (`media.transforms`), or at a
   * width through `media.imageUrl` when the app set one. Anything that
   * cannot be resized gets its plain address.
   */
  function imageUrl(asset: AssetInfo, o: { width?: number; size?: string }): string {
    if (asset.kind !== "image" || asset.mime === "image/svg+xml") return asset.url;
    if (o.size && transforms?.presets[o.size] && asset.mime !== "image/gif") return `${filesUrl}/${asset.id}/${encodeURIComponent(asset.name)}?size=${encodeURIComponent(o.size)}`;
    return media?.imageUrl && o.width ? media.imageUrl({ url: asset.url, width: o.width, asset }) : asset.url;
  }

  /** What the admin needs to know: stores, their rules, and what this actor may do. */
  /** The app's own check (`media.scan`). Refusing or throwing rejects the file: better no file than an unchecked one. */
  async function scanned(actor: Actor, f: Omit<ScanFile, "url">, adapter: MediaStoreConfig["adapter"] | null): Promise<void> {
    if (!media?.scan) return;
    let reason: string | null = null;
    try {
      const r = await media.scan({ ...f, url: adapter ? await adapter.presignGet(f.key, { expires: 600, download: null }) : null });
      if (r === false || (typeof r === "object" && r && !r.ok)) reason = (typeof r === "object" && r.reason) || "refused";
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (reason === null) return;
    ctx.audit(actor, "asset.upload", { outcome: "denied", detail: { store: f.store, key: f.key, reason } });
    throw fail("asset_rejected", { name: f.name, reason });
  }

  // ── the whole bucket (file manager) ───────────────────────────────────────
  //
  // The media library shows the files the CMS knows. These functions look at
  // the storage itself: files that got there some other way show up too, and
  // get a row only when someone uses them ("register").

  const reserved = (key: string) => key === RESERVED_FOLDER || key.startsWith(`${RESERVED_FOLDER}/`);
  /** Looking around a bucket: the store's `access.browse`, else whoever may read it. */
  const canBrowse = (actor: Actor, store: string): boolean => {
    const own = media?.stores[store]?.access?.browse;
    return own ? actor.kind === "system" || own({ actor, store }) : canAsset(actor, store, "read");
  };
  function needBrowse(actor: Actor, store: string) {
    if (!canBrowse(actor, store)) throw actor.kind === "anonymous" ? fail("unauthorized") : fail("forbidden_media", { store });
  }
  /** An object key as the caller gave it: inside the bucket, and not the CMS's own folder. */
  function objectKey(key: unknown): string {
    const k = String(key ?? "").replace(/^\/+/, "");
    if (!k || k.length > 1024 || reserved(k) || /[\u0000-\u001f]/.test(k) || k.split("/").some((p) => p === ".." || p === ".")) throw fail("invalid_folder", { folder: String(key) });
    return k;
  }
  /** A folder of the bucket as it is named there (not cleaned up: other programs name folders their own way). */
  function folderPath(folder: unknown, o: { top?: boolean } = {}): string {
    const f = String(folder ?? "").split("/").filter(Boolean).join("/");
    if ((f && objectKey(f) !== f) || (!f && !o.top)) throw fail("invalid_folder", { folder: String(folder) });
    return f;
  }
  const split = (key: string) => {
    const k = key.replace(/\/$/, "");
    const cut = k.lastIndexOf("/");
    return { folder: cut < 0 ? "" : k.slice(0, cut), name: k.slice(cut + 1) };
  };

  /** One level of a bucket: its sub-folders and files, with what the CMS knows about each file. */
  async function browse(actor: Actor, input: { store?: string | null; prefix?: string | null; q?: string | null; cursor?: string | null; limit?: number } = {}) {
    await ctx.ready();
    const store = storeOf(input.store);
    needBrowse(actor, store.name);
    const folder = folderPath(input.prefix, { top: true });
    const base = folder ? `${folder}/` : "";
    // Storage can only search by how a name starts.
    const r = await store.cfg.adapter.list({ prefix: base + String(input.q ?? "").replace(/\//g, ""), delimiter: "/", cursor: input.cursor || null, limit: Math.min(Math.max(input.limit ?? 200, 1), 1000) });
    const objects = r.objects.filter((o) => !o.key.endsWith("/") && !reserved(o.key));
    const known = new Map((await repo.findAssetsByKeys(store.name, objects.map((o) => o.key))).map((a) => [a.key, a]));
    return {
      store: store.name,
      prefix: folder,
      folders: r.prefixes.map((p) => p.replace(/\/$/, "")).filter((p) => !reserved(p)).map((p) => ({ path: p, name: p.slice(base.length) })),
      files: objects.map((o) => {
        const a = known.get(o.key);
        const name = split(o.key).name;
        const mime = a?.mime ?? mimeOf(name, o.mime);
        return { key: o.key, name, size: o.size, mime, kind: a?.kind ?? kindOf(mime), updatedAt: o.lastModified, asset: a?.status === "ready" ? view(a) : null };
      }),
      cursor: r.cursor,
    };
  }

  /** Give a file that is already in the bucket a row, so it can be described, used in documents and shared. */
  async function register(actor: Actor, input: { store?: string | null; key: string; alt?: string; tags?: string[] }): Promise<AssetView> {
    await ctx.ready();
    const store = storeOf(input.store);
    need(actor, store.name, "write");
    const key = objectKey(input.key);
    const existing = await repo.findAssetByKey(store.name, key);
    if (existing?.status === "ready") return view(existing);
    const head = existing || key.endsWith("/") ? null : await store.cfg.adapter.head(key);
    if (!head) throw fail("asset_not_found", { id: key });
    const { folder, name } = split(key);
    const mime = mimeOf(name, head.mime);
    const kind = kindOf(mime);
    await scanned(actor, { store: store.name, key, name, mime, size: head.size }, store.cfg.adapter);
    const size = kind === "image" ? imageSize((await store.cfg.adapter.readStart(key, 256 * 1024).catch(() => null)) ?? new Uint8Array()) : null;
    const who = ctx.actorRef(actor);
    const now = ctx.nowIso();
    const row = await repo.insertAsset({ id: newAssetId(), store: store.name, key, folder, name, kind, mime, size: head.size, width: size?.width ?? null, height: size?.height ?? null, duration: null, alt: (input.alt ?? "").trim().slice(0, 500), tags: cleanTags(input.tags), thumbKey: null, status: "ready", uploadId: null, createdBy: who.label, createdByKind: who.kind, createdByAgent: who.agent, createdAt: now, updatedAt: now });
    ctx.audit(actor, "asset.register", { detail: { id: row.id, store: row.store, key } });
    return view(row);
  }

  const MANY = 1000;
  /** Every object under the chosen files and folders (a folder: everything below it, its marker included). */
  async function expand(store: { name: string; cfg: MediaStoreConfig }, input: { keys?: readonly string[]; folders?: readonly string[] }, max = MANY): Promise<string[]> {
    const out = new Set<string>((input.keys ?? []).map(objectKey));
    for (const f of input.folders ?? []) {
      let cursor: string | null = null;
      do {
        const r: StorageList = await store.cfg.adapter.list({ prefix: `${folderPath(f)}/`, cursor, limit: 1000 });
        for (const o of r.objects) out.add(o.key);
        cursor = r.cursor;
        if (out.size > max) throw fail("too_many_files", { max });
      } while (cursor);
    }
    if (out.size > max) throw fail("too_many_files", { max });
    return [...out];
  }

  /**
   * Move files and whole folders into the folder `to`. A file that fails is
   * reported and the rest goes on; running it again moves what is left.
   * Documents keep working: they point at ids, and the rows follow the files.
   */
  async function moveMany(actor: Actor, input: { store?: string | null; keys?: readonly string[]; folders?: readonly string[]; to: string | null }): Promise<{ moved: number; failed: { key: string; message: string }[] }> {
    await ctx.ready();
    const store = storeOf(input.store);
    need(actor, store.name, "delete");
    const to = folderPath(input.to, { top: true });
    const plan: { from: string; dest: string }[] = (input.keys ?? []).map(objectKey).map((k) => ({ from: k, dest: joinKey(to, split(k).name) }));
    for (const f of input.folders ?? []) {
      const folder = folderPath(f);
      const base = joinKey(to, split(folder).name);
      if (base === folder) continue;
      if (base.startsWith(`${folder}/`)) throw fail("invalid_folder", { folder: to });
      for (const k of await expand(store, { folders: [folder] })) plan.push({ from: k, dest: base + k.slice(folder.length) });
      if (plan.length > MANY) throw fail("too_many_files", { max: MANY });
    }
    const adapter = store.cfg.adapter;
    const failed: { key: string; message: string }[] = [];
    let moved = 0;
    for (const p of plan) {
      if (p.from === p.dest) continue;
      try {
        const row = await repo.findAssetByKey(store.name, p.from);
        const marker = p.from.endsWith("/");
        // A name that is taken at the destination gets a number; nothing is overwritten.
        const dest = marker ? p.dest : (await freeKey(store, split(p.dest).folder, split(p.dest).name, row?.id)).key;
        await adapter.copy(p.from, dest);
        if (row) await repo.updateAsset(row.id, { key: dest, ...split(dest), updatedAt: ctx.nowIso() });
        await adapter.delete(p.from);
        if (!marker) moved++;
      } catch (e) {
        failed.push({ key: p.from, message: e instanceof Error ? e.message : String(e) });
      }
    }
    ctx.audit(actor, "asset.move", { outcome: failed.length ? "failed" : "ok", detail: { store: store.name, to, moved, failed: failed.length } });
    return { moved, failed };
  }

  /** Delete files and whole folders. Files that documents use stop it with `asset_in_use` unless `confirm` is set. */
  async function removeMany(actor: Actor, input: { store?: string | null; keys?: readonly string[]; folders?: readonly string[]; confirm?: boolean; check?: boolean }): Promise<{ deleted: number; files: number; used: number; documents: AssetUsage[]; hidden: number }> {
    await ctx.ready();
    const store = storeOf(input.store);
    need(actor, store.name, "delete");
    const keys = await expand(store, input);
    const rows = await repo.findAssetsByKeys(store.name, keys);
    const files = keys.filter((k) => !k.endsWith("/")).length;
    let used = 0;
    let hidden = 0;
    const documents = new Map<string, AssetUsage>();
    for (const a of rows) {
      const u = await usage(actor, a);
      if (u.documents.length + u.hidden) used++;
      hidden += u.hidden;
      for (const d of u.documents) documents.set(`${d.collection}/${d.slug}`, d);
    }
    const found = { files, used, documents: [...documents.values()], hidden };
    // `check`: only count, so a screen can say what a folder holds before anything is deleted.
    if (input.check) return { deleted: 0, ...found };
    if (used && !input.confirm) throw fail("asset_in_use", { count: documents.size + hidden, documents: [...documents.keys()] }, { current: { documents: [...documents.values()], hidden, files, used } });
    const byKey = new Map(rows.map((a) => [a.key, a]));
    for (const k of keys) {
      const a = byKey.get(k);
      if (a) await discard(a);
      else await store.cfg.adapter.delete(k);
    }
    ctx.audit(actor, "asset.delete", { detail: { store: store.name, files, usedBy: documents.size + hidden } });
    return { deleted: files, ...found };
  }

  const SHARE_SECONDS = { "1h": 3600, "24h": 24 * 3600, "7d": 7 * 24 * 3600 } as const;
  /**
   * An address to hand to someone outside. Private store: works until
   * `expiresAt` and cannot be taken back (it is a signed address). Public
   * store: the file's public address, which does not expire.
   */
  async function share(actor: Actor, id: string, o: { ttl?: keyof typeof SHARE_SECONDS } = {}): Promise<{ url: string; expiresAt: string | null }> {
    await ctx.ready();
    const a = await load(id);
    need(actor, a.store, "delete");
    const store = storeOf(a.store);
    const period = o.ttl ?? "24h";
    const seconds = SHARE_SECONDS[period];
    if (!seconds) throw fail("invalid", { reason: "ttl must be 1h, 24h or 7d" });
    const direct = store.cfg.visibility === "public" ? store.cfg.adapter.publicUrl(a.key) : null;
    const url = direct ?? (await store.cfg.adapter.presignGet(a.key, { expires: seconds, download: null }));
    ctx.audit(actor, "asset.share", { detail: { id: a.id, store: a.store, key: a.key, ttl: direct ? null : period } });
    return { url, expiresAt: direct ? null : new Date(Date.parse(ctx.nowIso()) + seconds * 1000).toISOString() };
  }

  /** Where to send someone who asks for a file by its key (files without a row have no id). */
  async function openKey(actor: Actor, input: { store?: string | null; key: string; download?: boolean }): Promise<{ url: string; visibility: "public" | "private" }> {
    await ctx.ready();
    const store = storeOf(input.store);
    needBrowse(actor, store.name);
    const key = objectKey(input.key);
    const direct = store.cfg.visibility === "public" && !input.download ? store.cfg.adapter.publicUrl(key) : null;
    return { url: direct ?? (await store.cfg.adapter.presignGet(key, { expires: ttl, download: input.download ? split(key).name : null })), visibility: store.cfg.visibility };
  }

  /**
   * Register every file of a store (or of one folder) that has no row yet,
   * and report rows whose file is gone. Nothing is deleted: a document may
   * still point at a missing file, and its check will say so.
   */
  async function sync(input: { store?: string | null; prefix?: string | null } = {}): Promise<{ registered: number; known: number; missing: { id: string; key: string }[] }> {
    await ctx.ready();
    const store = storeOf(input.store);
    const folder = folderPath(input.prefix, { top: true });
    const system: Actor = { kind: "system", label: "storage sync" };
    const seen = new Set<string>();
    let registered = 0;
    let cursor: string | null = null;
    do {
      const r: StorageList = await store.cfg.adapter.list({ prefix: folder ? `${folder}/` : "", cursor, limit: 1000 });
      const objects = r.objects.filter((o) => !o.key.endsWith("/") && !reserved(o.key));
      const have = new Set((await repo.findAssetsByKeys(store.name, objects.map((o) => o.key))).map((a) => a.key));
      for (const o of objects) {
        seen.add(o.key);
        if (!have.has(o.key)) (await register(system, { store: store.name, key: o.key }), registered++);
      }
      cursor = r.cursor;
    } while (cursor);
    const missing: { id: string; key: string }[] = [];
    let before: string | undefined;
    for (;;) {
      const rows = await repo.listAssets({ store: store.name, under: folder || undefined, status: "ready", notKinds: ["folder"], before, limit: 500 });
      for (const a of rows) if (!seen.has(a.key)) missing.push({ id: a.id, key: a.key });
      if (rows.length < 500) break;
      before = `${rows[rows.length - 1].createdAt}|${rows[rows.length - 1].id}`;
    }
    return { registered, known: seen.size - registered, missing };
  }

  function describe(actor: Actor) {
    if (!media) return null;
    const stores = names
      .filter((n) => canAsset(actor, n, "read"))
      .map((n) => {
        const cfg = media.stores[n];
        return { name: n, label: cfg.label ?? n, visibility: cfg.visibility, ...rulesOf(cfg), parts: cfg.adapter.multipart !== false, can: { write: canAsset(actor, n, "write"), delete: canAsset(actor, n, "delete"), browse: canBrowse(actor, n) } };
      });
    return stores.length ? { stores, partSize: PART_SIZE, stripMetadata: !!media.stripMetadata, sizes: Object.keys(transforms?.presets ?? {}) } : null;
  }

  return {
    enabled: !!media && names.length > 0,
    stores: () => names.map((n) => ({ name: n, ...media!.stores[n], ...rulesOf(media!.stores[n]) })),
    describe,
    can: canAsset,
    requestUpload,
    partUrls,
    uploadStatus,
    completeUpload,
    abortUpload,
    setThumb,
    put,
    replace,
    import: importFromUrl,
    list,
    zip,
    folders,
    createFolder,
    deleteFolder,
    get,
    update,
    move,
    remove,
    trashed,
    untrash,
    purge,
    purgeOlder,
    open,
    cleanup,
    browse,
    register,
    moveMany,
    removeMany,
    share,
    openKey,
    sync,
    checkDoc,
    assertDoc,
    syncRefs,
    idsIn,
    assetsFor,
    imageUrl,
  };
}

export type CmsAssets = ReturnType<typeof createAssets>;
