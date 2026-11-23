/**
 * Vercel Blob as a `StorageAdapter` (`npm install @vercel/blob`).
 *
 *   import { vercelBlobStorage } from "@mainsoft/agent-cms/storage-vercel-blob";
 *
 *   createCms({
 *     media: {
 *       stores: {
 *         public: { visibility: "public", adapter: vercelBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN!, access: "public" }) },
 *       },
 *     },
 *   });
 *
 * `access` is how the Blob store was created (public or private); a private
 * store is read through signed links only.
 *
 * How it differs from S3-compatible storage:
 * - A file goes up in ONE request, whatever its size (`multipart: false`).
 *   There are no parts to retry one by one and nothing to carry on after a
 *   reload: a failed upload starts again.
 * - Blob decides the stored type from the file's extension and decides
 *   itself whether a file opens in the browser or downloads; `disposition`
 *   is not ours to set.
 * - No CORS rule to configure: Blob answers browsers on any origin.
 *
 * Checked against real public and private Blob stores with @vercel/blob 2.9.0
 * (2026-11-20). Only the package's documented calls are used.
 */

import type { PutOptions, SignedRequest, StorageAdapter, StorageList, StoredObject } from "./storage";

/** The parts of `@vercel/blob` this adapter calls. */
export interface VercelBlobApi {
  put(pathname: string, body: unknown, o: Record<string, unknown>): Promise<{ pathname: string }>;
  head(pathname: string, o: { token: string }): Promise<{ size: number; uploadedAt: Date | string; pathname: string; contentType?: string | null; etag?: string | null }>;
  get(pathname: string, o: Record<string, unknown>): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
  copy(from: string, to: string, o: Record<string, unknown>): Promise<unknown>;
  del(pathname: string | string[], o: { token: string }): Promise<void>;
  list(o: Record<string, unknown>): Promise<{ blobs: { pathname: string; size: number; uploadedAt: Date | string; etag?: string | null }[]; folders?: string[]; cursor?: string; hasMore: boolean }>;
  createFolder(pathname: string, o: Record<string, unknown>): Promise<unknown>;
  issueSignedToken(o: Record<string, unknown>): Promise<{ validUntil: number } & Record<string, unknown>>;
  presignUrl(token: unknown, o: Record<string, unknown>): Promise<{ presignedUrl: string }>;
  BlobNotFoundError?: abstract new (...args: never[]) => Error;
}

export interface VercelBlobStorageOptions {
  /** The store's read-write token (`BLOB_READ_WRITE_TOKEN`). Server only. */
  token: string;
  /** How the Blob store was created. */
  access: "public" | "private";
  /** Put every key under this folder of the store. */
  prefix?: string;
  fetch?: typeof fetch;
  /** A stand-in for the `@vercel/blob` module (tests). */
  blob?: VercelBlobApi;
}

export class VercelBlobError extends Error {
  constructor(
    readonly op: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`Vercel Blob ${op} failed: ${message}`, options);
    this.name = "VercelBlobError";
  }
}

/** Signed links cannot outlive this (Vercel's limit is 7 days). */
const MAX_LINK_MS = 7 * 24 * 3600 * 1000 - 60_000;
const TOKEN_LIFE_MS = 2 * 3600 * 1000;
const NO_PARTS = "Vercel Blob takes a file in one request; uploads in parts are not supported on this store";

/** "This blob is not there". A bundler may rename the class, so its name alone is not enough. */
const notFound = (e: unknown, b?: VercelBlobApi) =>
  !!e && typeof e === "object" && ((!!b?.BlobNotFoundError && e instanceof b.BlobNotFoundError) || (e as { name?: string }).name === "BlobNotFoundError" || (e as { constructor?: { name?: string } }).constructor?.name === "BlobNotFoundError");
