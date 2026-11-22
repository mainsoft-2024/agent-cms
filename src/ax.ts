/**
 * Editing documents the way coding agents edit code (0.15.0): read with line
 * numbers, search many documents, replace unique text, write a whole file,
 * fetch or send a file through a short-lived link, and — when a collection
 * says `agentEdits: "suggest"` — keep an agent's edit as a suggestion that a
 * person applies or rejects.
 *
 * One way for every kind of content: markdown bodies, HTML blocks, HTML
 * documents and fields (frontmatter lines) are all lines of one file.
 */
import { base64url, randomBytes } from "./crypto";
import type { CmsErrorCode, CmsErrorOptions, ErrorParams } from "./errors";
import { isCmsError } from "./errors";
import type { CmsRepo } from "./repo";
import type { Actor, AuditAction, CmsDoc, CollectionConfig, Diagnostic } from "./types";
import type { ZodTypeAny } from "zod";
import {
  applyEdits,
  docFile,
  docPath,
  fileToInput,
  FileError,
  globMatch,
  grepText,
  lineMatcher,
  lineOfKey,
  numberLines,
  outline,
  snippets,
  type GrepLine,
  type OutlineItem,
  type TextEdit,
} from "./doc-files";

type AnyCollection = CollectionConfig<ZodTypeAny | undefined, string>;
type Input = Record<string, unknown> & { format?: "markdown" | "html" };

export interface AxContext {
  repo: CmsRepo;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  ready: () => void | Promise<void>;
  nowIso: () => string;
  collection: (slug: string) => AnyCollection;
  collections: () => string[];
  can: (actor: Actor, col: string, what: "read" | "write" | "publish" | "delete", doc?: CmsDoc | null) => boolean;
  assert: (actor: Actor, col: string, what: "read" | "write" | "publish" | "delete", doc?: CmsDoc | null) => void;
  /** Remove fields `actor` may not see from a copy of `doc` (the same projection reads use). */
  project?: <T extends { fields?: Record<string, unknown> } | null | undefined>(actor: Actor, col: string, doc: CmsDoc | null, content: T) => T;
  /** Field paths `actor` may not see in the stored document (`fieldAccess`). */
  hidden?: (actor: Actor, col: string, doc: CmsDoc) => string[];
  get: (actor: Actor, col: string, slug: string, o?: { draft?: boolean }) => Promise<CmsDoc>;
  create: (actor: Actor, col: string, input: Input, o?: { note?: string }) => Promise<CmsDoc>;
  update: (actor: Actor, col: string, slug: string, input: Input, o?: { expectedVersion?: number; note?: string }) => Promise<CmsDoc>;
  actorRef: (actor: Actor) => { kind: "user" | "key" | "system"; id: string | null; label: string; agent: string | null };
  audit: (actor: Actor, action: AuditAction, o?: { collection?: string | null; slug?: string | null; version?: number | null; detail?: Record<string, unknown> }) => void;
}

export interface ReadResult {
  path: string;
  collection: string;
  slug: string;
  version: number;
  format: "markdown" | "html";
  /** True when this is the working copy (drafts included); false for the published copy. */
  draft: boolean;
  totalLines: number;
  from: number;
  to: number;
  /** Where the next page starts (null at the end). If `version` changes between pages, start again. */
  nextOffset: number | null;
  /** `N→text` lines. */
  content: string;
  outline?: OutlineItem[];
}

export interface GrepMatch extends GrepLine {
  path: string;
  collection: string;
  slug: string;
}

export interface GrepResult {
  output: "lines" | "files" | "count";
  matches: GrepMatch[];
  files: { path: string; count: number }[];
  count: number;
  /** True when the search stopped early (time, size or `limit`); narrow it and search again. */
  partial: boolean;
  searched: number;
}

export interface EditResult {
  path: string;
  collection: string;
  slug: string;
  /** The version after the edit (unchanged when it was kept as a suggestion). */
  version: number;
  saved: boolean;
  /** Lines around each change in the new file. */
  snippet: string;
  changed: { from: number; to: number }[];
  counts: number[];
  /** Set when the collection keeps agents' edits as suggestions. */
  suggestion?: Suggestion;
  /** True for `dryRun`: nothing was saved. */
  dryRun?: boolean;
}

