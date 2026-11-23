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
import { createRoles, type RoleOp, type UsersOptions } from "./roles";
import { createStats } from "./stats";
import { createTransfer } from "./transfer";
import { createAssets, type MediaOptions } from "./assets";
import { createModel, type CmsModel, type RelatedDoc, type TreeNode } from "./model";
import { DEFAULT_VIDEO_HOSTS } from "./video";
import { createFlow, type ScheduledRun } from "./flow";
import { createJobs, type JobsRun } from "./jobs";
import { createOutbox, type OutEvent, type WebhookOptions } from "./outbox";
import { PLUGIN_NAME, type CmsPlugin, type PluginNav, type PluginRoute, type PluginTool } from "./plugin";
import { createSealer } from "./secrets";
import { PUBLIC_EVENTS, type CacheAdapter, type CacheOptions, type ChangeEvent, type ChangesOptions } from "./changes";
import { base64url, fromBase64url, fromUtf8, hex, hmacSha256, sha256, timingSafeEqual } from "./crypto";
import type { z, ZodTypeAny } from "zod";
import { fieldChanges, hunks, splitLines, unifiedDiff, type FieldChange, type Hunk } from "./diff";
import { CmsError, formatMessage, isCmsError, type CmsErrorCode, type CmsErrorOptions, type Diagnostic, type ErrorParams, type Messages } from "./errors";
import { displayPrefix, generateKey, hashKey } from "./keys";
import { badRanges, createLimiter, type RateLimitOptions } from "./limits";
import { createRetention, type RetentionOptions } from "./retention";
import { createForms, type FormsOptions } from "./forms";
import { appLinkKeys, extractToc, htmlRegions, parseMarkdown } from "./markdown";
import { hasScripts, inspectHtml, type HtmlInert } from "./html-inspect";
import { createAx } from "./ax";
import { docAddress, isTranslationDoc, localeAddress, localeRepo, LOCALE_RE, referenceVersion, splitAddress, statusOf, translatableFields, type TranslationInfo, type TranslationList, type TranslationStatus } from "./locale";
import { applyPatch, sectionRanges, type PatchOp } from "./patch";
import type { AuditQuery, CmsRepo, DocPatch, StoredVersion } from "./repo";
import { docsById } from "./repo";
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
  type DocSeo,
  type DocTemplate,
  type CmsRecord,
  type DocCounts,
  type DocStatus,
  type DocSummary,
  type KeyScope,
  type PublishCheckResult,
  type RedirectListItem,
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

/**
 * One document (0.21.0): site settings, a footer, a banner. A collection that holds exactly one
 * document, with versions, drafts, publishing, permissions and webhooks like any other. Read it
 * with `cms.single(actor, "site")` (the schema's defaults until it is saved), save it with
 * `cms.updateSingle()`. The body is hidden in the admin unless `body: true`.
 */
export function defineSingle<const S extends string, F extends ZodTypeAny | undefined = undefined>(
  c: Omit<CollectionConfig<F, S>, "single" | "tree" | "templates" | "snippets" | "categories" | "slugPattern"> & { body?: CollectionConfig<F, S>["body"] | boolean }
): CollectionConfig<F, S> {
  const { body, ...rest } = c;
  return { ...rest, ...(typeof body === "object" ? { body } : {}), single: true, admin: { ...(rest.admin ?? {}), ...(body === true ? {} : { hideBody: true }) } } as CollectionConfig<F, S>;
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
/** With `slugs: { hangul: "keep" }` (0.21.0): Hangul syllables count as letters. */
export const SLUG_HANGUL_RE = /^[a-z0-9\uac00-\ud7a3]+(?:-[a-z0-9\uac00-\ud7a3]+)*$/;
/** The slug of the one document in a `defineSingle` collection. */
export const SINGLE_SLUG = "_single";
export const LIMITS = { slug: 120, title: 200, summary: 300, body: 60_000, keyword: 40, keywords: 30 } as const;

export interface DocInput<F = Record<string, unknown>> {
  slug?: string;
  title?: string;
  summary?: string;
  body?: string;
  /** "markdown" (default) or "html": only in collections whose `body.formats` include it. */
  format?: "markdown" | "html";
  /** Search engine details (0.21.0, collections with `seo`). Merged over what is stored; null clears. */
  seo?: Partial<DocSeo> | null;
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
  /** Start from a template (0.21.0): its key (code) or id (saved in the admin). What you send wins over it. */
  template?: string;
  /**
   * 0.22.0, `create` in a localized collection: the language of the new document. Another language
   * than the default starts a translation of the source with the same slug (`from`, else `input.slug`):
   * its text is copied from the source unless you send your own.
   */
  locale?: string;
  /** 0.22.0: the slug of the source document a translation starts from (default: `input.slug`). */
  from?: string;
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
  /**
   * 0.22.0: search documents in this language (localized collections). Default: the default
   * language. Collections that are not translated are searched whatever the language.
   */
  locale?: string;
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
  /**
   * The change log that carries events between servers (0.17.0): how long it is kept, how often
   * others look at it, a signal that wakes them (`./changes`).
   */
  changes?: ChangesOptions;
  /**
   * Cache what readers get (published documents and lists): `memoryCache()` from `./changes`, or
   * any store with `get` and `set`. Emptied for a collection whenever its public copy changes, on
   * this server at once and on the others within `changes.pollMs`. Default: no cache.
   */
  cache?: CacheAdapter | (CacheOptions & { store: CacheAdapter });
  /**
   * Redirects (0.21.0). On: a published document's address may change, and the old address
   * redirects to the new one (301); admins add their own. Lookups are kept in memory for
   * `ttlMs` (30 s) and refreshed at once on this server when they change.
   */
  redirects?: boolean | { ttlMs?: number };
  /** Address suggestions (0.21.0): Korean titles romanized (default), kept as they are, or left out. */
  slugs?: { hangul?: "romanize" | "keep" | "off" };
  /**
   * Sites `:::video` blocks may embed (0.21.0). `hosts` are added to YouTube and Vimeo; with
   * `defaults: false` only `hosts` are allowed (`{ hosts: ["loom.com"], defaults: false }`, or
   * `{ hosts: [], defaults: false }` for no embeds at all). Files from the media library always work.
   */
  video?: { hosts?: readonly string[]; defaults?: boolean };
  /**
   * Languages documents are written in (0.22.0), e.g. `["ko", "en"]`. Collections with
   * `localized: true` then have one document per language. Off by default.
   */
  locales?: readonly string[];
  /** The language translations are made from (0.22.0). Default: the first of `locales`. */
  defaultLocale?: string;
  /**
   * Forms (0.22.0): admins build them (fields, steps, conditions), pages show them with the
   * copied `cms-form` component, submissions land in `cms_form_submissions`. Files need a private
   * media store. See `FormsOptions` for the captcha hook (`verify`), e-mail (`notify`) and limits.
   */
  forms?: boolean | FormsOptions;
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
  /** 0.22.0: documents in this language (localized collections). Default: the default language. */
  locale?: string;
  /** 0.22.0, readers: where a document has no published translation in `locale`, list the default language's. */
  fallback?: boolean;
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
const b64url = (b: Uint8Array | string) => base64url(b);

/** `{ seo }` when it says anything, else nothing (documents without SEO keep their old shape). */
function seoOf(seo: DocSeo | null | undefined): { seo?: DocSeo } {
  if (!seo) return {};
  const out: DocSeo = {};
  for (const k of ["title", "description", "image", "canonical"] as const) if (typeof seo[k] === "string" && seo[k]!.trim()) out[k] = seo[k]!.trim();
  if (seo.noindex) out.noindex = true;
  return Object.keys(out).length ? { seo: out } : {};
}

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
    ...(doc.seo ? { seo: { ...doc.seo } } : {}),
  };
}

/** The untyped CMS (what the transports use). `createCms` returns it with typed overloads on top. */
export type CmsTelemetry =
  | { type: "request"; /** Also sent back as `X-Request-Id`. */ id?: string; method: string; path: string; status: number; ms: number; actor: string; via: string | null }
  | ({ type: "event" } & OutEvent)
  | { type: "job"; kind: string; id: string; ok: boolean; attempt: number; ms: number; error?: string }
  | { type: "cron"; ms: number; jobs: JobsRun }
  | { type: "error"; where: string; message: string }
  | { type: "cache"; collection: string; hit: boolean }
  | { type: "search"; ms: number; q: string; hits: number; collections: number }
  | { type: "index"; ms: number; documents: number; units: number };

/** How long a missing change-log number may still be committing before it counts as rolled back. */
// A number missing from the change log for less than this is a transaction still committing
// (numbers are taken before the commit): wait for it. Older gaps are rolled-back writes.
/** How long an events stream waits for the dispatcher to start before going on without numbers. */
const POSITION_WAIT_MS = 5_000;
/** Local events kept to enrich log rows while the reader catches up. */
const WAITING_MAX = 10_000;
const GAP_WAIT_MS = 15_000;

/** An event as subscribers hear it: with its number in the change log, and whether another server made it. */
export type FeedEvent = OutEvent & { seq?: number; remote?: boolean };
interface ChangeRowLike {
  seq: number;
  event: string;
  collection: string | null;
  slug: string | null;
  version: number | null;
  origin: string;
  data: Record<string, unknown>;
}

/** First path segments the CMS uses itself. A plugin cannot take one of these names. */
export const RESERVED_ROUTES = new Set(["collections", "search", "preview", "audit", "keys", "mcp", "assets", "files", "stores", "reviews", "trash", "releases", "webhooks", "jobs", "plugins", "automations", "roles", "export", "import", "openapi.json", "grep", "raw", "retention", "_events", "_changes", "auth", "users", "_stats", "_me", "_cron", "singles", "redirects", "sitemap.xml", "forms"]);

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
  "doc.move": "doc.moved",
};