class Missing extends Error {}
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (d: Date | string | undefined) => (d ? new Date(d).toISOString() : null);
const hasExt = (key: string) => /\.[A-Za-z0-9]{1,10}$/.test(key.split("/").pop() ?? "");
/** `max-age=N` out of a Cache-Control value, which is all Blob lets us set. */
const maxAge = (cacheControl: string | null | undefined) => {
  const m = /max-age=(\d+)/.exec(cacheControl ?? "");
  return m ? { cacheControlMaxAge: Number(m[1]) } : {};
};

export function vercelBlobStorage(o: VercelBlobStorageOptions): StorageAdapter & { readonly options: Readonly<VercelBlobStorageOptions> } {
  if (o.access !== "public" && o.access !== "private") throw new Error('agent-cms: vercelBlobStorage({ access }) must be "public" or "private", the way the Blob store was created');
  const storeId = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(o.token ?? "")?.[1];
  if (!storeId) throw new Error("agent-cms: vercelBlobStorage({ token }) needs the store's read-write token (BLOB_READ_WRITE_TOKEN, it starts with vercel_blob_rw_)");
  const { token, access } = o;
  const prefix = o.prefix ? `${o.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const doFetch = o.fetch ?? fetch;
  const full = (key: string) => prefix + key;
  const strip = (k: string) => (k.startsWith(prefix) ? k.slice(prefix.length) : k);
  const fixed = { access, token, addRandomSuffix: false, allowOverwrite: true };

  let lib: Promise<VercelBlobApi> | null = o.blob ? Promise.resolve(o.blob) : null;
  const load = () =>
    (lib ??= import("@vercel/blob").then(
      (m) => m as unknown as VercelBlobApi,
      (e) => {
        lib = null;
        throw new Error(`agent-cms: vercelBlobStorage() could not load "@vercel/blob" (npm install @vercel/blob): ${text(e)}`);
      }
    ));
  async function call<T>(op: string, fn: (b: VercelBlobApi) => Promise<T>): Promise<T> {
    const b = await load();
    try {
      return await fn(b);
    } catch (e) {
      if (notFound(e, b)) throw new Missing(text(e));
      throw new VercelBlobError(op, text(e), { cause: e });
    }
  }

  // One signing token per kind of work, shared by every link until it nears its end.
  const signers = new Map<string, Promise<{ validUntil: number }>>();
  async function signer(operation: "get" | "put", needMs: number) {
    const cached = await signers.get(operation)?.catch(() => null);
    if (cached && cached.validUntil - Date.now() >= needMs + 30_000) return cached;
    const made = call("sign", (b) => b.issueSignedToken({ token, operations: [operation], validUntil: Date.now() + Math.min(MAX_LINK_MS + 30_000, Math.max(needMs + 600_000, TOKEN_LIFE_MS)) }));
    signers.set(operation, made);
    return made;
  }
  async function presign(operation: "get" | "put", key: string, expires: number, more: Record<string, unknown> = {}) {
    const ms = Math.min(Math.max(1, expires) * 1000, MAX_LINK_MS);
    const t = await signer(operation, ms);
    return (await call("sign", (b) => b.presignUrl(t, { operation, pathname: full(key), access, validUntil: Date.now() + ms, ...more }))).presignedUrl;
  }

  async function head(key: string): Promise<StoredObject | null> {
    try {
      const h = await call("head", (b) => b.head(full(key), { token }));
      return { key, size: h.size, mime: h.contentType ?? null, etag: h.etag ?? null, lastModified: iso(h.uploadedAt) };
    } catch (e) {
      if (e instanceof Missing) return null;
      throw e;
    }
  }
  async function copy(from: string, to: string, mime?: string) {
    // Blob reads the type from the extension; a name without one needs it said.
    const contentType = mime ?? (hasExt(to) ? undefined : ((await head(from))?.mime ?? undefined));
    await call("copy", (b) => b.copy(full(from), full(to), { ...fixed, ...(contentType ? { contentType } : {}) }));
  }

  // What a browser contacts: signed uploads go to the Blob API (`https://vercel.com/api/blob`, or
  // VERCEL_BLOB_API_URL when set), signed reads to the store's own host.
  const apiOverride = (() => {
    try {
      const v = process.env.VERCEL_BLOB_API_URL || process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL;
      return v ? new URL(v).origin : null;
    } catch {
      return null;
    }
  })();
  const browserOrigins = [apiOverride ?? "https://vercel.com", `https://${storeId.toLowerCase()}.${access}.blob.vercel-storage.com`];

  return {
    options: o,
    multipart: false,
    browserOrigins,
    async presignPut(key, p): Promise<SignedRequest> {
      const url = await presign("put", key, p.expires, { addRandomSuffix: false, allowOverwrite: true, ...(p.size ? { maximumSizeInBytes: p.size } : {}), ...maxAge(p.cacheControl) });
      return { url, headers: { "content-type": p.mime } };
    },
    async put(key, body, p: PutOptions) {
      if (key.endsWith("/")) {
        // An empty folder. Making one that is already there is fine.
        await call("createFolder", (b) => b.createFolder(full(key).replace(/\/+$/, ""), { token, access })).catch(async (e) => {
          if (!(await head(key))) throw e;
        });
        return;
      }
      if (!body.length) {
        // The package refuses an empty body; a signed request takes one.
        const signed = await this.presignPut(key, { ...p, expires: 300 });
        const res = await doFetch(signed.url, { method: "PUT", headers: signed.headers, body: body as BodyInit });
        if (!res.ok) throw new VercelBlobError("put", `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        await res.arrayBuffer().catch(() => {});
        return;
      }
      await call("put", (b) => b.put(full(key), new Blob([body as BlobPart]), { ...fixed, contentType: p.mime, ...maxAge(p.cacheControl) }));
    },
    async createMultipart() {
      throw new VercelBlobError("createMultipart", NO_PARTS);
    },
    async presignPart() {
      throw new VercelBlobError("presignPart", NO_PARTS);
    },
    async listParts() {
      return [];
    },
    async completeMultipart() {
      throw new VercelBlobError("completeMultipart", NO_PARTS);
    },
    async abortMultipart() {},
    head,
    async readStart(key, bytes) {
      if (bytes <= 0) return new Uint8Array();
      try {
        const got = await call("read", (b) => b.get(full(key), { access, token, headers: { range: `bytes=0-${bytes - 1}` } }));
        if (!got) return null;
        if (!got.stream) return new Uint8Array();
        return new Uint8Array(await new Response(got.stream).arrayBuffer()).slice(0, bytes);
      } catch (e) {
        if (e instanceof Missing) return null;
        // A range of an empty file cannot be answered.
        const h = await head(key);
        if (!h) return null;
        if (h.size === 0) return new Uint8Array();
        throw e;
      }
    },
    async presignGet(key, g) {
      const url = await presign("get", key, g.expires);
      return g.download ? `${url}&download=1` : url;
    },
    publicUrl(key) {
      return access === "public" ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${full(key).split("/").map(encodeURIComponent).join("/")}` : null;
    },
    copy: (from, to) => copy(from, to),
    /**
     * A file a browser sent is stored as a download. Copying it onto itself
     * from the server makes Blob apply its usual rule (pictures, PDF, video
     * and sound open in the browser), in about a second even for large files.
     */
    async settle(key, p) {
      if (p.disposition?.startsWith("attachment")) return;
      await copy(key, key, p.mime);
    },
    async delete(key) {
      await call("delete", (b) => b.del(full(key), { token }));
    },
    async list(l = {}): Promise<StorageList> {
      const r = await call("list", (b) => b.list({ token, prefix: prefix + (l.prefix ?? ""), mode: l.delimiter ? "folded" : "expanded", limit: l.limit ?? 1000, ...(l.cursor ? { cursor: l.cursor } : {}) }));
      return {
        objects: r.blobs.map((x) => ({ key: strip(x.pathname), size: x.size, mime: null, etag: x.etag ?? null, lastModified: iso(x.uploadedAt) })),
        prefixes: (r.folders ?? []).map(strip),
        cursor: r.hasMore && r.cursor ? r.cursor : null,
      };
    },
  };
}
