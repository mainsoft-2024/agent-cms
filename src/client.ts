/**
 * Clients for an app that runs agent-cms. Browser- and edge-safe (only
 * `fetch`).
 *
 * - `createCmsClient({ url, key })`: the agent tools over MCP with an API key
 *   (scripts, CI, another service, the CLI). Never ship a write key to a browser.
 * - `createRestClient({ url })`: the REST API with the browser's session
 *   cookie. This is what the copied admin screens use.
 */

import type { AutomationCondition, AutomationInput, AutomationRun, CmsAutomation } from "./automations";
import type { WebhookInput, WebhookView } from "./outbox";
import type { CmsRole, PersonMatch, RoleInput, RoleMember, RoleOp } from "./roles";
import type { CmsStats } from "./stats";
import type { ImportItem, ImportOptions, TransferFile } from "./transfer";
import type { CmsJob, WebhookDelivery, WebhookEvent } from "./types";
import type { AssetListOptions, AssetUsage, AssetView, UploadInstructions, UploadRequest } from "./assets";
import type { AgentChange, BulkAction, BulkResult, DocDiff, PreviewLink, PreviewTtl } from "./cms";
import type { Diagnostic, ErrorParams } from "./errors";
import type { PatchOp } from "./patch";
import type { CommentThread, ReleaseView, ScheduledRun, TrashItem, TrashRef } from "./flow";
import type { Block, TocItem } from "./markdown";
import type { AuditEntry, AutosaveState, CmsComment, CmsDoc, CmsKey, CmsRelease, CmsVersion, DocCounts, DocInputWire, DocSummary, KeyScope, Presence, SavedFilter, VersionSummary } from "./wire";

export type { BlockedItem, CommentThread, ReleaseView, ScheduledRun, TrashItem, TrashRef } from "./flow";
export type { WebhookInput, WebhookView } from "./outbox";
export type { CmsJob, WebhookDelivery, WebhookEvent } from "./types";
export type { AutomationAction, AutomationCondition, AutomationInput, AutomationRun, CmsAutomation } from "./automations";
export type { CmsRole, PersonMatch, RoleInput, RoleMember, RoleOp, RolePermissions } from "./roles";
export type { CmsStats } from "./stats";
export type { ImportConflict, ImportItem, ImportOptions, TransferFile } from "./transfer";

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

/** `Retry-After` in seconds ("120" or an HTTP date); undefined when absent or unreadable. */
export function retryAfterOf(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h.trim());
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

export class CmsRemoteError extends Error {
  constructor(
    message: string,
    /** e.g. "conflict_version", "forbidden_write", "not_found" (from the server), or "http" / "rpc" / "network". */
    public code: string,
    public extra: { kind?: string; status?: number; params?: ErrorParams; diagnostics?: Diagnostic[]; current?: unknown; /** Seconds to wait (from `Retry-After`) before trying again. */ retryAfter?: number; /** `X-Request-Id` of the failed request, for support and logs. */ requestId?: string } = {}
  ) {
    super(message);
    this.name = "CmsRemoteError";
  }
  readonly isCmsRemoteError = true;
  get kind() {
    return this.extra.kind;
  }
  get retryAfter() {
    return this.extra.retryAfter;
  }
  get requestId() {
    return this.extra.requestId;
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
  /** Signed in: the dashboard has numbers to show. */
  dashboard?: boolean;
  /** This caller may manage automations. */
  automations?: boolean;
  /** This caller may manage roles. */
  roles?: boolean;
  /** Webhooks can be made and this caller may manage them. */
  webhooks?: boolean;
  /** Menu entries plugins add. */
  nav?: { label: string; href: string; plugin: string }[];
  /** What plugins put into `_me`, by plugin name. */
  plugins?: Record<string, Record<string, unknown>>;
  actor: { kind: string; label?: string; id?: string | null; email?: string | null };
  isAdmin: boolean;
  previewLinks: boolean;
  /** Days something stays in the trash (0: there is no trash). */
  trashDays?: number;
  /** The zone schedules are shown and entered in. */
  timeZone?: string;
  /** The media library, when the app has one and this actor may see it. */
  media?: MediaInfo | null;
  collections: { slug: string; label: string; visibility: "public" | "internal"; canWrite: boolean; canPublish: boolean }[];
  /** The CMS's own sign-in, when the app uses it (`createAuth`). */
  auth?: { passwords: boolean; passkeys: boolean; sso: { label: string } | null; mail: boolean; adminPath: string; people: boolean } | null;
}

// ── own sign-in (`createAuth`) ────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  password: boolean;
  totp: boolean;
  passkeys: number;
  sso: boolean;
  roles: { id: string; name: string }[];
}
export interface AuthInvite {
  id: string;
  email: string;
  isAdmin: boolean;
  roleId: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}
