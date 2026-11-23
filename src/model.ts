/**
 * The content model of 0.21.0: relations between documents, document trees, snippets,
 * heading anchor aliases, redirects, SEO and the sitemap. Plain functions over the repo;
 * `cms.ts` decides who may call them and wires them into saves and reads.
 */

import type { AnyCollection } from "./cms";
import type { CmsError, CmsErrorCode, CmsErrorOptions, Diagnostic, ErrorParams } from "./errors";
import { fieldMarks, DOC_ID_RE, type FieldMark } from "./fields";
import { anchorOf, headingAnchors, snippetKeys, SNIPPET_RE, videoUses } from "./markdown";
import type { CmsRepo } from "./repo";
import type { CmsDoc, CmsRedirect, DocContent, DocRef, DocSeo } from "./types";
import { DEFAULT_VIDEO_HOSTS, hostAllowed, videoEmbed, videoHost } from "./video";

export interface ModelContext {
  repo: CmsRepo;
  collections: ReadonlyMap<string, AnyCollection>;
  collection: (col: string) => AnyCollection;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => CmsError;
  diag: (path: string, code: CmsErrorCode, params: ErrorParams, severity: Diagnostic["severity"]) => Diagnostic;
  nowIso: () => string;
  report: (e: unknown, where: string) => void;
  urlOf: (col: string, slug: string) => string | null;
  redirects: false | { ttlMs: number };
  videoHosts: readonly string[];
  /** An anonymous reader may read this document (`beforeRead` hooks). */
  publicReadable: (col: string, slug: string) => Promise<boolean>;
}

/** What `?expand=` puts in place of an id. Null: gone, or not for this reader. */
export interface RelatedDoc {
  id: string;
  collection: string;
  slug: string;
  title: string;
  summary: string;
  status: CmsDoc["status"];
  url: string | null;
}

/** One node of `cms.tree()`. */
export interface TreeNode {
  id: string;
  slug: string;
  title: string;
  status: CmsDoc["status"];
  published: boolean;
  position: string | null;
  children: TreeNode[];
}

type RelationMark = Extract<FieldMark, { kind: "relation" }>;

const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
function setPath(obj: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split(".");
  let cur = obj;
  for (const k of ks.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") return;
    cur = cur[k] as Record<string, unknown>;
  }
  cur[ks[ks.length - 1]] = v;
}

// ── sortable positions (fractional keys) ─────────────────────────────────────