/** Dotted paths in a fields object (`seo.title`). */
function getPath(o: Record<string, unknown>, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function hasPath(o: Record<string, unknown>, path: string): boolean {
  const keys = path.split(".");
  let cur: unknown = o;
  for (const k of keys) {
    if (!cur || typeof cur !== "object" || !(k in (cur as object))) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}
function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = v;
}
function unsetPath(o: Record<string, unknown>, path: string) {
  const keys = path.split(".");
  let cur: unknown = o;
  for (const k of keys.slice(0, -1)) {
    if (!cur || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur && typeof cur === "object") delete (cur as Record<string, unknown>)[keys[keys.length - 1]];
}

/** A list cursor: the last row of the page (`k.` + base64url of `time|id`), or an old numeric offset. */
function encodeCursor(at: string, id: string): string {
  return `k.${base64url(`${at}|${id}`)}`;
}
function decodeCursor(c: string | null | undefined): { at: string; id: string } | null | "offset" {
  if (!c) return null;
  if (/^\d+$/.test(c)) return c === "0" ? null : "offset";
  if (!c.startsWith("k.")) return null;
  let text = "";
  try {
    text = fromUtf8(fromBase64url(c.slice(2)));
  } catch {
    return null;
  }
  const [at, id] = text.split("|");
  return at && id && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}

export function createCmsCore(opts: CreateCmsOptions) {
  // ── locales (0.22.0) ──────────────────────────────────────────────────────
  const locales: readonly string[] = opts.locales ? [...new Set(opts.locales)] : [];
  const defaultLocale = locales.length ? (opts.defaultLocale ?? locales[0]) : "";
  for (const l of locales) if (!LOCALE_RE.test(l)) throw new Error(`[agent-cms] locales: "${l}" is not a language tag (e.g. "ko", "en", "pt-BR")`);
  if (opts.defaultLocale !== undefined && !locales.includes(opts.defaultLocale)) throw new Error(`[agent-cms] defaultLocale "${opts.defaultLocale}" is not one of locales`);
  /** A translated collection (only with `locales`). */
  const localized = (col: string) => locales.length > 0 && !!collections.get(col)?.localized;
  const repo = locales.length ? localeRepo(opts.repo, { defaultLocale, localized }) : opts.repo;
  const now = opts.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const collections = new Map<string, AnyCollection>();
  const minCoverage = opts.minCoverage ?? 0.5;
  const refreshMs = opts.searchRefreshMs ?? 60_000;
  const messages = opts.messages;
  /** `slugs: { hangul: "keep" }` (0.21.0): Hangul in addresses. */
  const hangulSlugs = opts.slugs?.hangul === "keep";
  /** Listeners added at run time (`cms.onTelemetry`, e.g. the standalone server's `/metrics`). */
  const telemetryListeners = new Set<(e: CmsTelemetry) => void>();
  const telemetry = (e: CmsTelemetry) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // a broken listener must not break the CMS
    }
    for (const fn of telemetryListeners) {
      try {
        fn(e);
      } catch {
        // same
      }
    }
  };
  const reportTo = opts.onError ?? ((err: unknown, where: string) => console.warn(`[agent-cms] ${where}:`, err));
  const report = (err: unknown, where: string) => {
    telemetry({ type: "error", where, message: err instanceof Error ? err.message : String(err) });
    // The app's reporter is best effort: if it throws, say so on the console and carry on.
    try {
      const r = reportTo(err, where) as unknown;
      if (r && typeof (r as Promise<unknown>).catch === "function") void (r as Promise<unknown>).catch((e) => console.warn("[agent-cms] onError failed:", e));
    } catch (e) {
      console.warn("[agent-cms] onError failed:", e);
    }
  };

  // ── events: webhooks and plugin listeners ─────────────────────────────────

  const eventListeners: { event: WebhookEvent | "*"; fn: (e: OutEvent) => void | Promise<void>; plugin: string }[] = [];
  /** Tell the outside what happened. Never throws, never awaited by the write that caused it. */
  /** Listeners added at run time (the events stream): told about every event until they unsubscribe. */
  const subscribers = new Set<(e: FeedEvent) => void>();
  function tellSubscribers(e: FeedEvent) {
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch (err) {
        report(err, "subscriber");
      }
    }
  }
  /** This process, in the change log (so it does not hear itself twice). */
  const origin = `p${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const logChanges = opts.changes?.log !== false && typeof repo.appendChange === "function";
  /** Change-log writes not finished yet (`settle()` waits for them before a shutdown). */
  const inFlight = new Set<Promise<unknown>>();
  /**
   * The ordered dispatcher (0.18.0). Every event with a change-log number reaches subscribers in
   * number order, read back from the log: what this process wrote and what other servers wrote go
   * through the same path, so a number a stream hands out as a resume point never passes one that
   * was not delivered. `delivered` is the last number told; -1 while nobody follows the log.
   */
  let delivered = -1;
  /** Events of this process waiting for their turn in the log (richer than the row: same fields, no `remote`). */
  const waitingLocal = new Map<number, FeedEvent>();
  const canFollow = () => logChanges && typeof repo.changesSince === "function";
  const ordered = repo.changesInCommitOrder === true;
  /** A promise counted by `settle()`. */
  function track<T>(p: Promise<T>): Promise<T> {
    const q: Promise<T> = p.finally(() => inFlight.delete(q));
    inFlight.add(q);
    return q;
  }
  const publishSignal = () => {
    if (opts.changes?.signal) void track(Promise.resolve(opts.changes.signal.publish()).catch((err) => report(err, "change signal")));
  };
  /** A numbered event of this process: told in log order with the rest. */
  function sendNumbered(e: FeedEvent & { seq: number }) {
    if (!canFollow()) {
      // Nothing reads the log back here: tell it at once, without a number to resume from.
      const { seq: _s, ...rest } = e;
      tellSubscribers(rest);
      return;
    }
    if (!subscribers.size || follow.closed) return; // the log keeps it for whoever asks later
    if (delivered >= 0 && e.seq <= delivered) return; // already told from the log
    waitingLocal.set(e.seq, e);
    // Only a richer copy of what the log holds: when the reader falls far behind, the oldest go
    // (the log's own row is told instead).
    if (waitingLocal.size > WAITING_MAX) waitingLocal.delete(waitingLocal.keys().next().value as number);
    void pullChanges();
  }
  /**
   * Change rows written inside the transaction that made the change (0.18.0): if the process
   * dies right after the commit, the change is still in the log. The event sent afterwards
   * reuses that row instead of writing a second one. Key: event, collection, slug, version.
   */
  const preLogged = new Map<string, { seq: number; e: OutEvent }[]>();
  const logKey = (e: { event: string; collection?: string | null; slug?: string | null; version?: number | null; locale?: string }) => `${e.event}|${e.collection ?? ""}|${e.slug ?? ""}|${e.version ?? ""}${e.locale ? `|${e.locale}` : ""}`;
  /**
   * 0.22.0: an event about a document of a localized collection says its language. Inside the CMS a
   * translation is named `slug@locale`; events, the change log and webhooks get the slug and `locale`.
   */
  function withLocale<E extends { collection?: string | null; slug?: string | null; locale?: string }>(e: E): E {
    if (!locales.length || !e.collection || !e.slug || !localized(e.collection)) return e;
    const { slug, locale } = splitAddress(e.slug);
    return { ...e, slug, locale: e.locale ?? locale ?? defaultLocale };
  }
  type TxLog = (e: OutEvent) => Promise<void>;
  /**
   * `repo.tx` with a `log(event)` that writes the change row in the same transaction. Rows are
   * added after `fn` is done, as the transaction's last statements: the log's order lock is then
   * taken after every other lock the write holds, so two writes cannot wait on each other.
   */
  async function loggedTx<T>(fn: (r: CmsRepo, log: TxLog) => Promise<T>, o: { atomic?: boolean } = {}): Promise<T> {
    const notes: { key: string; seq: number; e: OutEvent }[] = [];
    const out = await repo.tx(async (r) => {
      notes.length = 0;
      const events: OutEvent[] = [];
      const log: TxLog = async (e) => {
        if (logChanges && typeof r.appendChange === "function") events.push(withLocale(e));
      };
      const res = await fn(r, log);
      for (const e of events) {
        const data: Record<string, unknown> = { actor: e.actor ?? null, url: e.url ?? null, ...(e.detail ? { detail: e.detail } : {}), ...(e.locale ? { locale: e.locale } : {}) };
        const seq = await r.appendChange!({ event: e.event, collection: e.collection ?? null, slug: e.slug ?? null, version: e.version ?? null, origin, data, at: nowIso() });
        notes.push({ key: logKey(e), seq, e });
      }
      return res;
    }, o);
    // Only after the commit: a rolled-back transaction left no rows to reuse.
    if (notes.length) {
      for (const n of notes) preLogged.set(n.key, [...(preLogged.get(n.key) ?? []), { seq: n.seq, e: n.e }]);
      publishSignal();
      // The events a write sends run right after it returns. A row nobody claims by then is still
      // a real change: the dispatcher reads it from the log like any other, so drop the note and
      // let it look.
      void track(
        new Promise<void>((done) =>
          setTimeout(() => {
            for (const n of notes) {
              const q = preLogged.get(n.key);
              const i = q?.findIndex((x) => x.seq === n.seq) ?? -1;
              if (!q || i < 0) continue;
              q.splice(i, 1);
              if (!q.length) preLogged.delete(n.key);
              sendNumbered({ ...(n.e as FeedEvent), seq: n.seq });
            }
            done();
          }, 0),
        ),
      );
    }
    return out;
  }
  function takePreLogged(e: OutEvent): number | null {
    const k = logKey(e);
    const q = preLogged.get(k);
    if (!q?.length) return null;
    const { seq } = q.shift()!;
    if (!q.length) preLogged.delete(k);
    return seq;
  }
  function emitEvent(e0: OutEvent) {
    const e = withLocale(e0);
    telemetry({ type: "event", ...e });
    const pre = logChanges ? takePreLogged(e) : null;
    if (pre !== null) sendNumbered({ ...e, seq: pre });
    else if (logChanges) {
      const data: Record<string, unknown> = { actor: e.actor ?? null, url: e.url ?? null, ...(e.detail ? { detail: e.detail } : {}), ...(e.locale ? { locale: e.locale } : {}) };
      void track(
        Promise.resolve(ensureSchema())
          .then(() => repo.appendChange!({ event: e.event, collection: e.collection ?? null, slug: e.slug ?? null, version: e.version ?? null, origin, data, at: nowIso() }))
          .then((seq) => {
            publishSignal();
            sendNumbered({ ...e, seq });
          })
          .catch((err) => {
            report(err, "change log");
            // Not in the log: subscribers still hear it, without a number to resume from.
            tellSubscribers(e);
          }),
      );
    } else tellSubscribers(e);
    // Webhook deliveries being queued count as unfinished work too: `settle()` waits for them.
    const queued: Promise<unknown> = Promise.resolve(outbox.emit(e)).catch((err) => report(err, "webhooks")).finally(() => inFlight.delete(queued));
    inFlight.add(queued);
    void automations.onEvent(e);
    for (const l of eventListeners) {
      if (l.event !== "*" && l.event !== e.event) continue;
      Promise.resolve()
        .then(() => l.fn(e))
        .catch((err) => report(err, `plugin ${l.plugin}: ${e.event}`));
    }
  }
  // ── following the change log (other servers) and the read cache ───────────

  const pollMs = Math.max(200, opts.changes?.pollMs ?? 2000);
  const follow = { timer: null as ReturnType<typeof setTimeout> | null, unsignal: null as null | (() => void), busy: false, again: false, listening: false, closed: false };
  const cacheStore: CacheAdapter | null = !opts.cache ? null : "store" in opts.cache && typeof (opts.cache as { store?: unknown }).store === "object" ? (opts.cache as { store: CacheAdapter }).store : (opts.cache as CacheAdapter);
  const cacheTtl = Math.max(1000, (opts.cache && "ttlMs" in opts.cache ? (opts.cache as CacheOptions).ttlMs : undefined) ?? 300_000);
  const wantFollow = () => logChanges && typeof repo.changesSince === "function" && (subscribers.size > 0 || !!cacheStore);
  function rowEvent(r: ChangeRowLike): FeedEvent {
    const d = r.data ?? {};
    return { event: r.event as OutEvent["event"], collection: r.collection, slug: r.slug, version: r.version, actor: (d.actor as OutEvent["actor"]) ?? null, url: (d.url as string | null) ?? null, ...(d.detail ? { detail: d.detail as Record<string, unknown> } : {}), ...(typeof d.locale === "string" ? { locale: d.locale } : {}), seq: r.seq, remote: r.origin !== origin } as FeedEvent;
  }
  let pulling: Promise<void> | null = null;
  /** Read the log after `delivered` and tell subscribers in order. Resolves when caught up. */
  function pullChanges(): Promise<void> {
    if (follow.busy) {
      follow.again = true;
      return pulling ?? Promise.resolve();
    }
    follow.busy = true;
    pulling = (async () => {
      try {
        do {
          follow.again = false;
          if (follow.closed || !canFollow()) break;
          await ensureSchema();
          if (delivered < 0) {
            delivered = (await repo.lastChange?.()) ?? 0;
            for (const k of waitingLocal.keys()) if (k <= delivered) waitingLocal.delete(k);
          }
          const rows = await repo.changesSince!(delivered, 200);
          let waiting = false;
          for (const r of rows) {
            // Only a log without commit order (a custom repo) can show a number before a smaller
            // one that is still committing: wait at a young gap there; an old one is a rollback.
            if (!ordered && r.seq !== delivered + 1 && Date.now() - Date.parse((r as { at?: string }).at ?? "") < GAP_WAIT_MS) {
              waiting = true;
              break;
            }
            delivered = r.seq;
            const mine = waitingLocal.get(r.seq);
            waitingLocal.delete(r.seq);
            if (r.origin !== origin && r.collection) {
              invalidate(r.collection);
              index.dirty = true;
            }
            tellSubscribers(mine ?? rowEvent(r));
          }
          for (const k of waitingLocal.keys()) if (k <= delivered) waitingLocal.delete(k);
          if (rows.length === 200 && !waiting) follow.again = true;
        } while (follow.again);
      } catch (e) {
        report(e, "change log follow");
      } finally {
        follow.busy = false;
        pulling = null;
      }
    })();
    return pulling;
  }
  /** Keep following while someone needs it (a stream is open or a cache is set). */
  function keepFollowing() {
    if (follow.closed || !wantFollow()) {
      // Nobody follows: start again from the newest number next time instead of replaying a backlog.
      if (!follow.busy) {
        delivered = -1;
        waitingLocal.clear();
      }
      if (follow.timer) clearTimeout(follow.timer);
      follow.timer = null;
      follow.unsignal?.();
      follow.unsignal = null;
      follow.listening = false;
      return;
    }
    const sig = opts.changes?.signal;
    if (sig && !follow.listening) {
      follow.listening = true;
      void Promise.resolve(sig.subscribe(() => void pullChanges()))
        .then((un) => {
          if (follow.listening && !follow.closed) follow.unsignal = un;
          else un();
        })
        .catch((e) => {
          follow.listening = false;
          report(e, "change signal");
        });
    }
    if (follow.timer) return;
    if (delivered < 0) void pullChanges();
    follow.timer = setTimeout(() => {
      follow.timer = null;
      void pullChanges().finally(keepFollowing);
    }, pollMs);
    (follow.timer as { unref?: () => void }).unref?.();
  }
  /** Which CMS the cache belongs to (tables or a set name), so CMSs sharing one store never mix. */
  const cacheNs = (opts.cache && "namespace" in opts.cache ? (opts.cache as CacheOptions).namespace : undefined) ?? repo.cacheNamespace?.() ?? `m${Math.random().toString(36).slice(2, 10)}`;
  // `v18`: copies cached by 0.17 carried the draft's status and editor; they are not read again.
  const cacheKey = (col: string, rest: string) => `agent-cms:${cacheNs}:v18:${col}:${rest}`;
  /** Set at once when this process changes a collection, so it never serves an older entry while the store catches up. */
  const localGen = new Map<string, string>();
  const newGen = () => Math.random().toString(36).slice(2, 10);
  const GEN_TTL = 30 * 86_400_000;
  /** Readers of this collection all see the same thing (no per-document read rule): it can be cached. */
  const cacheable = (col: string) => !!cacheStore && !collection(col).access?.read;
  function invalidate(col: string) {
    // Redirects that follow a document read its address from a 30 s cache: a change here forgets it.
    model.forgetTargets();
    if (!cacheStore) return;
    const gen = newGen();
    localGen.set(col, gen);
    const p = Promise.resolve(cacheStore.set(cacheKey(col, "gen"), gen, GEN_TTL))
      .catch((e) => report(e, "cache"))
      .finally(() => {
        inFlight.delete(p);
        if (localGen.get(col) === gen) localGen.delete(col);
      });
    inFlight.add(p);
  }
  async function cached<T>(col: string, key: string, make: () => Promise<T>): Promise<T> {
    if (!cacheStore || !cacheable(col)) return make();
    keepFollowing();
    let full: string;
    try {
      let gen = localGen.get(col) ?? (await cacheStore.get(cacheKey(col, "gen")));
      if (typeof gen !== "string") {
        gen = newGen();
        await cacheStore.set(cacheKey(col, "gen"), gen, GEN_TTL);
      }
      full = cacheKey(col, `${gen}:${key}`);
      const hit = await cacheStore.get(full);
      if (hit !== undefined) {
        telemetry({ type: "cache", collection: col, hit: true });
        return hit as T;
      }
    } catch (e) {
      report(e, "cache");
      return make();
    }
    telemetry({ type: "cache", collection: col, hit: false });
    const value = await make();
    void Promise.resolve(cacheStore.set(full, value ?? null, cacheTtl)).catch((e) => report(e, "cache"));
    return value;
  }

  function urlOf(col: string | null | undefined, slug: string | null | undefined): string | null {
    try {
      if (!col || !slug) return null;
      // 0.22.0: in a localized collection `url()` also gets the language (a translation is named `slug@locale`).
      if (localized(col)) {
        const a = splitAddress(slug);
        return collections.get(col)?.url?.({ slug: a.slug, locale: a.locale ?? defaultLocale }) ?? null;
      }
      return collections.get(col)?.url?.({ slug }) ?? null;
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
    if (c.localized && !locales.length) throw new Error(`[agent-cms] collection "${c.slug}" is localized: set createCms({ locales, defaultLocale })`);
    if (c.localized && c.single) throw new Error(`[agent-cms] collection "${c.slug}": a single cannot be localized yet`);
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
    // 0.22.0: the language goes into the entry's detail; the slug stays the document's slug.
    const named = withLocale<{ collection?: string | null; slug?: string | null; locale?: string }>({ collection: o.collection, slug: o.slug });
    if (named.locale) o = { ...o, slug: named.slug, detail: { ...(o.detail ?? {}), locale: named.locale } };
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
      emitEvent({ event, actor: actorRef(actor), collection: o.collection ?? null, slug: o.slug ?? null, version: o.version ?? null, url: urlOf(o.collection, named.locale ? localeAddress(o.slug!, named.locale === defaultLocale ? null : named.locale) : o.slug), ...(named.locale ? { locale: named.locale } : {}), ...(doc ? {} : { detail: o.detail ?? {} }) });
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
      const scoped = actor.scopes.includes(scope) || actor.scopes.includes("admin") || (what === "read" && (actor.scopes.includes("write") || actor.scopes.includes("publish")));
      if (!scoped) return false;
      // A key's scopes open the collection; a rule about one document still applies (0.18.0).
      const rule = what === "read" ? c.access?.read : what === "write" ? c.access?.write : c.access?.publish;
      return doc && rule ? rule({ actor, collection: col, doc }) : true;
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
    docViewFor: (actor, doc) => {
      if (!collections.has(doc.collection)) return null;
      // Projected: a reference only in a field this person may not see does not count for them.
      if (can(actor, doc.collection, "write", doc)) return { doc: conflictCopy(actor, doc.collection, doc), draft: true };
      const pub = publicView(doc);
      return pub && can(actor, doc.collection, "read", pub) ? { doc: conflictCopy(actor, doc.collection, pub), draft: false } : null;
    },
    roleAllows: (actor, store, what) => roles.allows(actor, `media:${store}`, what === "write" ? "write" : "delete"),
    warn: warnOnce,
    ready: ensureSchema,
    trashDays,
  });

  // ── content model (0.21.0) ─────────────────────────────────────────────────

  const model = createModel({
    repo,
    collections,
    collection,
    fail,
    diag: (path, code, params, severity) => ({ path, code, params, severity, message: formatMessage(messages, code, params) }),
    nowIso,
    today: () => dayIn(timeZone, now()),
    report,
    urlOf: (col, slug) => urlOf(col, slug),
    redirects: opts.redirects ? { ttlMs: Math.max(1000, (typeof opts.redirects === "object" ? opts.redirects.ttlMs : undefined) ?? 30_000) } : false,
    // YouTube and Vimeo unless `video.defaults` is false; `video.hosts` adds to them.
    videoHosts: [...new Set([...(opts.video?.defaults === false ? [] : DEFAULT_VIDEO_HOSTS), ...(opts.video?.hosts ?? [])].map((h) => h.toLowerCase()))],
    publicReadable: (col, slug) => readable({ kind: "anonymous" }, col, locales.length ? splitAddress(slug).slug : slug),
    localized,
    defaultLocale,
    publicCopy: (doc) => {
      if (!collections.has(doc.collection)) return null;
      const pub = publicView(doc);
      return pub && can({ kind: "anonymous" }, doc.collection, "read", pub) ? pub : null;
    },
  });
  /** Files and documents a copy points at. */
  async function syncAllRefs(r: CmsRepo, doc: CmsDoc) {
    await assets.syncRefs(r, doc);
    await model.syncRefs(r, doc);
  }
  /** Checks that read other documents: relations, snippets, videos. `prev`: the saved copy (a target deleted since is a warning). */
  async function modelDiagnostics(col: string, slug: string, c: DocContent, prev: DocContent | null, r: CmsRepo = repo, o: { publishing?: boolean } = {}): Promise<Diagnostic[]> {
    return [
      ...(await model.relationDiagnostics(col, c, model.relationIds(col, prev), r, o)),
      ...(!prev || prev.body !== c.body ? [...(await model.snippetDiagnostics(col, slug, c.body, r)), ...((c.format ?? "markdown") === "markdown" ? [...model.videoDiagnostics(c.body), ...model.anchorDiagnostics(c.body)] : [])] : []),
    ];
  }
  async function assertModel(actor: Actor, col: string, c: DocContent, prev: CmsDoc | null, r: CmsRepo = repo) {
    const errors = (await modelDiagnostics(col, c.slug, c, prev, r)).filter((d) => d.severity === "error");
    if (errors.length) throw safeError(actor, col, { ...(prev ?? prospectiveDoc(col, c)), ...c, collection: col } as CmsDoc, fail(errors[0].code, errors[0].params, { diagnostics: errors }));
  }

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
    if (cfg.single) {
      if (out.slug !== SINGLE_SLUG) add("slug", "single_only", { collection: col });
    } else if (!(cfg.slugPattern ?? (hangulSlugs ? SLUG_HANGUL_RE : SLUG_RE)).test(out.slug) || out.slug.length > LIMITS.slug) add("slug", "invalid_slug", { max: LIMITS.slug });
    if (!cfg.seo) delete out.seo;
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
    diags.push(...model.seoDiagnostics(col, out));
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
    if (collection(col).fieldAccess || collection(col).fieldHooks) cur = validate(col, await guardFields(actor, col, prev, cur), { actor, base: prev });
    for (const fn of collection(col).hooks?.beforeChange ?? []) {
      const seen = cur;
      const patch = await hook(fn, { collection: col, slug: cur.slug, content: cur, prev, actor }).catch((e) => {
        // The hook saw the candidate and the previous copy: a field hidden in either stays hidden.
        throw safeError(actor, col, [{ ...overlay(prev ?? prospectiveDoc(col, {}), seen, prev?.version), collection: col } as CmsDoc, ...(prev ? [prev] : [])], e, { pathless: "hide" });
      });
      if (patch && typeof patch === "object") cur = validate(col, { ...cur, ...patch }, { actor, base: prev });
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
  /**
   * Check results as `actor` may see them: one about a field hidden from them keeps its place and
   * severity but not its words (an app's message may quote the value).
   */
  function checksFor(actor: Actor, col: string, checked: CmsDoc | null, results: PublishCheckResult[]): PublishCheckResult[] {
    if (!checked || !collection(col).fieldAccess) return results;
    const hidden = hiddenPaths(actor, col, checked);
    if (!hidden.length) return results;
    // Conservative: a result about a hidden field, about something that contains one, or about no
    // field at all (its words could quote anything) keeps only its severity.
    return results.map((r) => (!r.path || coversHidden(hidden, r.path) ? { code: "check_hidden", severity: r.severity, message: message(fail("check_hidden")) } : r));
  }
  /** Whether a path is a hidden field, inside one, or contains one. */
  const coversHidden = (hidden: string[], path: string) => {
    const f = path.replace(/^fields\./, "");
    return path === "fields" || isHiddenPath(hidden, path) || hidden.some((h) => h.startsWith(`${f}.`));
  };
  /** Diagnostics about the copy being checked, as `actor` may see them (same rule as `checksFor`, pathless built-in ones kept). */
  function diagnosticsFor<D extends { path: string; code: string }>(actor: Actor, col: string, checked: CmsDoc | null | (CmsDoc | null)[], diags: D[], o: { pathless?: "keep" | "hide" } = {}): D[] {
    const copies = (Array.isArray(checked) ? checked : [checked]).filter((c): c is CmsDoc => !!c);
    if (!copies.length || !collection(col).fieldAccess) return diags;
    // A field hidden in any of the copies the checks looked at is hidden here.
    const hidden = [...new Set(copies.flatMap((c) => hiddenPaths(actor, col, c)))];
    if (!hidden.length) return diags;
    const hide = (d: D) => (d.path ? coversHidden(hidden, d.path) : o.pathless === "hide");
    return diags.map((d) => (hide(d) ? ({ ...d, path: "", code: "check_hidden", params: {}, message: message(fail("check_hidden")) } as D) : d));
  }
  async function gate(which: "beforePublish" | "beforeDelete", actor: Actor, doc: { collection: string; slug: string; version: number }, content: DocContent, base?: CmsDoc | null) {
    if (which === "beforePublish") {
      // Judged on the very copy being checked (no second read: this runs inside the transaction).
      const checked = { ...(base ?? prospectiveDoc(doc.collection, { slug: doc.slug })), ...content, format: content.format, collection: doc.collection, slug: doc.slug, version: doc.version } as CmsDoc;
      const errors = checksFor(actor, doc.collection, checked, await appChecks(doc.collection, doc.slug, content)).filter((x) => x.severity === "error");
      if (errors.length)
        throw fail("publish_check_failed", { checks: errors.map((e) => e.message).join("; ") }, { diagnostics: errors.map((e) => ({ path: e.path ?? "", code: "publish_check_failed" as const, params: { checks: e.message, check: e.code, line: e.line ?? null }, severity: "error" as const, message: e.message })) });
    }
    for (const fn of collection(doc.collection).hooks?.[which] ?? [])
      await hook(fn, { collection: doc.collection, slug: doc.slug, content, version: doc.version, actor }).catch((e) => {
        throw safeError(actor, doc.collection, { ...overlay(base ?? prospectiveDoc(doc.collection, { slug: doc.slug }), content, doc.version), collection: doc.collection, slug: doc.slug } as CmsDoc, e, { pathless: "hide" });
      });
  }

  /** The collection's own `publishChecks`. A check that throws counts as an error with its message. */
  async function appChecks(col: string, slug: string, content: DocContent): Promise<PublishCheckResult[]> {
    const out: PublishCheckResult[] = [];
    for (const fn of collection(col).publishChecks ?? []) {
      try {
        for (const r of (await fn(content, { collection: col, slug })) ?? []) out.push({ code: String(r.code), message: String(r.message), severity: r.severity === "error" ? "error" : "warning", path: r.path, line: r.line });
      } catch (e) {
        // The error itself goes to the app's error report; people see that a check could not run
        // (an exception's text may quote anything, hidden fields included).
        report(e, "publishChecks");
        out.push({ code: "check_failed", message: message(fail("check_failed")), severity: "error" });
      }
    }
    return out;
  }

  /**
   * Validate a candidate. With `who`, what the error says is what that person may see of exactly
   * this candidate (over `base`, the stored row): findings about hidden fields become `check_hidden`.
   */
  function validate(col: string, c: DocContent, who?: { actor: Actor; base: CmsDoc | null }): DocContent {
    const { content, diagnostics } = check(col, c);
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      const e = fail(errors[0].code, errors[0].params, { diagnostics: errors });
      // Judged on the normalized content the checks saw.
      throw who ? safeError(who.actor, col, { ...overlay(who.base ?? prospectiveDoc(col, {}), content, who.base?.version), collection: col } as CmsDoc, e) : e;
    }
    return content;
  }
  /** A fresh error that says only what `actor` may see of `candidate` (the same rule as `diagnosticsFor`). */
  function safeError(actor: Actor, col: string, candidate: CmsDoc | CmsDoc[], e: unknown, o: { pathless?: "keep" | "hide" } = {}): unknown {
    if (!isCmsError(e) || !collections.has(col) || !collection(col).fieldAccess) return e;
    const diags = (e as { diagnostics?: Diagnostic[] }).diagnostics;
    if (!diags?.length) return e;
    const shownDiags = diagnosticsFor(actor, col, candidate, [...diags], o);
    if (shownDiags.every((d, i) => d === diags[i])) return e;
    // Something was hidden: the whole envelope is rebuilt from what is shown (the original top-level
    // params may quote a hidden finding).
    // The status goes with the code: kept when the first finding is still the error's own, else the
    // status of the code shown.
    const first = shownDiags[0];
    const status = first.code === e.code ? (e as { status?: number }).status : undefined;
    return fail(first.code as CmsErrorCode, (first as { params?: ErrorParams }).params ?? {}, { diagnostics: shownDiags, ...(status ? { status } : {}) });
  }

  /** Check a document without saving (`existing` slug: as an update of that document). */
  async function diagnose(actor: Actor, col: string, input: DocInput, o: { slug?: string } = {}): Promise<Diagnostic[]> {
    assert(actor, col, "write");
    const cfg = collection(col);
    const cur = o.slug ? await repo.findDoc(col, o.slug) : null;
    // An existing document is only looked at by someone who may edit it (its own rules).
    if (cur) assert(actor, col, "write", cur);
    const base: DocContent = cur ?? { slug: "", title: "", summary: "", body: "", category: cfg.categories?.[0] ?? null, keywords: [], fields: {} };
    const content = merged(base, input);
    const { diagnostics, content: normalized } = check(col, content);
    if (cur && content.slug !== cur.slug && cur.publishedVersion !== null && !model.redirectsOn()) diagnostics.push({ path: "slug", code: "slug_locked", params: {}, severity: "error", message: formatMessage(messages, "slug_locked") });
    const resolved = await model.resolveRelations(col, content.fields).catch(() => content.fields);
    diagnostics.push(...(await modelDiagnostics(col, content.slug, { ...content, fields: resolved ?? {} }, cur, repo, { publishing: true })));
    // Warnings only (a save never waits on them): asked here, where editors see diagnostics.
    diagnostics.push(...(await model.seoImageDiagnostics(col, normalized)));
    if (!cur && content.slug) {
      const rd = await model.redirectAt(col, content.slug);
      if (rd) diagnostics.push({ path: "slug", code: "redirect_taken", params: { from: rd.from, id: rd.id }, severity: "warning", message: formatMessage(messages, "redirect_taken", { from: rd.from }) });
    }
    const other = content.slug ? await repo.findDoc(col, content.slug, { trashed: true }) : null;
    const taken = other?.deletedAt ? "slug_in_trash" : "slug_taken";
    if (other && other.id !== cur?.id) diagnostics.push({ path: "slug", code: taken, params: { slug: content.slug }, severity: "error", message: formatMessage(messages, taken, { slug: content.slug }) });
    const files = await assets.checkDoc(cfg, content, cur ? assets.idsIn(cfg, cur) : undefined);
    // What is said about fields this person may not see (a file's id or name in one) stays out.
    // Judged on the copy that was checked (what was sent over what is stored), with the same
    // conservative rule as publish checks.
    // Each group judged on the copy its checker saw: the schema's on the normalized copy, the
    // files' on the one as sent.
    const on = (c: DocContent) => ({ ...overlay(cur ?? prospectiveDoc(col, {}), c, cur?.version), collection: col }) as CmsDoc;
    return [...diagnosticsFor(actor, col, on(normalized), diagnostics), ...diagnosticsFor(actor, col, on(content), files)];
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
      ...seoOf(input.seo !== undefined ? (input.seo === null ? null : ({ ...(cur.seo ?? {}), ...input.seo } as DocSeo)) : cur.seo),
    };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** What a reader without write access sees: the published snapshot only. */
  /** A stored copy (a version, the published or autosave copy) laid over its document, with its own format and version. */
  function overlay(doc: CmsDoc, copy: Partial<DocContent> | null | undefined, version: number | null | undefined): CmsDoc {
    return { ...doc, ...(copy ?? {}), format: (copy as { format?: DocContent["format"] } | null | undefined)?.format, version: version ?? doc.version } as CmsDoc;
  }
  function publicView(doc: CmsDoc): CmsDoc | null {
    if (doc.publishedVersion === null || doc.status === "archived" || !doc.published) return null;
    // The published copy without the working copy's own state: its review notes and schedule
    // belong to the draft, which this reader is not shown.
    // Nor who last changed the draft: the published copy says only that it is published.
    return { ...doc, ...contentOf(doc.published), format: (doc.published as DocContent).format, version: doc.publishedVersion, status: "published", autosave: null, review: null, schedule: null, dueAt: null, updatedBy: null, updatedByKind: null, updatedByAgent: null };
  }

  /**
   * The published copy shown in an editor's list or dashboard in place of a draft they may not
   * edit (0.18.0): who last changed the draft, and when, belong to the draft.
   */
  function fallbackView(doc: CmsDoc): CmsDoc | null {
    const pub = publicView(doc);
    return pub && { ...pub, updatedAt: doc.republishedAt ?? doc.publishedAt ?? pub.updatedAt, updatedBy: null, updatedByKind: null, updatedByAgent: null };
  }

  // ── locales (0.22.0) ──────────────────────────────────────────────────────

  /** Repo filter for "documents, not translations" (in an app that never had locales every row is one). */
  const srcOnly = (): { sources: true } => ({ sources: true });
  /** The language asked for, checked. Null: the default language (or the collection is not translated). */
  function localeOf(col: string, locale: string | null | undefined, o: { write?: boolean } = {}): string | null {
    if (locale === undefined || locale === null || locale === "") return null;
    if (!locales.includes(locale)) throw fail("locale_unknown", { locale, locales: locales.join(", ") || "-" });
    if (!localized(col)) {
      if (o.write && locale !== defaultLocale) throw fail("locale_not_localized", { collection: col });
      return null;
    }
    return locale === defaultLocale ? null : locale;
  }
  /** How the CMS names a document in a language: `slug@en` for a translation, the slug for the source. */
  function address(col: string, slug: string, locale?: string | null, o: { write?: boolean } = {}): string {
    const l = localeOf(col, locale, o);
    return l ? localeAddress(splitAddress(slug).slug, l) : slug;
  }
  const translatableCache = new Map<string, Record<string, boolean>>();
  /** Top-level fields with their own value per language (true) or shared with the source (false). */
  function translatable(col: string): Record<string, boolean> {
    let t = translatableCache.get(col);
    if (!t) translatableCache.set(col, (t = translatableFields(collection(col) as Parameters<typeof translatableFields>[0])));
    return t;
  }
  /** A translation's content with the source's shared values (category, format, non-text fields). */
  function withShared<T extends Partial<DocContent>>(col: string, c: T, src: Partial<DocContent> | null | undefined): T {
    if (!src) return c;
    const tf = translatable(col);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((c.fields ?? {}) as Record<string, unknown>)) if (tf[k]) fields[k] = v;
    for (const [k, v] of Object.entries((src.fields ?? {}) as Record<string, unknown>)) if (!tf[k]) fields[k] = v;
    const out = { ...c, fields, category: src.category ?? null } as T & { format?: DocContent["format"] };
    if (src.format === "html") out.format = "html";
    else delete out.format;
    return out;
  }
  /** The first value in `input` that a translation may not change (it follows the source), or null. */
  function sharedViolation(col: string, input: DocInput, src: DocContent, slug: string, cur?: DocContent): string | null {
    if (input.slug !== undefined && input.slug !== slug) return "slug";
    if (input.category !== undefined && (input.category ?? null) !== (src.category ?? null)) return "category";
    if (input.format !== undefined && (input.format ?? "markdown") !== (src.format ?? "markdown")) return "format";
    const tf = translatable(col);
    for (const [k, v] of Object.entries((input.fields ?? {}) as Record<string, unknown>)) {
      if (tf[k]) continue;
      const have = (src.fields ?? {})[k];
      if (stableJson(mergePatch(have, v) ?? null) === stableJson(have ?? null)) continue;
      // The value the translation's own copy holds (from when it was last saved) is not a change either.
      const own = cur?.fields?.[k];
      if (cur && stableJson(mergePatch(own, v) ?? null) === stableJson(own ?? null)) continue;
      return `fields.${k}`;
    }
    return null;
  }
  const sharedError = (field: string) => fail("locale_field_shared", { field, source: defaultLocale });
  /** Fill translations in `docs` with their source's shared values: its working copy for editors, its published copy for readers. */
  async function fillShared(docs: CmsDoc[], draft: boolean, r: CmsRepo = repo): Promise<CmsDoc[]> {
    if (!locales.length || !docs.some(isTranslationDoc)) return docs;
    const sources = await docsById(r, docs.filter(isTranslationDoc).map((d) => d.groupId!));
    return docs.map((d) => {
      if (!isTranslationDoc(d)) return d;
      const s = sources.get(d.groupId!);
      if (!s) return d;
      const copy = draft ? s : publicView(s);
      if (!copy) return d;
      const out = withShared(d.collection, d, copy);
      if (out.published) out.published = withShared(d.collection, out.published, s.published ?? copy);
      return out;
    });
  }
  const fillOne = async (d: CmsDoc, draft: boolean) => (await fillShared([d], draft))[0];

  async function get(actor: Actor, col: string, slug: string, o: { draft?: boolean; snippets?: "raw"; locale?: string | null; fallback?: boolean } = {}): Promise<CmsDoc> {
    const l = localeOf(col, o.locale);
    if (!l) return getOne(actor, col, slug, o);
    const addr = localeAddress(splitAddress(slug).slug, l);
    if (!o.fallback) return getOne(actor, col, addr, o);
    try {
      return await getOne(actor, col, addr, o);
    } catch (e) {
      if (!isCmsError(e) || e.code !== "not_found") throw e;
    }
    // No translation this reader may see: the source, saying which language was asked for.
    return { ...(await getOne(actor, col, splitAddress(slug).slug, o)), requestedLocale: l };
  }
  async function getOne(actor: Actor, col: string, slug: string, o: { draft?: boolean; snippets?: "raw" } = {}): Promise<CmsDoc> {
    collection(col);
    await ensureSchema();
    await beforeRead(actor, col, locales.length ? splitAddress(slug).slug : slug, !!o.draft);
    if (!o.draft && cacheable(col)) {
      assert(actor, col, "read");
      const pub = await cached(col, `d:${slug}`, async () => {
        const d = await repo.findDoc(col, slug);
        const p = d ? publicView(d) : null;
        return p ? fillOne(p, false) : null;
      });
      if (!pub) throw fail("not_found", { collection: col, slug });
      return read(actor, pub, false, { snippets: o.snippets });
    }
    const doc = await repo.findDoc(col, slug);
    if (!doc) throw fail("not_found", { collection: col, slug });
    if (o.draft && can(actor, col, "write", doc)) return read(actor, await fillOne(doc, true), true);
    // A reader is judged on the copy they would get (the published one), not on the draft.
    const pub = publicView(doc);
    if (!pub) {
      assert(actor, col, "read", doc);
      throw fail("not_found", { collection: col, slug });
    }
    assert(actor, col, "read", pub);
    return read(actor, await fillOne(pub, false), false, { snippets: o.snippets });
  }
  /** Field rules, then `afterRead` hooks: each sees what the one before returned. */
  async function read(actor: Actor, doc: CmsDoc, draft: boolean, o: { list?: boolean; snippets?: "raw" } = {}): Promise<CmsDoc> {
    const cfg = collection(doc.collection);
    let cur = doc;
    // 0.21.0: readers get snippets filled in; editors (draft) and `snippets: "raw"` get the tokens.
    if (!draft && o.snippets !== "raw" && typeof cur.body === "string" && cur.body.includes("[[snippet:") && (cur.format ?? "markdown") === "markdown") cur = { ...cur, body: await model.expandSnippets(cur.body) };
    if (cfg.fieldAccess || cfg.fieldHooks) {
      const fields = structuredClone(cur.fields ?? {}) as Record<string, unknown>;
      const hidden = Object.entries(cfg.fieldAccess ?? {}).filter(([, rule]) => rule.read && !rule.read({ actor, doc })).map(([path]) => path);
      for (const path of hidden) unsetPath(fields, path);
      // The published copy and the autosave copy carry fields too. Each is judged on its own
      // content and version (a rule may hide a field only in some copies), and a field hidden in
      // the current copy stays hidden in them as well.
      if (cfg.fieldAccess) {
        const strip = <T extends { fields?: Record<string, unknown> } | null | undefined>(c: T, version: number | null): T => {
          if (!c?.fields) return c;
          const own = hiddenPaths(actor, doc.collection, overlay(doc, c as Partial<DocContent>, version));
          const all = [...new Set([...hidden, ...own])];
          if (!all.length) return c;
          const f = structuredClone(c.fields);
          for (const path of all) unsetPath(f, path);
          return { ...c, fields: f };
        };
        cur = { ...cur, published: strip(cur.published as never, cur.publishedVersion), ...(cur.autosave ? { autosave: { ...cur.autosave, content: strip(cur.autosave.content as never, cur.autosave.baseVersion ?? cur.version) } } : {}) } as CmsDoc;
      }
      for (const [path, h] of Object.entries(cfg.fieldHooks ?? {})) {
        if (!h.afterRead || !hasPath(fields, path)) continue;
        const v = await hook((x: unknown) => h.afterRead!(x, { actor, doc, draft }), getPath(fields, path));
        if (v === undefined) unsetPath(fields, path);
        else setPath(fields, path, v);
      }
      cur = { ...cur, fields };
    }
    const fns = cfg.hooks?.afterRead;
    if (!fns?.length) return cur;
    for (const fn of fns) cur = (await hook((d: CmsDoc) => fn(d, { actor, draft, ...(o.list ? { list: true } : {}) }), cur)) ?? cur;
    return cur;
  }
  /** Field paths `actor` may not see in `doc` (from `fieldAccess`). */
  function hiddenPaths(actor: Actor, col: string, doc: CmsDoc | null): string[] {
    const rules = collection(col).fieldAccess;
    if (!rules) return [];
    return Object.entries(rules)
      .filter(([, rule]) => rule.read && !rule.read({ actor, doc: doc as CmsDoc }))
      .map(([path]) => path);
  }
  /**
   * The one projection every copy of a document goes through before it leaves the server
   * (versions, diffs, conflicts, preview links, grep, search): fields the reader may not see
   * are removed from that copy too, not only from the current one.
   */
  function project<T extends { fields?: Record<string, unknown> } | null | undefined>(actor: Actor, col: string, doc: CmsDoc | null, content: T, version?: number | null): T {
    if (!content?.fields) return content;
    // The rule looks at the copy being shown (an old version, a preview) with its own version
    // number, not the latest draft.
    // A stored copy without a format is markdown: it does not inherit the draft's.
    const hidden = hiddenPaths(actor, col, (doc ? overlay(doc, content as Partial<DocContent>, version ?? doc.version) : { ...prospectiveDoc(col, {}), ...content }) as CmsDoc);
    return projectWith(hidden, content);
  }
  /** Remove these field paths from a copy. */
  function projectWith<T extends { fields?: Record<string, unknown> } | null | undefined>(hidden: readonly string[], content: T): T {
    if (!content?.fields || !hidden.length) return content;
    const f = structuredClone(content.fields);
    for (const path of hidden) unsetPath(f, path);
    return { ...content, fields: f };
  }
  const isHiddenPath = (hidden: string[], path: string) => hidden.some((h) => path === h || path.startsWith(`${h}.`) || path === `fields.${h}` || path.startsWith(`fields.${h}.`));
  async function beforeRead(actor: Actor, col: string, slug: string | null, draft: boolean) {
    for (const fn of collection(col).hooks?.beforeRead ?? []) await hook(fn, { actor, collection: col, slug, draft });
  }
  /** Whether list rows need per-reader work (field rules or `afterRead`). */
  const readsPerDoc = (col: string) => {
    const c = collection(col);
    return !!(c.fieldAccess || c.fieldHooks?.length || Object.values(c.fieldHooks ?? {}).some((h) => h.afterRead) || c.hooks?.afterRead?.length);
  };
  /** Field paths this actor may not see / not change in a document (for the admin form and saves). */
  function fieldRulesFor(actor: Actor, col: string, doc: CmsDoc | null): { hidden: string[]; readOnly: string[] } {
    const hidden: string[] = [];
    const readOnly: string[] = [];
    for (const [path, rule] of Object.entries(collection(col).fieldAccess ?? {})) {
      if (doc && rule.read && !rule.read({ actor, doc })) hidden.push(path);
      else if (rule.write && !rule.write({ actor, doc })) readOnly.push(path);
    }
    return { hidden, readOnly };
  }
  /**
   * Before a save: fields this actor may not see keep their stored value (the form never had
   * them); fields it may not change must be unchanged; field `beforeChange` hooks run.
   */
  async function guardFields(actor: Actor, col: string, prev: CmsDoc | null, content: DocContent, o: { hooks?: boolean } = {}): Promise<DocContent> {
    const cfg = collection(col);
    if (!cfg.fieldAccess && !cfg.fieldHooks) return content;
    const fields = structuredClone(content.fields ?? {}) as Record<string, unknown>;
    const before = (prev?.fields ?? {}) as Record<string, unknown>;
    // On create there is no stored document: the rules look at the one being made.
    const proposed = prev ?? prospectiveDoc(col, { ...content, fields });
    for (const [path, rule] of Object.entries(cfg.fieldAccess ?? {})) {
      const canSee = !rule.read || rule.read({ actor, doc: proposed });
      const canWrite = !rule.write || rule.write({ actor, doc: prev });
      if (!canSee || !canWrite) {
        const sent = hasPath(fields, path);
        const same = JSON.stringify(getPath(fields, path) ?? null) === JSON.stringify(getPath(before, path) ?? null);
        if (sent && !same && canSee) throw fail("forbidden_field", { field: path }, { status: 403 });
        // Not sent, or sent by someone who cannot see it: keep what is stored.
        if (hasPath(before, path)) setPath(fields, path, structuredClone(getPath(before, path)));
        else unsetPath(fields, path);
      }
    }
    for (const [path, h] of Object.entries(o.hooks === false ? {} : (cfg.fieldHooks ?? {}))) {
      if (!h.beforeChange) continue;
      const v = await hook((x: unknown) => h.beforeChange!(x, { actor, prev: getPath(before, path), doc: prev }), getPath(fields, path));
      if (v === undefined) unsetPath(fields, path);
      else setPath(fields, path, v);
    }
    return { ...content, fields };
  }


  async function list(actor: Actor, col: string, o: ListOptions = {}): Promise<CmsDoc[]> {
    collection(col);
    await ensureSchema();
    const editor = !!o.drafts && can(actor, col, "write");
    if (!editor) assert(actor, col, "read");
    await beforeRead(actor, col, null, editor);
    // An editor gets the working copy of each document they may edit (judged on the stored row);
    // of the others, the published copy if they may read it; nothing else.
    /** Published copies in an editor's list (documents they may read but not edit): read as published, not as drafts. */
    const fallback = new WeakSet<CmsDoc>();
    // With per-document write rules the status filter is applied to the copy each person gets (a
    // published copy shown in place of a draft is "published"), not to the stored row.
    const perDocWrite = !!collection(col).access?.write;
    // 0.22.0: one language at a time (the default language: the source documents).
    const l = localeOf(col, o.locale);
    const which = l ? { locale: l } : srcOnly();
    const rows = editor
      ? (await fillShared(await repo.listDocs({ collection: col, ...which, statuses: o.status && !perDocWrite ? [o.status] : undefined }), true)).flatMap((d) => {
          if (!perDocWrite || can(actor, col, "write", d)) return !o.status || d.status === o.status ? [d] : [];
          const pub = fallbackView(d);
          if (!pub || !can(actor, col, "read", pub) || (o.status && o.status !== "published")) return [];
          fallback.add(pub);
          return [pub];
        })
      : await cached(col, l ? `list:${l}${o.fallback ? ":f" : ""}` : "list", async () => {
          const shown = (ds: CmsDoc[]) => ds.map(publicView).filter((d): d is CmsDoc => !!d);
          const own = shown(await repo.listDocs({ collection: col, published: true, ...which }));
          if (!l || !o.fallback) return fillShared(own, false);
          // Documents with no published translation in `l`: the source, marked with the language asked for.
          const have = new Set(own.map((d) => d.groupId));
          const rest = shown(await repo.listDocs({ collection: col, published: true, ...srcOnly() })).filter((d) => !have.has(d.id)).map((d) => ({ ...d, requestedLocale: l }));
          return fillShared([...own, ...rest], false);
        });
    const q = o.q?.trim().toLowerCase();
    const sorted = rows
      .filter((d) => editor || can(actor, col, "read", d))
      .filter((d) => !o.category || d.category === o.category)
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.slug.includes(q) || d.summary.toLowerCase().includes(q))
      // Who last changed a draft is the draft's: published copies do not match it.
      .filter((d) => !editor || !o.by || (!fallback.has(d) && d.updatedByKind === o.by))
      .filter((d) => {
        if (!editor || !o.state) return true;
        const s = docState(d);
        if (o.state === "scheduled") return !!d.schedule;
        if (o.state === "review") return d.review?.state === "requested";
        return o.state === "modified" ? s.modifiedSincePublish : s.state === o.state;
      })
      .sort((a, b) => (editor ? b.updatedAt.localeCompare(a.updatedAt) : (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt)));
    return readsPerDoc(col) ? Promise.all(sorted.map((d) => read(actor, d, editor && !fallback.has(d), { list: true }))) : sorted;
  }

  function summaryOf(d: CmsDoc): DocSummary {
    const s = docState(d);
    return {
      id: d.id,
      collection: d.collection,
      slug: d.slug,
      ...(d.locale ? { locale: d.locale } : {}),
      ...(d.requestedLocale ? { requestedLocale: d.requestedLocale } : {}),
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
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const keyset = decodeCursor(o.cursor);
    const editor = !!o.drafts && can(actor, col, "write");
    // In the database (0.17.0): filter, sort and cut there, and page by the last row, not by a count.
    // A per-document read rule is checked in memory (the list path below), not in SQL.
    const l = localeOf(col, o.locale);
    if (typeof repo.pageDocs === "function" && !(editor && o.state) && keyset !== "offset" && !collection(col).access?.read && !(editor && collection(col).access?.write) && !(l && o.fallback && !editor)) {
      collection(col);
      await ensureSchema();
      if (!editor) assert(actor, col, "read");
      await beforeRead(actor, col, null, editor);
      const query = { collection: col, published: !editor, statuses: editor && o.status ? [o.status] : undefined, category: o.category || undefined, q: o.q?.trim() || undefined, by: editor ? o.by : undefined, ...(l ? { locale: l } : {}), limit: limit + 1, after: keyset };
      const run = async () => {
        const r = await repo.pageDocs!(query);
        const rows = await fillShared(editor ? r.docs : r.docs.map(publicView).filter((d): d is CmsDoc => !!d), editor);
        // The cursor comes from the stored row, read before `afterRead` can change it: the next
        // page starts where the database left off.
        const raw = rows.slice(0, limit).at(-1);
        const key = raw ? { at: editor ? raw.updatedAt : (raw.publishedAt ?? raw.updatedAt), id: raw.id } : null;
        const shown = readsPerDoc(col) ? await Promise.all(rows.slice(0, limit).map((d) => read(actor, d, editor, { list: true }))) : rows.slice(0, limit);
        return { rows: shown.map(summaryOf), more: rows.length > limit, total: r.total, key };
      };
      const r = editor || readsPerDoc(col) ? await run() : await cached(col, `p:${JSON.stringify({ ...query, collection: undefined })}`, run);
      const slice = r.rows;
      if (o.hits && can(actor, col, "write")) {
        const counts = await hitCounts(actor, col, 7);
        for (const d of slice) d.hits7d = counts.get(d.id) ?? 0;
      }
      // A page cached by an older version has no key: fall back to the last row shown.
      const last = slice.at(-1);
      const key = r.key ?? (last ? { at: editor ? last.updatedAt : (last.publishedAt ?? last.updatedAt), id: last.id } : null);
      return { docs: slice, total: r.total, nextCursor: r.more && key?.at ? encodeCursor(key.at, key.id) : null };
    }
    const all = await list(actor, col, o);
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
    // The same selection as the editor's list: working copies of what this person may edit, the
    // published copy of the rest they may read, nothing else.
    const perDoc = !!collection(col).access?.write;
    for (const d of await repo.listDocs({ collection: col, ...srcOnly() })) {
      if (perDoc && !can(actor, col, "write", d)) {
        const pub = publicView(d);
        if (pub && can(actor, col, "read", pub)) {
          out.all++;
          out.published++;
        }
        continue;
      }
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

  /** A stored version as `actor` may see it: hidden fields leave the snapshot and the change list. */
  const withPublished = (v: StoredVersion, doc: CmsDoc, actor?: Actor): CmsVersion => {
    const out: CmsVersion = { ...v, published: v.version === doc.publishedVersion };
    if (!actor) return out;
    // The rule is asked about this version's own content, not the latest draft.
    const hidden = hiddenPaths(actor, doc.collection, overlay(doc, v.snapshot, v.version));
    if (!hidden.length) return out;
    // One decision for the snapshot and its change list.
    return {
      ...out,
      snapshot: projectWith(hidden, v.snapshot),
      changed: v.changed ? { ...v.changed, fields: v.changed.fields.filter((f) => !isHiddenPath(hidden, f)) } : v.changed,
    };
  };

  async function versions(actor: Actor, col: string, slug: string): Promise<CmsVersion[]> {
    const doc = await editable(actor, col, slug);
    return (await repo.listVersions(doc.id)).map((v) => withPublished(v, doc, actor));
  }

  /** Version list without snapshots. */
  async function versionList(actor: Actor, col: string, slug: string): Promise<VersionSummary[]> {
    const doc = await editable(actor, col, slug);
    return (await repo.listVersions(doc.id)).map((v) => {
      const { snapshot, ...rest } = withPublished(v, doc, actor);
      return { ...rest, title: snapshot.title };
    });
  }

  /**
   * Versions newest first, one page at a time (0.18.0): `cursor` is the version number the
   * next page starts below. The database cuts the page when it can.
   */
  async function versionPage(actor: Actor, col: string, slug: string, o: { limit: number; cursor?: string | null; summary?: boolean }): Promise<{ versions: (CmsVersion | VersionSummary)[]; total: number; nextCursor: string | null }> {
    const doc = await editable(actor, col, slug);
    const limit = Math.max(1, Math.min(o.limit, 500));
    // Cursor "v.<n>": continue below version n. A bare number is the 0.17 cursor (an offset
    // into the list oldest first): still answered that way, once, for callers mid-way.
    if (o.cursor && /^\d+$/.test(o.cursor)) {
      const all = (await repo.listVersions(doc.id)).sort((a, b) => a.version - b.version);
      const at = Number(o.cursor);
      const rows = all.slice(at, at + Math.max(1, Math.min(o.limit, 500))).map((v) => withPublished(v, doc, actor));
      const out = o.summary ? rows.map(({ snapshot, ...rest }) => ({ ...rest, title: snapshot.title })) : rows;
      return { versions: out, total: all.length, nextCursor: at + rows.length < all.length ? String(at + rows.length) : null };
    }
    const m = o.cursor ? /^v\.(\d+)$/.exec(o.cursor) : null;
    if (o.cursor && !m) throw fail("invalid", { message: "cursor" });
    const before = m ? Number(m[1]) : null;
    const r = typeof repo.pageVersions === "function"
      ? await repo.pageVersions(doc.id, { limit: limit + 1, before })
      : await repo.listVersions(doc.id).then((all) => ({ versions: all.filter((v) => before === null || v.version < before).slice(0, limit + 1), total: all.length }));
    const rows = r.versions.slice(0, limit).map((v) => withPublished(v, doc, actor));
    const out = o.summary ? rows.map(({ snapshot, ...rest }) => ({ ...rest, title: snapshot.title })) : rows;
    return { versions: out, total: r.total, nextCursor: r.versions.length > limit ? `v.${rows.at(-1)!.version}` : null };
  }

  async function version(actor: Actor, col: string, slug: string, n: number): Promise<CmsVersion> {
    const doc = await editable(actor, col, slug);
    const v = await repo.getVersion(doc.id, n);
    if (!v) throw fail("version_not_found", { version: n });
    return withPublished(v, doc, actor);
  }

  /** Field changes and body hunks between two versions of a document. */
  async function diff(actor: Actor, col: string, slug: string, a: number, b: number, o: { context?: number } = {}): Promise<DocDiff> {
    const doc = await editable(actor, col, slug);
    const [va, vb] = await Promise.all([repo.getVersion(doc.id, a), repo.getVersion(doc.id, b)]);
    if (!va) throw fail("version_not_found", { version: a });
    if (!vb) throw fail("version_not_found", { version: b });
    // A field hidden in either version is left out of both: a diff must not show it by contrast.
    const hidden = [...new Set([...hiddenPaths(actor, col, overlay(doc, va.snapshot, a)), ...hiddenPaths(actor, col, overlay(doc, vb.snapshot, b))])];
    const sa = projectWith(hidden, va.snapshot);
    const sb = projectWith(hidden, vb.snapshot);
    return { a, b, fields: fieldChanges(sa, sb), hunks: hunks(sa.body, sb.body, o.context ?? 3) };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** Counts writes in this process (the dashboard's cache starts over after one). */
  let writeGen = 0;

  function publicSig(doc: CmsDoc | null): string {
    const p = doc ? publicView(doc) : null;
    return p ? `${p.publishedVersion}:${stableJson(contentOf(p))}` : "";
  }

  /** `prev` is the row before the write (null for a create); `doc` after (null for a delete). */
  function changed(prev: CmsDoc | null, doc: CmsDoc | null, o: { quiet?: boolean } = {}) {
    const target = doc ?? prev;
    if (!target) return;
    writeGen++;
    const info: ChangeInfo = { contentChanged: publicSig(prev) !== publicSig(doc) };
    if (info.contentChanged) {
      index.dirty = true;
      invalidate(target.collection);
      // 0.21.0: a snippet shows inside other documents: their cached copies go too.
      if (collections.get(target.collection)?.snippets) {
        model.forgetSnippets();
        for (const c of collections.keys()) if (c !== target.collection) invalidate(c);
      }
    }
    if (doc && !o.quiet && !doc.deletedAt && (!prev || doc.version !== prev.version)) {
      const by = doc.updatedByKind ? { kind: doc.updatedByKind, id: null, label: doc.updatedBy ?? "", agent: doc.updatedByAgent ?? null } : null;
      emitEvent({ event: prev ? "doc.updated" : "doc.created", actor: by, collection: doc.collection, slug: docAddress(doc), version: doc.version, url: urlOf(doc.collection, docAddress(doc)) });
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
    hex(sha256(`${v}\n${h.removed.join("\n")}\n--\n${h.added.join("\n")}`)).slice(0, 12);

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
    fail("conflict_version", { expected, current: cur.version }, { current: can(actor, col, "write", cur) ? conflictCopy(actor, col, cur) : undefined });
  /** The current document sent with a conflict: the same field projection as a read. */
  const conflictCopy = (actor: Actor, col: string, cur: CmsDoc): CmsDoc => {
    if (!collection(col).fieldAccess) return cur;
    const hidden = hiddenPaths(actor, col, cur);
    return {
      ...projectWith(hidden, cur),
      published: copyProjected(actor, col, cur, cur.published as never, cur.publishedVersion, hidden),
      ...(cur.autosave ? { autosave: { ...cur.autosave, content: copyProjected(actor, col, cur, cur.autosave.content as never, cur.autosave.baseVersion ?? cur.version, hidden) } } : {}),
    } as CmsDoc;
  };
  /**
   * One copy of a document (published, autosave) as `actor` may see it (0.18.0): judged on its own
   * content at its own version, and anything hidden in the current copy (`alsoHidden`) stays hidden.
   */
  function copyProjected<T extends { fields?: Record<string, unknown> } | null | undefined>(actor: Actor, col: string, doc: CmsDoc, copy: T, version: number | null | undefined, alsoHidden: readonly string[]): T {
    if (!copy?.fields || !collection(col).fieldAccess) return copy;
    const own = hiddenPaths(actor, col, overlay(doc, copy as Partial<DocContent>, version));
    return projectWith([...new Set([...alsoHidden, ...own])], copy);
  }

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
    const l = localeOf(col, o.locale, { write: true });
    if (l) return createTranslation(actor, col, l, input, o);
    await ensureSchema();
    assert(actor, col, "write");
    if (o.publish) assert(actor, col, "publish");
    if (o.publish && needsReview(actor, col)) throw reviewRequired(actor, col, input.slug ?? null);
    const who = actorRef(actor);
    const cfg = collection(col);
    input = await prepared(actor, col, null, input);
    if (o.template) input = await withTemplate(actor, col, input, o.template);
    if (cfg.single) {
      if (await repo.findDoc(col, SINGLE_SLUG, { trashed: true })) throw fail("single_only", { collection: col });
      input = { ...input, slug: SINGLE_SLUG };
    }
    input = { ...input, fields: await model.resolveRelations(col, input.fields as Record<string, unknown> | undefined) };
    const content = await hooked(actor, col, null, validate(col, {
      slug: input.slug ?? "",
      title: input.title ?? "",
      summary: input.summary ?? "",
      body: input.body ?? "",
      ...(input.format === "html" ? { format: "html" as const } : {}),
      category: input.category ?? cfg.categories?.[0] ?? null,
      keywords: input.keywords ?? [],
      fields: (input.fields as Record<string, unknown>) ?? {},
      ...seoOf(input.seo as DocSeo | null | undefined),
    }, { actor, base: null }));
    await assets.assertDoc(cfg, content).catch((e) => {
      throw safeError(actor, col, prospectiveDoc(col, content), e);
    });
    await assertModel(actor, col, content, null);
    await htmlGate(actor, col, null, content);
    const at = nowIso();
    const doc = await loggedTx(async (r, log) => {
      const other = await r.findDoc(col, content.slug, { trashed: true });
      if (other) throw slugTaken(other);
      const publish = !!o.publish;
      if (publish) await gate("beforePublish", actor, { collection: col, slug: content.slug, version: 1 }, content);
      const row = await r.insertDoc({
        collection: col,
        ...content,
        ...(localized(col) ? { locale: defaultLocale } : {}),
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
      await syncAllRefs(r, row);
      await logWrite(log, actor, null, row);
      return row;
    });
    // Created before published: live events go out in the order of their change-log numbers.
    changed(null, doc);
    if (o.publish) audit(actor, "doc.publish", { collection: col, slug: docAddress(doc), version: 1 });
    return doc;
  }

  /**
   * Start a translation (0.22.0): a new document in `locale` with the source's slug. Its words come
   * from the source's published copy (else its working copy) unless `input` brings its own; what it
   * shares with the source (category, non-text fields) cannot be set here. `sourceVersion` says which
   * source version it starts from.
   */
  async function createTranslation(actor: Actor, col: string, locale: string, input: DocInput, o: WriteOptions): Promise<CmsDoc> {
    await ensureSchema();
    assert(actor, col, "write");
    if (o.publish) assert(actor, col, "publish");
    const fromSlug = splitAddress(o.from ?? input.slug ?? "").slug;
    const src = fromSlug ? await repo.findDoc(col, fromSlug) : null;
    if (!src) throw fail("locale_source_missing", { slug: fromSlug, source: defaultLocale });
    assert(actor, col, "write", src);
    if (o.publish && needsReview(actor, col)) throw reviewRequired(actor, col, src.slug);
    const bad = sharedViolation(col, input, src, src.slug);
    if (bad) throw sharedError(bad);
    const base = publicView(src) ?? src;
    const sourceVersion = referenceVersion(src);
    const cfg = collection(col);
    input = await prepared(actor, col, null, input);
    const tf = translatable(col);
    const own: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(base.fields ?? {})) if (tf[k]) own[k] = v;
    for (const [k, v] of Object.entries((input.fields ?? {}) as Record<string, unknown>)) if (tf[k]) own[k] = v;
    const draft = withShared(col, {
      slug: src.slug,
      title: input.title ?? base.title,
      summary: input.summary ?? base.summary,
      body: input.body ?? base.body,
      category: null,
      keywords: input.keywords ?? base.keywords,
      fields: own,
      ...(input.seo !== undefined ? seoOf(input.seo === null ? null : ({ ...(base.seo ?? {}), ...input.seo } as DocSeo)) : seoOf(base.seo ?? null)),
    } as DocContent, src);
    const content = { ...(await hooked(actor, col, null, validate(col, draft, { actor, base: null }))), slug: src.slug };
    await assets.assertDoc(cfg, content).catch((e) => {
      throw safeError(actor, col, { ...content, collection: col } as CmsDoc, e);
    });
    await assertModel(actor, col, content, null);
    await htmlGate(actor, col, null, content);
    const who = actorRef(actor);
    const at = nowIso();
    const doc = await loggedTx(async (r, log) => {
      if (await r.findDoc(col, localeAddress(src.slug, locale), { trashed: true })) throw fail("translation_exists", { slug: src.slug, locale });
      const publish = !!o.publish;
      if (publish) await gate("beforePublish", actor, { collection: col, slug: src.slug, version: 1 }, content);
      const row = await r.insertDoc({
        collection: col,
        ...content,
        locale,
        groupId: src.id,
        sourceVersion,
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
      await logWrite(log, actor, null, row);
      return row;
    });
    changed(null, doc);
    audit(actor, "doc.translate", { collection: col, slug: localeAddress(src.slug, locale), version: 1, detail: { from: defaultLocale, sourceVersion } });
    if (o.publish) audit(actor, "doc.publish", { collection: col, slug: localeAddress(src.slug, locale), version: 1 });
    return doc;
  }

  /** The source document behind `slug` (any language's address) in a localized collection. */
  async function sourceOf(col: string, slug: string): Promise<CmsDoc> {
    await ensureSchema();
    if (!localized(col)) throw fail("locale_not_localized", { collection: col });
    const base = splitAddress(slug).slug;
    const src = await repo.findDoc(col, base);
    if (!src) throw fail("not_found", { collection: col, slug: base });
    return src;
  }
  /** The translation in `locale` (an editor's copy), with its source. */
  async function translationOf(actor: Actor, col: string, slug: string, locale: string): Promise<{ src: CmsDoc; t: CmsDoc; locale: string }> {
    const src = await sourceOf(col, slug);
    const l = localeOf(col, locale, { write: true });
    if (!l) throw fail("locale_is_source", { locale, slug: src.slug });
    const t = await repo.findDoc(col, localeAddress(src.slug, l));
    if (!t) throw fail("translation_not_found", { slug: src.slug, locale: l });
    assert(actor, col, "write", t);
    return { src, t, locale: l };
  }

  /** Every language of a document with its translation status (0.22.0; editors). */
  async function translations(actor: Actor, col: string, slug: string): Promise<TranslationList> {
    const src = await sourceOf(col, slug);
    assert(actor, col, "write", src);
    const rows = await repo.listDocs({ groupId: src.id });
    const list: TranslationInfo[] = locales.map((l) => {
      if (l === defaultLocale) return { locale: l, status: "source", version: src.version, sourceVersion: null, publishedVersion: src.publishedVersion, updatedAt: src.updatedAt, docStatus: src.status };
      const t = rows.find((d) => isTranslationDoc(d) && d.locale === l) ?? null;
      return { locale: l, status: statusOf(src, t), version: t?.version ?? null, sourceVersion: t?.sourceVersion ?? null, publishedVersion: t?.publishedVersion ?? null, updatedAt: t?.updatedAt ?? null, docStatus: t?.status ?? null };
    });
    return { collection: col, slug: src.slug, defaultLocale, sourceVersion: referenceVersion(src), translations: list };
  }

  /** Say a translation matches source version `version` (default: the source's published, else latest) ("v7 기준으로 맞춤"). No new version. */
  async function markAligned(actor: Actor, col: string, slug: string, locale: string, o: { version?: number } = {}): Promise<CmsDoc> {
    const { src, t } = await translationOf(actor, col, slug, locale);
    const v = o.version ?? referenceVersion(src);
    if (!Number.isInteger(v) || v < 1 || v > src.version) throw fail("version_not_found", { version: v });
    const doc = (await repo.updateDoc(t.id, { sourceVersion: v, updatedAt: t.updatedAt })) ?? t;
    audit(actor, "doc.align", { collection: col, slug: docAddress(t), version: t.version, detail: { sourceVersion: v, before: t.sourceVersion ?? null } });
    changed(t, doc, { quiet: true });
    return doc;
  }

  /** What changed in the source since the translation in `locale` was aligned (0.22.0): a diff of source versions. */
  async function sourceDiff(actor: Actor, col: string, slug: string, locale: string, o: { context?: number } = {}): Promise<DocDiff & { collection: string; slug: string; locale: string; status: TranslationStatus }> {
    const { src, t, locale: l } = await translationOf(actor, col, slug, locale);
    const from = t.sourceVersion ?? 1;
    const to = referenceVersion(src);
    const base = { collection: col, slug: src.slug, locale: l, status: statusOf(src, t) };
    if (from >= to) return { ...base, a: from, b: to, fields: [], hunks: [] };
    return { ...base, ...(await diff(actor, col, src.slug, from, to, o)) };
  }

  /** Write a new version from `next`; decides the status. */
  async function commit(r: CmsRepo, actor: Actor, doc: CmsDoc, next: DocContent, o: WriteOptions & { restoredFrom?: number }): Promise<CmsDoc> {
    const who = actorRef(actor);
    const cfg = collection(doc.collection);
    const at = nowIso();
    const v = doc.version + 1;
    // 0.22.0: a translation keeps the source's slug and shared values whatever the copy says (a restored old version too).
    if (isTranslationDoc(doc)) next = { ...withShared(doc.collection, next, await r.findDocById(doc.groupId!)), slug: doc.slug };
    next = await hooked(actor, doc.collection, doc, next);
    const moved = next.slug !== doc.slug && doc.publishedVersion !== null;
    if (moved && !model.redirectsOn()) throw fail("slug_locked");
    const other = next.slug !== doc.slug ? await r.findDoc(doc.collection, next.slug, { trashed: true }) : null;
    if (other) throw slugTaken(other);
    // 0.22.0: translations move with their source (same slug in every language). No new version for them.
    if (next.slug !== doc.slug && localized(doc.collection)) {
      for (const t of await r.listDocs({ groupId: doc.id, trashed: false })) if (t.id !== doc.id) await r.updateDoc(t.id, { slug: next.slug, updatedAt: t.updatedAt });
      for (const t of await r.listDocs({ groupId: doc.id, trashed: true })) if (t.id !== doc.id) await r.updateDoc(t.id, { slug: next.slug, updatedAt: t.updatedAt });
    }

    const inPlace = cfg.versions?.drafts === false && doc.publishedVersion !== null && doc.status !== "archived";
    const publish = !!o.publish || inPlace;
    // 0.21.0: a published address changes only together with publishing (readers and the redirect switch at once).
    if (moved && !publish) throw fail("slug_needs_publish");
    // A new version is one nobody approved yet.
    if (publish && needsReview(actor, doc.collection)) throw reviewRequired(actor, doc.collection, doc.slug);
    if (publish) await gate("beforePublish", actor, { collection: doc.collection, slug: next.slug, version: v }, next, doc);
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
    await syncAllRefs(r, updated);
    await model.keepAnchors(r, doc.id, doc.body, next.body);
    if (moved) await model.autoRedirect(r, updated, doc.slug, next.slug, who.label);
    return updated;
  }

  /** Read, change and save in one transaction. */
  async function write(actor: Actor, col: string, slug: string, make: (cur: CmsDoc) => DocInput, o: WriteOptions = {}) {
    await ensureSchema();
    let prev: CmsDoc | null = null;
    const doc = await loggedTx(async (r, log) => {
      const out = await writeIn(r);
      await logWrite(log, actor, prev, out, o.publish ? "write-publish" : undefined);
      return out;
    });
    async function writeIn(r: CmsRepo): Promise<CmsDoc> {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "write", cur);
      if (o.publish || (collection(col).versions?.drafts === false && cur.publishedVersion !== null)) assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
      const asked0 = await prepared(actor, col, cur, make(cur));
      // 0.22.0: a translation changes only its own words; what it shares with the source is refused (agents learn where to write).
      if (isTranslationDoc(cur)) {
        const src = await r.findDocById(cur.groupId!);
        const bad = src ? sharedViolation(col, asked0, src, cur.slug, cur) : null;
        if (bad) throw sharedError(bad);
      }
      // A single's one document keeps its slug whatever the form sends.
      const asked = collection(col).single ? { ...asked0, slug: undefined } : asked0;
      const candidate = merged(cur, { ...asked, fields: await model.resolveRelations(col, asked.fields as Record<string, unknown> | undefined, r) });
      const next = validate(col, candidate, { actor, base: cur });
      await assets.assertDoc(collection(col), next, cur, r).catch((e) => {
        throw safeError(actor, col, { ...cur, ...next, format: next.format } as CmsDoc, e);
      });
      await assertModel(actor, col, next, cur, r);
      if (same(next, cur)) {
        // Nothing changed. Still honour "publish".
        if (o.publish && cur.publishedVersion !== cur.version) {
          await assertReviewed(r, actor, cur, cur.version);
          return publishIn(r, actor, cur, cur.version);
        }
        return cur.autosave ? ((await r.updateDoc(cur.id, { autosave: null, updatedAt: cur.updatedAt })) ?? cur) : cur;
      }
      return commit(r, actor, cur, next, o);
    }
    changed(prev, doc);
    if (o.publish && doc.publishedVersion === doc.version && prev && (prev as CmsDoc).publishedVersion !== doc.version) audit(actor, "doc.publish", { collection: col, slug: docAddress(doc), version: doc.version });
    flow.markAgent(actor, doc);
    return { prev: prev as CmsDoc | null, doc };
  }

  async function update(actor: Actor, col: string, slug: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    if (o.locale) slug = address(col, slug, o.locale, { write: true });
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
      const { diagnostics, content: normalized } = check(col, { ...cur, body });
      const files = await assets.checkDoc(collection(col), { ...cur, body }, assets.idsIn(collection(col), cur));
      const shown = [...diagnosticsFor(actor, col, overlay(cur, normalized, cur.version), diagnostics), ...diagnosticsFor(actor, col, { ...cur, body } as CmsDoc, files)];
      return { doc: null, diff: unifiedDiff(cur.body, body, { from: `v${cur.version}`, to: "patched" }), diagnostics: shown, saved: false };
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
    let content = contentOf(merged(cur.autosave?.content ?? cur, input));
    if (collection(col).fieldAccess) {
      // Only the access rules here (field hooks run on the real save): a draft copy cannot sneak a change in.
      content = await guardFields(actor, col, cur, content, { hooks: false });
    }
    if (JSON.stringify(content).length > LIMITS.body * 2) throw fail("body_too_large", {}, { status: 413 });
    const state = { content, at: nowIso(), by: actorRef(actor).label, baseVersion };
    // Keep updatedAt: an autosave is not a change anyone else sees.
    await repo.updateDoc(cur.id, { autosave: state, updatedAt: cur.updatedAt });
    // The answer goes to the caller: fields they may not see (kept from the stored copy) stay out.
    return collection(col).fieldAccess ? { ...state, content: copyProjected(actor, col, cur, state.content, baseVersion, hiddenPaths(actor, col, cur)) } : state;
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
    await gate("beforePublish", actor, { collection: doc.collection, slug: doc.slug, version: n }, v.snapshot, doc);
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
    }, doc.version);
    // Only the row that was checked: an edit that landed in between is a conflict, not overwritten.
    if (!updated) throw await movedOn(r, actor, doc);
    await syncAllRefs(r, updated);
    return updated;
  }

  /** The error for a write whose row changed after it was read in the same transaction. */
  async function movedOn(r: CmsRepo, actor: Actor, doc: CmsDoc): Promise<Error> {
    const now = await r.findDocById(doc.id);
    return now && !now.deletedAt ? conflict(now, doc.version, actor, doc.collection) : fail("not_found", { collection: doc.collection, slug: doc.slug });
  }

  type StateKind = "publish" | "archive" | "unpublish" | "write-publish";
  /**
   * The change rows a write makes, inside its transaction: the same events `changed()` and
   * `audit()` send afterwards (which then reuse these rows).
   */
  async function logWrite(log: TxLog, actor: Actor, prev: CmsDoc | null, doc: CmsDoc, kind?: StateKind) {
    if (!logChanges) return;
    const slug = docAddress(doc);
    const url = urlOf(doc.collection, slug);
    if (!doc.deletedAt && (!prev || doc.version !== prev.version)) {
      const by = doc.updatedByKind ? { kind: doc.updatedByKind, id: null, label: doc.updatedBy ?? "", agent: doc.updatedByAgent ?? null } : null;
      await log({ event: prev ? "doc.updated" : "doc.created", actor: by, collection: doc.collection, slug, version: doc.version, url });
    }
    if (actor.kind === "anonymous") return;
    const me = actorRef(actor);
    // The same rules the events after the commit follow (see `audit("doc.publish")` in create, write, publish).
    const published =
      kind === "publish"
        ? doc.publishedVersion !== null
        : kind === "write-publish"
          ? !!prev && doc.publishedVersion !== null && doc.publishedVersion === doc.version && prev.publishedVersion !== doc.version
          : !prev && doc.publishedVersion !== null;
    if (published) await log({ event: "doc.published", actor: me, collection: doc.collection, slug, version: doc.publishedVersion, url });
    if (kind === "archive") await log({ event: "doc.archived", actor: me, collection: doc.collection, slug, version: doc.version, url });
    if (kind === "unpublish") await log({ event: "doc.unpublished", actor: me, collection: doc.collection, slug, version: doc.version, url });
  }

  /** Run a publish-level state change on one document in a transaction. */
  async function stateChange(actor: Actor, col: string, slug: string, expectedVersion: number | undefined, fn: (r: CmsRepo, cur: CmsDoc) => Promise<CmsDoc>, kind?: StateKind, documentId?: string) {
    await ensureSchema();
    let prev: CmsDoc | null = null;
    const doc = await loggedTx(async (r, log) => {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "publish", cur);
      // Asked for one document by id (an import publishing what it saved): a different document
      // at the same address since then is not it.
      if (documentId !== undefined && cur.id !== documentId) throw fail("document_replaced", { slug });
      if (expectedVersion !== undefined && expectedVersion !== cur.version) throw conflict(cur, expectedVersion, actor, col);
      const out = await fn(r, cur);
      await logWrite(log, actor, cur, out, kind);
      return out;
    });
    changed(prev, doc);
    return doc;
  }

  async function publish(actor: Actor, col: string, slug: string, o: { version?: number; expectedVersion?: number; documentId?: string } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
      await assertReviewed(r, actor, cur, o.version ?? cur.version);
      return publishIn(r, actor, cur, o.version ?? cur.version);
    }, "publish", o.documentId);
    audit(actor, "doc.publish", { collection: col, slug, version: doc.publishedVersion });
    return doc;
  }

  /** 409 `doc_referenced` with the documents that point at `cur` (unreadable ones counted without a name). */
  async function assertNotReferenced(actor: Actor, cur: CmsDoc) {
    const refs = await refsShown(actor, cur.id, { forDelete: true });
    if (refs.length)
      throw fail("doc_referenced", { count: refs.length }, { status: 409, diagnostics: refs.map((x) => ({ path: x.fields.join(","), code: "doc_referenced" as const, params: { collection: x.collection, slug: x.slug, title: x.title, count: refs.length }, severity: "error" as const, message: x.title })) });
  }

  /** Hide a published document. Documents that point at it are listed (409 `doc_referenced`) unless `force`. */
  async function archive(actor: Actor, col: string, slug: string, o: { expectedVersion?: number; force?: boolean } = {}): Promise<CmsDoc> {
    if (!o.force) {
      // Asked before the transaction, like delete: the list reads other documents (and the reader's
      // rules), which must not wait on this transaction's connection.
      await ensureSchema();
      const pre = await repo.findDoc(col, slug);
      if (pre && can(actor, col, "publish", pre) && pre.publishedVersion !== null && pre.status !== "archived" && (o.expectedVersion === undefined || o.expectedVersion === pre.version)) await assertNotReferenced(actor, pre);
    }
    const raced = new Error("referenced since the check");
    let doc: CmsDoc;
    try {
      doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
        if (cur.publishedVersion === null) throw fail("not_published");
        if (cur.status === "archived") return cur;
        // Asked again inside the transaction, on its own connection only (`r`): a reference saved
        // between the check above and here stops it too. The rules and names are read after the
        // rollback (a second connection here would wait on this one forever on pglite).
        if (!o.force && (await model.referencedBy(cur.id, r)).some((x) => collections.has(x.doc.collection))) throw raced;
        const out = await r.updateDoc(cur.id, { status: "archived", updatedAt: nowIso() }, cur.version);
        if (!out) throw await movedOn(r, actor, cur);
        return out;
      }, "archive");
    } catch (e) {
      if (e !== raced) throw e;
      const now = await repo.findDoc(col, slug);
      if (now) await assertNotReferenced(actor, now);
      throw fail("doc_referenced", { count: 1 }, { status: 409 });
    }
    audit(actor, "doc.archive", { collection: col, slug, version: doc.version });
    return doc;
  }

  async function unarchive(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
      if (cur.status !== "archived") return cur;
      const at = nowIso();
      const out = await r.updateDoc(cur.id, { status: cur.publishedVersion === cur.version ? "published" : "draft", republishedAt: at, updatedAt: at }, cur.version);
      if (!out) throw await movedOn(r, actor, cur);
      return out;
    });
    audit(actor, "doc.unarchive", { collection: col, slug, version: doc.version });
    return doc;
  }

  async function unpublishIn(r: CmsRepo, actor: Actor, cur: CmsDoc): Promise<CmsDoc> {
    if (cur.publishedVersion === null && cur.status !== "archived") {
      if (!cur.schedule) return cur;
      const cleared = await r.updateDoc(cur.id, { schedule: null, dueAt: null, updatedAt: cur.updatedAt }, cur.version);
      if (!cleared) throw await movedOn(r, actor, cur);
      return cleared;
    }
    const who = actorRef(actor);
    const out = await r.updateDoc(cur.id, { status: "draft", publishedVersion: null, published: null, schedule: null, dueAt: null, updatedAt: nowIso(), updatedBy: who.label, updatedByKind: who.kind, updatedByAgent: who.agent }, cur.version);
    if (!out) throw await movedOn(r, actor, cur);
    await syncAllRefs(r, out);
    return out;
  }

  /**
   * Take a document off the public site and back to draft. Its versions stay;
   * the first publish time is kept, so publishing again doesn't re-date it.
   */
  async function unpublish(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, (r, cur) => unpublishIn(r, actor, cur), "unpublish");
    audit(actor, "doc.unpublish", { collection: col, slug, version: doc.version });
    return doc;
  }

  async function restore(actor: Actor, col: string, slug: string, n: number, o: WriteOptions = {}): Promise<CmsDoc> {
    await ensureSchema();
    let prev: CmsDoc | null = null;
    const doc = await loggedTx(async (r, log) => {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "write", cur);
      if (o.publish || (collection(col).versions?.drafts === false && cur.publishedVersion !== null)) assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
      const v = await r.getVersion(cur.id, n);
      if (!v) throw fail("version_not_found", { version: n });
      const out = await commit(r, actor, cur, validate(col, { ...v.snapshot, slug: cur.slug }, { actor, base: cur }), { ...o, restoredFrom: n });
      await logWrite(log, actor, cur, out);
      return out;
    });
    audit(actor, "doc.restore", { collection: col, slug, version: doc.version, detail: { from: n } });
    changed(prev, doc);
    return doc;
  }

  async function remove(actor: Actor, col: string, slug: string, o: { expectedVersion?: number; force?: boolean } = {}): Promise<void> {
    await ensureSchema();
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw fail("not_found", { collection: col, slug });
    assert(actor, col, "delete", cur);
    if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
    // 0.21.0: children first; documents that point here are listed and need `force`.
    if (model.treeOf(col)) {
      const kids = (await repo.listDocs({ collection: col, ...srcOnly() })).filter((d) => d.parentId === cur.id);
      if (kids.length) throw fail("doc_has_children", { count: kids.length }, { status: 409 });
    }
    if (!o.force) await assertNotReferenced(actor, cur);
    await gate("beforeDelete", actor, cur, contentOf(cur));
    // With a trash the row stays (and keeps its address) until it is restored or purged.
    await loggedTx(async (r, log) => {
      // 0.22.0: a source takes its translations with it (each can be restored from the trash).
      const kids = localized(col) && !isTranslationDoc(cur) ? (await r.listDocs({ groupId: cur.id })).filter((d) => d.id !== cur.id) : [];
      for (const d of [...kids, cur]) {
        if (trashDays > 0) await r.updateDoc(d.id, { deletedAt: nowIso(), deletedBy: actorRef(actor).label, schedule: null, dueAt: null, updatedAt: nowIso() });
        else await r.deleteDoc(d.id);
      }
      if (actor.kind !== "anonymous") await log({ event: "doc.deleted", actor: actorRef(actor), collection: col, slug, version: cur.version, url: urlOf(col, slug) });
    });
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
    // An existing document is only looked at by someone who may edit it (its own rules).
    if (cur) assert(actor, col, "write", cur);
    const content = merged(cur ?? { slug: "", title: "", summary: "", body: "", category: null, keywords: [], fields: {} }, input);
    const blocks = parseMarkdown(content.body, { lines: true });
    return {
      blocks,
      toc: extractToc(blocks),
      diagnostics,
      diff: cur ? unifiedDiff(cur.body, content.body, { from: `v${cur.version}`, to: "preview" }) : null,
      publicUrl: cfg.url && content.slug ? cfg.url({ slug: content.slug }) : null,
      // Files named only in fields this person may not see are not listed.
      assets: await assets.assetsFor({ collection: col, body: content.body, fields: project(actor, col, cur, content).fields }),
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
    return base64url(hmacSha256(opts.previewSecret!, payload));
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
    // `i`: the document's id, so a link never opens another document later given the same slug.
    const payload = b64url(JSON.stringify({ c: col, s: doc.slug, i: doc.id, v: doc.version, exp, ...(o.comments ? { cm: 1 } : {}) }));
    const token = `${payload}.${sign(payload)}`;
    const base = cfg.url({ slug: doc.slug });
    audit(actor, "preview.create", { collection: col, slug: docAddress(doc), version: doc.version, detail: { ttl: o.ttl ?? "24h", comments: !!o.comments } });
    return { url: withQuery(base, "cms_preview", token), token, version: doc.version, expiresAt: new Date(exp).toISOString() };
  }

  /** Read the version a preview token points at (for the app's public page). */
  function previewPayload(token: string): { c: string; s: string; i?: string; v: number; exp: number; cm?: 1 } {
    if (!opts.previewSecret) throw fail("preview_disabled");
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig || !timingSafeEqual(sign(payload), sig)) throw fail("preview_invalid");
    let p: { c: string; s: string; i?: string; v: number; exp: number; cm?: 1 };
    try {
      p = JSON.parse(fromUtf8(fromBase64url(payload)));
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
    if (!doc || (p.i && doc.id !== p.i)) throw fail("not_found", { collection: p.c, slug: p.s });
    const v = await repo.getVersion(doc.id, p.v);
    if (!v) throw fail("version_not_found", { version: p.v });
    // Whoever holds the link reads as an anonymous visitor: fields hidden from readers stay hidden.
    const anon: Actor = { kind: "anonymous" };
    return { collection: p.c, slug: p.s, version: p.v, expiresAt: new Date(p.exp).toISOString(), doc: project(anon, p.c, doc, contentOf(v.snapshot), p.v), comments: !!p.cm };
  }

  // ── search ────────────────────────────────────────────────────────────────

  const index = { built: null as SearchIndex | null, dirty: true, stamp: "", checkedAt: 0, building: null as Promise<SearchIndex> | null };

  async function buildIndex(): Promise<SearchIndex> {
    model.forgetSnippets();
    const started = Date.now();
    const searchable = [...collections.values()].filter((c) => c.search?.enabled !== false).map((c) => c.slug);
    // Translations only where their collection is translated now (locales turned off later: sources only).
    const docs = (await repo.listDocs({ published: true })).filter((d) => searchable.includes(d.collection) && (!isTranslationDoc(d) || localized(d.collection)));
    const units: ReturnType<typeof unitsOf> = [];
    // 0.22.0: translations are searched in their own language, with the source's shared fields.
    const shown = await fillShared(docs.map(publicView).filter((d): d is CmsDoc => !!d), false);
    for (const p of shown) {
      // 0.21.0: what readers see, snippets filled in.
      const body = p.body.includes("[[snippet:") ? await model.expandSnippets(p.body) : p.body;
      units.push(...unitsOf({ ...p, body, publishedAt: p.publishedAt, locale: localized(p.collection) ? p.locale || defaultLocale : undefined }));
    }
    const built = new SearchIndex(units);
    telemetry({ type: "index", ms: Date.now() - started, documents: docs.length, units: units.length });
    return built;
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
    // 0.22.0: one language at a time in localized collections (default: the default language).
    if (o.locale && !locales.includes(o.locale)) throw fail("locale_unknown", { locale: o.locale, locales: locales.join(", ") || "-" });
    const lang = locales.length ? (o.locale || defaultLocale) : undefined;
    const inLang = (u: SearchHit["unit"]) => !lang || !localized(u.collection) || (u.locale ?? defaultLocale) === lang;
    if (o.logGap !== undefined) warnOnce("logGap", "search option logGap was renamed to reportMiss in 0.6.0");
    const reportMiss = o.reportMiss ?? o.logGap ?? false;
    const started = Date.now();
    const idx = await searchIndex();
    const limit = Math.max(1, Math.min(o.limit ?? 5, 50));
    const ruled = (col: string) => { const c = collection(col); return !!(c.access?.read || c.fieldAccess); };
    const restricted = cols.some(ruled);
    // With per-document rules some hits will be dropped: rank more candidates, authorize, then cut,
    // so documents the reader may not see do not crowd out the ones they may.
    // The app's filter sees units of ruled collections only after they are authorized and projected
    // (below), never a unit the reader may not see.
    const raw = idx.search(query, { limit: restricted ? limit * 4 + 10 : limit + 3, perDoc: o.perDoc ?? 2, ...(lang ? { locale: lang } : {}), filter: (u) => cols.includes(u.collection) && inLang(u) && (ruled(u.collection) || !o.filter || o.filter(u)) });
    let hits = raw.filter((h) => h.coverage >= minCoverage);
    // The same read policy as a read: per-document `access.read` and hidden fields, judged on the
    // very copy the unit was cut from (same document id, same published version).
    if (restricted && hits.some((h) => ruled(h.unit.collection))) {
      const docs = await docsById(repo, [...new Set(hits.filter((h) => ruled(h.unit.collection)).map((h) => h.unit.docId))]);
      let stale = false;
      hits = hits.flatMap((h) => {
        if (!ruled(h.unit.collection)) return [h];
        const d = docs.get(h.unit.docId) ?? null;
        const pub = d && !d.deletedAt ? publicView(d) : null;
        if (!pub || pub.slug !== h.unit.slug || (h.unit.version !== undefined && pub.version !== h.unit.version)) {
          // The index is behind the database: drop the unit and rebuild.
          stale = true;
          return [];
        }
        if (!can(actor, h.unit.collection, "read", pub)) return [];
        // The rules judge the published copy itself (its format, version and fields); a search unit
        // carries only some of them.
        const unit = projectWith(hiddenPaths(actor, h.unit.collection, pub), h.unit);
        if (o.filter && !o.filter(unit)) return [];
        return [{ ...h, unit }];
      });
      if (stale) index.dirty = true;
    }
    hits = hits.slice(0, limit);
    const empty = hits.length === 0;
    telemetry({ type: "search", ms: Date.now() - started, q: query.trim().slice(0, 200), hits: hits.length, collections: cols.length });
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
  const rolesCtx: Parameters<typeof createRoles>[0] = {
    repo,
    now,
    fail,
    audit,
    baseAdmin,
    ready: ensureSchema,
    users: opts.users,
    targets: () => [
      ...[...collections.values()].map((c) => ({ slug: c.slug, label: c.label, coded: [...(c.access?.write ? (["write"] as const) : []), ...(c.access?.publish ? (["publish", "delete"] as const) : []), ...(c.managed ? (["write", "publish", "delete"] as const) : [])] })),
      // 0.17.0: the media library as a target (`write` uploads and edits, `delete` moves and deletes), per store.
      ...Object.entries(opts.media?.stores ?? {}).map(([name, st]) => ({ slug: `media:${name}`, label: Object.keys(opts.media?.stores ?? {}).length > 1 ? `Media · ${name}` : "Media", coded: [...(st.access?.write ? (["write"] as const) : []), ...(st.access?.delete ? (["delete"] as const) : [])], media: true })),
      // 0.22.0: forms (read = see submissions, write = build forms, delete = delete submissions).
      ...(opts.forms ? [{ slug: "forms", label: "Forms", coded: [] as RoleOp[], ops: ["read", "write", "delete"] as RoleOp[] }] : []),
    ],
  };
  const roles = createRoles(rolesCtx);
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

  async function auditLog(actor: Actor, o: { cursor?: string | null; limit?: number } & Omit<AuditQuery, "before" | "limit"> = {}) {
    await ensureSchema();
    if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_audit");
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const time = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
    const entries = await repo.listAudit({ before: o.cursor ?? null, limit: limit + 1, action: o.action, actionPrefix: o.actionPrefix, outcome: o.outcome, actorKind: o.actorKind, actorId: o.actorId, who: o.who?.trim() || undefined, collection: o.collection, slug: o.slug, since: time(o.since), until: time(o.until) });
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
    overlay,
    diagnosticsFor,
    rulesPerDocument: (col: string) => {
      const c = collections.get(col);
      return !!(c?.access?.read || c?.access?.write || c?.access?.publish);
    },
    ready: ensureSchema,
    editable,
    conflict,
    publishIn,
    unpublishIn,
    changed,
    problems: async (doc, c, r, actor, version) => {
      const cfg = collection(doc.collection);
      const { diagnostics, content: normalized } = check(doc.collection, c);
      const files = await assets.checkDoc(cfg, c, assets.idsIn(cfg, doc), r);
      if (!actor) return [...diagnostics, ...files];
      // Each group judged on the copy its checker saw (normalized for the schema, as sent for files).
      return [...diagnosticsFor(actor, doc.collection, overlay(doc, normalized, version ?? doc.version), diagnostics), ...diagnosticsFor(actor, doc.collection, overlay(doc, c, version ?? doc.version), files)];
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
    viewDoc: async (actor, col, slug) => {
      const d = await repo.findDoc(col, slug);
      if (!d || !collections.has(col)) return null;
      if (can(actor, col, "write", d)) return { doc: conflictCopy(actor, col, d), hidden: hiddenPaths(actor, col, d) };
      const pub = publicView(d);
      return pub && can(actor, col, "read", pub) ? { doc: conflictCopy(actor, col, pub), hidden: hiddenPaths(actor, col, pub) } : null;
    },
    update: (actor, col, slug, input) => update(actor, col, slug, input),
    addToRelease: (actor, id, item) => flow.releases.add(actor, id, [item]),
    sendWebhook: (id, e) => outbox.send(id, e),
    options: opts.automations ?? {},
  });
  const formsOn = opts.forms ? (typeof opts.forms === "object" ? opts.forms : {}) : null;
  const forms = createForms({
    repo,
    now,
    fail,
    audit: (actor, action, detail) => audit(actor, action, { detail }),
    isAdmin,
    allows: (actor, op) => roles.allows(actor, "forms", op),
    ready: ensureSchema,
    report,
    options: formsOn,
    storage: () => {
      const stores = opts.media?.stores ?? {};
      const name = formsOn?.store ?? Object.keys(stores).find((n) => stores[n].visibility === "private");
      const st = name ? stores[name] : undefined;
      return st && st.visibility === "private" ? { name: name!, adapter: st.adapter } : null;
    },
    limit: (bucket, perMinute) => limiter.check(bucket, perMinute),
    emit: (detail) => emitEvent({ event: "form.submitted", actor: null, collection: null, slug: null, version: null, url: null, detail }),
    message: (code, params) => formatMessage(messages, code, params),
  });
  if (formsOn?.store && !forms.uploadsReady()) warnOnce("forms-store", `[agent-cms] forms.store "${formsOn.store}" is not a private media store: file fields will refuse files`);
  const retention = createRetention({
    repo,
    options: opts.retention ?? {},
    now,
    timeZone,
    dayIn,
    redirects: !!opts.redirects,
    forms: !!opts.forms,
    purgeSubmissions: (before) => forms.purgeBefore(before),
    assertAdmin: (actor) => {
      if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_admin");
    },
    audit: (actor, detail) => audit(actor, "retention.run", { detail }),
  });
  const stats = createStats({ repo, now, dayOf: (d) => dayIn(timeZone, d), ready: ensureSchema, collections: () => [...collections.keys()], can, counts, isAdmin, generation: () => writeGen, publicView: fallbackView, rulesPerDocument: (c: string) => { const x = collections.get(c); return !!(x?.access?.read || x?.access?.write || x?.access?.publish); } });

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
    project,
    publicView,
    hidden: (actor: Actor, col: string, doc: CmsDoc) => hiddenPaths(actor, col, doc),
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
    assert(actor, col, "write", cur);
    const proposed = validateLoose(col, merged(cur, input));
    const checks = checksFor(actor, col, overlay(cur, proposed, cur.version), await appChecks(col, slug, proposed));
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

  /** Wrap a write so the document it returns is projected for the actor who asked. */
  /** The state of a document and nothing of its content: what a caller who may change but not read it gets back. */
  function receipt(d: CmsDoc): CmsDoc {
    return {
      receipt: true,
      id: d.id,
      collection: d.collection,
      slug: d.slug,
      title: "",
      summary: "",
      body: "",
      fields: {},
      keywords: [],
      category: null,
      status: d.status,
      version: d.version,
      publishedVersion: d.publishedVersion,
      published: null,
      publishedAt: d.publishedAt,
      republishedAt: d.republishedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      updatedBy: null,
      updatedByKind: null,
      updatedByAgent: null,
      autosave: null,
      deletedAt: d.deletedAt,
      deletedBy: null,
      schedule: null,
      dueAt: null,
      review: null,
    } as unknown as CmsDoc;
  }
  function shown<A extends [Actor, string, ...unknown[]], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    const isDoc = (d: unknown): d is CmsDoc => !!d && typeof d === "object" && "collection" in d && "fields" in d && "slug" in d;
    // What the caller may receive is decided apart from what they were allowed to do: someone who
    // may publish but not edit gets the published copy if they may read it, else only the state.
    const forCaller = (actor: Actor, d: CmsDoc): CmsDoc => {
      if (!collections.has(d.collection) || can(actor, d.collection, "write", d)) return conflictCopy(actor, d.collection, d);
      // Not an editable copy: only the state, with the working version (what a next write is
      // checked against). Readers fetch the published copy with a read.
      return receipt(d);
    };
    return async (...a: A) => {
      const out = await fn(...a);
      if (isDoc(out)) return forCaller(a[0], out) as unknown as R;
      // `{ doc, … }` (patch and friends): the document inside.
      if (out && typeof out === "object" && isDoc((out as { doc?: unknown }).doc)) {
        const d = forCaller(a[0], (out as unknown as { doc: CmsDoc }).doc);
        // A receipt says nothing of the content: a diff of the saved body would.
        return { ...(out as object), doc: d, ...(d.receipt && "diff" in (out as object) ? { diff: "" } : {}) } as unknown as R;
      }
      return out;
    };
  }

  // ── content model API (0.21.0) ─────────────────────────────────────────────

  /** Documents pointing at `id`, as `actor` may see them (one they may not read counts, without its name). */
  /**
   * Documents pointing at `id`. Writers of a source see its working-copy links; others only links in
   * what is published and readable. `forDelete`: every source counts (unreadable ones without a name).
   */
  async function refsShown(actor: Actor, id: string, o: { forDelete?: boolean } = {}): Promise<{ id: string | null; collection: string; slug: string; title: string; status: DocStatus | null; fields: string[] }[]> {
    const out: { id: string | null; collection: string; slug: string; title: string; status: DocStatus | null; fields: string[] }[] = [];
    for (const x of await model.referencedBy(id)) {
      const d = x.doc;
      if (!collections.has(d.collection)) continue;
      const fieldsOk = (copy: CmsDoc, fs: string[]) => {
        const hidden = fieldRulesFor(actor, d.collection, copy).hidden;
        return fs.filter((f) => !isHiddenPath(hidden, f));
      };
      let entry: (typeof out)[number] | null = null;
      if (can(actor, d.collection, "write", d)) {
        const fs = (await readable(actor, d.collection, d.slug, true)) ? fieldsOk(d, x.draftFields) : [];
        if (fs.length) entry = { id: d.id, collection: d.collection, slug: d.slug, title: d.title, status: d.status, fields: fs };
      } else {
        const pub = publicView(d);
        const fs = pub ? fieldsOk(pub, x.publishedFields) : [];
        if (pub && fs.length && can(actor, d.collection, "read", pub) && (await readable(actor, d.collection, pub.slug))) entry = { id: d.id, collection: d.collection, slug: pub.slug, title: pub.title, status: pub.status, fields: fs };
      }
      if (entry) out.push(entry);
      else if (o.forDelete) out.push({ id: null, collection: d.collection, slug: "", title: "", status: null, fields: [] });
    }
    return out;
  }
  /** `beforeRead` hooks let this actor read the document. */
  async function readable(actor: Actor, col: string, slug: string, draft = false): Promise<boolean> {
    try {
      await beforeRead(actor, col, slug, draft);
      return true;
    } catch {
      return false;
    }
  }
  async function referencedBy(actor: Actor, col: string, slug: string) {
    await ensureSchema();
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw fail("not_found", { collection: col, slug });
    if (!can(actor, col, "write", cur)) {
      const pub = publicView(cur);
      if (!pub || !can(actor, col, "read", pub)) throw fail("not_found", { collection: col, slug });
    }
    return refsShown(actor, cur.id);
  }
  /** What `actor` may see of a document a relation points at. */
  const relatedView = (actor: Actor, draft: boolean) => async (d: CmsDoc): Promise<CmsDoc | null> => {
    if (!collections.has(d.collection)) return null;
    if (draft && can(actor, d.collection, "write", d)) return (await readable(actor, d.collection, d.slug, true)) ? d : null;
    const pub = publicView(d);
    return pub && can(actor, d.collection, "read", pub) && (await readable(actor, d.collection, pub.slug)) ? pub : null;
  };
  /** Related documents in place of ids for `paths` (`?expand=author,related`). */
  async function expandFields<T extends CmsDoc>(actor: Actor, doc: T, paths: readonly string[], draft = false): Promise<T> {
    if (!paths.length) return doc;
    return { ...doc, fields: await model.expand(doc.collection, doc.fields ?? {}, paths, relatedView(actor, draft)) };
  }
  /** The documents one relation field points at, in order (ones the reader may not see left out). */
  async function related(actor: Actor, col: string, slug: string, field: string, o: { draft?: boolean } = {}) {
    const doc = await get(actor, col, slug, o);
    const out = await model.expand(col, doc.fields ?? {}, [field], relatedView(actor, !!o.draft));
    const v = field.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), out);
    return (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean) as RelatedDoc[];
  }

  /** Move a document in its collection's tree (no new version). `before`: the sibling it goes in front of; null puts it last. */
  async function move(actor: Actor, col: string, slug: string, to: { parentId: string | null; before?: string | null }): Promise<CmsDoc> {
    await ensureSchema();
    if (!model.treeOf(col)) throw fail("tree_off", { collection: col });
    // Moves of one collection go one at a time: in this process by a queue, across processes by the
    // database's lock (`lockTree`, held until the transaction ends). Two opposite moves at once would
    // otherwise each pass the cycle check and together make a loop. That lock needs a transaction, so a
    // driver without them refuses moves (`transactions_required`) rather than move without the lock.
    const prev = treeQueue.get(col) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((res) => (release = res));
    const tail = prev.then(() => mine);
    treeQueue.set(col, tail);
    await prev;
    try {
      return await moveLocked(actor, col, slug, to);
    } finally {
      release();
      if (treeQueue.get(col) === tail) treeQueue.delete(col);
    }
  }
  const treeQueue = new Map<string, Promise<void>>();
  async function moveLocked(actor: Actor, col: string, slug: string, to: { parentId: string | null; before?: string | null }): Promise<CmsDoc> {
    const out = await loggedTx(async (r, log) => {
      await r.lockTree?.(col);
      const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug) ? await r.findDocById(slug) : null;
      const cur = byId && byId.collection === col && !byId.deletedAt ? byId : await r.findDoc(col, slug);
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "write", cur);
      const place = await model.placeIn(r, col, cur, to.parentId ?? null, to.before ?? null);
      const moved = await r.updateDoc(cur.id, { parentId: place.parentId, position: place.position, updatedAt: cur.updatedAt });
      if (!moved) throw fail("not_found", { collection: col, slug });
      if (actor.kind !== "anonymous") await log({ event: "doc.moved", actor: actorRef(actor), collection: col, slug, version: cur.version, url: urlOf(col, slug), detail: { parentId: place.parentId } });
      return moved;
    }, { atomic: true });
    audit(actor, "doc.move", { collection: col, slug, version: out.version, detail: { parentId: out.parentId ?? null } });
    invalidate(col);
    return out;
  }
  /** The tree of a collection. Readers get published documents; one that is not published is left out and its children move up. */
  async function tree(actor: Actor, col: string, o: { draft?: boolean } = {}): Promise<TreeNode[]> {
    await ensureSchema();
    if (!model.treeOf(col)) throw fail("tree_off", { collection: col });
    await beforeRead(actor, col, null, !!o.draft);
    const docs = await repo.listDocs({ collection: col, ...srcOnly() });
    const visible = (d: CmsDoc) => {
      if (o.draft && can(actor, col, "write", d)) return true;
      const pub = publicView(d);
      return !!pub && can(actor, col, "read", pub);
    };
    // A reader sees the published title and address.
    const shownDocs = docs.map((d) => (o.draft && can(actor, col, "write", d) ? d : { ...d, ...(publicView(d) ?? {}) }));
    return model.buildTree(shownDocs as CmsDoc[], visible);
  }
  /** Parents of a document, top first. */
  async function ancestors(actor: Actor, col: string, slug: string, o: { draft?: boolean } = {}): Promise<{ id: string; slug: string; title: string }[]> {
    const doc = await get(actor, col, slug, o);
    const all = new Map((await repo.listDocs({ collection: col, ...srcOnly() })).map((d) => [d.id, d]));
    const out: { id: string; slug: string; title: string }[] = [];
    const seen = new Set<string>();
    for (let p = doc.parentId ? all.get(doc.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? all.get(p.parentId) : undefined) {
      seen.add(p.id);
      const v = await relatedView(actor, !!o.draft)(p);
      if (v) out.unshift({ id: v.id, slug: v.slug, title: v.title });
    }
    return out;
  }

  // singles
  function singleCol(slug: string): AnyCollection {
    const c = collection(slug);
    if (!c.single) throw fail("unknown_collection", { collection: slug });
    return c;
  }
  /** The one document of a `defineSingle` collection. Before the first save: the schema's defaults (version 0). */
  async function single(actor: Actor, slug: string, o: { draft?: boolean } = {}): Promise<CmsDoc> {
    const cfg = singleCol(slug);
    await ensureSchema();
    const doc = await repo.findDoc(slug, SINGLE_SLUG);
    if (doc && (doc.publishedVersion !== null || (o.draft && can(actor, slug, "write", doc)))) return get(actor, slug, SINGLE_SLUG, o);
    assert(actor, slug, o.draft ? "write" : "read");
    await beforeRead(actor, slug, SINGLE_SLUG, !!o.draft);
    const parsed = cfg.fields?.safeParse({});
    const synthetic = prospectiveDoc(slug, { slug: SINGLE_SLUG, title: cfg.label, category: null, fields: parsed?.success ? (parsed.data as Record<string, unknown>) : {} });
    return o.draft ? synthetic : read(actor, synthetic, false);
  }
  /**
   * A complete document that does not exist yet (version 0, a draft nobody wrote): what `fieldAccess`
   * rules and similar callbacks look at before a document is made (a single's defaults, a template).
   */
  function prospectiveDoc(col: string, c: Partial<DocContent>): CmsDoc {
    const at = nowIso();
    return {
      id: "",
      collection: col,
      slug: c.slug ?? "",
      title: c.title ?? "",
      summary: c.summary ?? "",
      body: c.body ?? "",
      ...(c.format === "html" ? { format: "html" as const } : {}),
      category: c.category !== undefined ? c.category : (collection(col).categories?.[0] ?? null),
      keywords: c.keywords ?? [],
      fields: c.fields ?? {},
      ...(c.seo !== undefined ? { seo: c.seo } : {}),
      status: "draft",
      version: 0,
      publishedVersion: null,
      published: null,
      publishedAt: null,
      republishedAt: null,
      createdAt: at,
      updatedAt: at,
      updatedBy: null,
      updatedByKind: null,
      updatedByAgent: null,
      autosave: null,
      deletedAt: null,
      deletedBy: null,
      schedule: null,
      dueAt: null,
      review: null,
    };
  }
  /** Save the one document (made on the first save). */
  async function updateSingle(actor: Actor, slug: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    const cfg = singleCol(slug);
    await ensureSchema();
    const cur = await repo.findDoc(slug, SINGLE_SLUG);
    const { slug: _drop, ...rest } = input;
    // expectedVersion 0 (what single() says before the first save) means "create it".
    if (!cur) return create(actor, slug, { title: cfg.label, ...rest, slug: SINGLE_SLUG }, { ...o, expectedVersion: undefined });
    if (o.expectedVersion === 0) throw conflict(cur, 0, actor, slug);
    return update(actor, slug, SINGLE_SLUG, rest, o);
  }

  // templates
  type StoredTemplate = { label: string; description?: string; title?: string; summary?: string; body?: string; fields?: Record<string, unknown>; createdBy?: string | null; createdById?: string | null };
  const templateOf = (r: CmsRecord): DocTemplate => {
    const d = r.data as StoredTemplate;
    return { key: r.id, id: r.id, label: d.label, description: d.description, title: d.title, summary: d.summary, body: d.body, fields: d.fields, source: "admin", createdBy: d.createdBy ?? null, createdAt: r.createdAt };
  };
  /**
   * Templates for new documents: the collection's own, then the ones editors saved. Read rights are enough
   * to see the list (an agent with a read key may look), but only people who may write the collection get
   * the content (title, summary, body, fields), since a saved template may be a copy of a draft. Fields the
   * reader may not see (`fieldAccess`) are left out for them too. Anonymous readers get none.
   */
  async function templates(actor: Actor, col: string): Promise<DocTemplate[]> {
    await ensureSchema();
    if (actor.kind === "anonymous") throw fail("unauthorized");
    assert(actor, col, "read");
    const all = await allTemplates(col);
    if (!can(actor, col, "write")) return all.map(templateMeta);
    if (!collection(col).fieldAccess) return all;
    // The rules look at the draft the template would make (no address yet: slug "").
    return all.map((t) => (t.fields ? projectWith(hiddenPaths(actor, col, templateDraft(col, t, {})), t) : t));
  }
  async function allTemplates(col: string): Promise<DocTemplate[]> {
    const code = (collection(col).templates ?? []).map((t) => ({ ...t, source: "code" as const }));
    const saved = (await repo.listRecords({ kind: "template", scope: col, order: "asc", limit: 200 })).map(templateOf);
    return [...code, ...saved];
  }
  /** The new draft a template makes, with `input` over it. */
  function templateDraft(col: string, t: DocTemplate, input: DocInput): CmsDoc {
    return prospectiveDoc(col, {
      slug: collection(col).single ? SINGLE_SLUG : (input.slug ?? ""),
      title: input.title ?? t.title ?? "",
      summary: input.summary ?? t.summary ?? "",
      body: input.body ?? t.body ?? "",
      ...(input.format === "html" ? { format: "html" as const } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.keywords ? { keywords: input.keywords } : {}),
      fields: { ...(t.fields ?? {}), ...((input.fields as Record<string, unknown> | undefined) ?? {}) },
    });
  }
  /** What a reader without write access sees of a template: what it is called, not what is in it. */
  const templateMeta = (t: DocTemplate): DocTemplate => {
    const out: DocTemplate = { key: t.key, label: t.label, source: t.source ?? "code" };
    if (t.description !== undefined) out.description = t.description;
    if (t.icon !== undefined) out.icon = t.icon;
    if (t.id !== undefined) out.id = t.id;
    if (t.createdBy !== undefined) out.createdBy = t.createdBy;
    if (t.createdAt !== undefined) out.createdAt = t.createdAt;
    return out;
  };
  const TEMPLATE_LABEL_MAX = 80;
  function cleanTemplate(t: Partial<StoredTemplate>): StoredTemplate {
    const label = String(t.label ?? "").trim();
    if (!label || label.length > TEMPLATE_LABEL_MAX) throw fail("template_invalid", { reason: `label 1-${TEMPLATE_LABEL_MAX}` });
    const body = String(t.body ?? "");
    if (body.length > LIMITS.body) throw fail("template_invalid", { reason: "body" });
    return { label, description: String(t.description ?? "").slice(0, 200) || undefined, title: t.title ? String(t.title).slice(0, LIMITS.title) : undefined, summary: t.summary ? String(t.summary).slice(0, LIMITS.summary) : undefined, body, fields: t.fields && typeof t.fields === "object" ? structuredClone(t.fields) : undefined };
  }
  async function saveTemplate(actor: Actor, col: string, t: Partial<StoredTemplate>): Promise<DocTemplate> {
    await ensureSchema();
    assert(actor, col, "write");
    const who = actorRef(actor);
    const rec = await repo.insertRecord({ kind: "template", scope: col, key: null, at: nowIso(), data: { ...cleanTemplate(t), createdBy: who.label, createdById: who.id } });
    audit(actor, "template.create", { collection: col, detail: { id: rec.id, label: (rec.data as StoredTemplate).label } });
    return templateOf(rec);
  }
  async function ownTemplate(actor: Actor, col: string, id: string): Promise<CmsRecord> {
    await ensureSchema();
    assert(actor, col, "write");
    const rec = await repo.findRecord("template", id);
    if (!rec || rec.scope !== col) throw fail("template_not_found");
    const who = actorRef(actor);
    if (!isAdmin(actor) && actor.kind !== "system" && (rec.data as StoredTemplate).createdById !== who.id) throw fail("forbidden_template");
    return rec;
  }
  async function updateTemplate(actor: Actor, col: string, id: string, patch: Partial<StoredTemplate>): Promise<DocTemplate> {
    const rec = await ownTemplate(actor, col, id);
    const d = rec.data as StoredTemplate;
    const next = { ...cleanTemplate({ ...d, ...patch }), createdBy: d.createdBy ?? null, createdById: d.createdById ?? null };
    const out = await repo.updateRecord("template", id, { data: next, at: nowIso() });
    if (!out) throw fail("template_not_found");
    audit(actor, "template.update", { collection: col, detail: { id, label: next.label } });
    return templateOf(out);
  }
  async function deleteTemplate(actor: Actor, col: string, id: string): Promise<void> {
    await ownTemplate(actor, col, id);
    await repo.deleteRecords({ kind: "template", id });
    audit(actor, "template.delete", { collection: col, detail: { id } });
  }
  /** `input` over a template. Field values the schema no longer takes are dropped. */
  async function withTemplate(actor: Actor, col: string, input: DocInput, key: string): Promise<DocInput> {
    assert(actor, col, "write");
    const raw = (await allTemplates(col)).find((x) => x.key === key || x.id === key);
    if (!raw) throw fail("template_not_found");
    const cfg = collection(col);
    // Fields the writer may not read stay out of the copy; the rules look at the document being made.
    const t = cfg.fieldAccess && raw.fields ? projectWith(hiddenPaths(actor, col, templateDraft(col, raw, input)), raw) : raw;
    let fields: Record<string, unknown> = { ...(t.fields ?? {}) };
    if (cfg.fields && Object.keys(fields).length) {
      const parsed = cfg.fields.safeParse(fields);
      if (!parsed.success) for (const i of parsed.error.issues) if (i.path.length) delete fields[String(i.path[0])];
    }
    fields = { ...fields, ...((input.fields as Record<string, unknown> | undefined) ?? {}) };
    return { ...input, title: input.title ?? t.title, summary: input.summary ?? t.summary, body: input.body ?? t.body, fields };
  }

  // snippets
  /** Documents that use snippet `slug` (people with write access to the snippet's collection). */
  async function snippetUses(actor: Actor, col: string, slug: string) {
    await ensureSchema();
    if (!collection(col).snippets) throw fail("unknown_collection", { collection: col });
    assert(actor, col, "write");
    const docs = await model.snippetUsage(slug);
    return docs.filter((d) => collections.has(d.collection) && can(actor, d.collection, "write", d)).map((d) => ({ id: d.id, collection: d.collection, slug: d.slug, title: d.title, status: d.status }));
  }

  // redirects
  function assertRedirectAdmin(actor: Actor) {
    if (!model.redirectsOn()) throw fail("redirects_off");
    if (!isAdmin(actor) && actor.kind !== "system") throw fail("forbidden_redirects");
  }
  const redirectsApi = {
    enabled: () => model.redirectsOn(),
    /**
     * Every redirect with its visits over the last 30 days (`hits30d`, `daily` oldest first) and, for one
     * that follows a document, that document (`target`: null once it is gone).
     */
    async list(actor: Actor): Promise<RedirectListItem[]> {
      await ensureSchema();
      assertRedirectAdmin(actor);
      const rows = await model.listRedirects();
      const series = await model.redirectHitSeries(30);
      const docs = await docsById(repo, [...new Set(rows.map((x) => x.toDocumentId).filter((x): x is string => !!x))]);
      return rows.map((x) => {
        const d = x.toDocumentId ? docs.get(x.toDocumentId) : undefined;
        const s = series.get(x.id);
        return {
          ...x,
          hits30d: s?.total ?? 0,
          daily: s?.daily ?? new Array<number>(30).fill(0),
          target: d && !d.deletedAt && collections.has(d.collection) ? { id: d.id, collection: d.collection, slug: d.published?.slug ?? d.slug, title: d.published?.title ?? d.title, published: d.publishedVersion !== null && d.status !== "archived" } : null,
        };
      });
    },
    /** Visits of one redirect per day over the last `days` days (at most 90), oldest first. */
    async hits(actor: Actor, id: string, o: { days?: number } = {}): Promise<{ days: { day: string; n: number }[]; total: number }> {
      await ensureSchema();
      assertRedirectAdmin(actor);
      if (!(await model.listRedirects()).some((x) => x.id === id)) throw fail("redirect_not_found");
      const n = Math.min(90, Math.max(1, Math.floor(o.days ?? 30)));
      const s = (await model.redirectHitSeries(n)).get(id);
      const today = dayIn(timeZone, now());
      return { days: Array.from({ length: n }, (_, i) => ({ day: addDays(today, i - (n - 1)), n: s?.daily[i] ?? 0 })), total: s?.total ?? 0 };
    },
    /** `toDocumentId`: follow that document's current public address (`to` is then ignored). */
    async create(actor: Actor, input: { from: string; to?: string; toDocumentId?: string | null; status?: 301 | 302 }) {
      await ensureSchema();
      assertRedirectAdmin(actor);
      const out = await repo.tx((r) => model.saveRedirect(r, { from: input.from, to: input.to ?? "", toDocumentId: input.toDocumentId || null, status: input.status === 302 ? 302 : 301, source: "manual", createdBy: actorRef(actor).label }));
      model.forgetRedirects();
      audit(actor, "redirect.create", { detail: { id: out.id, from: out.from, to: out.to, ...(out.toDocumentId ? { toDocumentId: out.toDocumentId } : {}) } });
      return out;
    },
    /** A new `to` stops following a document; a new `toDocumentId` starts (null: back to the address in `to`). */
    async update(actor: Actor, id: string, patch: { from?: string; to?: string; toDocumentId?: string | null; status?: 301 | 302 }) {
      await ensureSchema();
      assertRedirectAdmin(actor);
      const cur = (await model.listRedirects()).find((x) => x.id === id);
      if (!cur) throw fail("redirect_not_found");
      const toDocumentId = patch.toDocumentId !== undefined ? patch.toDocumentId || null : patch.to !== undefined ? null : cur.toDocumentId;
      const out = await repo.tx((r) => model.saveRedirect(r, { id, from: patch.from ?? cur.from, to: patch.to ?? cur.to, status: patch.status ?? cur.status, toDocumentId, source: "manual", createdBy: cur.createdBy }));
      model.forgetRedirects();
      audit(actor, "redirect.update", { detail: { id, from: out.from, to: out.to, ...(out.toDocumentId ? { toDocumentId: out.toDocumentId } : {}) } });
      return out;
    },
    async remove(actor: Actor, id: string) {
      await ensureSchema();
      assertRedirectAdmin(actor);
      const cur = (await model.listRedirects()).find((x) => x.id === id);
      if (!cur) throw fail("redirect_not_found");
      await repo.deleteRedirect!(id);
      model.forgetRedirects();
      audit(actor, "redirect.delete", { detail: { id, from: cur.from } });
    },
    /** Where an old address goes now (public; counts the visit). */
    resolve: (path: string) => model.resolveRedirect(path),
    /** Write the visits counted so far now instead of within the minute (before a shutdown, in tests). */
    flushHits: () => model.flushHits(),
  };

  type SeoSource = Pick<CmsDoc, "collection" | "slug" | "title" | "summary" | "body"> & { seo?: DocSeo | null };
  /**
   * Search engine details: `seoFor(doc)` fills the gaps of a document you already read (no rules are
   * asked: it is your copy); `seoFor(actor, col, slug)` reads it first as `actor` would.
   */
  function seoFor(doc: SeoSource): ReturnType<CmsModel["seoFor"]>;
  function seoFor(actor: Actor, col: string, slug: string, o?: { draft?: boolean }): Promise<ReturnType<CmsModel["seoFor"]>>;
  function seoFor(a: Actor | SeoSource, col?: string, slug?: string, o: { draft?: boolean } = {}): ReturnType<CmsModel["seoFor"]> | Promise<ReturnType<CmsModel["seoFor"]>> {
    if (col === undefined && "collection" in a) return model.seoFor(a);
    return get(a as Actor, col!, slug!, o).then((doc) => model.seoFor(doc));
  }
  /** An address for a title (`slugs.hangul`: romanized by default). Taken addresses get -2, -3… */
  async function suggestSlug(actor: Actor, col: string, title: string): Promise<string> {
    await ensureSchema();
    assert(actor, col, "write");
    const mode = opts.slugs?.hangul ?? "romanize";
    let text = String(title ?? "").trim().slice(0, 200);
    // "off": no suggestion for Korean titles (people type the address).
    if (mode === "off" && /[\uac00-\ud7a3]/.test(text)) return "";
    if (/[\uac00-\ud7a3]/.test(text) && mode === "romanize") {
      const { romanize } = await import("es-hangul");
      text = text.replace(/[\uac00-\ud7a3]+/g, (w) => ` ${romanize(w)} `);
    }
    const keep = mode === "keep" ? "\\uac00-\\ud7a3" : "";
    let base = text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFC")
      .toLowerCase()
      .replace(new RegExp(`[^a-z0-9${keep}]+`, "g"), "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "");
    if (!base) base = "untitled";
    for (let n = 1; n < 100; n++) {
      const s = n === 1 ? base : `${base}-${n}`;
      if (!(await repo.findDoc(col, s, { trashed: true }))) return s;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  const api = {
    collections: () => [...collections.values()],
    collection,
    /** Whether the collection's rules decide per document who may read, edit or publish (`access`). */
    rulesPerDocument: (col: string) => {
      const c = collections.get(col);
      return !!(c?.access?.read || c?.access?.write || c?.access?.publish);
    },
    can,
    isAdmin,
    get,
    list,
    page,
    counts,
    versions,
    versionList,
    versionPage,
    version,
    diff,
    diagnose,
    // What a write returns goes to the caller: the same field projection as a read (0.18.0).
    // Internal callers (import, files, flow) keep the stored row.
    create: shown(create),
    update: shown(update),
    patch: shown(patch),
    sections,
    autosave: shown(autosave),
    discardAutosave: shown(discardAutosave),
    publish: shown(publish),
    archive: shown(archive),
    unarchive: shown(unarchive),
    unpublish: shown(unpublish),
    restore: shown(restore),
    remove,
    bulk,
    // 0.22.0 multilingual documents
    /** Languages (`createCms({ locales })`, empty when off) and the one translations are made from. */
    locales: locales as readonly string[],
    defaultLocale,
    /** Whether a collection is translated. */
    localized,
    /** Fields of a collection with whether translations have their own value (true) or share the source's (false). */
    translatableFields: (col: string) => ({ ...translatable(col) }),
    /** How to name a document in a language wherever a slug is taken: `slug@en` for a translation, the slug for the source. */
    address: (col: string, slug: string, locale?: string | null, o: { write?: boolean } = {}) => address(col, slug, locale, o),
    translations,
    markAligned: shown(markAligned),
    sourceDiff,
    // 0.21.0 content model
    /** Relation fields of a collection: path, target collections, many. */
    collectionRelations: (col: string) => model.relationFields(col).map(([path, m]) => ({ path, collections: m.collections, many: m.many })),
    referencedBy,
    related,
    expand: expandFields,
    move: shown(move),
    tree,
    ancestors,
    single,
    updateSingle: shown(updateSingle),
    templates,
    saveTemplate,
    updateTemplate,
    deleteTemplate,
    snippetUses,
    redirects: redirectsApi,
    /** Forms (0.22.0): definitions, the public form and submissions. See `src/forms.ts`. */
    forms,
    /** Where an old address goes now (the plan's name for `redirects.resolve`; public, counts the visit). */
    resolveRedirect: (path: string) => model.resolveRedirect(path),
    videoHosts: model.videoHosts as readonly string[],
    seoFor,
    /** `seoFor(doc)` under its 0.21.0 first-pass name. */
    seoOf: (doc: SeoSource) => model.seoFor(doc),
    sitemap: (origin: string, o: { collections?: readonly string[]; page?: number | null; self?: string } = {}) => Promise.resolve(ensureSchema()).then(() => model.sitemap(origin, o)),
    suggestSlug,
    /** Old heading anchors by current anchor (public renders keep old links working). */
    anchorAliases: (documentId: string) => model.aliasMap(documentId),
    resolveAnchor: (documentId: string, anchor: string, body: string) => model.resolveAnchor(documentId, anchor, body),
    expandSnippets: (body: string) => model.expandSnippets(body),
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
    subscribe(fn: (e: FeedEvent) => void): () => void {
      subscribers.add(fn);
      keepFollowing();
      return () => {
        subscribers.delete(fn);
        keepFollowing();
      };
    },
    /**
     * The change log (0.17.0): `since(actor, seq)` lists what `actor` may hear after `seq`, oldest
     * first; `last()` is the newest number. `null` from `since` means `seq` is older than what the
     * log keeps: reload everything.
     */
    changes: {
      async last(): Promise<number> {
        await ensureSchema();
        return (await repo.lastChange?.()) ?? 0;
      },
      /**
       * Where live delivery stands (0.18.0): every numbered event up to the answer has been told,
       * in order, and every one after it will be. An events stream that subscribed first and
       * replays up to this number misses nothing and repeats nothing. `null` when this repo has
       * no readable log (events then carry no number).
       */
      async position(): Promise<number | null> {
        if (!canFollow() || follow.closed) return null;
        keepFollowing();
        // Any point the dispatcher has reached splits replay from live delivery correctly; it only
        // has to have started. Waiting is bounded: a stuck database gives a stream without numbers.
        if (delivered < 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([pullChanges(), new Promise<void>((done) => (timer = setTimeout(done, POSITION_WAIT_MS)))]);
          clearTimeout(timer);
        }
        return delivered < 0 || follow.closed ? null : delivered;
      },
      /** Whether change numbers are in commit order (see `CmsRepo.changesInCommitOrder`). */
      ordered,
      async since(actor: Actor, seq: number, o: { collections?: readonly string[]; limit?: number; until?: number; hear: (e: FeedEvent) => FeedEvent | boolean | null }): Promise<{ changes: ChangeEvent[]; last: number; more: boolean } | null> {
        await ensureSchema();
        if (!repo.changesSince) return { changes: [], last: 0, more: false };
        const limit = Math.max(1, Math.min(o.limit ?? 200, 1000));
        const out: ChangeEvent[] = [];
        let after = Math.max(0, Math.floor(seq));
        let first = true;
        for (;;) {
          const rows = await repo.changesSince(after, 500);
          if (first && seq > 0 && rows.length && rows[0].seq > after + 1) {
            // Rows after `seq` were pruned: the caller missed something it cannot get back.
            const oldest = await repo.changesSince(0, 1);
            if (oldest.length && oldest[0].seq > after + 1) return null;
          }
          first = false;
          for (const r of rows) {
            if (o.until !== undefined && r.seq > o.until) return { changes: out, last: after, more: false };
            if (!ordered && r.seq !== after + 1 && Date.now() - Date.parse((r as { at?: string }).at ?? "") < GAP_WAIT_MS) return { changes: out, last: after, more: true };
            after = r.seq;
            const heard = o.hear(rowEvent(r));
            if (!heard) continue;
            // `hear` may return a reduced copy (no document identity) instead of `true`.
            const e = heard === true ? rowEvent(r) : heard;
            out.push({ seq: r.seq, at: (r as { at?: string }).at ?? "", event: r.event, collection: r.collection, slug: e.slug ?? null, version: e.version ?? null, url: e.url ?? null, actor: (e.actor as ChangeEvent["actor"]) ?? null, ...(e.detail ? { detail: e.detail } : {}), ...(e.locale ? { locale: e.locale } : {}) });
            if (out.length >= limit) return { changes: out, last: r.seq, more: true };
          }
          if (rows.length < 500) return { changes: out, last: Math.max(after, seq), more: false };
        }
      },
    },
    /**
     * Waits for writes that run after a response (the change log, webhook queueing) and stops
     * following other servers. Call before closing the database or ending the process.
     */
    async settle(): Promise<void> {
      follow.closed = true;
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      // A read of the log that was already running finishes (it tells nobody once closed).
      if (pulling) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([pulling.catch(() => {}), new Promise<void>((done) => (timer = setTimeout(done, POSITION_WAIT_MS)))]);
        clearTimeout(timer);
      }
      if (follow.timer) clearTimeout(follow.timer);
      follow.timer = null;
      follow.unsignal?.();
      follow.unsignal = null;
      follow.listening = false;
    },
    /** Also hear what `onEvent` hears (requests, events, errors, cache, search). Returns the function that stops it. */
    onTelemetry(fn: (e: CmsTelemetry) => void): () => void {
      telemetryListeners.add(fn);
      return () => void telemetryListeners.delete(fn);
    },
    /** Field paths an actor may not see / not change (`fieldAccess`), for the admin form. */
    fieldRulesFor,
    /** Whether reads go through a cache (`createCms({ cache })`). */
    cacheOn: !!cacheStore,
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
      // One query for all of them (0.17.0), not one per document.
      const found = repo.findDocsByIds ? new Map((await repo.findDocsByIds([...byDoc.keys()])).map((d) => [d.id, d])) : null;
      for (const [id, versions] of byDoc) {
        if (out.length >= limit) break;
        const doc = found ? (found.get(id) ?? null) : await repo.findDocById(id);
        if (!doc || !collections.has(doc.collection) || (o.collections?.length && !o.collections.includes(doc.collection))) continue;
        if (can(actor, doc.collection, "write", doc)) out.push({ collection: doc.collection, slug: doc.slug, version: doc.version, at: doc.updatedAt });
        // Readers are judged on the public copy, like a read: a rule that looks at fields sees the published ones.
        else if (publicView(doc) && can(actor, doc.collection, "read", publicView(doc)!) && versions.includes(doc.publishedVersion as number)) out.push({ collection: doc.collection, slug: doc.slug, version: doc.publishedVersion as number, at: doc.updatedAt });
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
    schedule: shown(flow.schedule),
    unschedule: shown(flow.unschedule),
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
      const keepDays = Math.max(1, opts.changes?.keepDays ?? 7);
      const pruneChanges = repo.pruneChanges ? repo.pruneChanges(new Date(now().getTime() - keepDays * 86_400_000).toISOString()) : Promise.resolve(0);
      await Promise.all([jobs.prune(), outbox.prune(), retention.tick(), pruneChanges, forms.tick()]).catch((e) => report(e, "cron housekeeping"));
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
    requestReview: shown(flow.requestReview),
    approveReview: shown(flow.approveReview),
    rejectReview: shown(flow.rejectReview),
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
    labelVersion: async (actor: Actor, col: string, slug: string, n: number, o: { label?: string | null; pinned?: boolean }) => {
      const v = await flow.labelVersion(actor, col, slug, n, o);
      const doc = await repo.findDoc(col, slug);
      if (!doc) throw fail("not_found", { collection: col, slug });
      return withPublished(v, doc, actor);
    },
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
    /** For modules built on the core (sign-in): write to the audit log, the clock, errors, the schema check. */
    writeAudit: audit,
    now,
    fail,
    ready: ensureSchema,
    /** Where the roles screen finds people, when it is known only after `createCms` (the CMS's own sign-in). */
    useUsers(u: UsersOptions) {
      rolesCtx.users = u;
    },
    /** True when the roles screen has a list of people. */
    hasUsers: () => !!rolesCtx.users,
    /** The roles a person is in (for the people screen). */
    rolesOf: (userId: string, email?: string | null) => roles.of(userId, email),
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
  get<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: Parameters<CmsCore["get"]>[3]): Promise<TypedDoc<FieldsOf<C, N>>>;
  single<N extends CollectionName<C>>(actor: Actor, slug: N, o?: { draft?: boolean }): Promise<TypedDoc<FieldsOf<C, N>>>;
  list<N extends CollectionName<C>>(actor: Actor, col: N, o?: Parameters<CmsCore["list"]>[2]): Promise<TypedDoc<FieldsOf<C, N>>[]>;
  create<N extends CollectionName<C>>(actor: Actor, col: N, input: DocInput<FieldsOf<C, N>>, o?: WriteOptions): Promise<TypedDoc<FieldsOf<C, N>>>;
  update<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, input: DocInput<FieldsOf<C, N>>, o?: WriteOptions): Promise<TypedDoc<FieldsOf<C, N>>>;
  publish<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { version?: number; expectedVersion?: number; documentId?: string }): Promise<TypedDoc<FieldsOf<C, N>>>;
  /** Documents that point here make it answer 409 `doc_referenced` with their list, unless `force`. */
  archive<N extends CollectionName<C>>(actor: Actor, col: N, slug: string, o?: { expectedVersion?: number; force?: boolean }): Promise<TypedDoc<FieldsOf<C, N>>>;
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

/** Put `key=value` in a URL's query, before any #fragment, replacing an old value. Works for relative URLs. */
export function withQuery(url: string, key: string, value: string): string {
  const hash = url.indexOf("#");
  const [head, frag] = hash >= 0 ? [url.slice(0, hash), url.slice(hash)] : [url, ""];
  const q = head.indexOf("?");
  const [path, query] = q >= 0 ? [head.slice(0, q), head.slice(q + 1)] : [head, ""];
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${path}?${params.toString()}${frag}`;
}
