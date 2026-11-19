/**
 * Clients for an app that runs agent-cms. Browser- and edge-safe (only
 * `fetch`).
 *
 * - `createCmsClient({ url, key })`: the agent tools over MCP with an API key
 *   (scripts, CI, another service, the CLI). Never ship a write key to a browser.
 * - `createRestClient({ url })`: the REST API with the browser's session
 *   cookie. This is what the copied admin screens use.
 */

import type { AssetListOptions, AssetUsage, AssetView, UploadInstructions, UploadRequest } from "./assets";
import type { AgentChange, BulkAction, BulkResult, DocDiff, PreviewLink, PreviewTtl } from "./cms";
import type { Diagnostic, ErrorParams } from "./errors";
import type { PatchOp } from "./patch";
import type { CommentThread, ReleaseView, ScheduledRun, TrashItem, TrashRef } from "./flow";
import type { Block, TocItem } from "./markdown";
import type { AuditEntry, AutosaveState, CmsComment, CmsDoc, CmsKey, CmsRelease, CmsVersion, DocCounts, DocInputWire, DocSummary, KeyScope, Presence, SavedFilter, VersionSummary } from "./wire";

export type { BlockedItem, CommentThread, ReleaseView, ScheduledRun, TrashItem, TrashRef } from "./flow";

/** What `POST /collections/:c/_preview` answers: the document as it would be, nothing saved. */
export interface DocPreview {
  blocks: Block[];
  toc: TocItem[];
  diagnostics: Diagnostic[];
  diff: string | null;
  publicUrl: string | null;
  assets: Record<string, { id: string; name: string; kind: string; url: string; alt: string; width: number | null; height: number | null }>;
}
/** The open release a document is in. */
export interface DocRelease {
  id: string;
  name: string;
  state: CmsRelease["state"];
  publishAt: string | null;
}

export interface CmsClientOptions {
  /** The CMS base URL, e.g. https://app.example.com/api/cms */
  url: string;
  /** An API key (`sgk_…`). */
  key: string;
  fetch?: typeof fetch;
  /** Sent as `x-agent-cms-client` (the CLI sends "cli"). */
  clientName?: string;
}

export class CmsRemoteError extends Error {
  constructor(
    message: string,
    /** e.g. "conflict_version", "forbidden_write", "not_found" (from the server), or "http" / "rpc" / "network". */
    public code: string,
    public extra: { kind?: string; status?: number; params?: ErrorParams; diagnostics?: Diagnostic[]; current?: unknown } = {}
  ) {
    super(message);
    this.name = "CmsRemoteError";
  }
  readonly isCmsRemoteError = true;
  get kind() {
    return this.extra.kind;
  }
  get status() {
    return this.extra.status;
  }
  get params() {
    return this.extra.params;
  }
  get diagnostics() {
    return this.extra.diagnostics;
  }
  /** On `conflict_version`: the working copy someone else saved (for a merge). */
  get current() {
    return this.extra.current;
  }
}

/** Like `isCmsError`: survives duplicated copies of this class in a bundle. */
export function isCmsRemoteError(e: unknown): e is CmsRemoteError {
  return !!e && typeof e === "object" && (e as { isCmsRemoteError?: unknown }).isCmsRemoteError === true;
}

export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createCmsClient(opts: CmsClientOptions) {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  let seq = 0;

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await doFetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${opts.key}`,
        ...(opts.clientName ? { "x-agent-cms-client": opts.clientName } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
    });
    const text = await res.text();
    let msg: { result?: unknown; error?: { message?: string; code?: string | number }; message?: string } | null = null;
    try {
      msg = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok || !msg) {
      // REST-shaped auth errors (expired key, invalid key) come back as { error, message }.
      const rest = msg as { error?: unknown; message?: string } | null;
      if (rest && typeof rest.error === "string") throw new CmsRemoteError(rest.message ?? rest.error, rest.error, { status: res.status });
      throw new CmsRemoteError(msg?.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`, "http", { status: res.status });
    }
    if (msg.error) throw new CmsRemoteError(msg.error.message ?? "RPC error", "rpc");
    return msg.result;
  }

  return {
    /** Tools this key can use. */
    async listTools(): Promise<RemoteTool[]> {
      const r = (await rpc("tools/list", {})) as { tools: RemoteTool[] };
      return r.tools;
    },
    /** Call one tool (see `CMS_TOOL_NAMES`). Throws CmsRemoteError on failure. */
    async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = (await rpc("tools/call", { name, arguments: args })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
        structuredContent?: Record<string, unknown>;
      };
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      if (r.isError) {
        const s = r.structuredContent as { error?: string; message?: string; kind?: string; params?: ErrorParams; diagnostics?: Diagnostic[]; current?: unknown } | undefined;
        if (s?.error) throw new CmsRemoteError(s.message ?? text, s.error, { kind: s.kind, params: s.params, diagnostics: s.diagnostics, current: s.current });
        const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
        throw new CmsRemoteError(m ? m[2] : text, m ? m[1] : "tool");
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return r.structuredContent as T;
      }
    },
  };
}