const DIG = "0123456789abcdefghijklmnopqrstuvwxyz";
/** A key strictly between `a` and `b` (null: open end). Inserting never renumbers siblings. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error("keyBetween: a must sort before b");
  let out = "";
  let upper = b;
  for (let i = 0; ; i++) {
    const ca = a !== null && i < a.length ? DIG.indexOf(a[i]) : 0;
    const cb = upper !== null ? (i < upper.length ? DIG.indexOf(upper[i]) : 0) : DIG.length;
    if (ca === cb) {
      out += DIG[ca];
      continue;
    }
    const mid = Math.floor((ca + cb) / 2);
    if (mid > ca) return out + DIG[mid];
    out += DIG[ca];
    upper = null;
  }
}

/** Path rules for redirects: starts with one `/`, no spaces or `..`, no trailing `/` (root aside). */
export function normalizePath(p: string): string | null {
  let s = String(p ?? "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || /[\s\\\x00-\x1f]/.test(s) || /%2e|%2f|%5c/i.test(s) || s.length > 500 || /(^|\/)\.\.?(\/|$)/.test(s)) return null;
  s = s.split("#")[0];
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s || "/";
}

export function createModel(ctx: ModelContext) {
  const { repo, fail } = ctx;

  // ── relations ───────────────────────────────────────────────────────────────

  const relCache = new Map<string, [string, RelationMark][]>();
  function relationFields(col: string): [string, RelationMark][] {
    let r = relCache.get(col);
    if (!r) {
      r = [...fieldMarks(ctx.collection(col).fields)].filter((e): e is [string, RelationMark] => e[1].kind === "relation");
      relCache.set(col, r);
    }
    return r;
  }
  const anyRelations = () => [...ctx.collections.keys()].some((c) => relationFields(c).length > 0);
  const idsAt = (fields: unknown, path: string): string[] => {
    const v = getPath(fields, path);
    if (typeof v === "string") return v ? [v] : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  };

  /**
   * Turn `{ collection, slug }` in relation fields into ids (agents name documents by address).
   * Returns new fields; an address that names nothing is refused with `relation_missing`.
   */
  async function resolveRelations(col: string, fields: Record<string, unknown> | undefined, r: CmsRepo = repo): Promise<Record<string, unknown> | undefined> {
    const rels = relationFields(col);
    if (!fields || !rels.length) return fields;
    let out: Record<string, unknown> | null = null;
    for (const [path, m] of rels) {
      const v = getPath(fields, path);
      if (v === undefined || v === null) continue;
      const one = async (x: unknown): Promise<unknown> => {
        if (!x || typeof x !== "object" || Array.isArray(x)) return x;
        const ref = x as { collection?: unknown; slug?: unknown; id?: unknown };
        if (typeof ref.id === "string") return ref.id;
        const c = typeof ref.collection === "string" ? ref.collection : m.collections.length === 1 ? m.collections[0] : null;
        const slug = typeof ref.slug === "string" ? ref.slug : null;
        const doc = c && slug && ctx.collections.has(c) ? await r.findDoc(c, slug) : null;
        if (!doc) {
          const label = `${c ?? "?"}/${slug ?? "?"}`;
          throw fail("relation_missing", { id: label }, { diagnostics: [ctx.diag(`fields.${path}`, "relation_missing", { id: label }, "error")] });
        }
        return doc.id;
      };
      const next = Array.isArray(v) ? await Promise.all(v.map(one)) : await one(v);
      if (next !== v) {
        out ??= structuredClone(fields);
        setPath(out, path, next);
      }
    }
    return out ?? fields;
  }

  async function docsByIds(ids: string[], r: CmsRepo = repo): Promise<Map<string, CmsDoc>> {
    const want = [...new Set(ids.filter((i) => DOC_ID_RE.test(i)))];
    if (!want.length) return new Map();
    const rows = r.findDocsByIds ? await r.findDocsByIds(want) : (await Promise.all(want.map((i) => r.findDocById(i)))).filter((d): d is CmsDoc => !!d);
    return new Map(rows.filter((d) => !d.deletedAt).map((d) => [d.id, d]));
  }

  /** Problems with what relation fields point at. `known`: ids the saved copy already had (a target deleted since is a warning there). */
  async function relationDiagnostics(col: string, c: Pick<DocContent, "fields">, known: ReadonlySet<string> = new Set(), r: CmsRepo = repo, o: { publishing?: boolean } = {}): Promise<Diagnostic[]> {
    const rels = relationFields(col);
    if (!rels.length) return [];
    const all = rels.flatMap(([p]) => idsAt(c.fields, p));
    if (!all.length) return [];
    const docs = await docsByIds(all, r);
    const out: Diagnostic[] = [];
    for (const [path, m] of rels) {
      for (const id of idsAt(c.fields, path)) {
        const d = docs.get(id);
        if (!d) out.push(ctx.diag(`fields.${path}`, "relation_missing", { id }, known.has(id) ? "warning" : "error"));
        else if (!m.collections.includes(d.collection)) out.push(ctx.diag(`fields.${path}`, "relation_wrong_collection", { id, collections: m.collections.join(", ") }, "error"));
        else if (o.publishing && (d.publishedVersion === null || d.status === "archived")) out.push(ctx.diag(`fields.${path}`, "relation_unpublished", { id, title: d.title }, "warning"));
      }
    }
    return out;
  }
  const relationIds = (col: string, c: Pick<DocContent, "fields"> | null | undefined) => new Set(c ? relationFields(col).flatMap(([p]) => idsAt(c.fields, p)) : []);

  /** Who `doc` points at, in its working copy and in what is published. */
  async function syncRefs(r: CmsRepo, doc: CmsDoc): Promise<void> {
    if (!r.setDocRefs || !anyRelations()) return;
    const rels = ctx.collections.has(doc.collection) ? relationFields(doc.collection) : [];
    const refs = new Map<string, Omit<DocRef, "fromId">>();
    const add = (fields: unknown, which: "inDraft" | "inPublished") => {
      for (const [path] of rels)
        for (const id of idsAt(fields, path)) {
          if (!DOC_ID_RE.test(id)) continue;
          const k = `${id}|${path}`;
          const cur = refs.get(k) ?? { toId: id, field: path, inDraft: false, inPublished: false };
          cur[which] = true;
          refs.set(k, cur);
        }
    };
    add(doc.fields, "inDraft");
    if (doc.published && doc.publishedVersion !== null) add(doc.published.fields, "inPublished");
    await r.setDocRefs(doc.id, [...refs.values()]);
  }

  /** Documents that point at `id` (live ones only). */
  async function referencedBy(id: string, r: CmsRepo = repo): Promise<{ doc: CmsDoc; draftFields: string[]; publishedFields: string[] }[]> {
    if (!r.listDocRefsTo) return [];
    const refs = await r.listDocRefsTo(id);
    const docs = await docsByIds(refs.map((x) => x.fromId), r);
    const by = new Map<string, { doc: CmsDoc; draftFields: string[]; publishedFields: string[] }>();
    for (const x of refs) {
      const d = docs.get(x.fromId);
      if (!d || d.id === id) continue;
      const cur = by.get(d.id) ?? { doc: d, draftFields: [], publishedFields: [] };
      if (x.inDraft) cur.draftFields.push(x.field);
      if (x.inPublished) cur.publishedFields.push(x.field);
      by.set(d.id, cur);
    }
    return [...by.values()];
  }

  /** Put related documents in place of ids for `paths` (one level). `view` says what this reader may see of a target. */
  async function expand(col: string, fields: Record<string, unknown>, paths: readonly string[], view: (d: CmsDoc) => Promise<CmsDoc | null>): Promise<Record<string, unknown>> {
    const rels = new Map(relationFields(col));
    const want = paths.filter((p) => rels.has(p));
    if (!want.length) return fields;
    const docs = await docsByIds(want.flatMap((p) => idsAt(fields, p)));
    const out = structuredClone(fields);
    const seen = new Map<string, CmsDoc | null>();
    for (const [id, d] of docs) seen.set(id, await view(d));
    const show = (id: string): RelatedDoc | null => {
      const v = seen.get(id) ?? null;
      return v ? { id: v.id, collection: v.collection, slug: v.slug, title: v.title, summary: v.summary, status: v.status, url: ctx.urlOf(v.collection, v.slug) } : null;
    };
    for (const p of want) {
      const v = getPath(fields, p);
      if (typeof v === "string") setPath(out, p, show(v));
      else if (Array.isArray(v)) setPath(out, p, v.map((x) => (typeof x === "string" ? show(x) : null)));
    }
    return out;
  }

  // ── snippets ────────────────────────────────────────────────────────────────

  const snippetCols = () => [...ctx.collections.values()].filter((c) => c.snippets).map((c) => c.slug);
  /** Published snippet bodies by key, refreshed when a snippet changes here or after 30 s. */
  let snippetCache: { at: number; bodies: Map<string, { col: string; slug: string; body: string } | null> } | null = null;
  function forgetSnippets() {
    snippetCache = null;
  }
  async function snippetBody(key: string): Promise<string | null> {
    if (!snippetCache || Date.now() - snippetCache.at > 30_000) snippetCache = { at: Date.now(), bodies: new Map() };
    let hit = snippetCache.bodies.get(key);
    if (hit === undefined) {
      hit = null;
      for (const c of snippetCols()) {
        const d = await repo.findDoc(c, key);
        if (d && d.published && d.publishedVersion !== null && d.status !== "archived" && ctx.collection(c).visibility === "public" && !ctx.collection(c).access?.read) {
          hit = { col: c, slug: d.published.slug ?? d.slug, body: d.published.body ?? "" };
          break;
        }
      }
      snippetCache.bodies.set(key, hit);
    }
    // The published text is cached; whether readers may see it is asked every time.
    return hit && (await ctx.publicReadable(hit.col, hit.slug)) ? hit.body : null;
  }
  /** A body with `[[snippet:key]]` replaced by published snippets (3 levels; a missing one becomes nothing). Code fences stay as they are. */
  async function expandSnippets(body: string, depth = 0, seen: string[] = []): Promise<string> {
    if (!snippetCols().length || !body.includes("[[snippet:")) return body;
    const keys = snippetKeys(body);
    if (!keys.length) return body;
    const bodies = new Map<string, string>();
    for (const k of keys) {
      const b = depth < 3 && !seen.includes(k) ? await snippetBody(k) : null;
      bodies.set(k, b === null ? "" : await expandSnippets(b, depth + 1, [...seen, k]));
    }
    let inFence: string | null = null;
    return body
      .split("\n")
      .map((line) => {
        const f = /^\s*(`{3,}|~{3,})/.exec(line);
        if (f) {
          if (!inFence) inFence = f[1];
          else if (line.trim().startsWith(inFence)) inFence = null;
          return line;
        }
        if (inFence) return line;
        return line.replace(SNIPPET_RE, (_m, k: string) => bodies.get(k.toLowerCase()) ?? "");
      })
      .join("\n");
  }
  /** Snippets a body names that do not exist (as warnings) and loops through snippets (as errors). */
  async function snippetDiagnostics(col: string, slug: string, body: string, r: CmsRepo = repo): Promise<Diagnostic[]> {
    const cols = snippetCols();
    if (!cols.length) return [];
    const keys = snippetKeys(body);
    if (!keys.length) return [];
    const out: Diagnostic[] = [];
    const find = async (k: string) => {
      for (const c of cols) {
        const d = await r.findDoc(c, k);
        if (d) return d;
      }
      return null;
    };
    for (const k of keys) if (!(await find(k))) out.push(ctx.diag("body", "snippet_missing", { key: k }, "warning"));
    if (cols.includes(col)) {
      // Follow the working copies from this snippet: coming back to it is a loop.
      const walk = async (k: string, path: string[]): Promise<string[] | null> => {
        if (k === slug) return path;
        if (path.length > 6) return null;
        const d = await find(k);
        if (!d) return null;
        for (const n of snippetKeys(d.body)) {
          const hit = await walk(n, [...path, n]);
          if (hit) return hit;
        }
        return null;
      };
      for (const k of keys) {
        const loop = await walk(k, [slug, k]);
        if (loop) {
          out.push(ctx.diag("body", "snippet_cycle", { path: loop.join(" → ") }, "error"));
          break;
        }
      }
    }
    return out;
  }
  /** Documents whose working copy names snippet `key`. */
  async function snippetUsage(key: string): Promise<CmsDoc[]> {
    const token = `[[snippet:${key.toLowerCase()}]]`;
    const out: CmsDoc[] = [];
    for (const c of ctx.collections.keys()) for (const d of await repo.listDocs({ collection: c })) if (d.body.toLowerCase().includes(token)) out.push(d);
    return out;
  }

  // ── videos ──────────────────────────────────────────────────────────────────

  function videoDiagnostics(body: string): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const v of videoUses(body)) {
      if (!v.src) continue;
      const host = videoHost(v.src) ?? v.src;
      if (!videoEmbed(v.src, ctx.videoHosts) || !hostAllowed(host, ctx.videoHosts)) out.push(ctx.diag("body", "video_host_blocked", { host, hosts: ctx.videoHosts.join(", "), line: v.line }, "error"));
    }
    return out;
  }

  // ── heading anchors ─────────────────────────────────────────────────────────

  /** Anchors of `prev` that `next` lost, each with the heading it most likely became. */
  function lostAnchors(prev: string, next: string): { old: string; current: string }[] {
    const a = headingAnchors(prev);
    const b = headingAnchors(next);
    const now = new Set(b.map((h) => h.id));
    const out: { old: string; current: string }[] = [];
    const takenB = new Set<number>();
    a.forEach((h, i) => {
      if (now.has(h.id)) return;
      // Same place in a list of the same length (a heading was renamed), else the same words.
      let j = a.length === b.length ? i : -1;
      if (j < 0 || takenB.has(j)) j = b.findIndex((x, k) => !takenB.has(k) && !a.some((y) => y.id === x.id) && anchorOf(x.text) === anchorOf(h.text));
      if (j < 0) return;
      takenB.add(j);
      out.push({ old: h.id, current: b[j].id });
    });
    return out;
  }
  /** Record aliases for anchors a save lost; aliases that pointed at a lost anchor move along. */
  async function keepAnchors(r: CmsRepo, documentId: string, prev: string, next: string): Promise<void> {
    if (!r.addAnchorAliases || prev === next) return;
    const lost = lostAnchors(prev, next);
    if (!lost.length) return;
    const moved = new Map(lost.map((l) => [l.old, l.current]));
    const older = r.listAnchorAliases ? await r.listAnchorAliases(documentId) : [];
    const rows = [...lost, ...older.filter((o) => moved.has(o.current)).map((o) => ({ old: o.old, current: moved.get(o.current)! }))].filter((x) => x.old !== x.current);
    await r.addAnchorAliases(documentId, rows);
  }
  /** Current anchor for `anchor` in a document (itself when it still exists or is unknown). */
  async function resolveAnchor(documentId: string, anchor: string, body: string): Promise<string> {
    if (headingAnchors(body).some((h) => h.id === anchor) || !repo.listAnchorAliases) return anchor;
    const hit = (await repo.listAnchorAliases(documentId)).find((a) => a.old === anchor);
    return hit?.current ?? anchor;
  }
  async function aliasMap(documentId: string): Promise<Record<string, string[]>> {
    if (!repo.listAnchorAliases) return {};
    const out: Record<string, string[]> = Object.create(null);
    for (const a of await repo.listAnchorAliases(documentId)) (out[a.current] ??= []).push(a.old);
    return out;
  }

  // ── trees ───────────────────────────────────────────────────────────────────

  const treeOf = (col: string) => {
    const t = ctx.collection(col).tree;
    return t ? { maxDepth: Math.max(1, (typeof t === "object" ? t.maxDepth : undefined) ?? 3) } : null;
  };
  const byPosition = (a: CmsDoc, b: CmsDoc) => (a.position ?? "￿").localeCompare(b.position ?? "￿") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

  /** Where `id` would go: parent and position. Throws the tree rule it breaks. */
  async function placeIn(r: CmsRepo, col: string, doc: CmsDoc, parentId: string | null, beforeId: string | null): Promise<{ parentId: string | null; position: string }> {
    const tree = treeOf(col);
    if (!tree) throw fail("tree_off", { collection: col });
    const all = await r.listDocs({ collection: col });
    const byId = new Map(all.map((d) => [d.id, d]));
    if (parentId) {
      const p = byId.get(parentId);
      if (!p) throw fail("not_found", { collection: col, slug: parentId });
      // Not under itself or one of its descendants.
      const walked = new Set<string>();
      for (let cur: CmsDoc | undefined = p; cur && !walked.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        if (cur.id === doc.id) throw fail("tree_cycle");
        walked.add(cur.id);
      }
    }
    const depthOf = (id: string | null): number => {
      let n = 0;
      for (let cur = id ? byId.get(id) : undefined; cur && n < 100; cur = cur.parentId ? byId.get(cur.parentId) : undefined) n++;
      return n;
    };
    const height = (id: string, depth = 0): number => (depth > 100 ? 1 : 1 + Math.max(0, ...all.filter((d) => d.parentId === id).map((d) => height(d.id, depth + 1))));
    if (depthOf(parentId) + height(doc.id) > tree.maxDepth) throw fail("tree_too_deep", { max: tree.maxDepth });
    const siblings = all.filter((d) => (d.parentId ?? null) === parentId && d.id !== doc.id).sort(byPosition);
    // Siblings without a position (made before the tree was on) get one first, in their order.
    let prev: string | null = null;
    for (const s of siblings) {
      if (!s.position || (prev !== null && s.position <= prev)) {
        s.position = keyBetween(prev, null);
        await r.updateDoc(s.id, { position: s.position, updatedAt: s.updatedAt });
      }
      prev = s.position;
    }
    const at = beforeId ? siblings.findIndex((s) => s.id === beforeId) : -1;
    const lo = at > 0 ? siblings[at - 1].position! : at === 0 ? null : (siblings[siblings.length - 1]?.position ?? null);
    const hi = at >= 0 ? siblings[at].position! : null;
    return { parentId, position: keyBetween(lo, hi) };
  }

  /** The tree of a collection from documents a reader may see. Hidden documents are left out and their children move up. */
  function buildTree(docs: CmsDoc[], visible: (d: CmsDoc) => boolean): TreeNode[] {
    const byParent = new Map<string | null, CmsDoc[]>();
    const ids = new Set(docs.map((d) => d.id));
    for (const d of docs) {
      const p = d.parentId && ids.has(d.parentId) ? d.parentId : null;
      byParent.set(p, [...(byParent.get(p) ?? []), d]);
    }
    const make = (parent: string | null, guard: Set<string>): TreeNode[] => {
      const out: TreeNode[] = [];
      for (const d of (byParent.get(parent) ?? []).sort(byPosition)) {
        if (guard.has(d.id)) continue;
        const g = new Set(guard).add(d.id);
        const kids = make(d.id, g);
        if (visible(d)) out.push({ id: d.id, slug: d.slug, title: d.title, status: d.status, published: d.publishedVersion !== null && d.status !== "archived", position: d.position ?? null, children: kids });
        else out.push(...kids);
      }
      return out;
    };
    return make(null, new Set());
  }

  // ── redirects ───────────────────────────────────────────────────────────────

  const redirectsOn = () => !!ctx.redirects && typeof repo.listRedirects === "function";
  let table: { at: number; rows: Map<string, CmsRedirect> } | null = null;
  const hits = new Map<string, number>();
  let hitTimer: ReturnType<typeof setTimeout> | null = null;
  async function loadTable(r: CmsRepo = repo): Promise<Map<string, CmsRedirect>> {
    const ttl = ctx.redirects ? ctx.redirects.ttlMs : 30_000;
    if (table && Date.now() - table.at < ttl && r === repo) return table.rows;
    const rows = new Map((await r.listRedirects!()).map((x) => [x.from, x]));
    if (r === repo) table = { at: Date.now(), rows };
    return rows;
  }
  function forgetRedirects() {
    table = null;
  }
  async function flushHits(): Promise<void> {
    if (hitTimer) clearTimeout(hitTimer);
    hitTimer = null;
    if (!hits.size || !repo.addRedirectHits) return;
    const batch = new Map(hits);
    hits.clear();
    await repo.addRedirectHits(batch, ctx.nowIso()).catch((e) => ctx.report(e, "redirect hits"));
  }
  /** Where `path` goes now, or null. Counts the visit (written once a minute). */
  async function resolveRedirect(path: string): Promise<{ to: string; status: 301 | 302 } | null> {
    if (!redirectsOn()) return null;
    const p = normalizePath(path);
    if (!p) return null;
    const rows = await loadTable();
    const hit = rows.get(p);
    if (!hit) return null;
    hits.set(hit.id, (hits.get(hit.id) ?? 0) + 1);
    if (!hitTimer) {
      hitTimer = setTimeout(() => void flushHits(), 60_000);
      (hitTimer as { unref?: () => void }).unref?.();
    }
    let to = hit.to;
    if (hit.toDocumentId) {
      const d = await repo.findDocById(hit.toDocumentId);
      const u = d ? ctx.urlOf(d.collection, d.slug) : null;
      if (u) to = u;
    }
    return { to, status: hit.status };
  }
  const validTarget = (to: string) => normalizePath(to) ?? (/^https?:\/\/[^\s]+$/i.test(to) && to.length <= 2000 ? to : null);

  /** Save a redirect: chains are shortened (A→B, B→C becomes A→C) and loops refused. */
  async function saveRedirect(r: CmsRepo, input: { id?: string; from: string; to: string; status?: 301 | 302; toDocumentId?: string | null; source: "auto" | "manual"; createdBy: string | null }): Promise<CmsRedirect> {
    const from = normalizePath(input.from);
    if (!from) throw fail("redirect_invalid", { reason: "from" });
    let to = validTarget(input.to);
    if (!to) throw fail("redirect_invalid", { reason: "to" });
    const rows = await loadTable(r);
    // Follow the target's own redirect (one step is enough: the table never holds chains).
    const next = rows.get(to);
    if (next && next.id !== input.id) to = next.to;
    if (to === from) throw fail("redirect_loop");
    const taken = rows.get(from);
    if (taken && taken.id !== input.id) {
      if (input.source !== "auto") throw fail("redirect_taken", { from });
      await r.deleteRedirect!(taken.id);
    }
    let saved: CmsRedirect;
    const status = input.status ?? 301;
    if (input.id) {
      const u = await r.updateRedirect!(input.id, { from, to, status, toDocumentId: input.toDocumentId, source: input.source });
      if (!u) throw fail("redirect_not_found");
      saved = u;
    } else saved = await r.insertRedirect!({ from, to, status, toDocumentId: input.toDocumentId ?? null, source: input.source, createdBy: input.createdBy });
    // Others that led to `from` now lead straight to `to`.
    for (const x of rows.values()) if (x.to === from && x.id !== saved.id) {
      if (x.from === to) await r.deleteRedirect!(x.id);
      else await r.updateRedirect!(x.id, { to });
    }
    forgetRedirects();
    return saved;
  }
  /** A published document moved: its old address redirects to the new one. */
  async function autoRedirect(r: CmsRepo, doc: CmsDoc, oldSlug: string, newSlug: string, by: string | null): Promise<void> {
    if (!redirectsOn()) return;
    const oldUrl = ctx.urlOf(doc.collection, oldSlug);
    const newUrl = ctx.urlOf(doc.collection, newSlug);
    const from = oldUrl ? normalizePath(oldUrl) : null;
    const to = newUrl ? normalizePath(newUrl) : null;
    if (!from || !to || from === to) return;
    const rows = await loadTable(r);
    // Moving back to an address that redirected away: that redirect goes.
    const back = rows.get(to);
    if (back) await r.deleteRedirect!(back.id);
    forgetRedirects();
    await saveRedirect(r, { from, to, toDocumentId: doc.id, source: "auto", createdBy: by });
  }
  async function listRedirects(): Promise<CmsRedirect[]> {
    if (!repo.listRedirects) return [];
    return repo.listRedirects();
  }
  /** A redirect that starts at the address a new document would take (the admin offers to remove it). */
  async function redirectAt(col: string, slug: string): Promise<CmsRedirect | null> {
    if (!redirectsOn()) return null;
    const u = ctx.urlOf(col, slug);
    const p = u ? normalizePath(u) : null;
    return p ? ((await loadTable()).get(p) ?? null) : null;
  }

  // ── SEO and sitemap ─────────────────────────────────────────────────────────

  const seoRules = (col: string) => {
    const s = ctx.collection(col).seo;
    return s ? { titleMax: (typeof s === "object" ? s.titleMax : undefined) ?? 60, descriptionMax: (typeof s === "object" ? s.descriptionMax : undefined) ?? 160 } : null;
  };
  /** SEO warnings for a copy (lengths and a missing description). */
  function seoDiagnostics(col: string, c: DocContent): Diagnostic[] {
    const rules = seoRules(col);
    if (!rules) return [];
    const out: Diagnostic[] = [];
    const title = c.seo?.title || c.title;
    const desc = c.seo?.description || c.summary;
    if (title.length > rules.titleMax) out.push(ctx.diag(c.seo?.title ? "seo.title" : "title", "seo_title_long", { length: title.length, max: rules.titleMax }, "warning"));
    if (!desc) out.push(ctx.diag("seo.description", "seo_description_missing", {}, "warning"));
    else if (desc.length > rules.descriptionMax) out.push(ctx.diag(c.seo?.description ? "seo.description" : "summary", "seo_description_long", { length: desc.length, max: rules.descriptionMax }, "warning"));
    return out;
  }
  /** What a page puts in its head: SEO values with the title, summary and first image filling gaps. */
  function seoFor(doc: Pick<CmsDoc, "collection" | "slug" | "title" | "summary" | "body"> & { seo?: DocSeo | null }): { title: string; description: string; image: string | null; canonical: string | null; noindex: boolean; url: string | null } {
    const s = doc.seo ?? {};
    const first = /!\[[^\]]*\]\((asset:[a-z0-9]{12}(?:\/[^\s)]*)?|https:\/\/[^\s)]+)/.exec(doc.body ?? "")?.[1] ?? null;
    return { title: s.title || doc.title, description: s.description || doc.summary, image: s.image || first, canonical: s.canonical || null, noindex: !!s.noindex, url: ctx.urlOf(doc.collection, doc.slug) };
  }
  const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  /**
   * `sitemap.xml` for published documents of public collections that have `url()`. `noindex`
   * documents stay out. Above 50 000 addresses, `page` picks a part and `page: null` answers the index.
   */
  async function sitemap(origin: string, o: { collections?: readonly string[]; page?: number | null; self?: string } = {}): Promise<string> {
    const base = origin.replace(/\/+$/, "");
    const abs = (u: string) => (/^https?:\/\//i.test(u) ? u : `${base}${u.startsWith("/") ? "" : "/"}${u}`);
    const urls: { loc: string; lastmod: string }[] = [];
    for (const c of ctx.collections.values()) {
      if (o.collections && !o.collections.includes(c.slug)) continue;
      if (!c.url || c.visibility !== "public" || c.access?.read || c.single || c.snippets) continue;
      for (const d of await repo.listDocs({ collection: c.slug, published: true })) {
        const pub = d.published;
        if (!pub || (pub as DocContent).seo?.noindex) continue;
        if (!(await ctx.publicReadable(c.slug, pub.slug ?? d.slug))) continue;
        const u = ctx.urlOf(c.slug, pub.slug ?? d.slug);
        if (u) urls.push({ loc: abs((pub as DocContent).seo?.canonical || u), lastmod: d.republishedAt ?? d.publishedAt ?? d.updatedAt });
      }
    }
    urls.sort((a, b) => a.loc.localeCompare(b.loc));
    const PER = 50_000;
    const head = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    if (urls.length > PER && (o.page === undefined || o.page === null)) {
      const n = Math.ceil(urls.length / PER);
      return `${head}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Array.from({ length: n }, (_, i) => `  <sitemap><loc>${xmlEsc(`${o.self ?? `${base}/sitemap.xml`}?page=${i + 1}`)}</loc></sitemap>`).join("\n")}\n</sitemapindex>\n`;
    }
    const page = urls.length > PER ? urls.slice(((o.page ?? 1) - 1) * PER, (o.page ?? 1) * PER) : urls;
    return `${head}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${page.map((u) => `  <url><loc>${xmlEsc(u.loc)}</loc><lastmod>${xmlEsc(u.lastmod.slice(0, 10))}</lastmod></url>`).join("\n")}\n</urlset>\n`;
  }

  return {
    relationFields,
    resolveRelations,
    relationDiagnostics,
    relationIds,
    syncRefs,
    referencedBy,
    expand,
    expandSnippets,
    snippetDiagnostics,
    snippetUsage,
    forgetSnippets,
    snippetCols,
    videoDiagnostics,
    lostAnchors,
    keepAnchors,
    resolveAnchor,
    aliasMap,
    treeOf,
    placeIn,
    buildTree,
    byPosition,
    redirectsOn,
    resolveRedirect,
    saveRedirect,
    autoRedirect,
    listRedirects,
    redirectAt,
    forgetRedirects,
    flushHits,
    seoDiagnostics,
    seoFor,
    sitemap,
    videoHosts: ctx.videoHosts.length ? ctx.videoHosts : DEFAULT_VIDEO_HOSTS,
  };
}

export type CmsModel = ReturnType<typeof createModel>;
