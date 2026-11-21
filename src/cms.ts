/**
 * The CMS itself: every rule about documents, versions, publishing, access,
 * search, keys, previews and the audit log. Transport-free: REST (`http.ts`),
 * MCP (`mcp.ts`), the tool list (`tools.ts`) and the CLI are thin shells over this
 * object, so they can never disagree.
 *
 * User questions are app data: the CMS stores none of them. A search the
 * caller flags with `reportMiss` that finds nothing calls `onSearchMiss`, and
 * the app decides what to keep.
 */

import { createAutomations, type AutomationOptions } from "./automations";
import { createRoles, type UsersOptions } from "./roles";
import { createStats } from "./stats";
import { createTransfer } from "./transfer";
import { createAssets, type MediaOptions } from "./assets";
import { createFlow, type ScheduledRun } from "./flow";
import { createJobs, type JobsRun } from "./jobs";
import { createOutbox, type OutEvent, type WebhookOptions } from "./outbox";
import { PLUGIN_NAME, type CmsPlugin, type PluginNav, type PluginRoute, type PluginTool } from "./plugin";
import { createSealer } from "./secrets";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { z, ZodTypeAny } from "zod";
import { fieldChanges, hunks, splitLines, unifiedDiff, type FieldChange, type Hunk } from "./diff";
import { CmsError, formatMessage, isCmsError, type CmsErrorCode, type CmsErrorOptions, type Diagnostic, type ErrorParams, type Messages } from "./errors";
import { displayPrefix, generateKey, hashKey } from "./keys";
import { badRanges, createLimiter, type RateLimitOptions } from "./limits";
import { createRetention, type RetentionOptions } from "./retention";
import { appLinkKeys, extractToc, htmlRegions, parseMarkdown } from "./markdown";
import { hasScripts, inspectHtml, type HtmlInert } from "./html-inspect";
import { createAx } from "./ax";
import { applyPatch, sectionRanges, type PatchOp } from "./patch";
import type { CmsRepo, DocPatch, StoredVersion } from "./repo";
import { SCHEMA_VERSION } from "./schema-version";
import { normalizeQuery, SearchIndex, unitsOf, type SearchHit } from "./search";
import {
  docState,
  type Actor,
  type WebhookEvent,
  type AuditAction,
  type AuditEntry,
  type CmsDoc,
  type CmsKey,
  type CmsVersion,
  type CollectionConfig,
  type DocContent,
  type DocCounts,
  type DocStatus,
  type DocSummary,
  type KeyScope,
  type PublishCheckResult,
  type ReviewMark,
  type SearchMissEvent,
  type VersionChange,
  type VersionSummary,
  type Via,
} from "./types";

// ── collection typing ─────────────────────────────────────────────────────────

/** Any collection (the default when nothing is known about the set). */
export type AnyCollection = CollectionConfig<ZodTypeAny | undefined, string>;

export function defineCollection<const S extends string, F extends ZodTypeAny | undefined = undefined>(c: CollectionConfig<F, S>): CollectionConfig<F, S> {
  return c;
}

/** Collection slugs of a set (a union of literals when the set was declared with `defineCollection`). */
export type CollectionName<C extends readonly AnyCollection[]> = C[number]["slug"];

/** The parsed `fields` type of collection `N` (zod output), or a plain record. */
export type FieldsOf<C extends readonly AnyCollection[], N extends string> =
  Extract<C[number], { slug: N }> extends CollectionConfig<infer F, string>
    ? [F] extends [undefined]
      ? Record<string, unknown>
      : [ZodTypeAny] extends [F]
        ? Record<string, unknown>
        : z.output<NonNullable<F>>
    : Record<string, unknown>;

export type TypedDoc<F> = Omit<CmsDoc, "fields"> & { fields: F };

// ── options ──────────────────────────────────────────────────────────────────

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LIMITS = { slug: 120, title: 200, summary: 300, body: 60_000, keyword: 40, keywords: 30 } as const;

export interface DocInput<F = Record<string, unknown>> {
  slug?: string;
  title?: string;
  summary?: string;
  body?: string;
  /** "markdown" (default) or "html": only in collections whose `body.formats` include it. */
  format?: "markdown" | "html";
  category?: string | null;
  keywords?: string[];
  /** On update: a JSON Merge Patch (a key set to null is removed). */
  fields?: FieldsPatch<F>;
}

/** A merge patch of `F`: every key optional, objects patched recursively, null removes. */
export type FieldsPatch<F> = F extends readonly unknown[] ? F : F extends Record<string, unknown> ? { [K in keyof F]?: FieldsPatch<F[K]> | null } : F;

export interface WriteOptions {
  /** Version the caller last read; a mismatch is a 409 (someone else saved). */
  expectedVersion?: number;
  /** Why it changed (shown in the version list). */
  note?: string | null;
  /** Publish right away (needs publish permission). */
  publish?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when nothing relevant was found. */
  empty: boolean;
}

export interface SearchOptions {
  limit?: number;
  perDoc?: number;
  /** When nothing is found, tell the app through `onSearchMiss`. */
  reportMiss?: boolean;
  /** @deprecated since 0.6.0: renamed to `reportMiss`. */
  logGap?: boolean;
  filter?: (u: SearchHit["unit"]) => boolean;
}

export interface CreateCmsOptions<C extends readonly AnyCollection[] = readonly AnyCollection[]> {
  repo: CmsRepo;
  collections: C;
  /** How often to check whether another process changed documents (ms). Default 60s. */
  searchRefreshMs?: number;
  /** Search results below this coverage count as "nothing found". Default 0.5. */
  minCoverage?: number;
  now?: () => Date;
  /** IANA time zone that decides which calendar day a usage hit counts for. Default "UTC". */
  timeZone?: string;
  /** Error messages (default English). `import { ko } from "@mainsoft/agent-cms/messages/ko"`. */
  messages?: Partial<Messages>;
  /**
   * Called (not awaited) when a search flagged with `reportMiss` found
   * nothing. Store it in your own table if you want a "questions nobody
   * answered" screen; the CMS keeps nothing. Errors go to `onError`.
   */
  onSearchMiss?: (e: SearchMissEvent) => void | Promise<void>;
  /** Secret for signed draft preview links (32+ characters). Preview links are off without it. */
  previewSecret?: string;
  /** Check `cms_meta.schema_version` before the first call. Default true. */
  schemaCheck?: boolean;
  onError?: (err: unknown, where: string) => void;
  /** Deprecation and setup warnings (default console.warn), each once. */
  warn?: (message: string) => void;
  /**
   * The media library: where files are stored and what may be uploaded.
   * Without it documents hold text only. See `./storage-s3` for S3-compatible
   * storage.
   */
  media?: MediaOptions;
  /**
   * Days a deleted document or file stays in the trash before it is deleted
   * for good. Default 30. `{ days: 0 }`: no trash, a delete is final.
   */
  trash?: { days?: number };
  /**
   * Secret for the `/_cron` route (`Authorization: Bearer <secret>`), which
   * runs scheduled publishes and empties the trash. The route is off without it.
   */
  cronSecret?: string;
  /**
   * Key for values the CMS keeps encrypted in the database (webhook signing secrets, what plugins
   * seal). At least 32 characters. Without it webhooks cannot be created. Changing it makes the
   * stored values unreadable.
   */
  secretsKey?: string;
  webhooks?: WebhookOptions;
  /** Additions made with `definePlugin`. */
  plugins?: readonly CmsPlugin[];
  /**
   * Everything worth measuring, as it happens: requests, events, job runs, errors. Connect it to
   * your tracing or metrics. Must not throw; it is never awaited.
   */
  onEvent?: (e: CmsTelemetry) => void;
  /** Functions automations can call by name. Automations themselves are made on the admin screen. */
  automations?: AutomationOptions;
  /** The people of your app, for the roles screen (search by name, look up by id). Without it members are added by id. */
  users?: UsersOptions;
  /** Requests per minute per API key and per address without a key (`./limits`). Default: no limit. */
  rateLimit?: RateLimitOptions;
  /** How long the audit log, read counts, revoked keys and webhook deliveries are kept. Default: forever. */
  retention?: RetentionOptions;
}

/** Second argument of `afterChange` hooks and `onChange` listeners. */
export interface ChangeInfo {
  /**
   * True when what the public sees changed (published content, publish,
   * unpublish, archive, unarchive, delete). False for draft-only saves.
   */
  contentChanged: boolean;
}

