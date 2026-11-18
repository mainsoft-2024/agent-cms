/**
 * Clients for an app that runs agent-cms. Browser- and edge-safe (only
 * `fetch`).
 *
 * - `createCmsClient({ url, key })`: the agent tools over MCP with an API key
 *   (scripts, CI, another service, the CLI). Never ship a write key to a browser.
 * - `createRestClient({ url })`: the REST API with the browser's session
 *   cookie. This is what the copied admin screens use.
 */

import type { AgentChange, BulkAction, BulkResult, DocDiff, PreviewLink, PreviewTtl } from "./cms";
import type { Diagnostic, ErrorParams } from "./errors";
import type { PatchOp } from "./patch";
import type { AuditEntry, AutosaveState, CmsDoc, CmsKey, CmsVersion, DocCounts, DocInputWire, DocSummary, KeyScope, VersionSummary } from "./wire";

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
  collections: { slug: string; label: string; visibility: "public" | "internal"; canWrite: boolean; canPublish: boolean }[];
}

export interface CollectionSchema {
  slug: string;
  label: string;
  visibility: "public" | "internal";
  categories: string[] | null;
  draftsMode: boolean;
  hasUrl: boolean;
  fields: Record<string, unknown> | null;
  admin: Record<string, { label?: string; help?: string; widget?: string }>;
  forbiddenChars: string[];
  canWrite: boolean;
  canPublish: boolean;
}

export interface ListQuery {
  state?: "draft" | "published" | "modified" | "archived";
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
    previewLink: (c: string, s: string, ttl: PreviewTtl = "24h") => req<PreviewLink>("POST", `${doc(c, s)}/preview`, { body: { ttl } }),
    search: (q: string, collections?: string[]) => req<{ empty: boolean; hits: { collection: string; slug: string; title: string; heading: string; anchor: string; score: number }[] }>("GET", "/search", { query: { q, collections: collections?.join(",") } }),
    keys: () => req<{ keys: CmsKey[] }>("GET", "/keys").then((r) => r.keys),
    createKey: (k: { name: string; scopes: KeyScope[]; collections?: string[] | null; expiresAt?: string | null }) => req<{ key: CmsKey; secret: string }>("POST", "/keys", { body: k }),
    revokeKey: (id: string) => req<{ ok: true }>("DELETE", `/keys/${enc(id)}`),
    audit: (q: { cursor?: string | null; action?: string; outcome?: string; actorKind?: "user" | "key" | "system" | "anonymous"; limit?: number } = {}) => req<{ entries: AuditEntry[]; nextCursor: string | null }>("GET", "/audit", { query: q }),
  };
}

export type RestClient = ReturnType<typeof createRestClient>;
