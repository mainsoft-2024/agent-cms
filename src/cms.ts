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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { z, ZodTypeAny } from "zod";
import { fieldChanges, hunks, splitLines, unifiedDiff, type FieldChange, type Hunk } from "./diff";
import { CmsError, formatMessage, isCmsError, type CmsErrorCode, type CmsErrorOptions, type Diagnostic, type ErrorParams, type Messages } from "./errors";
import { displayPrefix, generateKey, hashKey } from "./keys";
import { appLinkKeys } from "./markdown";
import { applyPatch, sectionRanges, type PatchOp } from "./patch";
import type { CmsRepo, DocPatch, StoredVersion } from "./repo";
import { SCHEMA_VERSION } from "./schema-version";
import { normalizeQuery, SearchIndex, unitsOf, type SearchHit } from "./search";
import {
  docState,
  type Actor,
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
  /** Display state (editors): draft, published (incl. modified), modified, archived. */
  state?: "draft" | "published" | "modified" | "archived";
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
    category: doc.category ?? null,
    keywords: [...(doc.keywords ?? [])],
    fields: structuredClone(doc.fields ?? {}),
  };
}

/** The untyped CMS (what the transports use). `createCms` returns it with typed overloads on top. */
export function createCmsCore(opts: CreateCmsOptions) {
  const repo = opts.repo;
  const now = opts.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const collections = new Map<string, AnyCollection>();
  const minCoverage = opts.minCoverage ?? 0.5;
  const refreshMs = opts.searchRefreshMs ?? 60_000;
  const messages = opts.messages;
  const report = opts.onError ?? ((err: unknown, where: string) => console.warn(`[agent-cms] ${where}:`, err));
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

  // ── schema handshake ──────────────────────────────────────────────────────

  let schemaReady: Promise<void> | null = null;
  function ensureSchema(): Promise<void> | void {
    if (opts.schemaCheck === false) return;
    schemaReady ??= (async () => {
      const raw = await repo.getMeta("schema_version");
      const found = raw == null ? null : Number(raw);
      if (found === null || !(found >= SCHEMA_VERSION)) {
        throw fail("schema_outdated", { found: found ?? 1, expected: SCHEMA_VERSION, command: "npx agent-cms migrate check" }, { status: 503 });
      }
    })().catch((e) => {
      schemaReady = null; // try again on the next call (after the migration ran)
      throw e;
    });
    return schemaReady;
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

  function can(actor: Actor, col: string, what: "read" | "write" | "publish", doc?: CmsDoc | null): boolean {
    const c = collection(col);
    if (actor.kind === "system") return true;
    if (c.managed && what !== "read") return false;
    if (actor.kind === "key") {
      if (!keyCovers(actor, col)) return false;
      return actor.scopes.includes(what) || actor.scopes.includes("admin") || (what === "read" && (actor.scopes.includes("write") || actor.scopes.includes("publish")));
    }
    if (what === "read") {
      if (c.access?.read) return c.access.read({ actor, collection: col, doc });
      return c.visibility === "public";
    }
    const fn = what === "write" ? c.access?.write : c.access?.publish;
    if (fn) return fn({ actor, collection: col, doc });
    return actor.kind === "user" && actor.isAdmin;
  }

  function assert(actor: Actor, col: string, what: "read" | "write" | "publish", doc?: CmsDoc | null) {
    if (can(actor, col, what, doc)) return;
    if (actor.kind !== "anonymous" && what !== "read") audit(actor, "access.denied", { collection: col, slug: doc?.slug ?? null, outcome: "denied", detail: { need: what } });
    if (actor.kind === "anonymous") throw fail("unauthorized");
    throw fail(what === "publish" ? "forbidden_publish" : what === "write" ? "forbidden_write" : "forbidden_read", { collection: col });
  }

  /** Who to record as the author. `agent` is the agent acting for a person, when there is one. */
  function actorRef(actor: Actor): { kind: "user" | "key" | "system"; id: string | null; label: string; agent: string | null } {
    if (actor.kind === "user") return { kind: "user", id: actor.id, label: actor.label, agent: actor.agent?.label?.trim() || null };
    if (actor.kind === "key") return { kind: "key", id: actor.id, label: actor.label, agent: null };
    if (actor.kind === "system") return { kind: "system", id: null, label: actor.label, agent: null };
    throw fail("unauthorized");
  }

  // ── validation ────────────────────────────────────────────────────────────

  /** Every problem with `c` at once (and the cleaned content). */
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
    return { content: out, diagnostics: diags };
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
    const other = content.slug ? await repo.findDoc(col, content.slug) : null;
    if (other && other.id !== cur?.id) diagnostics.push({ path: "slug", code: "slug_taken", params: { slug: content.slug }, severity: "error", message: formatMessage(messages, "slug_taken", { slug: content.slug }) });
    return diagnostics;
  }

  const same = (a: DocContent, b: DocContent) => stableJson(contentOf(a)) === stableJson(contentOf(b));

  function merged(cur: DocContent, input: DocInput): DocContent {
    return {
      slug: input.slug ?? cur.slug,
      title: input.title ?? cur.title,
      summary: input.summary ?? cur.summary,
      body: input.body ?? cur.body,
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
    if (o.draft && can(actor, col, "write", doc)) return doc;
    assert(actor, col, "read", doc);
    const pub = publicView(doc);
    if (!pub) throw fail("not_found", { collection: col, slug });
    return pub;
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
    const out: DocCounts = { all: 0, draft: 0, published: 0, modified: 0, archived: 0 };
    for (const d of await repo.listDocs({ collection: col })) {
      const s = docState(d);
      out.all++;
      out[s.state]++;
      if (s.modifiedSincePublish) out.modified++;
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
  function changed(prev: CmsDoc | null, doc: CmsDoc | null) {
    const target = doc ?? prev;
    if (!target) return;
    const info: ChangeInfo = { contentChanged: publicSig(prev) !== publicSig(doc) };
    if (info.contentChanged) index.dirty = true;
    for (const l of listeners) {
      try {
        l(target, info);
      } catch (e) {
        report(e, "onChange");
      }
    }
    for (const h of collection(target.collection).hooks?.afterChange ?? []) {
      Promise.resolve()
        .then(() => h(target, info))
        .catch((e) => report(e, "afterChange"));
    }
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

  async function create(actor: Actor, col: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    await ensureSchema();
    assert(actor, col, "write");
    if (o.publish) assert(actor, col, "publish");
    const who = actorRef(actor);
    const cfg = collection(col);
    const content = validate(col, {
      slug: input.slug ?? "",
      title: input.title ?? "",
      summary: input.summary ?? "",
      body: input.body ?? "",
      category: input.category ?? cfg.categories?.[0] ?? null,
      keywords: input.keywords ?? [],
      fields: (input.fields as Record<string, unknown>) ?? {},
    });
    const at = nowIso();
    const doc = await repo.tx(async (r) => {
      if (await r.findDoc(col, content.slug)) throw fail("slug_taken", { slug: content.slug });
      const publish = !!o.publish;
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
    if (next.slug !== doc.slug && doc.publishedVersion !== null) throw fail("slug_locked");
    if (next.slug !== doc.slug && (await r.findDoc(doc.collection, next.slug))) throw fail("slug_taken", { slug: next.slug });

    const inPlace = cfg.versions?.drafts === false && doc.publishedVersion !== null && doc.status !== "archived";
    const publish = !!o.publish || inPlace;
    const wasPublic = doc.publishedVersion !== null && doc.status !== "archived";
    let patch: DocPatch = { ...next, version: v, updatedBy: who.label, updatedByKind: who.kind, updatedByAgent: who.agent, updatedAt: at, autosave: null };
    if (publish) {
      patch = { ...patch, status: "published", publishedVersion: v, published: next, publishedAt: doc.publishedAt ?? at };
      if (!wasPublic && doc.publishedAt) patch.republishedAt = at;
    } else patch = { ...patch, status: doc.status === "archived" ? "archived" : "draft" };

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
      const next = validate(col, merged(cur, make(cur)));
      if (same(next, cur)) {
        // Nothing changed. Still honour "publish".
        if (o.publish && cur.publishedVersion !== cur.version) return publishIn(r, actor, cur, cur.version);
        return cur.autosave ? ((await r.updateDoc(cur.id, { autosave: null, updatedAt: cur.updatedAt })) ?? cur) : cur;
      }
      return commit(r, actor, cur, next, o);
    });
    if (o.publish && doc.publishedVersion === doc.version && prev && (prev as CmsDoc).publishedVersion !== doc.version) audit(actor, "doc.publish", { collection: col, slug: doc.slug, version: doc.version });
    changed(prev, doc);
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

  async function publishIn(r: CmsRepo, actor: Actor, doc: CmsDoc, n: number): Promise<CmsDoc> {
    const v = n === doc.version ? { snapshot: contentOf(doc) } : await r.getVersion(doc.id, n);
    if (!v) throw fail("version_not_found", { version: n });
    const at = nowIso();
    const wasPublic = doc.publishedVersion !== null && doc.status !== "archived";
    const updated = await r.updateDoc(doc.id, {
      status: n === doc.version ? "published" : "draft",
      publishedVersion: n,
      published: v.snapshot,
      publishedAt: doc.publishedAt ?? at,
      ...(!wasPublic && doc.publishedAt ? { republishedAt: at } : {}),
      updatedAt: at,
      updatedBy: actorRef(actor).label,
      updatedByKind: actorRef(actor).kind,
      updatedByAgent: actorRef(actor).agent,
    });
    if (!updated) throw fail("not_found", { collection: doc.collection, slug: doc.slug });
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
    const doc = await stateChange(actor, col, slug, o.expectedVersion, (r, cur) => publishIn(r, actor, cur, o.version ?? cur.version));
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

  /**
   * Take a document off the public site and back to draft. Its versions stay;
   * the first publish time is kept, so publishing again doesn't re-date it.
   */
  async function unpublish(actor: Actor, col: string, slug: string, o: { expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await stateChange(actor, col, slug, o.expectedVersion, async (r, cur) => {
      if (cur.publishedVersion === null && cur.status !== "archived") return cur;
      const who = actorRef(actor);
      return (await r.updateDoc(cur.id, { status: "draft", publishedVersion: null, published: null, updatedAt: nowIso(), updatedBy: who.label, updatedByKind: who.kind, updatedByAgent: who.agent }))!;
    });
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
    assert(actor, col, "publish", cur);
    if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw conflict(cur, o.expectedVersion, actor, col);
    await repo.deleteDoc(cur.id);
    audit(actor, "doc.delete", { collection: col, slug, version: cur.version });
    changed(cur, null);
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
  async function createPreviewLink(actor: Actor, col: string, slug: string, o: { ttl?: PreviewTtl } = {}): Promise<PreviewLink> {
    if (!opts.previewSecret) throw fail("preview_disabled");
    const cfg = collection(col);
    if (!cfg.url) throw fail("no_public_url");
    const doc = await editable(actor, col, slug);
    const ttl = PREVIEW_TTLS[o.ttl ?? "24h"];
    if (!ttl) throw fail("invalid_request", { issues: `ttl: ${o.ttl}` });
    const exp = now().getTime() + ttl;
    const payload = b64url(JSON.stringify({ c: col, s: doc.slug, v: doc.version, exp }));
    const token = `${payload}.${sign(payload)}`;
    const base = cfg.url({ slug: doc.slug });
    audit(actor, "preview.create", { collection: col, slug: doc.slug, version: doc.version, detail: { ttl: o.ttl ?? "24h" } });
    return { url: `${base}${base.includes("?") ? "&" : "?"}cms_preview=${token}`, token, version: doc.version, expiresAt: new Date(exp).toISOString() };
  }

  /** Read the version a preview token points at (for the app's public page). */
  async function readPreview(token: string): Promise<PreviewRead> {
    if (!opts.previewSecret) throw fail("preview_disabled");
    await ensureSchema();
    const [payload, sig] = String(token).split(".");
    const good = payload && sig ? Buffer.from(sign(payload)) : null;
    if (!good || good.length !== Buffer.from(sig).length || !timingSafeEqual(good, Buffer.from(sig))) throw fail("preview_invalid");
    let p: { c: string; s: string; v: number; exp: number };
    try {
      p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw fail("preview_invalid");
    }
    if (!(p.exp > now().getTime())) throw fail("preview_expired");
    collection(p.c);
    const doc = await repo.findDoc(p.c, p.s);
    if (!doc) throw fail("not_found", { collection: p.c, slug: p.s });
    const v = await repo.getVersion(doc.id, p.v);
    if (!v) throw fail("version_not_found", { version: p.v });
    return { collection: p.c, slug: p.s, version: p.v, expiresAt: new Date(p.exp).toISOString(), doc: contentOf(v.snapshot) };
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

  const isAdmin = (actor: Actor) => actor.kind === "system" || (actor.kind === "user" && actor.isAdmin) || (actor.kind === "key" && actor.scopes.includes("admin"));

  function assertKeyAdmin(actor: Actor) {
    if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_keys");
  }

  const toKey = (k: CmsKey & { hash?: string }): CmsKey => ({
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

  async function createKey(actor: Actor, input: { name: string; scopes: KeyScope[]; collections?: string[] | null; expiresAt?: string | null }) {
    await ensureSchema();
    assertKeyAdmin(actor);
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
    audit(actor, "key.create", { detail: { key: row.id, name, scopes: row.scopes, collections: row.collections, expiresAt } });
    return { key: toKey(row), secret: raw };
  }

  async function listKeys(actor: Actor): Promise<CmsKey[]> {
    await ensureSchema();
    assertKeyAdmin(actor);
    return (await repo.listKeys()).map(toKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function revokeKey(actor: Actor, id: string) {
    assertKeyAdmin(actor);
    if (!(await repo.revokeKey(id, nowIso()))) throw fail("key_not_found");
    audit(actor, "key.revoke", { detail: { key: id } });
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
    if (row.revokedAt) {
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

  return {
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
    search,
    recordHits,
    hitCounts,
    createKey,
    listKeys,
    revokeKey,
    authenticateKey,
    audit: auditLog,
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