export type CmsClient = ReturnType<typeof createCmsClient>;

// ── REST (admin screens) ──────────────────────────────────────────────────────

export interface RestClientOptions {
  /** The CMS base URL, e.g. "/api/cms" in the browser. */
  url: string;
  fetch?: typeof fetch;
  /** Extra headers (e.g. a key for server-side use). */
  headers?: Record<string, string>;
}

export interface Me {
  actor: { kind: string; label?: string; id?: string | null };
  isAdmin: boolean;
  previewLinks: boolean;
  /** Days something stays in the trash (0: there is no trash). */
  trashDays?: number;
  /** The media library, when the app has one and this actor may see it. */
  media?: MediaInfo | null;
  collections: { slug: string; label: string; visibility: "public" | "internal"; canWrite: boolean; canPublish: boolean }[];
}

export type { AssetUsage, AssetView } from "./assets";

export interface MediaStoreInfo {
  name: string;
  label: string;
  visibility: "public" | "private";
  /** File types the store takes (MIME types, `image/*` groups, `.ext`). */
  accept: readonly string[];
  maxFileSize: number;
  can: { write: boolean; delete: boolean; browse: boolean };
}

export interface MediaInfo {
  stores: MediaStoreInfo[];
  partSize: number;
}

export interface FolderTree {
  store: string;
  label: string;
  visibility: "public" | "private";
  total: number;
  folders: { path: string; count: number }[];
}

/** One entry of a bucket listing. `asset` is set when the CMS has a row for the file. */
export interface StoreFile {
  key: string;
  name: string;
  size: number;
  mime: string;
  kind: AssetView["kind"];
  updatedAt: string | null;
  asset: AssetView | null;
}
export interface StoreListing {
  store: string;
  prefix: string;
  folders: { path: string; name: string }[];
  files: StoreFile[];
  cursor: string | null;
}
export type ShareTtl = "1h" | "24h" | "7d";

export type AssetCounts = Record<"all" | "image" | "video" | "audio" | "document" | "other", number>;
export type AssetDetail = AssetView & { usage: AssetUsage[]; usageHidden: number };

export interface CollectionSchema {
  slug: string;
  label: string;
  visibility: "public" | "internal";
  categories: string[] | null;
  draftsMode: boolean;
  hasUrl: boolean;
  fields: Record<string, unknown> | null;
  admin: Record<string, { label?: string; help?: string; widget?: string; accept?: string[]; maxFileSize?: number; store?: string }>;
  /** Images without alt text stop a save in this collection. */
  requireAlt?: boolean;
  forbiddenChars: string[];
  canWrite: boolean;
  canPublish: boolean;
  /** The collection's review rule, and whether it applies to you. */
  review?: { agents?: "required"; everyone?: "required" } | null;
  needsReview?: boolean;
}

export interface ListQuery {
  state?: "draft" | "published" | "modified" | "archived" | "scheduled" | "review";
  q?: string;
  category?: string;
  by?: "user" | "key" | "system";
  limit?: number;
  cursor?: string | null;
  hits?: boolean;
}