export interface Suggestion {
  id: string;
  collection: string;
  slug: string;
  baseVersion: number;
  edits: TextEdit[];
  note: string | null;
  by: { kind: "user" | "key" | "system"; label: string; agent: string | null };
  at: string;
  /** Lines of the file the suggestion changes (in the version it was made on). */
  lines: { from: number; to: number }[];
}

export interface RawLink {
  url: string;
  method: "GET" | "PUT";
  expiresAt: string;
  version: number;
  path: string;
}

const RAW_TTL_MS = 10 * 60 * 1000;
const GREP_BUDGET_MS = 2000;
const GREP_MAX_DOCS = 500;
const GREP_MAX_BYTES = 10 * 1024 * 1024;

export function createAx(ctx: AxContext) {
  const { fail } = ctx;
  const isAgent = (actor: Actor) => actor.kind === "key" || (actor.kind === "user" && !!actor.agent);
  const suggests = (actor: Actor, col: string) => ctx.collection(col).agentEdits === "suggest" && isAgent(actor);
  const fmt = (d: { format?: "markdown" | "html" }): "markdown" | "html" => (d.format === "html" ? "html" : "markdown");

  /** The working copy for writers, else the published copy. */
  async function docFor(actor: Actor, col: string, slug: string): Promise<{ doc: CmsDoc; draft: boolean }> {
    ctx.collection(col);
    await ctx.ready();
    const row = await ctx.repo.findDoc(col, slug);
    if (row && ctx.can(actor, col, "write", row)) return { doc: await ctx.get(actor, col, slug, { draft: true }), draft: true };
    return { doc: await ctx.get(actor, col, slug), draft: false };
  }

  /** A validation error with the file line it is about. */
  function withLines(e: unknown, text: string): unknown {
    if (!isCmsError(e) || !e.diagnostics?.length) return e;
    const bodyAt = text.split("\n").findIndex((l, i) => i > 0 && l === "---") + 2;
    const lineOf = (d: Diagnostic) => {
      const p = d.path.split(".");
      if (p[0] === "fields") return lineOfKey(text, p[1] ?? "");
      if (p[0] === "body") return typeof d.params?.line === "number" ? bodyAt + (d.params.line as number) - 1 : bodyAt;
      return lineOfKey(text, p[0]);
    };
    const first = e.diagnostics[0];
    return fail("file_invalid", { line: lineOf(first), reason: first.message }, { diagnostics: e.diagnostics.map((d) => ({ ...d, params: { ...d.params, line: lineOf(d) } })), status: e.status });
  }

  function parse(text: string, curFields: Record<string, unknown>): Input {
    try {
      return fileToInput(text, curFields) as Input;
    } catch (e) {
      if (e instanceof FileError) throw fail("file_invalid", { line: e.line, reason: e.reason });
      throw e;
    }
  }

  function editFailure(r: Exclude<ReturnType<typeof applyEdits>, { text: string }>): Error {
    if (r.code === "edit_not_found") {
      const near = r.similar.map((s) => `${s.line}: ${s.text}`).join(" | ");
      const hint = (r.hint ? ` (${r.hint})` : "") + (near ? `. Closest lines — ${near}` : "");
      return fail("edit_not_found", { index: r.index, hint, similar: r.similar.map((x) => `${x.line}: ${x.text}`) });
    }
    if (r.code === "edit_not_unique") return fail("edit_not_unique", { index: r.index, count: r.count, lines: r.lines.join(", ") });
    return fail("edit_invalid", { index: r.index, reason: r.reason });
  }

  async function saveSuggestion(actor: Actor, doc: CmsDoc, edits: TextEdit[], note: string | null, lines: { from: number; to: number }[], stored: CmsDoc): Promise<Suggestion> {
    const who = ctx.actorRef(actor);
    const at = ctx.nowIso();
    // What the author could not see: their edits can only quote the rest. A reader who cannot see
    // something the author could does not get the suggestion (its text may quote it).
    const authorHidden = ctx.hidden?.(actor, stored.collection, stored) ?? [];
    const data = { docId: stored.id, baseVersion: doc.version, edits, note, by: { kind: who.kind, label: who.label, agent: who.agent }, lines, authorHidden };
    const r = await ctx.repo.insertRecord({ kind: "suggestion", scope: `${doc.collection}/${doc.slug}`, data, at });
    ctx.audit(actor, "doc.suggest", { collection: doc.collection, slug: doc.slug, version: doc.version, detail: { id: r.id, edits: edits.length } });
    return { id: r.id, collection: doc.collection, slug: doc.slug, at, ...data } as Suggestion;
  }

  /** Whether `actor` may see this stored suggestion of `stored`: bound to that document, and quoting nothing hidden from them. */
  function suggestionFor(actor: Actor, stored: CmsDoc, data: Record<string, unknown>): boolean {
    // Bound to the document it was made on; older records without that binding are not shown.
    if (typeof data.docId !== "string" || data.docId !== stored.id) return false;
    const mine = ctx.hidden?.(actor, stored.collection, stored) ?? [];
    if (!mine.length) return true;
    const theirs = data.authorHidden;
    return Array.isArray(theirs) && mine.every((p) => theirs.includes(p));
  }
  /** The stored document and the suggestion, for someone who may edit it and see the suggestion. */
  async function loadSuggestion(actor: Actor, col: string, slug: string, id: string) {
    ctx.collection(col);
    await ctx.ready();
    const r = await ctx.repo.findRecord("suggestion", id);
    const stored = await ctx.repo.findDoc(col, slug);
    if (!r || !stored || r.scope !== `${col}/${slug}`) throw fail("suggestion_not_found");
    ctx.assert(actor, col, "write", stored);
    if (!suggestionFor(actor, stored, r.data)) throw fail("suggestion_not_found");
    return { r, stored };
  }

  const api = {
    /** The document as a numbered file (`offset`/`limit` in lines), or its outline. */
    async read(actor: Actor, col: string, slug: string, o: { offset?: number; limit?: number; outline?: boolean } = {}): Promise<ReadResult> {
      const { doc, draft } = await docFor(actor, col, slug);
      const text = docFile(doc);
      const n = numberLines(text, o.offset ?? 1, o.outline ? 0 : (o.limit ?? 400));
      const base = { path: docPath(col, doc.slug, doc.format), collection: col, slug: doc.slug, version: doc.version, format: fmt(doc), draft, totalLines: n.total };
      if (o.outline) return { ...base, from: 1, to: n.total, nextOffset: null, content: "", outline: outline(text) };
      return { ...base, from: n.from, to: n.to, nextOffset: n.to < n.total ? n.to + 1 : null, content: n.content };
    },

    /** The file as text (CLI pull, raw links). */
    async file(actor: Actor, col: string, slug: string): Promise<{ text: string; version: number; path: string; format: "markdown" | "html" }> {
      const { doc } = await docFor(actor, col, slug);
      return { text: docFile(doc), version: doc.version, path: docPath(col, doc.slug, doc.format), format: fmt(doc) };
    },

    /** Find lines across documents (literal text by default). */
    async grep(
      actor: Actor,
      o: { pattern: string; regex?: boolean; ignoreCase?: boolean; collections?: string[]; slugs?: string[]; glob?: string; context?: number; output?: "lines" | "files" | "count"; drafts?: boolean; limit?: number }
    ): Promise<GrepResult> {
      await ctx.ready();
      let match: (l: string) => boolean;
      try {
        match = lineMatcher(o);
      } catch (e) {
        throw fail("pattern_invalid", { reason: e instanceof Error ? e.message : String(e) });
      }
      const output = o.output ?? "lines";
      const limit = Math.max(1, Math.min(o.limit ?? 200, 2000));
      const cols = (o.collections?.length ? o.collections : ctx.collections()).filter((c) => {
        ctx.collection(c);
        return ctx.can(actor, c, "read") || ctx.can(actor, c, "write");
      });
      const t0 = Date.now();
      const out: GrepResult = { output, matches: [], files: [], count: 0, partial: false, searched: 0 };
      let bytes = 0;
      outer: for (const col of cols) {
        const writer = o.drafts !== false && ctx.can(actor, col, "write");
        const rows = writer ? await ctx.repo.listDocs({ collection: col }) : await ctx.repo.listDocs({ collection: col, published: true });
        for (const row of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
          if (o.slugs?.length && !o.slugs.includes(row.slug)) continue;
          if (o.glob && !globMatch(o.glob, `${col}/${row.slug}`)) continue;
          // Per document: a writer of the collection may still be kept out of one document by its rules.
          const mine = writer && ctx.can(actor, col, "write", row);
          // Readers are judged on, and shown, the published copy.
          const pub = mine || row.publishedVersion === null || row.status === "archived" || !row.published ? null : ({ ...row, ...(row.published as object), format: (row.published as { format?: string }).format, version: row.publishedVersion, review: null, schedule: null, dueAt: null } as CmsDoc);
          if (!mine && (!pub || !ctx.can(actor, col, "read", pub))) continue;
          if (out.searched >= GREP_MAX_DOCS || bytes > GREP_MAX_BYTES || Date.now() - t0 > GREP_BUDGET_MS) {
            out.partial = true;
            break outer;
          }
          const raw = mine ? row : pub!;
          const doc = ctx.project ? ctx.project(actor, col, raw, raw) : raw;
          const text = docFile(doc as CmsDoc);
          bytes += text.length;
          out.searched++;
          const hits = grepText(text, match, output === "lines" ? (o.context ?? 0) : 0);
          if (!hits.length) continue;
          const path = docPath(col, row.slug, (doc as CmsDoc).format);
          out.count += hits.length;
          out.files.push({ path, count: hits.length });
          if (output === "lines") {
            for (const h of hits) {
              if (out.matches.length >= limit) {
                out.partial = true;
                break outer;
              }
              out.matches.push({ ...h, path, collection: col, slug: row.slug });
            }
          } else if (out.files.length >= limit) {
            out.partial = true;
            break outer;
          }
        }
      }
      return out;
    },

    /** Replace unique text with new text, in order, all or none; one new version. */
    async edit(actor: Actor, col: string, slug: string, edits: TextEdit[], o: { note?: string; expectedVersion?: number; dryRun?: boolean } = {}): Promise<EditResult> {
      ctx.collection(col);
      await ctx.ready();
      // Authorize on the stored row (a rule may look at fields this actor cannot see); edit the text they can see.
      const stored = await ctx.repo.findDoc(col, slug);
      if (!stored) throw fail("not_found", { collection: col, slug });
      ctx.assert(actor, col, "write", stored);
      const doc = await ctx.get(actor, col, slug, { draft: true });
      if (o.expectedVersion !== undefined && o.expectedVersion !== doc.version) throw fail("conflict_version", { expected: o.expectedVersion, current: doc.version });
      const text = docFile(doc);
      const r = applyEdits(text, edits);
      if (!("text" in r)) throw editFailure(r);
      const input = parse(r.text, doc.fields);
      const base = { path: docPath(col, doc.slug, input.format), collection: col, slug: doc.slug, changed: r.changed, counts: r.counts, snippet: snippets(r.text, r.changed) };
      // A dry run shows what would change; nothing is saved, suggested or announced.
      if (o.dryRun) return { ...base, version: doc.version, saved: false, dryRun: true };
      if (suggests(actor, col)) {
        const suggestion = await saveSuggestion(actor, doc, edits, o.note ?? null, r.changed, stored);
        return { ...base, version: doc.version, saved: false, suggestion };
      }
      let saved: CmsDoc;
      try {
        saved = await ctx.update(actor, col, slug, input, { expectedVersion: doc.version, note: o.note });
      } catch (e) {
        throw withLines(e, r.text);
      }
      return { ...base, slug: saved.slug, path: docPath(col, saved.slug, saved.format), version: saved.version, saved: saved.version !== doc.version };
    },

    /** Replace the whole file (or make the document). Replacing needs `expectedVersion`. */
    async write(actor: Actor, col: string, slug: string, content: string, o: { expectedVersion?: number; note?: string } = {}): Promise<EditResult> {
      ctx.collection(col);
      await ctx.ready();
      const existing = await ctx.repo.findDoc(col, slug);
      if (!existing) {
        const input = parse(content, {});
        input.slug ??= slug;
        let doc: CmsDoc;
        try {
          doc = await ctx.create(actor, col, input, { note: o.note });
        } catch (e) {
          throw withLines(e, content);
        }
        const lines = content.split("\n").length;
        return { path: docPath(col, doc.slug, doc.format), collection: col, slug: doc.slug, version: doc.version, saved: true, snippet: numberLines(content, 1, 12).content, changed: [{ from: 1, to: lines }], counts: [1] };
      }
      if (o.expectedVersion === undefined) throw fail("edit_invalid", { index: 0, reason: "expectedVersion is required to replace a whole document (read it first)" });
      // Authorized on the stored row; the text replaced is the one this actor can see.
      ctx.assert(actor, col, "write", existing);
      const doc = await ctx.get(actor, col, slug, { draft: true });
      if (doc.id !== existing.id) throw fail("conflict_version", { expected: o.expectedVersion, current: doc.version });
      if (o.expectedVersion !== doc.version) throw fail("conflict_version", { expected: o.expectedVersion, current: doc.version });
      const cur = docFile(doc);
      const input = parse(content, doc.fields);
      const changed = changedLines(cur, content);
      const base = { path: docPath(col, doc.slug, input.format), collection: col, slug: doc.slug, changed, counts: [1], snippet: snippets(content, changed) };
      if (suggests(actor, col)) {
        const suggestion = await saveSuggestion(actor, doc, [{ oldString: cur, newString: content }], o.note ?? null, changed, existing);
        return { ...base, version: doc.version, saved: false, suggestion };
      }
      let saved: CmsDoc;
      try {
        saved = await ctx.update(actor, col, slug, input, { expectedVersion: doc.version, note: o.note });
      } catch (e) {
        throw withLines(e, content);
      }
      return { ...base, slug: saved.slug, version: saved.version, saved: saved.version !== doc.version };
    },

    /** A 10-minute link to fetch (GET) or send (PUT) the file without putting it in a conversation. */
    async rawLink(actor: Actor, col: string, slug: string, o: { method?: "GET" | "PUT" } = {}): Promise<RawLink> {
      const method = o.method === "PUT" ? "PUT" : "GET";
      const { doc } = await docFor(actor, col, slug);
      if (method === "PUT") ctx.assert(actor, col, "write", doc);
      const token = base64url(randomBytes(24));
      const expiresAt = new Date(Date.parse(ctx.nowIso()) + RAW_TTL_MS).toISOString();
      const plain = JSON.parse(JSON.stringify(actor)) as Actor;
      await ctx.repo.insertRecord({ kind: "raw_link", key: token, scope: `${col}/${doc.slug}`, data: { collection: col, slug: doc.slug, method, version: doc.version, actor: plain, expiresAt }, at: ctx.nowIso() });
      return { url: `/raw/${token}`, method, expiresAt, version: doc.version, path: docPath(col, doc.slug, doc.format) };
    },

    /** What a raw link points at (the HTTP route answers with it). */
    async rawOpen(token: string, method: "GET" | "PUT"): Promise<{ actor: Actor; collection: string; slug: string; version: number }> {
      await ctx.ready();
      const r = token && /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await ctx.repo.findRecordByKey("raw_link", token) : null;
      const d = r?.data as { collection: string; slug: string; method: "GET" | "PUT"; version: number; actor: Actor; expiresAt: string } | undefined;
      if (!r || !d || d.method !== method) throw fail("raw_link_invalid");
      if (Date.parse(d.expiresAt) < Date.parse(ctx.nowIso())) {
        await ctx.repo.deleteRecords({ kind: "raw_link", id: r.id });
        throw fail("raw_link_expired");
      }
      // A PUT link sends one file; a GET link can be read until it expires.
      // Claimed by deleting it: of two requests at once only one deletes a row.
      if (method === "PUT" && (await ctx.repo.deleteRecords({ kind: "raw_link", id: r.id })) === 0) throw fail("raw_link_invalid");
      return { actor: d.actor, collection: d.collection, slug: d.slug, version: d.version };
    },

    /** Suggestions waiting on a document (writers). */
    async suggestions(actor: Actor, col: string, slug: string): Promise<Suggestion[]> {
      ctx.collection(col);
      await ctx.ready();
      const stored = await ctx.repo.findDoc(col, slug);
      if (!stored) throw fail("not_found", { collection: col, slug });
      ctx.assert(actor, col, "write", stored);
      const rows = await ctx.repo.listRecords({ kind: "suggestion", scope: `${col}/${stored.slug}`, order: "asc", limit: 200 });
      // Only this document's (a later one with the same slug does not inherit them), and none whose
      // author could see a field this person may not.
      return rows
        .filter((r) => suggestionFor(actor, stored, r.data))
        .map((r) => {
          const { authorHidden: _h, ...data } = r.data as Record<string, unknown>;
          return { id: r.id, collection: col, slug: stored.slug, at: r.createdAt, ...(data as Omit<Suggestion, "id" | "collection" | "slug" | "at">) };
        });
    },

    /** Apply a suggestion (optionally changed) as the person; the edit must still fit the current text. */
    async applySuggestion(actor: Actor, col: string, slug: string, id: string, o: { edits?: TextEdit[]; note?: string } = {}): Promise<EditResult> {
      const { r, stored } = await loadSuggestion(actor, col, slug, id);
      const s = r.data as unknown as Suggestion;
      const person: Actor = actor.kind === "user" && actor.agent ? { ...actor, agent: undefined } : actor;
      // Apply as the person even when the collection keeps agents' edits as suggestions.
      let res: EditResult;
      {
        ctx.assert(person, col, "write", stored);
        const doc = await ctx.get(person, col, slug, { draft: true });
        if (doc.id !== stored.id) throw fail("suggestion_not_found");
        const text = docFile(doc);
        const applied = applyEdits(text, o.edits ?? s.edits);
        if (!("text" in applied)) throw fail("suggestion_stale");
        const input = parse(applied.text, doc.fields);
        const saved = await ctx.update(person, col, slug, input, { expectedVersion: doc.version, note: o.note ?? s.note ?? `suggestion by ${s.by.agent ?? s.by.label}` });
        res = { path: docPath(col, saved.slug, saved.format), collection: col, slug: saved.slug, version: saved.version, saved: true, changed: applied.changed, counts: applied.counts, snippet: snippets(applied.text, applied.changed) };
      }
      await ctx.repo.deleteRecords({ kind: "suggestion", id });
      ctx.audit(actor, "doc.suggest.apply", { collection: col, slug, version: res.version, detail: { id } });
      return res;
    },

    async rejectSuggestion(actor: Actor, col: string, slug: string, id: string): Promise<void> {
      await loadSuggestion(actor, col, slug, id);
      await ctx.repo.deleteRecords({ kind: "suggestion", id });
      ctx.audit(actor, "doc.suggest.reject", { collection: col, slug, detail: { id } });
    },
  };
  return api;
}

/** Changed line ranges between two texts (new side, 1-based). */
function changedLines(a: string, b: string): { from: number; to: number }[] {
  const A = a.split("\n");
  const B = b.split("\n");
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length - 1;
  let eb = B.length - 1;
  while (ea >= s && eb >= s && A[ea] === B[eb]) {
    ea--;
    eb--;
  }
  if (s > eb) return s >= B.length && A.length === B.length ? [] : [{ from: Math.min(s + 1, B.length), to: Math.min(s + 1, B.length) }];
  return [{ from: s + 1, to: eb + 1 }];
}

export type CmsAx = ReturnType<typeof createAx>;