/** `YYYY-MM-DD` of `d` in `timeZone`. */
export function dayIn(timeZone: string, d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface ListOptions {
  drafts?: boolean;
  status?: DocStatus;
  /** Display state (editors): draft, published (incl. modified), modified, archived, scheduled, review (waiting for one). */
  state?: "draft" | "published" | "modified" | "archived" | "scheduled" | "review";
  category?: string;
  /** Title, slug or summary contains (case-insensitive). */
  q?: string;
  /** Last writer kind (editors). */
  by?: "user" | "key" | "system";
}

/** RFC 7396 JSON Merge Patch: objects merge, null removes a key, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export const PREVIEW_TTLS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;
export type PreviewTtl = keyof typeof PREVIEW_TTLS;

export const BULK_ACTIONS = ["publish", "unpublish", "archive", "unarchive", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export interface BulkResult {
  slug: string;
  ok: boolean;
  error?: { code: CmsErrorCode; message: string };
}

/** An agent's change still waiting for a person (`cms.agentChanges`). */
export interface AgentChange {
  /** Hunk id; pass it to `reviewChanges`. */
  id: string;
  version: number;
  /** The agent's name (a key's name, the app's label, or the agent acting for a person). */
  author: string;
  /** `user` only when an agent acted for a person; `behalf` then names that person. */
  authorKind: "key" | "system" | "user";
  behalf: string | null;
  at: string;
  removed: string[];
  added: string[];
  /** Line just before the change in that version (to put removed lines back). */
  before: string | null;
}

export interface PreviewLink {
  url: string;
  token: string;
  version: number;
  expiresAt: string;
}

export interface PreviewRead {
  collection: string;
  slug: string;
  version: number;
  expiresAt: string;
  doc: DocContent;
  /** The link lets its holder read and write comments. */
  comments: boolean;
}

export interface DocDiff {
  a: number;
  b: number;
  fields: FieldChange[];
  hunks: Hunk[];
}

const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
const stableJson = (v: unknown) => JSON.stringify(stable(v));
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function contentOf(doc: DocContent): DocContent {
  return {
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary ?? "",
    body: doc.body ?? "",
    ...(doc.format === "html" ? { format: "html" as const } : {}),
    category: doc.category ?? null,
    keywords: [...(doc.keywords ?? [])],
    fields: structuredClone(doc.fields ?? {}),
  };
}

/** The untyped CMS (what the transports use). `createCms` returns it with typed overloads on top. */
export type CmsTelemetry =
  | { type: "request"; method: string; path: string; status: number; ms: number; actor: string; via: string | null }
  | ({ type: "event" } & OutEvent)
  | { type: "job"; kind: string; id: string; ok: boolean; attempt: number; ms: number; error?: string }
  | { type: "cron"; ms: number; jobs: JobsRun }
  | { type: "error"; where: string; message: string };

/** First path segments the CMS uses itself. A plugin cannot take one of these names. */
export const RESERVED_ROUTES = new Set(["collections", "search", "preview", "audit", "keys", "mcp", "assets", "files", "stores", "reviews", "trash", "releases", "webhooks", "jobs", "plugins", "automations", "roles", "export", "import", "openapi.json", "grep", "raw", "retention", "_events", "auth", "_stats", "_me", "_cron"]);

/** Audit actions that are also events (webhooks, plugin listeners). */
const EVENT_OF: Partial<Record<AuditAction, WebhookEvent>> = {
  "doc.publish": "doc.published",
  "doc.unpublish": "doc.unpublished",
  "doc.archive": "doc.archived",
  "doc.delete": "doc.deleted",
  "doc.undelete": "doc.restored",
  "review.request": "review.requested",
  "review.approve": "review.approved",
  "review.reject": "review.rejected",
  "asset.upload": "asset.uploaded",
  "asset.move": "asset.moved",
  "asset.delete": "asset.deleted",
  "release.publish": "release.published",
};

export function createCmsCore(opts: CreateCmsOptions) {
  const repo = opts.repo;
  const now = opts.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const collections = new Map<string, AnyCollection>();
  const minCoverage = opts.minCoverage ?? 0.5;
  const refreshMs = opts.searchRefreshMs ?? 60_000;
  const messages = opts.messages;
  const telemetry = (e: CmsTelemetry) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // a broken listener must not break the CMS
    }
  };
  const reportTo = opts.onError ?? ((err: unknown, where: string) => console.warn(`[agent-cms] ${where}:`, err));
  const report = (err: unknown, where: string) => {
    telemetry({ type: "error", where, message: err instanceof Error ? err.message : String(err) });
    reportTo(err, where);
  };

  // ── events: webhooks and plugin listeners ─────────────────────────────────

  const eventListeners: { event: WebhookEvent | "*"; fn: (e: OutEvent) => void | Promise<void>; plugin: string }[] = [];
  /** Tell the outside what happened. Never throws, never awaited by the write that caused it. */
  /** Listeners added at run time (the events stream): told about every event until they unsubscribe. */
  const subscribers = new Set<(e: OutEvent) => void>();
  function emitEvent(e: OutEvent) {
    telemetry({ type: "event", ...e });
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch (err) {
        report(err, "subscriber");
      }
    }
    void outbox.emit(e);
    void automations.onEvent(e);
    for (const l of eventListeners) {
      if (l.event !== "*" && l.event !== e.event) continue;
      Promise.resolve()
        .then(() => l.fn(e))
        .catch((err) => report(err, `plugin ${l.plugin}: ${e.event}`));
    }
  }
  function urlOf(col: string | null | undefined, slug: string | null | undefined): string | null {
    try {
      return col && slug ? (collections.get(col)?.url?.({ slug }) ?? null) : null;
    } catch {
      return null;
    }
  }
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    (opts.warn ?? ((m: string) => console.warn(`[agent-cms] ${m}`)))(msg);
  };
  const listeners = new Set<(doc: CmsDoc, info: ChangeInfo) => void>();
  const timeZone = opts.timeZone ?? "UTC";
  dayIn(timeZone, new Date()); // throws RangeError at boot on an unknown zone
  if (opts.previewSecret !== undefined && opts.previewSecret.length < 32) throw new Error("[agent-cms] previewSecret must be at least 32 characters");

  // Fail closed at boot: every collection says who may read it.
  for (const c of opts.collections) {
    if (collections.has(c.slug)) throw new Error(`[agent-cms] two collections are named "${c.slug}"`);
    if (c.visibility !== "public" && c.visibility !== "internal") {
      throw new Error(`[agent-cms] collection "${c.slug}": set visibility to "public" or "internal" (required since 0.6.0)`);
    }
    if (c.visibility === "internal" && !c.access?.read) {
      throw new Error(`[agent-cms] collection "${c.slug}" is internal, so it needs access.read (who may read it)`);
    }
    if ((c.search as { gapLogging?: unknown } | undefined)?.gapLogging !== undefined) {
      warnOnce("gapLogging", `search.gapLogging was removed in 0.6.0 and is ignored ("${c.slug}"). Use createCms({ onSearchMiss }) and store misses in your app. See UPGRADE-0.6.md.`);
    }
    collections.set(c.slug, c);
  }

  const fail = (code: CmsErrorCode, params: ErrorParams = {}, o: CmsErrorOptions = {}) => new CmsError(code, params, { messages, ...o });
  const trashDays = Math.max(0, Math.floor(opts.trash?.days ?? 30));

  // ── schema handshake ──────────────────────────────────────────────────────

  let schemaReady: Promise<void> | null = null;
  function ensureSchema(): Promise<void> | void {
    if (opts.schemaCheck === false) return roles.load().catch((e) => report(e, "roles"));
    const loadRoles = () => roles.load().catch((e) => report(e, "roles"));
    schemaReady ??= (async () => {
      const raw = await repo.getMeta("schema_version");
      const found = raw == null ? null : Number(raw);
      if (found === null || !(found >= SCHEMA_VERSION)) {
        throw fail("schema_outdated", { found: found ?? 1, expected: SCHEMA_VERSION, command: "npx @mainsoft/agent-cms migrate check" }, { status: 503 });
      }
    })().catch((e) => {
      schemaReady = null; // try again on the next call (after the migration ran)
      throw e;
    });
    return schemaReady.then(loadRoles);
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  function actorInfo(actor: Actor) {
    if (actor.kind === "anonymous") return { actorKind: "anonymous" as const, actorId: null, actorLabel: "anonymous" };
    if (actor.kind === "system") return { actorKind: "system" as const, actorId: null, actorLabel: actor.label };
    return { actorKind: actor.kind, actorId: actor.id, actorLabel: actor.label, actorAgent: actor.kind === "user" ? (actor.agent?.label ?? null) : null };
  }

  function audit(actor: Actor, action: AuditAction, o: { collection?: string | null; slug?: string | null; version?: number | null; outcome?: AuditEntry["outcome"]; detail?: Record<string, unknown> } = {}) {
    void repo
      .insertAudit({
        at: nowIso(),
        ...actorInfo(actor),
        action,
        collection: o.collection ?? null,
        slug: o.slug ?? null,
        version: o.version ?? null,
        outcome: o.outcome ?? "ok",
        via: actor.via ?? null,
        detail: o.detail ?? {},
      })
      .catch((e) => report(e, "audit"));
    const event = EVENT_OF[action];
    if (event && (o.outcome ?? "ok") === "ok" && actor.kind !== "anonymous") {
      const doc = event.startsWith("doc.") || event.startsWith("review.");
      emitEvent({ event, actor: actorRef(actor), collection: o.collection ?? null, slug: o.slug ?? null, version: o.version ?? null, url: urlOf(o.collection, o.slug), ...(doc ? {} : { detail: o.detail ?? {} }) });
    }
  }

  // ── access ────────────────────────────────────────────────────────────────

  function collection(slug: string): AnyCollection {
    const c = collections.get(slug);
    if (!c) throw fail("unknown_collection", { collection: slug });
    return c;
  }

  function keyCovers(actor: Extract<Actor, { kind: "key" }>, col: string): boolean {
    return !actor.collections || actor.collections.includes(col);
  }

  function can(actor: Actor, col: string, what: "read" | "write" | "publish" | "delete", doc?: CmsDoc | null): boolean {
    const c = collection(col);
    if (actor.kind === "system") return true;
    if (c.managed && what !== "read") return false;
    if (actor.kind === "key") {
      if (!keyCovers(actor, col)) return false;
      const scope = what === "delete" ? "publish" : what;
      return actor.scopes.includes(scope) || actor.scopes.includes("admin") || (what === "read" && (actor.scopes.includes("write") || actor.scopes.includes("publish")));
    }
    if (what === "read") {
      if (c.access?.read) return c.access.read({ actor, collection: col, doc });
      return c.visibility === "public";
    }
    const fn = what === "write" ? c.access?.write : c.access?.publish;
    if (fn) return fn({ actor, collection: col, doc });
    if (actor.kind !== "user") return false;
    // The app's admins first, then what the roles say; people in no role get the default (admins only).
    return actor.isAdmin || (roles.allows(actor, col, what) ?? false);
  }

  function assert(actor: Actor, col: string, what: "read" | "write" | "publish" | "delete", doc?: CmsDoc | null) {
    if (can(actor, col, what, doc)) return;
    if (actor.kind !== "anonymous" && what !== "read") audit(actor, "access.denied", { collection: col, slug: doc?.slug ?? null, outcome: "denied", detail: { need: what } });
    if (actor.kind === "anonymous") throw fail("unauthorized");
    throw fail(what === "publish" || what === "delete" ? "forbidden_publish" : what === "write" ? "forbidden_write" : "forbidden_read", { collection: col });
  }

  /** Who to record as the author. `agent` is the agent acting for a person, when there is one. */
  function actorRef(actor: Actor): { kind: "user" | "key" | "system"; id: string | null; label: string; agent: string | null } {
    if (actor.kind === "user") return { kind: "user", id: actor.id, label: actor.label, agent: actor.agent?.label?.trim() || null };
    if (actor.kind === "key") return { kind: "key", id: actor.id, label: actor.label, agent: null };
    if (actor.kind === "system") return { kind: "system", id: null, label: actor.label, agent: null };
    throw fail("unauthorized");
  }

  // ── media ─────────────────────────────────────────────────────────────────

  const assets = createAssets({
    repo,
    media: opts.media,
    fail,
    diag: (path, code, params, severity) => ({ path, code, params, severity, message: formatMessage(messages, code, params) }),
    audit: (actor, action, o) => audit(actor, action, o),
    nowIso,
    actorRef,
    collection,
    canReadDoc: (actor, doc) => collections.has(doc.collection) && can(actor, doc.collection, "read", doc),
    warn: warnOnce,
    ready: ensureSchema,
    trashDays,
  });

  // ── validation ────────────────────────────────────────────────────────────

  /** Every problem with `c` at once (and the cleaned content). */
  /** What HTML in the body does nothing when drawn safely, with body line numbers. */
  function htmlInertOf(cfg: AnyCollection, c: DocContent): HtmlInert[] {
    const policy = cfg.html ?? {};
    if (c.format === "html") return policy.render === "isolated" ? [] : inspectHtml(c.body, policy);
    const out: HtmlInert[] = [];
    for (const r of htmlRegions(c.body)) {
      if (r.isolated && policy.render === "isolated") continue;
      for (const x of inspectHtml(r.v, policy)) out.push({ ...x, line: r.line + x.line - 1 });
    }
    return out;
  }

  /** HTML pieces of a body, as keys: what a write adds is what the old body did not have. */
  function htmlKeys(c: Pick<DocContent, "body" | "format"> | null): string[] {
    if (!c) return [];
    if (c.format === "html") return [`doc:${c.body}`];
    return htmlRegions(c.body).map((r) => `${r.isolated ? "isolated" : "safe"}:${r.v}`);
  }

  function canHtml(actor: Actor, col: string, what: "html" | "html_scripts", doc?: CmsDoc | null): boolean {
    const c = collection(col);
    if (actor.kind === "system") return true;
    if (actor.kind === "key") return actor.scopes.includes("admin") || (what === "html" && actor.scopes.includes("html"));
    const fn = what === "html" ? c.html?.access : c.html?.scripts;
    if (fn) return fn({ actor, collection: col, doc });
    if (actor.kind !== "user") return false;
    return actor.isAdmin || (roles.allows(actor, col, what) ?? false);
  }

  /**
   * HTML a write adds or changes needs the "html" permission; HTML that runs (an isolated block, or a
   * collection drawn isolated) needs "html_scripts". Removing or moving HTML is a normal edit.
   */
  async function htmlGate(actor: Actor, col: string, prev: Pick<DocContent, "body" | "format"> | null, next: Pick<DocContent, "body" | "format">) {
    const before = htmlKeys(prev);
    const added = htmlKeys(next).filter((k) => {
      const i = before.indexOf(k);
      if (i < 0) return true;
      before.splice(i, 1);
      return false;
    });
    if (!added.length) return;
    const cfg = collection(col);
    if (!canHtml(actor, col, "html")) {
      if (actor.kind !== "anonymous") audit(actor, "access.denied", { collection: col, outcome: "denied", detail: { need: "html" } });
      throw fail("forbidden_html", { collection: col });
    }
    const runs = added.some((k) => k.startsWith("isolated:") || (cfg.html?.render === "isolated" && hasScripts(k.slice(k.indexOf(":") + 1))));
    if (runs && !canHtml(actor, col, "html_scripts")) {
      if (actor.kind !== "anonymous") audit(actor, "access.denied", { collection: col, outcome: "denied", detail: { need: "html_scripts" } });
      throw fail("forbidden_html_scripts", { collection: col });
    }
  }

  function check(col: string, c: DocContent): { content: DocContent; diagnostics: Diagnostic[] } {
    const cfg = collection(col);
    const out = contentOf(c);
    const diags: Diagnostic[] = [];
    const add = (path: string, code: CmsErrorCode, params: ErrorParams = {}, severity: Diagnostic["severity"] = "error") =>
      diags.push({ path, code, params, severity, message: formatMessage(messages, code, params) });
    out.slug = (out.slug ?? "").trim();
    out.title = (out.title ?? "").trim();
    out.summary = out.summary.trim();
    out.keywords = [...new Set(out.keywords.map((k) => String(k).trim()).filter(Boolean))];
    if (!(cfg.slugPattern ?? SLUG_RE).test(out.slug) || out.slug.length > LIMITS.slug) add("slug", "invalid_slug", { max: LIMITS.slug });
    if (!out.title || out.title.length > LIMITS.title) add("title", "invalid_title", { max: LIMITS.title });
    if (out.summary.length > LIMITS.summary) add("summary", "summary_too_long", { max: LIMITS.summary });
    if (out.body.length > LIMITS.body) add("body", "body_too_long", { max: LIMITS.body });
    if (out.keywords.length > LIMITS.keywords || out.keywords.some((k) => k.length > LIMITS.keyword)) add("keywords", "invalid_keywords", { max: LIMITS.keywords, maxLength: LIMITS.keyword });
    for (const ch of cfg.forbiddenChars ?? []) {
      for (const f of ["title", "summary", "body"] as const) if (out[f].includes(ch)) add(f, "forbidden_char", { char: ch });
    }
    if (cfg.categories && (out.category === null || !cfg.categories.includes(out.category))) add("category", "invalid_category", { allowed: [...cfg.categories] });
    if (cfg.fields) {
      const parsed = cfg.fields.safeParse(out.fields ?? {});
      if (!parsed.success) for (const i of parsed.error.issues) add(["fields", ...i.path].join("."), "invalid_field", { path: i.path.join("."), issue: i.message });
      else out.fields = parsed.data as Record<string, unknown>;
    }
    if (cfg.links) {
      const bad = appLinkKeys(out.body).filter((k) => !cfg.links!.resolve(k));
      if (bad.length) add("body", "unknown_link", { keys: bad });
    }
    const formats = cfg.body?.formats ?? ["markdown"];
    if (!formats.includes(out.format ?? "markdown")) add("format", "format_not_allowed", { collection: col, format: out.format ?? "markdown" });
    for (const x of htmlInertOf(cfg, out)) add("body", "html_inert", { line: x.line, kind: x.kind, detail: x.detail }, "warning");
    return { content: out, diagnostics: diags };
  }

  /** Run a hook; what it throws becomes `hook_rejected` (a CmsError passes as it is). */
  async function hook<A, T>(fn: (a: A) => T | Promise<T>, arg: A): Promise<T> {
    try {
      return await fn(arg);
    } catch (e) {
      if (isCmsError(e)) throw e;
      throw fail("hook_rejected", { reason: e instanceof Error ? e.message : String(e) });
    }
  }
  /** `beforeChange` hooks, one after another: each sees what the one before returned. */
  async function hooked(actor: Actor, col: string, prev: CmsDoc | null, content: DocContent): Promise<DocContent> {
    let cur = content;
    for (const fn of collection(col).hooks?.beforeChange ?? []) {
      const patch = await hook(fn, { collection: col, slug: cur.slug, content: cur, prev, actor });
      if (patch && typeof patch === "object") cur = validate(col, { ...cur, ...patch });
    }
    return cur;
  }
  /** `beforeValidate` hooks: each may change the input before it is checked. */
  async function prepared(actor: Actor, col: string, prev: CmsDoc | null, input: DocInput): Promise<DocInput> {
    let cur = input;
    for (const fn of collection(col).hooks?.beforeValidate ?? []) {
      const patch = await hook(fn, { collection: col, input: cur as Partial<DocContent>, prev, actor });
      if (patch && typeof patch === "object") cur = { ...cur, ...patch } as DocInput;
    }
    return cur;
  }
  /** Hooks that run after the fact: never block, errors go to `onError`. */
  function after<A>(which: "afterPublish" | "afterDelete", fns: ReadonlyArray<(a: A) => void | Promise<void>> | undefined, arg: A) {
    for (const fn of fns ?? []) {
      Promise.resolve()
        .then(() => fn(arg))
        .catch((e) => report(e, which));
    }
  }
  async function gate(which: "beforePublish" | "beforeDelete", actor: Actor, doc: { collection: string; slug: string; version: number }, content: DocContent) {
    if (which === "beforePublish") {
      const errors = (await appChecks(doc.collection, doc.slug, content)).filter((x) => x.severity === "error");
      if (errors.length)
        throw fail("publish_check_failed", { checks: errors.map((e) => e.message).join("; ") }, { diagnostics: errors.map((e) => ({ path: e.path ?? "", code: "publish_check_failed" as const, params: { checks: e.message, check: e.code, line: e.line ?? null }, severity: "error" as const, message: e.message })) });
    }
    for (const fn of collection(doc.collection).hooks?.[which] ?? []) await hook(fn, { collection: doc.collection, slug: doc.slug, content, version: doc.version, actor });
  }

  /** The collection's own `publishChecks`. A check that throws counts as an error with its message. */
  async function appChecks(col: string, slug: string, content: DocContent): Promise<PublishCheckResult[]> {
    const out: PublishCheckResult[] = [];
    for (const fn of collection(col).publishChecks ?? []) {
      try {
        for (const r of (await fn(content, { collection: col, slug })) ?? []) out.push({ code: String(r.code), message: String(r.message), severity: r.severity === "error" ? "error" : "warning", path: r.path, line: r.line });
      } catch (e) {
        out.push({ code: "check_failed", message: e instanceof Error ? e.message : String(e), severity: "error" });
      }
    }
    return out;
  }

  function validate(col: string, c: DocContent): DocContent {
    const { content, diagnostics } = check(col, c);
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length) throw fail(errors[0].code, errors[0].params, { diagnostics: errors });
    return content;
  }

  /** Check a document without saving (`existing` slug: as an update of that document). */
  async function diagnose(actor: Actor, col: string, input: DocInput, o: { slug?: string } = {}): Promise<Diagnostic[]> {
    assert(actor, col, "write");
    const cfg = collection(col);
    const cur = o.slug ? await repo.findDoc(col, o.slug) : null;
    const base: DocContent = cur ?? { slug: "", title: "", summary: "", body: "", category: cfg.categories?.[0] ?? null, keywords: [], fields: {} };
    const content = merged(base, input);
    const { diagnostics } = check(col, content);
    if (cur && content.slug !== cur.slug && cur.publishedVersion !== null) diagnostics.push({ path: "slug", code: "slug_locked", params: {}, severity: "error", message: formatMessage(messages, "slug_locked") });
    const other = content.slug ? await repo.findDoc(col, content.slug, { trashed: true }) : null;
    const taken = other?.deletedAt ? "slug_in_trash" : "slug_taken";
    if (other && other.id !== cur?.id) diagnostics.push({ path: "slug", code: taken, params: { slug: content.slug }, severity: "error", message: formatMessage(messages, taken, { slug: content.slug }) });
    diagnostics.push(...(await assets.checkDoc(cfg, content, cur ? assets.idsIn(cfg, cur) : undefined)));
    return diagnostics;
  }

  const same = (a: DocContent, b: DocContent) => stableJson(contentOf(a)) === stableJson(contentOf(b));

  function merged(cur: DocContent, input: DocInput): DocContent {
    return {
      slug: input.slug ?? cur.slug,
      title: input.title ?? cur.title,
      summary: input.summary ?? cur.summary,
      body: input.body ?? cur.body,
      ...((input.format ?? cur.format) === "html" ? { format: "html" as const } : {}),
      category: input.category !== undefined ? input.category : cur.category,
      keywords: input.keywords ?? cur.keywords,
      fields: input.fields !== undefined ? (mergePatch(cur.fields, input.fields) as Record<string, unknown>) : cur.fields,
    };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** What a reader without write access sees: the published snapshot only. */
  function publicView(doc: CmsDoc): CmsDoc | null {
    if (doc.publishedVersion === null || doc.status === "archived" || !doc.published) return null;
    return { ...doc, ...contentOf(doc.published), version: doc.publishedVersion, autosave: null };
  }

  async function get(actor: Actor, col: string, slug: string, o: { draft?: boolean } = {}): Promise<CmsDoc> {
    collection(col);
    await ensureSchema();
    const doc = await repo.findDoc(col, slug);
    if (!doc) throw fail("not_found", { collection: col, slug });
    if (o.draft && can(actor, col, "write", doc)) return read(actor, doc, true);
    assert(actor, col, "read", doc);
    const pub = publicView(doc);
    if (!pub) throw fail("not_found", { collection: col, slug });
    return read(actor, pub, false);
  }
  /** `afterRead` hooks: each sees what the one before returned. */
  async function read(actor: Actor, doc: CmsDoc, draft: boolean): Promise<CmsDoc> {
    const fns = collection(doc.collection).hooks?.afterRead;
    if (!fns?.length) return doc;
    let cur = doc;
    for (const fn of fns) cur = (await hook((d: CmsDoc) => fn(d, { actor, draft }), cur)) ?? cur;
    return cur;
  }


  async function list(actor: Actor, col: string, o: ListOptions = {}): Promise<CmsDoc[]> {
    collection(col);
    await ensureSchema();
    const editor = !!o.drafts && can(actor, col, "write");
    if (!editor) assert(actor, col, "read");
    const rows = editor
      ? await repo.listDocs({ collection: col, statuses: o.status ? [o.status] : undefined })
      : (await repo.listDocs({ collection: col, published: true })).map(publicView).filter((d): d is CmsDoc => !!d);
    const q = o.q?.trim().toLowerCase();
    return rows
      .filter((d) => !o.category || d.category === o.category)
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.slug.includes(q) || d.summary.toLowerCase().includes(q))
      .filter((d) => !editor || !o.by || d.updatedByKind === o.by)
      .filter((d) => {
        if (!editor || !o.state) return true;
        const s = docState(d);
        if (o.state === "scheduled") return !!d.schedule;
        if (o.state === "review") return d.review?.state === "requested";
        return o.state === "modified" ? s.modifiedSincePublish : s.state === o.state;
      })
      .sort((a, b) => (editor ? b.updatedAt.localeCompare(a.updatedAt) : (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt)));
  }

  function summaryOf(d: CmsDoc): DocSummary {
    const s = docState(d);
    return {
      id: d.id,
      collection: d.collection,
      slug: d.slug,
      title: d.title,
      summary: d.summary,
      category: d.category,
      status: d.status,
      state: s.state,
      modifiedSincePublish: s.modifiedSincePublish,
      version: d.version,
      publishedVersion: d.publishedVersion,
      publishedAt: d.publishedAt,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
      updatedByKind: d.updatedByKind,
      updatedByAgent: d.updatedByAgent ?? null,
      schedule: d.schedule ? { publishAt: d.schedule.publishAt, unpublishAt: d.schedule.unpublishAt, version: d.schedule.version, by: d.schedule.by } : null,
      review: d.review ? { state: d.review.state, version: d.review.version, by: d.review.by, note: d.review.note } : null,
    };
  }

  /** A page of list items without bodies. `cursor` comes from the previous page. */
  async function page(actor: Actor, col: string, o: ListOptions & { limit?: number; cursor?: string | null; hits?: boolean } = {}) {
    const all = await list(actor, col, o);
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const offset = Math.max(0, Number(o.cursor ?? 0) || 0);
    const slice = all.slice(offset, offset + limit).map(summaryOf);
    if (o.hits && can(actor, col, "write")) {
      const counts = await hitCounts(actor, col, 7);
      for (const d of slice) d.hits7d = counts.get(d.id) ?? 0;
    }
    return { docs: slice, total: all.length, nextCursor: offset + limit < all.length ? String(offset + limit) : null };
  }

  /** Numbers for the list tabs (editors). */
  async function counts(actor: Actor, col: string): Promise<DocCounts> {
    assert(actor, col, "write");
    await ensureSchema();
    const out: DocCounts = { all: 0, draft: 0, published: 0, modified: 0, archived: 0, scheduled: 0, review: 0 };
    for (const d of await repo.listDocs({ collection: col })) {
      const s = docState(d);
      out.all++;
      out[s.state]++;
      if (s.modifiedSincePublish) out.modified++;
      if (d.schedule) out.scheduled++;
      if (d.review?.state === "requested") out.review++;
    }
    return out;
  }

  async function editable(actor: Actor, col: string, slug: string) {
    collection(col);
    await ensureSchema();
    const doc = await repo.findDoc(col, slug);
    if (!doc) throw fail("not_found", { collection: col, slug });
    assert(actor, col, "write", doc);
    return doc;
  }

  const withPublished = (v: StoredVersion, doc: CmsDoc): CmsVersion => ({ ...v, published: v.version === doc.publishedVersion });

  async function versions(actor: Actor, col: string, slug: string): Promise<CmsVersion[]> {
    const doc = await editable(actor, col, slug);
    return (await repo.listVersions(doc.id)).map((v) => withPublished(v, doc));
  }

  /** Version list without snapshots. */
  async function versionList(actor: Actor, col: string, slug: string): Promise<VersionSummary[]> {
    const doc = await editable(actor, col, slug);
    return (await repo.listVersions(doc.id)).map((v) => {
      const { snapshot, ...rest } = withPublished(v, doc);
      return { ...rest, title: snapshot.title };
    });
  }

  async function version(actor: Actor, col: string, slug: string, n: number): Promise<CmsVersion> {
    const doc = await editable(actor, col, slug);
    const v = await repo.getVersion(doc.id, n);
    if (!v) throw fail("version_not_found", { version: n });
    return withPublished(v, doc);
  }

  /** Field changes and body hunks between two versions of a document. */
  async function diff(actor: Actor, col: string, slug: string, a: number, b: number, o: { context?: number } = {}): Promise<DocDiff> {
    const doc = await editable(actor, col, slug);
    const [va, vb] = await Promise.all([repo.getVersion(doc.id, a), repo.getVersion(doc.id, b)]);
    if (!va) throw fail("version_not_found", { version: a });
    if (!vb) throw fail("version_not_found", { version: b });
    return { a, b, fields: fieldChanges(va.snapshot, vb.snapshot), hunks: hunks(va.snapshot.body, vb.snapshot.body, o.context ?? 3) };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  function publicSig(doc: CmsDoc | null): string {
    const p = doc ? publicView(doc) : null;
    return p ? `${p.publishedVersion}:${stableJson(contentOf(p))}` : "";
  }

  /** `prev` is the row before the write (null for a create); `doc` after (null for a delete). */
  function changed(prev: CmsDoc | null, doc: CmsDoc | null, o: { quiet?: boolean } = {}) {
    const target = doc ?? prev;
    if (!target) return;
    const info: ChangeInfo = { contentChanged: publicSig(prev) !== publicSig(doc) };
    if (info.contentChanged) index.dirty = true;
    if (doc && !o.quiet && !doc.deletedAt && (!prev || doc.version !== prev.version)) {
      const by = doc.updatedByKind ? { kind: doc.updatedByKind, id: null, label: doc.updatedBy ?? "", agent: doc.updatedByAgent ?? null } : null;
      emitEvent({ event: prev ? "doc.updated" : "doc.created", actor: by, collection: doc.collection, slug: doc.slug, version: doc.version, url: urlOf(doc.collection, doc.slug) });
    }
    for (const l of listeners) {
      try {
        l(target, info);
      } catch (e) {
        report(e, "onChange");
      }
    }
    const hooks = collection(target.collection).hooks;
    for (const h of hooks?.afterChange ?? []) {
      Promise.resolve()
        .then(() => h(target, info))
        .catch((e) => report(e, "afterChange"));
    }
    const wentPublic = !!doc && !doc.deletedAt && doc.publishedVersion !== null && doc.status !== "archived" && (!prev || prev.publishedVersion !== doc.publishedVersion || prev.status === "archived" || !!prev.deletedAt);
    if (wentPublic) after("afterPublish", hooks?.afterPublish, doc!);
    if (prev && !prev.deletedAt && (!doc || doc.deletedAt)) after("afterDelete", hooks?.afterDelete, prev);
  }

  async function prune(r: CmsRepo, doc: CmsDoc) {
    const max = collection(doc.collection).versions?.max ?? 100;
    if (max > 0) await r.pruneVersions(doc.id, max, doc.publishedVersion ? [doc.publishedVersion] : []);
  }

  const hunkId = (v: number, h: { removed: string[]; added: string[] }) =>
    createHash("sha256").update(`${v}\n${h.removed.join("\n")}\n--\n${h.added.join("\n")}`).digest("hex").slice(0, 12);

  /** What a new version changed against the previous one. */
  function changeOf(v: number, prev: DocContent | null, next: DocContent): VersionChange {
    if (!prev) return { fields: [], hunks: [] };
    const fields = fieldChanges(prev, next).map((f) => f.path);
    const lines = splitLines(next.body);
    const hs = hunks(prev.body, next.body, 0).map((h) => ({
      id: hunkId(v, h),
      removed: h.removed,
      added: h.added,
      before: h.bStart > 1 || (h.bLines === 0 && h.bStart > 0) ? (lines[(h.bLines === 0 ? h.bStart : h.bStart - 1) - 1] ?? null) : null,
    }));
    if (hs.length) fields.push("body");
    return { fields, hunks: hs };
  }

  const conflict = (cur: CmsDoc, expected: number, actor: Actor, col: string) =>
    fail("conflict_version", { expected, current: cur.version }, { current: can(actor, col, "write", cur) ? cur : undefined });

  /** True when this actor's publishes in `col` need someone's approval first (`review` in the collection). */
  function needsReview(actor: Actor, col: string): boolean {
    const rule = collection(col).review;
    if (!rule || actor.kind === "system") return false;
    if (rule.everyone === "required") return true;
    return rule.agents === "required" && (actor.kind === "key" || (actor.kind === "user" && !!actor.agent));
  }

  const reviewRequired = (actor: Actor, col: string, slug: string | null) => {
    audit(actor, "access.denied", { collection: col, slug, outcome: "denied", detail: { need: "review" } });
    return fail("review_required", { collection: col });
  };

  /** Refuse to publish version `n` when this actor needs a review and nobody approved that version. */
  async function assertReviewed(r: CmsRepo, actor: Actor, doc: CmsDoc, n: number): Promise<void> {
    if (!needsReview(actor, doc.collection)) return;
    if (!(await r.getVersion(doc.id, n))?.approvedBy) throw reviewRequired(actor, doc.collection, doc.slug);
  }

  const slugTaken = (other: CmsDoc) => fail(other.deletedAt ? "slug_in_trash" : "slug_taken", { slug: other.slug });

  async function create(actor: Actor, col: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    await ensureSchema();
    assert(actor, col, "write");
    if (o.publish) assert(actor, col, "publish");
    if (o.publish && needsReview(actor, col)) throw reviewRequired(actor, col, input.slug ?? null);
    const who = actorRef(actor);
    const cfg = collection(col);
    input = await prepared(actor, col, null, input);
    const content = await hooked(actor, col, null, validate(col, {
      slug: input.slug ?? "",
      title: input.title ?? "",
      summary: input.summary ?? "",
      body: input.body ?? "",
      ...(input.format === "html" ? { format: "html" as const } : {}),
      category: input.category ?? cfg.categories?.[0] ?? null,
      keywords: input.keywords ?? [],
      fields: (input.fields as Record<string, unknown>) ?? {},
    }));
    await assets.assertDoc(cfg, content);
    await htmlGate(actor, col, null, content);
    const at = nowIso();
    const doc = await repo.tx(async (r) => {
      const other = await r.findDoc(col, content.slug, { trashed: true });
      if (other) throw slugTaken(other);
      const publish = !!o.publish;
      if (publish) await gate("beforePublish", actor, { collection: col, slug: content.slug, version: 1 }, content);
      const row = await r.insertDoc({
        collection: col,
        ...content,
        status: publish ? "published" : "draft",
        version: 1,
        publishedVersion: publish ? 1 : null,
        published: publish ? content : null,
        publishedAt: publish ? at : null,
        updatedBy: who.label,
        updatedByKind: who.kind,
        updatedByAgent: who.agent,
        createdAt: at,
        updatedAt: at,
      });
      await r.insertVersion({ documentId: row.id, version: 1, snapshot: content, authorKind: who.kind, authorId: who.id, authorLabel: who.label, authorAgent: who.agent, note: o.note ?? null, createdAt: at, changed: changeOf(1, null, content) });
      await assets.syncRefs(r, row);
      return row;
    });
    if (o.publish) audit(actor, "doc.publish", { collection: col, slug: doc.slug, version: 1 });
    changed(null, doc);
    return doc;
  }

  /** Write a new version from `next`; decides the status. */
  async function commit(r: CmsRepo, actor: Actor, doc: CmsDoc, next: DocContent, o: WriteOptions & { restoredFrom?: number }): Promise<CmsDoc> {
    const who = actorRef(actor);
    const cfg = collection(doc.collection);
    const at = nowIso();
    const v = doc.version + 1;
    next = await hooked(actor, doc.collection, doc, next);
    if (next.slug !== doc.slug && doc.publishedVersion !== null) throw fail("slug_locked");
    const other = next.slug !== doc.slug ? await r.findDoc(doc.collection, next.slug, { trashed: true }) : null;
    if (other) throw slugTaken(other);

    const inPlace = cfg.versions?.drafts === false && doc.publishedVersion !== null && doc.status !== "archived";
    const publish = !!o.publish || inPlace;
    // A new version is one nobody approved yet.
    if (publish && needsReview(actor, doc.collection)) throw reviewRequired(actor, doc.collection, doc.slug);
    if (publish) await gate("beforePublish", actor, { collection: doc.collection, slug: next.slug, version: v }, next);
    const wasPublic = doc.publishedVersion !== null && doc.status !== "archived";
    await htmlGate(actor, doc.collection, doc, next);
    let patch: DocPatch = { ...next, format: next.format ?? "markdown", version: v, updatedBy: who.label, updatedByKind: who.kind, updatedByAgent: who.agent, updatedAt: at, autosave: null };
    if (publish) {
      patch = { ...patch, status: "published", publishedVersion: v, published: next, publishedAt: doc.publishedAt ?? at, review: null, ...afterPublish(doc) };
      if (!wasPublic && doc.publishedAt) patch.republishedAt = at;
    } else {
      patch = { ...patch, status: doc.status === "archived" ? "archived" : "draft" };
      // An open review request follows the document, so nobody approves an outdated version.
      if (doc.review?.state === "requested") patch.review = { ...doc.review, version: v };
    }

    const updated = await r.updateDoc(doc.id, patch, o.expectedVersion ?? doc.version);
    if (!updated) {
      const cur = (await r.findDoc(doc.collection, doc.slug)) ?? doc;
      throw conflict(cur, o.expectedVersion ?? doc.version, actor, doc.collection);
    }
    await r.insertVersion({
      documentId: doc.id,
      version: v,
      snapshot: next,
      authorKind: who.kind,
      authorAgent: who.agent,
      authorId: who.id,
      authorLabel: who.label,
      note: o.note ?? (o.restoredFrom ? `restored v${o.restoredFrom}` : null),
      createdAt: at,
      changed: changeOf(v, doc, next),
    });
    await prune(r, updated);
    await assets.syncRefs(r, updated);
    return updated;
  }

  /** Read, change and save in one transaction. */
  async function write(actor: Actor, col: string, slug: string, make: (cur: CmsDoc) => DocInput, o: WriteOptions = {}) {
    await ensureSchema();
    let prev: CmsDoc | null = null;
    const doc = await repo.tx(async (r) => {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "write", cur);
      if (o.publish || (collection(col).versions?.drafts === false && cur.publishedVersion !== null)) assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
      const next = validate(col, merged(cur, await prepared(actor, col, cur, make(cur))));
      await assets.assertDoc(collection(col), next, cur, r);
      if (same(next, cur)) {
        // Nothing changed. Still honour "publish".
        if (o.publish && cur.publishedVersion !== cur.version) {
          await assertReviewed(r, actor, cur, cur.version);
          return publishIn(r, actor, cur, cur.version);
        }
        return cur.autosave ? ((await r.updateDoc(cur.id, { autosave: null, updatedAt: cur.updatedAt })) ?? cur) : cur;
      }
      return commit(r, actor, cur, next, o);
    });
    if (o.publish && doc.publishedVersion === doc.version && prev && (prev as CmsDoc).publishedVersion !== doc.version) audit(actor, "doc.publish", { collection: col, slug: doc.slug, version: doc.version });
    changed(prev, doc);
    flow.markAgent(actor, doc);
    return { prev: prev as CmsDoc | null, doc };
  }

  async function update(actor: Actor, col: string, slug: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    return (await write(actor, col, slug, () => input, o)).doc;
  }

  /**
   * Change sections of the body (`patch.ts` ops) in one transaction. With
   * `dryRun` nothing is saved; you get the unified diff and the problems.
   */
  async function patch(
    actor: Actor,
    col: string,
    slug: string,
    ops: PatchOp[],
    o: WriteOptions & { dryRun?: boolean } = {}
  ): Promise<{ doc: CmsDoc | null; diff: string; diagnostics: Diagnostic[]; saved: boolean }> {
    if (o.dryRun) {
      const cur = await editable(actor, col, slug);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
      const body = applyPatch(cur.body, ops);
      const { diagnostics } = check(col, { ...cur, body });
      diagnostics.push(...(await assets.checkDoc(collection(col), { ...cur, body }, assets.idsIn(collection(col), cur))));
      return { doc: null, diff: unifiedDiff(cur.body, body, { from: `v${cur.version}`, to: "patched" }), diagnostics, saved: false };
    }
    let before = "";
    const r = await write(
      actor,
      col,
      slug,
      (cur) => {
        before = cur.body;
        return { body: applyPatch(cur.body, ops) };
      },
      o
    );
    return { doc: r.doc, diff: unifiedDiff(before, r.doc.body, { from: `v${r.prev?.version ?? "?"}`, to: `v${r.doc.version}` }), diagnostics: [], saved: r.doc.version !== r.prev?.version };
  }

  /** Section anchors of a document (what `patch` ops point at). */
  async function sections(actor: Actor, col: string, slug: string) {
    const doc = await editable(actor, col, slug);
    return sectionRanges(doc.body).map((s) => ({ anchor: s.anchor, heading: s.heading }));
  }

  /** Keep unsaved editor content without making a version. */
  async function autosave(actor: Actor, col: string, slug: string, input: DocInput, baseVersion: number) {
    await ensureSchema();
    const cur = await editable(actor, col, slug);
    const content = contentOf(merged(cur.autosave?.content ?? cur, input));
    if (JSON.stringify(content).length > LIMITS.body * 2) throw fail("body_too_large", {}, { status: 413 });
    const state = { content, at: nowIso(), by: actorRef(actor).label, baseVersion };
    // Keep updatedAt: an autosave is not a change anyone else sees.
    await repo.updateDoc(cur.id, { autosave: state, updatedAt: cur.updatedAt });
    return state;
  }

  async function discardAutosave(actor: Actor, col: string, slug: string) {
    const cur = await editable(actor, col, slug);
    if (cur.autosave) await repo.updateDoc(cur.id, { autosave: null, updatedAt: cur.updatedAt });
  }

  /** A publish uses up the publish half of a schedule; a later unpublish stays. */
  const afterPublish = (doc: CmsDoc): DocPatch => ({ schedule: doc.schedule?.unpublishAt ? { ...doc.schedule, publishAt: null } : null, dueAt: doc.schedule?.unpublishAt ?? null });

  async function publishIn(r: CmsRepo, actor: Actor, doc: CmsDoc, n: number): Promise<CmsDoc> {
    const v = n === doc.version ? { snapshot: contentOf(doc) } : await r.getVersion(doc.id, n);
    if (!v) throw fail("version_not_found", { version: n });
    await gate("beforePublish", actor, { collection: doc.collection, slug: doc.slug, version: n }, v.snapshot);
    const at = nowIso();
    const wasPublic = doc.publishedVersion !== null && doc.status !== "archived";
    const updated = await r.updateDoc(doc.id, {
      status: n === doc.version ? "published" : "draft",
      publishedVersion: n,
      published: v.snapshot,
      publishedAt: doc.publishedAt ?? at,
      ...(!wasPublic && doc.publishedAt ? { republishedAt: at } : {}),
      ...afterPublish(doc),
      ...(doc.review && n >= doc.review.version ? { review: null } : {}),
      updatedAt: at,
      updatedBy: actorRef(actor).label,
      updatedByKind: actorRef(actor).kind,
      updatedByAgent: actorRef(actor).agent,
    });
    if (!updated) throw fail("not_found", { collection: doc.collection, slug: doc.slug });
    await assets.syncRefs(r, updated);
    return updated;
  }

  /** Run a publish-level state change on one document in a transaction. */
  async function stateChange(actor: Actor, col: string, slug: string, expectedVersion: number | undefined, fn: (r: CmsRepo, cur: CmsDoc) => Promise<CmsDoc>) {
    await ensureSchema();
    let prev: CmsDoc | null = null;
    const doc = await repo.tx(async (r) => {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "publish", cur);
      if (expectedVersion !== undefined && expectedVersion !== cur.version) throw conflict(cur, expectedVersion, actor, col);
      return fn(r, cur);
    });
    changed(prev, doc);
    return doc;
  }

  async function publish(actor: Actor, col: string, slug: string, o: { version?: number; expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
      await assertReviewed(r, actor, cur, o.version ?? cur.version);
      return publishIn(r, actor, cur, o.version ?? cur.version);
    });
    audit(actor, "doc.publish", { collection: col, slug, version: doc.publishedVersion });
    return doc;
  }

  async function archive(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
      if (cur.publishedVersion === null) throw fail("not_published");
      if (cur.status === "archived") return cur;
      return (await r.updateDoc(cur.id, { status: "archived", updatedAt: nowIso() }))!;
    });
    audit(actor, "doc.archive", { collection: col, slug, version: doc.version });
    return doc;
  }

  async function unarchive(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
      if (cur.status !== "archived") return cur;
      const at = nowIso();
      return (await r.updateDoc(cur.id, { status: cur.publishedVersion === cur.version ? "published" : "draft", republishedAt: at, updatedAt: at }))!;
    });
    audit(actor, "doc.unarchive", { collection: col, slug, version: doc.version });
    return doc;
  }

  async function unpublishIn(r: CmsRepo, actor: Actor, cur: CmsDoc): Promise<CmsDoc> {
    if (cur.publishedVersion === null && cur.status !== "archived") return cur.schedule ? (await r.updateDoc(cur.id, { schedule: null, dueAt: null, updatedAt: cur.updatedAt }))! : cur;
    const who = actorRef(actor);
    const out = (await r.updateDoc(cur.id, { status: "draft", publishedVersion: null, published: null, schedule: null, dueAt: null, updatedAt: nowIso(), updatedBy: who.label, updatedByKind: who.kind, updatedByAgent: who.agent }))!;
    await assets.syncRefs(r, out);
    return out;
  }

  /**
   * Take a document off the public site and back to draft. Its versions stay;
   * the first publish time is kept, so publishing again doesn't re-date it.
   */
  async function unpublish(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, (r, cur) => unpublishIn(r, actor, cur));
    audit(actor, "doc.unpublish", { collection: col, slug, version: doc.version });
    return doc;
  }

  async function restore(actor: Actor, col: string, slug: string, n: number, o: WriteOptions = {}): Promise<CmsDoc> {
    await ensureSchema();
    let prev: CmsDoc | null = null;
    const doc = await repo.tx(async (r) => {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "write", cur);
      if (o.publish || (collection(col).versions?.drafts === false && cur.publishedVersion !== null)) assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
      const v = await r.getVersion(cur.id, n);
      if (!v) throw fail("version_not_found", { version: n });
      return commit(r, actor, cur, validate(col, { ...v.snapshot, slug: cur.slug }), { ...o, restoredFrom: n });
    });
    audit(actor, "doc.restore", { collection: col, slug, version: doc.version, detail: { from: n } });
    changed(prev, doc);
    return doc;
  }

  async function remove(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<void> {
    await ensureSchema();
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw fail("not_found", { collection: col, slug });
    assert(actor, col, "delete", cur);
    if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
    await gate("beforeDelete", actor, cur, contentOf(cur));
    // With a trash the row stays (and keeps its address) until it is restored or purged.
    if (trashDays > 0) await repo.updateDoc(cur.id, { deletedAt: nowIso(), deletedBy: actorRef(actor).label, schedule: null, dueAt: null, updatedAt: nowIso() });
    else await repo.deleteDoc(cur.id);
    audit(actor, "doc.delete", { collection: col, slug, version: cur.version, detail: { trash: trashDays > 0 } });
    changed(cur, null);
  }

  /**
   * What a document would look like, without saving it: the parsed blocks,
   * the table of contents, every problem, the diff against the saved body and
   * the files it uses. The admin preview and an agent's pre-save check share it.
   */
  async function preview(actor: Actor, col: string, input: DocInput, o: { slug?: string } = {}) {
    const diagnostics = await diagnose(actor, col, input, o);
    const cfg = collection(col);
    const cur = o.slug ? await repo.findDoc(col, o.slug) : null;
    const content = merged(cur ?? { slug: "", title: "", summary: "", body: "", category: null, keywords: [], fields: {} }, input);
    const blocks = parseMarkdown(content.body, { lines: true });
    return {
      blocks,
      toc: extractToc(blocks),
      diagnostics,
      diff: cur ? unifiedDiff(cur.body, content.body, { from: `v${cur.version}`, to: "preview" }) : null,
      publicUrl: cfg.url && content.slug ? cfg.url({ slug: content.slug }) : null,
      assets: await assets.assetsFor({ collection: col, body: content.body, fields: content.fields }),
    };
  }

  /** The same action on many documents; each in its own transaction, so one failure does not stop the rest. */
  async function bulk(actor: Actor, col: string, action: BulkAction, items: { slug: string; expectedVersion?: number }[]): Promise<BulkResult[]> {
    if (!BULK_ACTIONS.includes(action)) throw fail("invalid_request", { issues: `action: ${action}` });
    const out: BulkResult[] = [];
    const tagged: Actor = { ...actor };
    for (const it of items.slice(0, 200)) {
      try {
        const o = { expectedVersion: it.expectedVersion };
        if (action === "publish") await publish(tagged, col, it.slug, o);
        else if (action === "unpublish") await unpublish(tagged, col, it.slug, o);
        else if (action === "archive") await archive(tagged, col, it.slug, o);
        else if (action === "unarchive") await unarchive(tagged, col, it.slug, o);
        else await remove(tagged, col, it.slug, o);
        out.push({ slug: it.slug, ok: true });
      } catch (e) {
        if (!isCmsError(e)) report(e, "bulk");
        out.push({ slug: it.slug, ok: false, error: isCmsError(e) ? { code: e.code, message: message(e) } : { code: "internal", message: formatMessage(messages, "internal") } });
      }
    }
    return out;
  }

  // ── agent changes and review ──────────────────────────────────────────────

  const containsBlock = (body: string, block: string[]) => {
    if (!block.length) return true;
    const lines = splitLines(body);
    outer: for (let i = 0; i + block.length <= lines.length; i++) {
      for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) continue outer;
      return true;
    }
    return false;
  };

  /**
   * Body changes agents (keys, the app's own assistant) made that no person
   * has reviewed yet and that are still in the working copy.
   */
  async function agentChanges(actor: Actor, col: string, slug: string): Promise<AgentChange[]> {
    const doc = await editable(actor, col, slug);
    const out: AgentChange[] = [];
    for (const v of (await repo.listVersions(doc.id)).slice(0, 30)) {
      // A person's own edits are not agent changes; an agent acting for a person is.
      if ((v.authorKind === "user" && !v.authorAgent) || !v.changed) continue;
      const done = new Set(v.reviewed.map((m) => m.hunk));
      for (const h of v.changed.hunks) {
        if (done.has(h.id)) continue;
        if (h.added.length ? !containsBlock(doc.body, h.added) : containsBlock(doc.body, h.removed)) continue;
        out.push({ id: h.id, version: v.version, author: v.authorAgent ?? v.authorLabel, authorKind: v.authorKind, behalf: v.authorAgent ? v.authorLabel : null, at: v.createdAt, removed: h.removed, added: h.added, before: h.before ?? null });
      }
    }
    return out;
  }

  /** Mark agent hunks reviewed: accepted (kept) or reverted (the person's save undid them). */
  async function reviewChanges(actor: Actor, col: string, slug: string, o: { hunks: string[] | "all"; action?: ReviewMark["action"] }): Promise<{ reviewed: number }> {
    const doc = await editable(actor, col, slug);
    const who = actorRef(actor).label;
    const at = nowIso();
    const pending = await agentChanges(actor, col, slug);
    const want = o.hunks === "all" ? pending : pending.filter((p) => (o.hunks as string[]).includes(p.id));
    const byVersion = new Map<number, string[]>();
    for (const p of want) byVersion.set(p.version, [...(byVersion.get(p.version) ?? []), p.id]);
    for (const [n, ids] of byVersion) {
      const v = await repo.getVersion(doc.id, n);
      if (!v) continue;
      await repo.setVersionReviewed(doc.id, n, [...v.reviewed, ...ids.map((hunk) => ({ hunk, by: who, at, action: o.action ?? "accepted" }))]);
    }
    return { reviewed: want.length };
  }

  // ── preview links ─────────────────────────────────────────────────────────

  function sign(payload: string): string {
    return createHmac("sha256", opts.previewSecret!).update(payload).digest("base64url");
  }

  /** A signed URL that shows this exact version of the draft, no sign-in needed, until it expires. */
  async function createPreviewLink(actor: Actor, col: string, slug: string, o: { ttl?: PreviewTtl; comments?: boolean } = {}): Promise<PreviewLink> {
    if (!opts.previewSecret) throw fail("preview_disabled");
    const cfg = collection(col);
    if (!cfg.url) throw fail("no_public_url");
    const doc = await editable(actor, col, slug);
    const ttl = PREVIEW_TTLS[o.ttl ?? "24h"];
    if (!ttl) throw fail("invalid_request", { issues: `ttl: ${o.ttl}` });
    const exp = now().getTime() + ttl;
    const payload = b64url(JSON.stringify({ c: col, s: doc.slug, v: doc.version, exp, ...(o.comments ? { cm: 1 } : {}) }));
    const token = `${payload}.${sign(payload)}`;
    const base = cfg.url({ slug: doc.slug });
    audit(actor, "preview.create", { collection: col, slug: doc.slug, version: doc.version, detail: { ttl: o.ttl ?? "24h", comments: !!o.comments } });
    return { url: `${base}${base.includes("?") ? "&" : "?"}cms_preview=${token}`, token, version: doc.version, expiresAt: new Date(exp).toISOString() };
  }

  /** Read the version a preview token points at (for the app's public page). */
  function previewPayload(token: string): { c: string; s: string; v: number; exp: number; cm?: 1 } {
    if (!opts.previewSecret) throw fail("preview_disabled");
    const [payload, sig] = String(token).split(".");
    const good = payload && sig ? Buffer.from(sign(payload)) : null;
    if (!good || good.length !== Buffer.from(sig).length || !timingSafeEqual(good, Buffer.from(sig))) throw fail("preview_invalid");
    let p: { c: string; s: string; v: number; exp: number; cm?: 1 };
    try {
      p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw fail("preview_invalid");
    }
    if (!(p.exp > now().getTime())) throw fail("preview_expired");
    return p;
  }

  async function readPreview(token: string): Promise<PreviewRead> {
    const p = previewPayload(token);
    await ensureSchema();
    collection(p.c);
    const doc = await repo.findDoc(p.c, p.s);
    if (!doc) throw fail("not_found", { collection: p.c, slug: p.s });
    const v = await repo.getVersion(doc.id, p.v);
    if (!v) throw fail("version_not_found", { version: p.v });
    return { collection: p.c, slug: p.s, version: p.v, expiresAt: new Date(p.exp).toISOString(), doc: contentOf(v.snapshot), comments: !!p.cm };
  }

  // ── search ────────────────────────────────────────────────────────────────

  const index = { built: null as SearchIndex | null, dirty: true, stamp: "", checkedAt: 0, building: null as Promise<SearchIndex> | null };

  async function buildIndex(): Promise<SearchIndex> {
    const searchable = [...collections.values()].filter((c) => c.search?.enabled !== false).map((c) => c.slug);
    const docs = (await repo.listDocs({ published: true })).filter((d) => searchable.includes(d.collection));
    const units = docs.flatMap((d) => {
      const p = publicView(d);
      return p ? unitsOf({ ...p, publishedAt: p.publishedAt }) : [];
    });
    return new SearchIndex(units);
  }

  async function searchIndex(): Promise<SearchIndex> {
    const t = Date.now();
    if (index.built && !index.dirty && t - index.checkedAt > refreshMs) {
      index.checkedAt = t;
      const stamp = await repo.changeStamp().catch(() => index.stamp);
      if (stamp !== index.stamp) index.dirty = true;
    }
    if (index.built && !index.dirty) return index.built;
    if (!index.building) {
      index.dirty = false;
      index.building = (async () => {
        const stamp = await repo.changeStamp();
        const built = await buildIndex();
        index.built = built;
        index.stamp = stamp;
        index.checkedAt = Date.now();
        return built;
      })()
        .catch((err) => {
          index.dirty = true;
          report(err, "searchIndex");
          if (index.built) return index.built;
          throw err;
        })
        .finally(() => {
          index.building = null;
        });
    }
    return index.building;
  }

  async function search(actor: Actor, cols: string[], query: string, o: SearchOptions = {}): Promise<SearchResult> {
    await ensureSchema();
    for (const c of cols) assert(actor, c, "read");
    if (o.logGap !== undefined) warnOnce("logGap", "search option logGap was renamed to reportMiss in 0.6.0");
    const reportMiss = o.reportMiss ?? o.logGap ?? false;
    const idx = await searchIndex();
    const limit = Math.max(1, Math.min(o.limit ?? 5, 50));
    const raw = idx.search(query, { limit: limit + 3, perDoc: o.perDoc ?? 2, filter: (u) => cols.includes(u.collection) && (!o.filter || o.filter(u)) });
    const hits = raw.filter((h) => h.coverage >= minCoverage).slice(0, limit);
    const empty = hits.length === 0;
    if (empty && reportMiss && opts.onSearchMiss && query.trim()) {
      const e: SearchMissEvent = {
        query: query.trim().slice(0, 500),
        normalized: normalizeQuery(query) || query.trim().toLowerCase(),
        collections: [...cols],
        actor,
        source: actor.via ?? "app",
        at: nowIso(),
        nearest: raw.slice(0, 3).map((h) => ({ collection: h.unit.collection, slug: h.unit.slug, anchor: h.unit.anchor || null, score: Number(h.score.toFixed(3)), coverage: Number(h.coverage.toFixed(3)) })),
      };
      // Not awaited: the app's storage never slows down or breaks a search.
      void Promise.resolve()
        .then(() => opts.onSearchMiss!(e))
        .catch((err) => report(err, "onSearchMiss"));
    }
    return { hits, empty };
  }

  // ── usage counts ──────────────────────────────────────────────────────────

  async function recordHits(docIds: string[], source: Via = "app") {
    if (!docIds.length) return;
    await repo.addHits([...new Set(docIds)], dayIn(timeZone, now()), source).catch((e) => report(e, "recordHits"));
  }

  async function hitCounts(actor: Actor, col: string, days = 7): Promise<Map<string, number>> {
    assert(actor, col, "write");
    const since = addDays(dayIn(timeZone, now()), -(Math.max(1, days) - 1));
    return repo.hitCounts(since, col);
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  const baseAdmin = (actor: Actor) => actor.kind === "system" || (actor.kind === "user" && actor.isAdmin) || (actor.kind === "key" && actor.scopes.includes("admin"));
  const roles = createRoles({
    repo,
    now,
    fail,
    audit,
    baseAdmin,
    ready: ensureSchema,
    users: opts.users,
    targets: () => [...collections.values()].map((c) => ({ slug: c.slug, label: c.label, coded: [...(c.access?.write ? (["write"] as const) : []), ...(c.access?.publish ? (["publish", "delete"] as const) : []), ...(c.managed ? (["write", "publish", "delete"] as const) : [])] })),
  });
  /** An admin by the app's word, by a key's scope, or through a role marked "admin". */
  const isAdmin = (actor: Actor) => roles.isAdmin(actor);

  function assertKeyAdmin(actor: Actor) {
    if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_keys");
  }

  // What a key carries beyond its row (a record, so no column was needed): its own request limit,
  // the addresses it may be used from, why it was revoked, which key replaced it.
  interface KeyMeta {
    rateLimit?: number | null;
    allowedIps?: string[];
    revokedReason?: string | null;
    rotatedTo?: string | null;
  }
  const KEY_META = "key_meta";
  const KEY_META_TTL = 30_000;
  let keyMeta: Map<string, KeyMeta> | null = null;
  let keyMetaAt = 0;
  async function keyMetas(force = false): Promise<Map<string, KeyMeta>> {
    if (!force && keyMeta && now().getTime() - keyMetaAt < KEY_META_TTL) return keyMeta;
    const rows = await repo.listRecords({ kind: KEY_META, limit: 1000 });
    keyMeta = new Map(rows.filter((r) => r.key).map((r) => [r.key as string, r.data as KeyMeta]));
    keyMetaAt = now().getTime();
    return keyMeta;
  }
  async function setKeyMeta(id: string, patch: KeyMeta) {
    const cur = await repo.findRecordByKey(KEY_META, id);
    const data = { ...((cur?.data as KeyMeta | undefined) ?? {}), ...patch } as Record<string, unknown>;
    if (cur) await repo.updateRecord(KEY_META, cur.id, { data, at: nowIso() });
    else await repo.insertRecord({ kind: KEY_META, key: id, data, at: nowIso() });
    keyMeta = null;
  }
  function keyLimits(input: { rateLimit?: number | null; allowedIps?: string[] | null }): KeyMeta {
    const out: KeyMeta = {};
    if (input.rateLimit !== undefined && input.rateLimit !== null) {
      if (!Number.isInteger(input.rateLimit) || input.rateLimit < 1 || input.rateLimit > 100_000) throw fail("invalid_rate_limit");
      out.rateLimit = input.rateLimit;
    }
    const ips = (input.allowedIps ?? []).map((x) => x.trim()).filter(Boolean);
    const bad = badRanges(ips);
    if (bad.length) throw fail("invalid_ip_range", { value: bad[0] });
    if (ips.length) out.allowedIps = [...new Set(ips)].slice(0, 50);
    return out;
  }
  const limiter = createLimiter({ store: opts.rateLimit?.store, now: () => now().getTime() });

  const toKey = (k: CmsKey & { hash?: string }, meta?: KeyMeta): CmsKey => ({
    rateLimit: meta?.rateLimit ?? null,
    allowedIps: meta?.allowedIps ?? [],
    revokedReason: meta?.revokedReason ?? null,
    rotatedTo: meta?.rotatedTo ?? null,
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    collections: k.collections,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    expiresAt: k.expiresAt ?? null,
    createdAt: k.createdAt,
  });

  async function createKey(actor: Actor, input: { name: string; scopes: KeyScope[]; collections?: string[] | null; expiresAt?: string | null; rateLimit?: number | null; allowedIps?: string[] | null }) {
    await ensureSchema();
    assertKeyAdmin(actor);
    const limits = keyLimits(input);
    const name = input.name.trim();
    if (!name || name.length > 60) throw fail("invalid_key_name");
    if (!input.scopes.length) throw fail("scopes_required");
    for (const c of input.collections ?? []) collection(c);
    let expiresAt: string | null = null;
    if (input.expiresAt) {
      const t = Date.parse(input.expiresAt);
      if (!Number.isFinite(t) || t <= now().getTime()) throw fail("invalid_expiry");
      expiresAt = new Date(t).toISOString();
    }
    if (actor.kind === "key") {
      // A key may only mint keys that are a subset of itself.
      if (input.scopes.some((s) => !actor.scopes.includes(s))) throw fail("key_too_wide");
      if (actor.collections) {
        const asked = input.collections?.length ? input.collections : null;
        if (!asked || asked.some((c) => !actor.collections!.includes(c))) throw fail("key_too_wide");
      }
    }
    const raw = generateKey();
    const row = await repo.insertKey({
      name,
      prefix: displayPrefix(raw),
      hash: hashKey(raw),
      scopes: [...new Set(input.scopes)],
      collections: input.collections?.length ? input.collections : null,
      createdBy: actor.kind === "user" ? actor.id : null,
      expiresAt,
    });
    if (Object.keys(limits).length) await setKeyMeta(row.id, limits);
    audit(actor, "key.create", { detail: { key: row.id, name, scopes: row.scopes, collections: row.collections, expiresAt, ...limits } });
    return { key: toKey(row, limits), secret: raw };
  }

  /**
   * A new secret for the same key: same name, scopes, collections, expiry and limits. The old secret
   * keeps working for `graceMinutes` (default 60, 0 to cut it off now) so callers can switch over.
   */
  async function rotateKey(actor: Actor, id: string, o: { graceMinutes?: number } = {}) {
    await ensureSchema();
    assertKeyAdmin(actor);
    const old = (await repo.listKeys()).find((k) => k.id === id);
    const at = now();
    if (!old || (old.revokedAt && Date.parse(old.revokedAt) <= at.getTime())) throw fail("key_not_found");
    if (actor.kind === "key" && (old.scopes.some((x) => !actor.scopes.includes(x)) || (actor.collections && (!old.collections || old.collections.some((c) => !actor.collections!.includes(c)))))) throw fail("key_too_wide");
    const grace = Math.max(0, Math.min(Math.floor(o.graceMinutes ?? 60), 7 * 24 * 60));
    const meta = (await keyMetas(true)).get(id) ?? {};
    const raw = generateKey();
    const row = await repo.insertKey({ name: old.name, prefix: displayPrefix(raw), hash: hashKey(raw), scopes: old.scopes, collections: old.collections, createdBy: actor.kind === "user" ? actor.id : null, expiresAt: old.expiresAt ?? null });
    const carried: KeyMeta = { ...(meta.rateLimit ? { rateLimit: meta.rateLimit } : {}), ...(meta.allowedIps?.length ? { allowedIps: meta.allowedIps } : {}) };
    if (Object.keys(carried).length) await setKeyMeta(row.id, carried);
    const until = new Date(at.getTime() + grace * 60_000).toISOString();
    await repo.revokeKey(id, until);
    await setKeyMeta(id, { revokedReason: "rotated", rotatedTo: row.id });
    audit(actor, "key.rotate", { detail: { key: id, to: row.id, graceMinutes: grace } });
    return { key: toKey(row, carried), secret: raw, previous: { id, worksUntil: until } };
  }

  async function listKeys(actor: Actor): Promise<CmsKey[]> {
    await ensureSchema();
    assertKeyAdmin(actor);
    const metas = await keyMetas(true);
    return (await repo.listKeys()).map((k) => toKey(k, metas.get(k.id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function revokeKey(actor: Actor, id: string, o: { reason?: string | null } = {}) {
    assertKeyAdmin(actor);
    if (!(await repo.revokeKey(id, nowIso()))) throw fail("key_not_found");
    const reason = o.reason?.trim().slice(0, 200) || null;
    if (reason) await setKeyMeta(id, { revokedReason: reason });
    audit(actor, "key.revoke", { detail: { key: id, ...(reason ? { reason } : {}) } });
  }

  /** What limits a key: its own number or the default, and where it may be used from. */
  async function keyPolicy(id: string): Promise<{ perMinute: number | null; allowedIps: string[] }> {
    const meta = (await keyMetas()).get(id);
    return { perMinute: meta?.rateLimit ?? opts.rateLimit?.perMinute ?? null, allowedIps: meta?.allowedIps ?? [] };
  }

  /**
   * Resolve a raw key to an actor: null when unknown or revoked, throws
   * `key_expired` for an expired key (the caller learns why).
   */
  async function authenticateKey(raw: string): Promise<Extract<Actor, { kind: "key" }> | null> {
    await ensureSchema();
    const row = await repo.findKeyByHash(hashKey(raw));
    if (!row) return null;
    const at = now();
    const anon: Actor = { kind: "anonymous" };
    // A revoke time in the future is a rotated key inside its grace period: it still works.
    if (row.revokedAt && Date.parse(row.revokedAt) <= at.getTime()) {
      audit(anon, "auth.failed", { outcome: "denied", detail: { key: row.id, reason: "revoked" } });
      return null;
    }
    if (row.expiresAt && Date.parse(row.expiresAt) <= at.getTime()) {
      audit(anon, "auth.failed", { outcome: "denied", detail: { key: row.id, reason: "expired" } });
      throw fail("key_expired", { expiresAt: row.expiresAt.slice(0, 10) });
    }
    if (!row.lastUsedAt || at.getTime() - Date.parse(row.lastUsedAt) > 5 * 60_000) {
      void repo.touchKey(row.id, at.toISOString()).catch((e) => report(e, "touchKey"));
    }
    return { kind: "key", id: row.id, label: row.name, scopes: row.scopes, collections: row.collections };
  }

  // ── audit log ─────────────────────────────────────────────────────────────

  async function auditLog(actor: Actor, o: { cursor?: string | null; limit?: number; action?: string; outcome?: AuditEntry["outcome"]; actorKind?: AuditEntry["actorKind"] } = {}) {
    await ensureSchema();
    if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_audit");
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const entries = await repo.listAudit({ before: o.cursor ?? null, limit: limit + 1, action: o.action, outcome: o.outcome, actorKind: o.actorKind });
    const more = entries.length > limit;
    const page = entries.slice(0, limit);
    return { entries: page, nextCursor: more ? `${page[page.length - 1].at}|${page[page.length - 1].id}` : null };
  }

  /** The message of an error in this CMS's language. */
  function message(e: unknown): string {
    if (isCmsError(e)) return formatMessage(messages, e.code, e.params);
    return formatMessage(messages, "internal");
  }

  // ── background jobs, webhooks (jobs.ts, outbox.ts) ─────────────────────────

  const sealer = opts.secretsKey ? createSealer(opts.secretsKey) : null;
  const jobs = createJobs({ repo, now, report, event: telemetry });
  const outbox = createOutbox({
    repo,
    now,
    fail,
    audit,
    isAdmin,
    ready: ensureSchema,
    report,
    sealer,
    jobs,
    collections: () => [...collections.keys()],
    options: opts.webhooks ?? {},
  });

  // ── schedules, trash, reviews, comments, releases (flow.ts) ───────────────

  const flow = createFlow({
    repo,
    now,
    nowIso,
    fail,
    audit,
    actorRef,
    collection,
    collections: () => [...collections.values()],
    can,
    assert,
    isAdmin,
    ready: ensureSchema,
    editable,
    conflict,
    publishIn,
    unpublishIn,
    changed,
    problems: async (doc, c, r) => {
      const cfg = collection(doc.collection);
      return [...check(doc.collection, c).diagnostics, ...(await assets.checkDoc(cfg, c, assets.idsIn(cfg, doc), r))];
    },
    needsReview,
    assertReviewed,
    summaryOf,
    message,
    report,
    trashDays,
    assets,
    previewPayload,
  });

  // ── automations, the dashboard ──

  const automations = createAutomations({
    repo,
    now,
    today: () => dayIn(timeZone, now()),
    fail,
    audit,
    isAdmin,
    ready: ensureSchema,
    report,
    jobs,
    collections: () => [...collections.keys()],
    findDoc: (col, slug) => repo.findDoc(col, slug),
    update: (actor, col, slug, input) => update(actor, col, slug, input),
    addToRelease: (actor, id, item) => flow.releases.add(actor, id, [item]),
    sendWebhook: (id, e) => outbox.send(id, e),
    options: opts.automations ?? {},
  });
  const retention = createRetention({
    repo,
    options: opts.retention ?? {},
    now,
    timeZone,
    dayIn,
    assertAdmin: (actor) => {
      if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_admin");
    },
    audit: (actor, detail) => audit(actor, "retention.run", { detail }),
  });
  const stats = createStats({ repo, now, dayOf: (d) => dayIn(timeZone, d), ready: ensureSchema, collections: () => [...collections.keys()], can, counts, isAdmin });

  const transfer = createTransfer({
    repo,
    now,
    fail,
    audit,
    ready: ensureSchema,
    message,
    collections: () => [...collections.keys()],
    can,
    list,
    diagnose,
    create,
    update,
    publish,
    assetsOf: async (_actor, docs) => {
      if (!opts.media) return [];
      const ids = [...new Set(docs.flatMap((d) => [...(d.body + JSON.stringify(d.fields)).matchAll(/asset:([a-z0-9]{12})/g)].map((m) => m[1])))];
      return (await repo.findAssets(ids)).map((a) => ({ id: a.id, store: a.store, key: a.key, name: a.name, alt: a.alt, tags: a.tags }));
    },
  });

  // ── editing as files (ax.ts) ──────────────────────────────────────────────

  const ax = createAx({
    repo,
    fail,
    ready: ensureSchema,
    nowIso,
    collection,
    collections: () => [...collections.keys()],
    can,
    assert,
    get,
    create: (actor, col, input, o) => create(actor, col, input as DocInput, o),
    update: (actor, col, slug, input, o) => update(actor, col, slug, input as DocInput, o),
    actorRef,
    audit: (actor, action, o) => audit(actor, action, o ?? {}),
  });

  /** Everything to look at before publishing: the document's problems and the collection's own checks. */
  async function publishChecks(actor: Actor, col: string, slug: string, input: DocInput = {}) {
    const diagnostics = await diagnose(actor, col, input, { slug });
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw fail("not_found", { collection: col, slug });
    const checks = await appChecks(col, slug, validateLoose(col, merged(cur, input)));
    return { diagnostics, checks, blocking: diagnostics.some((d) => d.severity === "error") || checks.some((c) => c.severity === "error") };
  }
  /** The content as the checks see it, even when it does not validate yet. */
  function validateLoose(col: string, c: DocContent): DocContent {
    return check(col, c).content;
  }

  // ── plugins (plugin.ts) ───────────────────────────────────────────────────

  const plugins = {
    names: [] as string[],
    routes: [] as PluginRoute[],
    tools: [] as (PluginTool<any> & { plugin: string })[],
    nav: [] as (PluginNav & { plugin: string })[],
    me: [] as { plugin: string; fn: (actor: Actor) => Record<string, unknown> | Promise<Record<string, unknown>> }[],
    /** The SQL the plugins' tables need (run it with your migrations; every statement is safe to repeat). */
    sql: [] as string[],
  };

  const api = {
    collections: () => [...collections.values()],
    collection,
    can,
    isAdmin,
    get,
    list,
    page,
    counts,
    versions,
    versionList,
    version,
    diff,
    diagnose,
    create,
    update,
    patch,
    sections,
    autosave,
    discardAutosave,
    publish,
    archive,
    unarchive,
    unpublish,
    restore,
    remove,
    bulk,
    agentChanges,
    reviewChanges,
    createPreviewLink,
    readPreview,
    previewEnabled: () => !!opts.previewSecret,
    /** The zone days and schedules are shown in (`createCms({ timeZone })`, default UTC). */
    timeZone,
    search,
    recordHits,
    hitCounts,
    createKey,
    listKeys,
    revokeKey,
    rotateKey,
    keyPolicy,
    /** Request counting (`createCms({ rateLimit })`): `limits.check(who, perMinute)`. */
    limits: { check: limiter.check, anonymousPerMinute: opts.rateLimit?.anonymousPerMinute ?? null },
    /** Hear every event as it happens (the events stream uses this). Returns the function that stops it. */
    subscribe(fn: (e: OutEvent) => void): () => void {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    /**
     * Documents as files, for agents (0.15.0): `read`, `grep`, `edit`, `write`, `file`, `rawLink`,
     * `rawOpen`, and suggestions (`suggestions`, `applySuggestion`, `rejectSuggestion`).
     */
    ax,
    /** May `actor` add HTML (`"html"`) or HTML that runs (`"html_scripts"`) in the collection? */
    canHtml,
    publishChecks,
    /** Throws unless `actor` may do `what` in the collection. */
    assertCan: (actor: Actor, col: string, what: "read" | "write" | "publish" | "delete") => assert(actor, col, what),
    /**
     * Documents with a version saved after `since` (any process), newest first: what a client that
     * was away should fetch again. A reader only gets documents whose public copy is one of those versions.
     */
    async changedSince(actor: Actor, since: string, o: { collections?: readonly string[]; limit?: number } = {}) {
      await ensureSchema();
      const limit = Math.max(1, Math.min(o.limit ?? 200, 500));
      const stamps = await repo.versionsSince(since, limit * 3);
      const byDoc = new Map<string, number[]>();
      for (const v of stamps) byDoc.set(v.documentId, [...(byDoc.get(v.documentId) ?? []), v.version]);
      const out: { collection: string; slug: string; version: number; at: string }[] = [];
      for (const [id, versions] of byDoc) {
        if (out.length >= limit) break;
        const doc = await repo.findDocById(id);
        if (!doc || !collections.has(doc.collection) || (o.collections?.length && !o.collections.includes(doc.collection))) continue;
        if (can(actor, doc.collection, "write", doc)) out.push({ collection: doc.collection, slug: doc.slug, version: doc.version, at: doc.updatedAt });
        else if (can(actor, doc.collection, "read", doc) && publicView(doc) && versions.includes(doc.publishedVersion as number)) out.push({ collection: doc.collection, slug: doc.slug, version: doc.publishedVersion as number, at: doc.updatedAt });
      }
      return out;
    },
    /** Retention: `run(actor, { dryRun })`, `rules()`. Runs once a day with the cron call. */
    retention,
    authenticateKey,
    audit: auditLog,
    preview,
    needsReview,
    /** Publish (and/or unpublish) at a time; what goes out is the version that is current now. */
    schedule: flow.schedule,
    unschedule: flow.unschedule,
    /** Run everything whose time has come (the `/_cron` route calls this). */
    runScheduled: flow.runScheduled,
    /**
     * Everything a cron call does: what is scheduled, then the jobs that are due (webhook
     * deliveries, plugin jobs), then housekeeping. `/_cron` and `agent-cms cron` call this.
     */
    async cron(o: { budgetMs?: number } = {}): Promise<ScheduledRun & { jobs: JobsRun }> {
      const t0 = Date.now();
      const scheduled = await flow.runScheduled();
      await automations.tick().catch((e) => report(e, "automations"));
      const ran = await jobs.run(o);
      await Promise.all([jobs.prune(), outbox.prune(), retention.tick()]).catch((e) => report(e, "cron housekeeping"));
      telemetry({ type: "cron", ms: Date.now() - t0, jobs: ran });
      return { ...scheduled, jobs: ran };
    },
    /** Background jobs: `enqueue`, `run`, `stats`, `list`, `retry`, `define`. */
    jobs,
    /** Webhooks: `list`, `create`, `update`, `remove`, `secret`, `test`, `deliveries`, `retry`. Admins only. */
    webhooks: outbox,
    /** Automations: `list`, `create`, `update`, `remove`, `runs`, `test`, `addAction`. Admins only. */
    automations,
    /** Roles: `list`, `create`, `update`, `remove`, `addMember`, `removeMember`, `searchUsers`. Admins only. */
    roles,
    /** `export(actor, { collections, drafts })` and `import(actor, files, { dryRun, onConflict, publish })`: documents as markdown files. */
    transfer,
    /** The dashboard's numbers for the last 7, 14 or 30 days. */
    stats,
    /** Seal and open values kept in the database (null without `secretsKey`). */
    secrets: sealer,
    telemetry,
    plugins,
    cronSecret: opts.cronSecret ?? null,
    /** Deleted documents and files: `list`, `restore`, `purge`. */
    trash: { ...flow.trash, days: trashDays },
    requestReview: flow.requestReview,
    approveReview: flow.approveReview,
    rejectReview: flow.rejectReview,
    reviewRequests: flow.reviewRequests,
    comments: flow.comments,
    async addComment(...a: Parameters<typeof flow.addComment>) {
      const c = await flow.addComment(...a);
      if (a[0].kind !== "anonymous") emitEvent({ event: "comment.created", actor: actorRef(a[0]), collection: a[1], slug: a[2], version: null, url: urlOf(a[1], a[2]) });
      return c;
    },
    resolveComment: flow.resolveComment,
    previewComments: flow.previewComments,
    addPreviewComment: flow.addPreviewComment,
    labelVersion: flow.labelVersion,
    /** Documents that go public together: `list`, `get`, `create`, `add`, `publish`, `schedule`… */
    releases: flow.releases,
    /** Named list filters: `list`, `save`, `remove`. */
    filters: flow.filters,
    /** Who has a document open: `touch`, `leave`, `in`. */
    presence: flow.presence,
    /** The media library (`createCms({ media })`). */
    assets,
    /** The files a document uses, by id: address, size, alt text. For rendering. */
    assetsFor: assets.assetsFor,
    /** An image's address at a width, through `media.imageUrl` when set. */
    imageUrl: assets.imageUrl,
    message,
    messages,
    /** Fails with `schema_outdated` when the database needs a migration. */
    checkSchema: async () => {
      await ensureSchema();
    },
    /** Warm the search index (e.g. at boot) so the first agent call is fast. */
    warm: async () => {
      await ensureSchema();
      await searchIndex();
    },
    onChange(fn: (doc: CmsDoc, info: ChangeInfo) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    repo,
  };

  for (const p of opts.plugins ?? []) {
    if (!PLUGIN_NAME.test(p.name)) throw new Error(`[agent-cms] plugin name "${p.name}" must be lowercase letters, digits and dashes`);
    if (plugins.names.includes(p.name)) throw new Error(`[agent-cms] plugin "${p.name}" is given twice`);
    if (RESERVED_ROUTES.has(p.name) || collections.has(p.name)) throw new Error(`[agent-cms] plugin name "${p.name}" is taken by a route of the CMS`);
    plugins.names.push(p.name);
    plugins.sql.push(...(p.sql ?? []));
    p.setup({
      cms: api,
      secrets: sealer,
      on: (event, fn) => void eventListeners.push({ event, fn, plugin: p.name }),
      route: (method, path, handler) => void plugins.routes.push({ plugin: p.name, method, path: path.split("/").filter(Boolean), handler }),
      tool: (tool) => {
        if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) throw new Error(`[agent-cms] plugin ${p.name}: tool name "${tool.name}" must be snake_case`);
        plugins.tools.push({ ...tool, plugin: p.name });
      },
      job: (kind, def) => jobs.define(`${p.name}.${kind}`, def),
      enqueue: (kind, payload, o) => jobs.enqueue(`${p.name}.${kind}`, payload, o),
      me: (fn) => void plugins.me.push({ plugin: p.name, fn }),
      nav: (item) => void plugins.nav.push({ ...item, plugin: p.name }),
    });
  }
  return api;
}

export type CmsCore = ReturnType<typeof createCmsCore>;

type Typed = "get" | "list" | "create" | "update" | "publish" | "archive" | "unarchive" | "unpublish" | "restore";

/**
 * The CMS with types from its collections: collection names are checked at
 * compile time and `fields` is the collection's zod output.
 */
export type Cms<C extends readonly AnyCollection[] = readonly AnyCollection[]> = Omit<CmsCore, Typed> & {
  /** The untyped CMS (what REST, MCP and the tools use). */
  readonly core: CmsCore;
  get<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { draft?: boolean }): Promise<TypedDoc<FieldsOf<C, N>>>;
  list<N extends CollectionName<C>>(actor: Actor, col: N, o?: Parameters<CmsCore["list"]>[2]): Promise<TypedDoc<FieldsOf<C, N>>[]>;
  create<N extends CollectionName<C>>(actor: Actor, col: N, input: DocInput<FieldsOf<C, N>>, o?: WriteOptions): Promise<TypedDoc<FieldsOf<C, N>>>;
  update<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, input: DocInput<FieldsOf<C, N>>, o?: WriteOptions): Promise<TypedDoc<FieldsOf<C, N>>>;
  publish<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { version?: number; expectedVersion?: number }): Promise<TypedDoc<FieldsOf<C, N>>>;
  archive<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { expectedVersion?: number }): Promise<TypedDoc<FieldsOf<C, N>>>;
  unarchive<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { expectedVersion?: number }): Promise<TypedDoc<FieldsOf<C, N>>>;
  unpublish<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { expectedVersion?: number }): Promise<TypedDoc<FieldsOf<C, N>>>;
  restore<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, n: number, o?: WriteOptions): Promise<TypedDoc<FieldsOf<C, N>>>;
};

/** Anything that carries a CMS (the typed `Cms` or the core itself). */
export type CmsLike = { readonly core: CmsCore } | CmsCore;
export const coreOf = (c: CmsLike): CmsCore => ("core" in c && c.core ? c.core : (c as CmsCore));

export function createCms<const C extends readonly AnyCollection[]>(opts: CreateCmsOptions<C>): Cms<C> {
  const core = createCmsCore(opts as CreateCmsOptions);
  return Object.assign(Object.create(null) as object, core, { core }) as unknown as Cms<C>;
}