export function createRestClient(opts: RestClientOptions) {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const enc = encodeURIComponent;

  async function req<T>(method: string, path: string, o: { body?: unknown; ifMatch?: number; query?: Record<string, string | number | boolean | null | undefined> } = {}): Promise<T> {
    const qs = o.query
      ? Object.entries(o.query)
          .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== "")
          .map(([k, v]) => `${enc(k)}=${enc(v === true ? "1" : String(v))}`)
          .join("&")
      : "";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.ifMatch !== undefined ? { "if-match": `"v${o.ifMatch}"` } : {}),
          ...opts.headers,
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      });
    } catch (e) {
      throw new CmsRemoteError(e instanceof Error ? e.message : String(e), "network");
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; message?: string; kind?: string; params?: ErrorParams; diagnostics?: Diagnostic[]; current?: unknown };
      throw new CmsRemoteError(e.message ?? `HTTP ${res.status}`, e.error ?? "http", { kind: e.kind, status: res.status, params: e.params, diagnostics: e.diagnostics, current: e.current });
    }
    return data as T;
  }

  const doc = (c: string, s: string) => `/collections/${enc(c)}/${enc(s)}`;

  return {
    me: () => req<Me>("GET", "/_me"),
    schema: (c: string) => req<CollectionSchema>("GET", `/collections/${enc(c)}/_schema`),
    list: (c: string, q: ListQuery = {}) => req<{ docs: DocSummary[]; total: number; nextCursor: string | null }>("GET", `/collections/${enc(c)}`, { query: { fields: "summary", ...q } }),
    counts: (c: string) => req<{ counts: DocCounts }>("GET", `/collections/${enc(c)}/_counts`).then((r) => r.counts),
    get: (c: string, s: string, o: { draft?: boolean } = { draft: true }) => req<{ doc: CmsDoc }>("GET", doc(c, s), { query: { draft: o.draft } }).then((r) => r.doc),
    create: (c: string, d: DocInputWire, o: { publish?: boolean; note?: string } = {}) => req<{ doc: CmsDoc }>("POST", `/collections/${enc(c)}`, { body: { doc: d, ...o } }).then((r) => r.doc),
    update: (c: string, s: string, d: DocInputWire, o: { expectedVersion: number; publish?: boolean; note?: string }) =>
      req<{ doc: CmsDoc }>("PATCH", doc(c, s), { body: { doc: d, publish: o.publish, note: o.note }, ifMatch: o.expectedVersion }).then((r) => r.doc),
    remove: (c: string, s: string, expectedVersion?: number) => req<{ ok: true }>("DELETE", doc(c, s), { ifMatch: expectedVersion }),
    diagnose: (c: string, d: DocInputWire, slug?: string) => req<{ diagnostics: Diagnostic[] }>("POST", `/collections/${enc(c)}/_diagnose`, { body: { doc: d, slug } }).then((r) => r.diagnostics),
    patch: (c: string, s: string, ops: PatchOp[], o: { expectedVersion?: number; dryRun?: boolean } = {}) => req<{ doc: CmsDoc | null; diff: string; diagnostics: Diagnostic[]; saved: boolean }>("POST", `${doc(c, s)}/patch`, { body: { ops, ...o } }),
    autosave: (c: string, s: string, d: DocInputWire, baseVersion: number) => req<{ autosave: AutosaveState }>("PUT", `${doc(c, s)}/autosave`, { body: { doc: d, baseVersion } }).then((r) => r.autosave),
    discardAutosave: (c: string, s: string) => req<{ ok: true }>("DELETE", `${doc(c, s)}/autosave`),
    publish: (c: string, s: string, o: { expectedVersion?: number; version?: number } = {}) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/publish`, { body: { version: o.version }, ifMatch: o.expectedVersion }).then((r) => r.doc),
    unpublish: (c: string, s: string, expectedVersion?: number) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/unpublish`, { body: {}, ifMatch: expectedVersion }).then((r) => r.doc),
    archive: (c: string, s: string, expectedVersion?: number) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/archive`, { body: {}, ifMatch: expectedVersion }).then((r) => r.doc),
    unarchive: (c: string, s: string, expectedVersion?: number) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/unarchive`, { body: {}, ifMatch: expectedVersion }).then((r) => r.doc),
    bulk: (c: string, action: BulkAction, items: { slug: string; expectedVersion?: number }[]) => req<{ results: BulkResult[] }>("POST", `/collections/${enc(c)}/_bulk`, { body: { action, items } }).then((r) => r.results),
    versions: (c: string, s: string) => req<{ versions: VersionSummary[] }>("GET", `${doc(c, s)}/versions`, { query: { fields: "summary" } }).then((r) => r.versions),
    version: (c: string, s: string, n: number) => req<{ version: CmsVersion }>("GET", `${doc(c, s)}/versions/${n}`).then((r) => r.version),
    diff: (c: string, s: string, a: number, b: number) => req<DocDiff>("GET", `${doc(c, s)}/diff`, { query: { a, b } }),
    restore: (c: string, s: string, n: number, o: { expectedVersion?: number; publish?: boolean } = {}) =>
      req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/versions/${n}/restore`, { body: { publish: o.publish }, ifMatch: o.expectedVersion }).then((r) => r.doc),
    changes: (c: string, s: string) => req<{ changes: AgentChange[] }>("GET", `${doc(c, s)}/changes`).then((r) => r.changes),
    review: (c: string, s: string, hunks: string[] | "all", action: "accepted" | "reverted" = "accepted") => req<{ reviewed: number }>("POST", `${doc(c, s)}/review`, { body: { hunks, action } }),
    previewLink: (c: string, s: string, ttl: PreviewTtl = "24h", o: { comments?: boolean } = {}) => req<PreviewLink>("POST", `${doc(c, s)}/preview`, { body: { ttl, ...o } }),
    /** The working copy plus the open release it is in, if any. */
    getWithRelease: (c: string, s: string) => req<{ doc: CmsDoc; release?: DocRelease | null }>("GET", doc(c, s), { query: { draft: true } }),
    preview: (c: string, d: DocInputWire, slug?: string) => req<DocPreview>("POST", `/collections/${enc(c)}/_preview`, { body: { doc: d, slug } }),
    schedule: (c: string, s: string, b: { publishAt?: string | null; unpublishAt?: string | null; expectedVersion?: number }) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/schedule`, { body: b }).then((r) => r.doc),
    unschedule: (c: string, s: string) => req<{ doc: CmsDoc }>("DELETE", `${doc(c, s)}/schedule`).then((r) => r.doc),
    requestReview: (c: string, s: string, note?: string | null) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/review/request`, { body: { note } }).then((r) => r.doc),
    approveReview: (c: string, s: string, o: { publish?: boolean } = {}) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/review/approve`, { body: o }).then((r) => r.doc),
    rejectReview: (c: string, s: string, note?: string | null) => req<{ doc: CmsDoc }>("POST", `${doc(c, s)}/review/reject`, { body: { note } }).then((r) => r.doc),
    reviewRequests: (collection?: string) => req<{ requests: DocSummary[] }>("GET", "/reviews", { query: { collection } }).then((r) => r.requests),
    comments: (c: string, s: string) => req<{ comments: CommentThread[] }>("GET", `${doc(c, s)}/comments`).then((r) => r.comments),
    addComment: (c: string, s: string, b: { body: string; anchor?: string | null; quote?: string | null; threadId?: string | null }) => req<{ comment: CmsComment }>("POST", `${doc(c, s)}/comments`, { body: b }).then((r) => r.comment),
    resolveComment: (c: string, s: string, id: string, resolved = true) => req<{ comment: CmsComment }>("POST", `${doc(c, s)}/comments/${enc(id)}/resolve`, { body: { resolved } }).then((r) => r.comment),
    previewComments: (token: string) => req<{ comments: CommentThread[] }>("GET", "/preview/comments", { query: { token } }).then((r) => r.comments),
    addPreviewComment: (token: string, b: { name?: string | null; body: string; anchor?: string | null; quote?: string | null; threadId?: string | null }) => req<{ comment: CmsComment }>("POST", "/preview/comments", { query: { token }, body: b }).then((r) => r.comment),
    presence: (c: string, s: string, b: { cursor?: Presence["cursor"]; selection?: Presence["selection"] } = {}) => req<{ version: number; updatedBy: string | null; others: Presence[] }>("POST", `${doc(c, s)}/presence`, { body: b }),
    leave: (c: string, s: string) => req<{ ok: true }>("DELETE", `${doc(c, s)}/presence`),
    presenceIn: (c: string) => req<{ presence: { slug: string; people: Presence[] }[] }>("GET", `/collections/${enc(c)}/_presence`).then((r) => r.presence),
    labelVersion: (c: string, s: string, n: number, b: { label?: string | null; pinned?: boolean }) => req<{ version: CmsVersion }>("PATCH", `${doc(c, s)}/versions/${n}`, { body: b }).then((r) => r.version),
    filters: (c: string) => req<{ filters: (SavedFilter & { mine: boolean })[] }>("GET", `/collections/${enc(c)}/_filters`).then((r) => r.filters),
    saveFilter: (c: string, b: { name: string; query: Record<string, string>; shared?: boolean }) => req<{ filter: SavedFilter }>("POST", `/collections/${enc(c)}/_filters`, { body: b }).then((r) => r.filter),
    removeFilter: (c: string, id: string) => req<{ ok: true }>("DELETE", `/collections/${enc(c)}/_filters/${enc(id)}`),
    trash: (kind?: TrashRef["kind"]) => req<{ items: TrashItem[]; days: number; canPurge: boolean }>("GET", "/trash", { query: { kind } }),
    restoreTrash: (items: TrashRef[]) => req<{ restored: number }>("POST", "/trash/_restore", { body: { items: items.map((i) => ({ kind: i.kind, id: i.id })) } }),
    purgeTrash: (items: TrashRef[] | "all") => req<{ purged: number }>("POST", "/trash/_purge", { body: items === "all" ? { all: true } : { items: items.map((i) => ({ kind: i.kind, id: i.id })) } }),
    releases: () => req<{ releases: CmsRelease[] }>("GET", "/releases").then((r) => r.releases),
    release: (id: string) => req<{ release: ReleaseView }>("GET", `/releases/${enc(id)}`).then((r) => r.release),
    createRelease: (name: string) => req<{ release: ReleaseView }>("POST", "/releases", { body: { name } }).then((r) => r.release),
    renameRelease: (id: string, name: string) => req<{ release: ReleaseView }>("PATCH", `/releases/${enc(id)}`, { body: { name } }).then((r) => r.release),
    removeRelease: (id: string) => req<{ ok: true }>("DELETE", `/releases/${enc(id)}`),
    addToRelease: (id: string, items: { collection: string; slug: string; action?: "publish" | "unpublish" }[]) => req<{ release: ReleaseView }>("POST", `/releases/${enc(id)}/items`, { body: { items } }).then((r) => r.release),
    removeFromRelease: (id: string, documentId: string) => req<{ release: ReleaseView }>("DELETE", `/releases/${enc(id)}/items/${enc(documentId)}`).then((r) => r.release),
    publishRelease: (id: string) => req<{ release: CmsRelease }>("POST", `/releases/${enc(id)}/publish`, { body: {} }).then((r) => r.release),
    scheduleRelease: (id: string, publishAt: string | null) => req<{ release: ReleaseView }>("POST", `/releases/${enc(id)}/schedule`, { body: { publishAt } }).then((r) => r.release),
    search: (q: string, collections?: string[]) => req<{ empty: boolean; hits: { collection: string; slug: string; title: string; heading: string; anchor: string; score: number }[] }>("GET", "/search", { query: { q, collections: collections?.join(",") } }),
    keys: () => req<{ keys: CmsKey[] }>("GET", "/keys").then((r) => r.keys),
    createKey: (k: { name: string; scopes: KeyScope[]; collections?: string[] | null; expiresAt?: string | null }) => req<{ key: CmsKey; secret: string }>("POST", "/keys", { body: k }),
    revokeKey: (id: string) => req<{ ok: true }>("DELETE", `/keys/${enc(id)}`),
    assets: (q: Omit<AssetListOptions, "kinds"> & { kind?: string } = {}) => req<{ assets: AssetView[]; cursor: string | null; counts: AssetCounts }>("GET", "/assets", { query: { ...q } }),
    assetFolders: () => req<{ stores: FolderTree[] }>("GET", "/assets/_folders").then((r) => r.stores),
    createAssetFolder: (path: string, store?: string | null) => req<{ store: string; path: string }>("POST", "/assets/_folders", { body: { path, store } }),
    deleteAssetFolder: (path: string, store?: string | null) => req<{ ok: true }>("DELETE", "/assets/_folders", { query: { path, store } }),
    asset: (id: string) => req<{ asset: AssetDetail }>("GET", `/assets/${enc(id)}`).then((r) => r.asset),
    updateAsset: (id: string, patch: { alt?: string; tags?: string[] }) => req<{ asset: AssetView }>("PATCH", `/assets/${enc(id)}`, { body: patch }).then((r) => r.asset),
    moveAsset: (id: string, to: { folder?: string | null; name?: string | null }) => req<{ asset: AssetView }>("POST", `/assets/${enc(id)}/move`, { body: to }).then((r) => r.asset),
    /** Fails with `asset_in_use` (the documents are in `error.current`) unless `confirm` is set. */
    removeAsset: (id: string, o: { confirm?: boolean } = {}) => req<{ ok: true }>("DELETE", `/assets/${enc(id)}`, { query: { confirm: o.confirm } }),
    importAsset: (b: { url: string; name?: string | null; folder?: string | null; store?: string | null; alt?: string; tags?: string[] }) => req<{ asset: AssetView }>("POST", "/assets/_import", { body: b }).then((r) => r.asset),
    requestUpload: (b: UploadRequest) => req<{ asset: AssetView; upload: UploadInstructions }>("POST", "/assets/uploads", { body: b }),
    uploadStatus: (id: string) => req<{ asset: AssetView; partSize: number; partCount: number; done: number[] }>("GET", `/assets/uploads/${enc(id)}`),
    uploadPartUrls: (id: string, parts: number[]) => req<{ parts: { partNumber: number; url: string }[] }>("POST", `/assets/uploads/${enc(id)}/parts`, { body: { parts } }).then((r) => r.parts),
    completeUpload: (id: string, meta: { width?: number | null; height?: number | null; duration?: number | null } = {}) => req<{ asset: AssetView }>("POST", `/assets/uploads/${enc(id)}/complete`, { body: meta }).then((r) => r.asset),
    abortUpload: (id: string) => req<{ ok: true }>("DELETE", `/assets/uploads/${enc(id)}`),
    /** Store a small picture of the file (WebP, JPEG or PNG, up to 512KB). */
    async setAssetThumb(id: string, bytes: Blob | Uint8Array): Promise<AssetView> {
      let res: Response;
      try {
        res = await doFetch(`${base}/assets/${enc(id)}/thumb`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/octet-stream", ...opts.headers }, body: bytes as BodyInit });
      } catch (e) {
        throw new CmsRemoteError(e instanceof Error ? e.message : String(e), "network");
      }
      const data = (await res.json().catch(() => null)) as { asset?: AssetView; error?: string; message?: string; kind?: string; params?: ErrorParams } | null;
      if (!res.ok || !data?.asset) throw new CmsRemoteError(data?.message ?? `HTTP ${res.status}`, data?.error ?? "http", { kind: data?.kind, status: res.status, params: data?.params });
      return data.asset;
    },
    storeFiles: (store: string, q: { prefix?: string | null; q?: string; cursor?: string | null; limit?: number } = {}) => req<StoreListing>("GET", `/stores/${enc(store)}/files`, { query: { ...q } }),
    registerFile: (store: string, key: string, more: { alt?: string; tags?: string[] } = {}) => req<{ asset: AssetView }>("POST", `/stores/${enc(store)}/files/_register`, { body: { key, ...more } }).then((r) => r.asset),
    /** Move files and whole folders into the folder `to` ("" = the top). */
    moveFiles: (store: string, b: { keys?: string[]; folders?: string[]; to: string }) => req<{ moved: number; failed: { key: string; message: string }[] }>("POST", `/stores/${enc(store)}/files/_move`, { body: b }),
    /** Fails with `asset_in_use` unless `confirm` is set. `check: true` deletes nothing and only counts the files and their uses. */
    removeFiles: (store: string, b: { keys?: string[]; folders?: string[]; confirm?: boolean; check?: boolean }) => req<{ deleted: number; files: number; used: number; documents: AssetUsage[]; hidden: number }>("POST", `/stores/${enc(store)}/files/_delete`, { body: b }),
    shareAsset: (id: string, ttl: ShareTtl = "24h") => req<{ url: string; expiresAt: string | null }>("POST", `/assets/${enc(id)}/share`, { body: { ttl } }),
    /** Address of a file by its key (files the CMS has no row for). */
    storeFileUrl: (store: string, key: string, o: { download?: boolean } = {}) => `${base}/stores/${enc(store)}/files/_open?key=${enc(key)}${o.download ? "&download=1" : ""}`,
    /** Address of a file through the CMS route (`thumb`: its small picture). */
    fileUrl: (a: { id: string; name: string }, o: { thumb?: boolean; download?: boolean } = {}) => `${base}/files/${enc(a.id)}/${enc(a.name)}${o.thumb ? "?thumb=1" : o.download ? "?download=1" : ""}`,
    audit: (q: { cursor?: string | null; action?: string; outcome?: string; actorKind?: "user" | "key" | "system" | "anonymous"; limit?: number } = {}) => req<{ entries: AuditEntry[]; nextCursor: string | null }>("GET", "/audit", { query: q }),
  };
}

export type RestClient = ReturnType<typeof createRestClient>;