export interface AuthDevice {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  device: string;
  method: string;
}
export interface AuthPasskey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  synced: boolean;
}
export interface AuthState {
  setup: boolean;
  methods: { password: boolean; passkey: boolean; sso: { label: string } | null };
  mail: boolean;
  user: AuthUser | null;
  mfaSetup: boolean;
  adminPath: string;
}
export type LoginResult = { ok: true; mfaSetup?: boolean; user: AuthUser } | { mfa: true; ticket: string };
export interface AuthAccount {
  user: AuthUser;
  prefs: { theme?: "light" | "dark" | "system"; locale?: string };
  passkeys: AuthPasskey[];
  recoveryLeft: number;
  mfaSetup: boolean;
  confirmedUntil: string;
  canChangeEmail: boolean;
}

export type { AssetUsage, AssetView } from "./assets";

export interface MediaStoreInfo {
  name: string;
  label: string;
  visibility: "public" | "private";
  /** File types the store takes (MIME types, `image/*` groups, `.ext`). */
  accept: readonly string[];
  maxFileSize: number;
  /** `false`: the store takes a file in one request, so a failed upload starts again instead of carrying on. */
  parts?: boolean;
  can: { write: boolean; delete: boolean; browse: boolean };
}

export interface MediaInfo {
  stores: MediaStoreInfo[];
  partSize: number;
  /** Photos lose their camera data (location, time, device) in the browser before they are sent. */
  stripMetadata?: boolean;
  /** Names of the image sizes the server makes (`?size=`). */
  sizes?: string[];
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

/** An agent's edit kept for a person to apply or reject. */
export interface SuggestionWire {
  id: string;
  baseVersion: number;
  edits: { oldString: string; newString: string; replaceAll?: boolean }[];
  note: string | null;
  by: { kind: "user" | "key" | "system"; label: string; agent: string | null };
  at: string;
  lines: { from: number; to: number }[];
}

export interface CollectionSchema {
  /** Fields (by path) this person cannot see or change (`fieldAccess`, 0.17.0). */
  fieldRules?: { hidden: string[]; readOnly: string[] };
  /** Body formats this collection allows (0.15.0). */
  formats?: ("markdown" | "html")[];
  /** The person may add or change HTML blocks / run scripts in isolated HTML. */
  canHtml?: boolean;
  canHtmlScripts?: boolean;
  /** "suggest": an agent's edits wait as suggestions for a person. */
  agentEdits?: "apply" | "suggest";
  /** The collection has publish checks (the editor asks them before publishing). */
  publishChecks?: boolean;
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
      throw new CmsRemoteError(e.message ?? `HTTP ${res.status}`, e.error ?? "http", { kind: e.kind, status: res.status, params: e.params, diagnostics: e.diagnostics, current: e.current, retryAfter: retryAfterOf(res.headers.get("retry-after")), requestId: res.headers.get("x-request-id") ?? undefined });
    }
    return data as T;
  }

  const doc = (c: string, s: string) => `/collections/${enc(c)}/${enc(s)}`;

  return {
    me: () => req<Me>("GET", "/_me"),
    /** The CMS's own sign-in (`createAuth`). */
    auth: {
      state: () => req<AuthState>("GET", "/auth/state"),
      setup: (i: { code: string; email: string; name?: string; password?: string }) => req<{ ok: true; user: AuthUser }>("POST", "/auth/setup", { body: i }),
      login: (email: string, password: string) => req<LoginResult>("POST", "/auth/login", { body: { email, password } }),
      mfa: (i: { ticket: string; code?: string; recovery?: string; remember?: boolean }) => req<{ ok: true; user: AuthUser; recoveryLeft?: number }>("POST", "/auth/mfa", { body: i }),
      logout: () => req<{ ok: true }>("POST", "/auth/logout", { body: {} }),
      requestReset: (email: string) => req<{ ok: true; mail: boolean }>("POST", "/auth/reset/request", { body: { email } }),
      resetInfo: (token: string) => req<{ email: string }>("GET", "/auth/reset", { query: { token } }),
      reset: (token: string, password: string) => req<LoginResult>("POST", "/auth/reset", { body: { token, password } }),
      invite: (token: string) => req<{ email: string; invitedBy: string | null; isAdmin: boolean; exists: boolean }>("GET", `/auth/invite/${enc(token)}`),
      acceptInvite: (token: string, i: { name?: string; password?: string }) => req<{ ok: true; user: AuthUser; needsPasskey: boolean }>("POST", `/auth/invite/${enc(token)}`, { body: i }),
      passkeyOptions: (purpose: "login" | "register" | "reauth") => req<{ challengeId: string; publicKey: Record<string, unknown> }>("POST", "/auth/passkey/options", { body: { purpose } }),
      passkeyVerify: (challengeId: string, credential: unknown, label?: string) => req<LoginResult & { passkeys?: AuthPasskey[] }>("POST", "/auth/passkey/verify", { body: { challengeId, credential, label } }),
      ssoUrl: (next?: string) => `${base}/auth/oidc/start${next ? `?next=${enc(next)}` : ""}`,
      reauth: (password: string) => req<{ ok: true }>("POST", "/auth/reauth", { body: { password } }),
      policy: () => req<{ requireMfa: boolean }>("GET", "/auth/policy"),
      setPolicy: (requireMfa: boolean) => req<{ requireMfa: boolean }>("PATCH", "/auth/policy", { body: { requireMfa } }),
      account: () => req<AuthAccount>("GET", "/auth/me"),
      updateAccount: (i: { name?: string | null; prefs?: { theme?: "light" | "dark" | "system"; locale?: string } }) => req<{ user: AuthUser; prefs: AuthAccount["prefs"] }>("PATCH", "/auth/me", { body: i }),
      changePassword: (password: string, current?: string) => req<{ ok: true; endedSessions: number }>("POST", "/auth/me/password", { body: { password, current } }),
      sessions: () => req<{ sessions: AuthDevice[] }>("GET", "/auth/me/sessions").then((r) => r.sessions),
      endSession: (id: string) => req<{ ok: true; ended: number; signedOut: boolean }>("DELETE", `/auth/me/sessions/${enc(id)}`),
      endOtherSessions: () => req<{ ok: true; ended: number }>("DELETE", "/auth/me/sessions"),
      startTotp: () => req<{ secret: string; uri: string; svg: string }>("POST", "/auth/me/totp", { body: {} }),
      confirmTotp: (code: string) => req<{ ok: true; recoveryCodes: string[] }>("POST", "/auth/me/totp", { body: { code } }),
      disableTotp: () => req<{ ok: true }>("DELETE", "/auth/me/totp"),
      newRecoveryCodes: () => req<{ recoveryCodes: string[] }>("POST", "/auth/me/recovery", { body: {} }),
      renamePasskey: (id: string, label: string) => req<{ passkeys: AuthPasskey[] }>("PATCH", `/auth/me/passkeys/${enc(id)}`, { body: { label } }).then((r) => r.passkeys),
      removePasskey: (id: string) => req<{ passkeys: AuthPasskey[] }>("DELETE", `/auth/me/passkeys/${enc(id)}`).then((r) => r.passkeys),
    },
    /** People of the CMS's own sign-in (admins). */
    people: {
      list: (q?: string) => req<{ users: AuthUser[]; invites: AuthInvite[]; policy: { requireMfa: boolean }; mail: boolean; sso: { label: string } | null }>("GET", "/users", { query: { q } }),
      invite: (emails: string[], o: { roleId?: string | null; admin?: boolean } = {}) => req<{ invites: { email: string; link: string; sent: boolean }[] }>("POST", "/users/invite", { body: { emails, ...o } }).then((r) => r.invites),
      revokeInvite: (id: string) => req<{ ok: true }>("DELETE", `/users/invites/${enc(id)}`),
      resendInvite: (id: string) => req<{ email: string; link: string; sent: boolean }>("POST", `/users/invites/${enc(id)}/resend`, { body: {} }),
      update: (id: string, i: { name?: string | null; disabled?: boolean; admin?: boolean; roleId?: string | null }) => req<{ user: AuthUser }>("PATCH", `/users/${enc(id)}`, { body: i }).then((r) => r.user),
      resetLink: (id: string) => req<{ link: string; sent: boolean }>("POST", `/users/${enc(id)}/reset-link`, { body: {} }),
      endSessions: (id: string) => req<{ ended: number }>("DELETE", `/users/${enc(id)}/sessions`),
    },
    schema: (c: string, o: { slug?: string | null } = {}) => req<CollectionSchema>("GET", `/collections/${enc(c)}/_schema${o.slug ? `?slug=${enc(o.slug)}` : ""}`),
    list: (c: string, q: ListQuery = {}) => req<{ docs: DocSummary[]; total: number; nextCursor: string | null }>("GET", `/collections/${enc(c)}`, { query: { fields: "summary", ...q } }),
    counts: (c: string) => req<{ counts: DocCounts }>("GET", `/collections/${enc(c)}/_counts`).then((r) => r.counts),
    get: (c: string, s: string, o: { draft?: boolean } = { draft: true }) => req<{ doc: CmsDoc }>("GET", doc(c, s), { query: { draft: o.draft } }).then((r) => r.doc),
    create: (c: string, d: DocInputWire, o: { publish?: boolean; note?: string } = {}) => req<{ doc: CmsDoc }>("POST", `/collections/${enc(c)}`, { body: { doc: d, ...o } }).then((r) => r.doc),
    update: (c: string, s: string, d: DocInputWire, o: { expectedVersion: number; publish?: boolean; note?: string }) =>
      req<{ doc: CmsDoc }>("PATCH", doc(c, s), { body: { doc: d, publish: o.publish, note: o.note }, ifMatch: o.expectedVersion }).then((r) => r.doc),
    remove: (c: string, s: string, expectedVersion?: number) => req<{ ok: true }>("DELETE", doc(c, s), { ifMatch: expectedVersion }),
    diagnose: (c: string, d: DocInputWire, slug?: string) => req<{ diagnostics: Diagnostic[] }>("POST", `/collections/${enc(c)}/_diagnose`, { body: { doc: d, slug } }).then((r) => r.diagnostics),
    patch: (c: string, s: string, ops: PatchOp[], o: { expectedVersion?: number; dryRun?: boolean } = {}) => req<{ doc: CmsDoc | null; diff: string; diagnostics: Diagnostic[]; saved: boolean }>("POST", `${doc(c, s)}/patch`, { body: { ops, ...o } }),
    /** Agents' edits waiting as suggestions (collections with `agentEdits: "suggest"`). */
    suggestions: (c: string, s: string) => req<{ suggestions: SuggestionWire[] }>("GET", `${doc(c, s)}/suggestions`).then((r) => r.suggestions),
    applySuggestion: (c: string, s: string, id: string) => req<unknown>("POST", `${doc(c, s)}/suggestions/${enc(id)}/apply`),
    rejectSuggestion: (c: string, s: string, id: string) => req<unknown>("POST", `${doc(c, s)}/suggestions/${enc(id)}/reject`),
    /** What the collection's publish checks (and the schema) say about this content, before publishing. */
    publishChecks: (c: string, s: string, d?: DocInputWire) =>
      req<{ diagnostics: Diagnostic[]; checks: { code: string; message: string; severity: "error" | "warning"; path?: string; line?: number }[]; blocking: boolean }>("POST", `${doc(c, s)}/checks`, { body: { doc: d } }),
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
    trash: (kind?: TrashRef["kind"], q?: string) => req<{ items: TrashItem[]; days: number; canPurge: boolean }>("GET", "/trash", { query: { kind, q: q || undefined } }),
    restoreTrash: (items: TrashRef[]) => req<{ restored: number; results?: { kind: TrashRef["kind"]; id: string; ok: boolean; error?: { code: string; message: string } }[] }>("POST", "/trash/_restore", { body: { items: items.map((i) => ({ kind: i.kind, id: i.id })) } }),
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
    webhooks: () => req<{ webhooks: WebhookView[]; events: WebhookEvent[]; enabled: boolean }>("GET", "/webhooks"),
    /** The signing secret comes back here and from `webhookSecret` only. */
    createWebhook: (w: WebhookInput) => req<{ webhook: WebhookView; secret: string }>("POST", "/webhooks", { body: w }),
    updateWebhook: (id: string, w: Partial<WebhookInput>) => req<{ webhook: WebhookView }>("PATCH", `/webhooks/${enc(id)}`, { body: w }).then((r) => r.webhook),
    removeWebhook: (id: string) => req<{ ok: true }>("DELETE", `/webhooks/${enc(id)}`),
    webhookSecret: (id: string) => req<{ secret: string }>("GET", `/webhooks/${enc(id)}/secret`).then((r) => r.secret),
    testWebhook: (id: string) => req<{ delivery: WebhookDelivery }>("POST", `/webhooks/${enc(id)}/test`).then((r) => r.delivery),
    webhookDeliveries: (id: string, limit?: number) => req<{ deliveries: WebhookDelivery[] }>("GET", `/webhooks/${enc(id)}/deliveries`, { query: { limit } }).then((r) => r.deliveries),
    retryDelivery: (deliveryId: string) => req<{ queued: true }>("POST", `/webhooks/deliveries/${enc(deliveryId)}/retry`),
    exportDocs: (o: { collections?: string[]; drafts?: boolean } = {}) => req<{ files: TransferFile[]; documents: number }>("GET", "/export", { query: { collections: o.collections?.join(","), drafts: o.drafts } }),
    /** Address of the export as a file to download. */
    exportUrl: (o: { collections?: string[]; drafts?: boolean } = {}) => `${base}/export?download=1${o.collections?.length ? `&collections=${enc(o.collections.join(","))}` : ""}${o.drafts ? "&drafts=1" : ""}`,
    importDocs: (files: TransferFile[], o: ImportOptions = {}) => req<{ items: ImportItem[]; applied: boolean }>("POST", "/import", { body: { files, ...o } }),
    stats: (days?: number) => req<CmsStats>("GET", "/_stats", { query: { days } }),
    automations: () => req<{ automations: CmsAutomation[]; triggers: string[]; actions: string[]; actionLabels: Record<string, string>; functions: string[] }>("GET", "/automations"),
    createAutomation: (a: AutomationInput) => req<{ automation: CmsAutomation }>("POST", "/automations", { body: a }).then((r) => r.automation),
    updateAutomation: (id: string, a: AutomationInput) => req<{ automation: CmsAutomation }>("PATCH", `/automations/${enc(id)}`, { body: a }).then((r) => r.automation),
    removeAutomation: (id: string) => req<{ ok: true }>("DELETE", `/automations/${enc(id)}`),
    automationRuns: (id: string, limit?: number) => req<{ runs: AutomationRun[] }>("GET", `/automations/${enc(id)}/runs`, { query: { limit } }).then((r) => r.runs),
    /** Checks the conditions against one document and lists what would be done; nothing changes. */
    testAutomation: (id: string, target: { collection: string; slug: string }) =>
      req<{ matches: boolean; title: string; conditions: (AutomationCondition & { ok: boolean })[]; actions: { type: string; would: string }[] }>("POST", `/automations/${enc(id)}/test`, { body: target }),
    roles: () => req<{ roles: CmsRole[]; targets: { slug: string; label: string; coded: RoleOp[]; media?: boolean }[]; users: boolean }>("GET", "/roles"),
    createRole: (r: RoleInput) => req<{ role: CmsRole }>("POST", "/roles", { body: r }).then((x) => x.role),
    updateRole: (id: string, r: RoleInput) => req<{ role: CmsRole }>("PATCH", `/roles/${enc(id)}`, { body: r }).then((x) => x.role),
    removeRole: (id: string) => req<{ ok: true }>("DELETE", `/roles/${enc(id)}`),
    addRoleMember: (id: string, member: { id?: string; email?: string; label?: string }) => req<{ role: CmsRole }>("POST", `/roles/${enc(id)}/members`, { body: member }).then((x) => x.role),
    removeRoleMember: (id: string, userId: string) => req<{ role: CmsRole }>("DELETE", `/roles/${enc(id)}/members/${enc(userId)}`).then((x) => x.role),
    searchUsers: (q: string) => req<{ users: PersonMatch[] }>("GET", "/roles/_users", { query: { q } }).then((r) => r.users),
    jobs: (q: { state?: "waiting" | "failed" | "done"; kind?: string; limit?: number } = {}) => req<{ waiting: number; failed: number; jobs: CmsJob[] }>("GET", "/jobs", { query: q }),
    retryJob: (id: string) => req<{ ok: true }>("POST", `/jobs/${enc(id)}/retry`),
    search: (q: string, collections?: string[]) => req<{ empty: boolean; hits: { collection: string; slug: string; title: string; heading: string; anchor: string; score: number }[] }>("GET", "/search", { query: { q, collections: collections?.join(",") } }),
    keys: () => req<{ keys: CmsKey[] }>("GET", "/keys").then((r) => r.keys),
    createKey: (k: { name: string; scopes: KeyScope[]; collections?: string[] | null; expiresAt?: string | null; rateLimit?: number | null; allowedIps?: string[] | null }) => req<{ key: CmsKey; secret: string }>("POST", "/keys", { body: k }),
    revokeKey: (id: string, o: { reason?: string } = {}) => req<{ ok: true }>("DELETE", `/keys/${enc(id)}${o.reason ? `?reason=${encodeURIComponent(o.reason)}` : ""}`),
    /** A new secret for the same key; the old one keeps working for `graceMinutes` (default 60). */
    rotateKey: (id: string, o: { graceMinutes?: number } = {}) => req<{ key: CmsKey; secret: string; previous: { id: string; worksUntil: string } }>("POST", `/keys/${enc(id)}/rotate`, { body: o }),
    /** Retention: the rules, and a run (`dryRun` only counts). Admins. */
    retentionRules: () => req<{ rules: { what: string; days: number }[] }>("GET", "/retention"),
    runRetention: (o: { dryRun?: boolean } = {}) => req<{ dryRun: boolean; at: string; items: { what: string; days: number; before: string; rows: number }[] }>("POST", "/retention", { body: o }),
    assets: (q: Omit<AssetListOptions, "kinds"> & { kind?: string } = {}) => req<{ assets: AssetView[]; cursor: string | null; counts: AssetCounts }>("GET", "/assets", { query: { ...q } }),
    /** Address that downloads these files as one zip (open it in the browser; cookies sign it in). */
    assetZipUrl: (ids: readonly string[]) => `${base}/assets/_zip?ids=${ids.map(encodeURIComponent).join(",")}`,
    assetFolders: () => req<{ stores: FolderTree[] }>("GET", "/assets/_folders").then((r) => r.stores),
    createAssetFolder: (path: string, store?: string | null) => req<{ store: string; path: string }>("POST", "/assets/_folders", { body: { path, store } }),
    deleteAssetFolder: (path: string, store?: string | null) => req<{ ok: true }>("DELETE", "/assets/_folders", { query: { path, store } }),
    asset: (id: string) => req<{ asset: AssetDetail }>("GET", `/assets/${enc(id)}`).then((r) => r.asset),
    updateAsset: (id: string, patch: { alt?: string; tags?: string[]; focal?: { x: number; y: number } | null }) => req<{ asset: AssetView }>("PATCH", `/assets/${enc(id)}`, { body: patch }).then((r) => r.asset),
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
    fileUrl: (a: { id: string; name: string; rev?: number }, o: { thumb?: boolean; download?: boolean; size?: string } = {}) => {
      // `v` is not read by the server: it gives a replaced file a new address for the browser's cache.
      const query = [o.thumb ? "thumb=1" : o.download ? "download=1" : o.size ? `size=${enc(o.size)}` : "", a.rev ? `v=${a.rev}` : ""].filter(Boolean).join("&");
      return `${base}/files/${enc(a.id)}/${enc(a.name)}${query ? `?${query}` : ""}`;
    },
    audit: (q: { cursor?: string | null; action?: string; outcome?: string; actorKind?: "user" | "key" | "system" | "anonymous"; limit?: number } = {}) => req<{ entries: AuditEntry[]; nextCursor: string | null }>("GET", "/audit", { query: q }),
  };
}

export type RestClient = ReturnType<typeof createRestClient>;

// 0.17.0: reading zips and Notion exports in the browser (the admin's import tab).
export { unzip } from "./zip";
export { docsFromNotion, filesFromDocs, type NotionAsset } from "./import-sources";
