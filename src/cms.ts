/**
 * The CMS itself: every rule about documents, versions, publishing, access,
 * search, gaps, keys, coverage and deploy sync. Transport-free — REST
 * (`http.ts`), MCP (`mcp.ts`) and agent lookup (`agent.ts`) are thin shells over
 * this object, so the three can never disagree.
 */

import type { ZodTypeAny } from "zod";
import { matchesAny } from "./glob";
import { displayPrefix, generateKey, hashKey } from "./keys";
import { appLinkKeys } from "./markdown";
import type { CmsRepo, DocPatch } from "./repo";
import { normalizeQuery, SearchIndex, unitsOf, type SearchHit } from "./search";
import {
  CmsError,
  type Actor,
  type CmsDoc,
  type CmsGap,
  type CmsKey,
  type CmsVersion,
  type CollectionConfig,
  type DocContent,
  type DocStatus,
  type KeyScope,
} from "./types";

export function defineCollection<F extends ZodTypeAny | undefined>(c: CollectionConfig<F>): CollectionConfig<F> {
  return c;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIMITS = { slug: 120, title: 200, summary: 300, body: 60_000, keyword: 40, keywords: 30, covers: 40 } as const;

export interface DocInput {
  slug?: string;
  title?: string;
  summary?: string;
  body?: string;
  category?: string | null;
  keywords?: string[];
  covers?: string[];
  fields?: Record<string, unknown>;
}

export interface WriteOptions {
  /** Version the caller last read; a mismatch is a 409 (someone else saved). */
  expectedVersion?: number;
  /** Why it changed (shown in the version list). */
  note?: string | null;
  /** The PR this change ships with: the doc goes `pending` until that PR deploys. */
  pr?: number | null;
  /** Publish right away (needs publish permission). */
  publish?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when nothing relevant was found (also logged as a gap when enabled). */
  empty: boolean;
}

export interface CoverageDoc {
  collection: string;
  slug: string;
  title: string;
  status: DocStatus;
  matched: string[];
  /** This PR already carries a version of the doc. */
  updatedInPr: boolean;
}

export interface CreateCmsOptions {
  repo: CmsRepo;
  collections: CollectionConfig[];
  /** How often to check whether another process changed documents (ms). Default 60s. */
  searchRefreshMs?: number;
  /** Search results below this coverage count as "nothing found". Default 0.5. */
  minCoverage?: number;
  now?: () => Date;
  onError?: (err: unknown, where: string) => void;
}

export type Cms = ReturnType<typeof createCms>;

export function createCms(opts: CreateCmsOptions) {
  const repo = opts.repo;
  const now = opts.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const collections = new Map(opts.collections.map((c) => [c.slug, c]));
  const minCoverage = opts.minCoverage ?? 0.5;
  const refreshMs = opts.searchRefreshMs ?? 60_000;
  const report = opts.onError ?? ((err: unknown, where: string) => console.warn(`[agent-cms] ${where}:`, err));
  const listeners = new Set<(doc: CmsDoc) => void>();

  // ── access ────────────────────────────────────────────────────────────────

  function collection(slug: string): CollectionConfig {
    const c = collections.get(slug);
    if (!c) throw new CmsError("unknown_collection", `컬렉션 없음: ${slug}`);
    return c;
  }

  function keyCovers(actor: Extract<Actor, { kind: "key" }>, col: string): boolean {
    return !actor.collections || actor.collections.includes(col);
  }

  function can(actor: Actor, col: string, what: "read" | "write" | "publish", doc?: CmsDoc | null): boolean {
    const c = collection(col);
    if (actor.kind === "system") return true;
    if (actor.kind === "key") {
      if (!keyCovers(actor, col)) return false;
      const need: KeyScope = what;
      return actor.scopes.includes(need) || actor.scopes.includes("admin") || (what === "read" && actor.scopes.includes("write"));
    }
    if (what === "read") return c.access?.read ? c.access.read({ actor, collection: col, doc }) : true;
    const fn = what === "write" ? c.access?.write : c.access?.publish;
    if (fn) return fn({ actor, collection: col, doc });
    return actor.kind === "user" && actor.isAdmin;
  }

  function assert(actor: Actor, col: string, what: "read" | "write" | "publish", doc?: CmsDoc | null) {
    if (can(actor, col, what, doc)) return;
    if (actor.kind === "anonymous") throw new CmsError("unauthorized", "로그인이나 API 키가 필요함");
    throw new CmsError("forbidden", what === "publish" ? "게시 권한 없음" : what === "write" ? "편집 권한 없음" : "읽기 권한 없음");
  }

  function actorRef(actor: Actor): { kind: "user" | "key" | "system"; id: string | null; label: string } {
    if (actor.kind === "user") return { kind: "user", id: actor.id, label: actor.label };
    if (actor.kind === "key") return { kind: "key", id: actor.id, label: actor.label };
    if (actor.kind === "system") return { kind: "system", id: null, label: actor.label };
    throw new CmsError("unauthorized", "로그인이나 API 키가 필요함");
  }

  // ── validation ────────────────────────────────────────────────────────────

  function contentOf(doc: DocContent): DocContent {
    return {
      slug: doc.slug,
      title: doc.title,
      summary: doc.summary,
      body: doc.body,
      category: doc.category,
      keywords: [...doc.keywords],
      covers: [...doc.covers],
      fields: structuredClone(doc.fields ?? {}),
    };
  }

  function validate(col: string, c: DocContent): DocContent {
    const cfg = collection(col);
    const out = contentOf(c);
    out.slug = out.slug.trim();
    out.title = out.title.trim();
    out.summary = (out.summary ?? "").trim();
    out.keywords = [...new Set(out.keywords.map((k) => k.trim()).filter(Boolean))];
    out.covers = [...new Set(out.covers.map((k) => k.trim()).filter(Boolean))];
    if (!(cfg.slugPattern ?? SLUG_RE).test(out.slug) || out.slug.length > LIMITS.slug) throw new CmsError("invalid", "주소(slug)는 영문 소문자, 숫자, 하이픈만 쓸 수 있음");
    if (!out.title || out.title.length > LIMITS.title) throw new CmsError("invalid", `제목은 1~${LIMITS.title}자`);
    if (out.summary.length > LIMITS.summary) throw new CmsError("invalid", `요약은 ${LIMITS.summary}자 이하`);
    if (out.body.length > LIMITS.body) throw new CmsError("invalid", "본문이 너무 김");
    if (out.keywords.length > LIMITS.keywords || out.keywords.some((k) => k.length > LIMITS.keyword)) throw new CmsError("invalid", "검색어가 너무 많거나 김");
    if (out.covers.length > LIMITS.covers) throw new CmsError("invalid", "담당 코드가 너무 많음");
    for (const ch of cfg.forbiddenChars ?? []) {
      if (out.body.includes(ch) || out.title.includes(ch) || out.summary.includes(ch)) {
        throw new CmsError("invalid", `‘${ch}’ 문자는 쓸 수 없음`);
      }
    }
    if (cfg.categories) {
      if (out.category === null || !cfg.categories.includes(out.category)) {
        throw new CmsError("invalid", `분류는 ${cfg.categories.join(", ")} 중 하나`);
      }
    }
    if (cfg.fields) {
      const parsed = cfg.fields.safeParse(out.fields ?? {});
      if (!parsed.success) throw new CmsError("invalid", `필드 오류: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      out.fields = parsed.data as Record<string, unknown>;
    }
    if (cfg.links) {
      const bad = appLinkKeys(out.body).filter((k) => !cfg.links!.resolve(k));
      if (bad.length) throw new CmsError("invalid", `모르는 화면 링크: ${bad.join(", ")}`);
    }
    return out;
  }

  // jsonb does not keep key order, so compare with sorted keys.
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  const same = (a: DocContent, b: DocContent) => JSON.stringify(stable(contentOf(a))) === JSON.stringify(stable(contentOf(b)));

  // ── reads ─────────────────────────────────────────────────────────────────

  /** What a reader without write access sees: the published snapshot only. */
  function publicView(doc: CmsDoc): CmsDoc | null {
    if (doc.publishedVersion === null || doc.status === "archived" || !doc.published) return null;
    return { ...doc, ...contentOf(doc.published), version: doc.publishedVersion, needsReview: false, reviewReason: null, pendingPr: null };
  }

  async function get(actor: Actor, col: string, slug: string, o: { draft?: boolean } = {}): Promise<CmsDoc> {
    collection(col);
    const doc = await repo.findDoc(col, slug);
    if (!doc) throw new CmsError("not_found", "문서를 찾을 수 없음");
    if (o.draft && can(actor, col, "write", doc)) return doc;
    assert(actor, col, "read", doc);
    const pub = publicView(doc);
    if (!pub) throw new CmsError("not_found", "문서를 찾을 수 없음");
    return pub;
  }

  async function list(
    actor: Actor,
    col: string,
    o: { drafts?: boolean; status?: DocStatus; needsReview?: boolean; category?: string } = {}
  ): Promise<CmsDoc[]> {
    collection(col);
    const editor = o.drafts && can(actor, col, "write");
    if (!editor) assert(actor, col, "read");
    const rows = editor
      ? await repo.listDocs({ collection: col, statuses: o.status ? [o.status] : undefined, needsReview: o.needsReview })
      : (await repo.listDocs({ collection: col, published: true })).map(publicView).filter((d): d is CmsDoc => !!d);
    return rows
      .filter((d) => !o.category || d.category === o.category)
      .sort((a, b) => (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt));
  }

  async function versions(actor: Actor, col: string, slug: string): Promise<CmsVersion[]> {
    const doc = await repo.findDoc(col, slug);
    if (!doc) throw new CmsError("not_found", "문서를 찾을 수 없음");
    assert(actor, col, "write", doc);
    return (await repo.listVersions(doc.id)).map((v) => ({ ...v, published: v.version === doc.publishedVersion }));
  }

  async function version(actor: Actor, col: string, slug: string, n: number): Promise<CmsVersion> {
    const doc = await repo.findDoc(col, slug);
    if (!doc) throw new CmsError("not_found", "문서를 찾을 수 없음");
    assert(actor, col, "write", doc);
    const v = await repo.getVersion(doc.id, n);
    if (!v) throw new CmsError("not_found", `v${n} 없음`);
    return { ...v, published: v.version === doc.publishedVersion };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  function changed(doc: CmsDoc) {
    index.dirty = true;
    for (const l of listeners) {
      try {
        l(doc);
      } catch (e) {
        report(e, "onChange");
      }
    }
    for (const h of collection(doc.collection).hooks?.afterChange ?? []) {
      Promise.resolve(h(doc)).catch((e) => report(e, "afterChange"));
    }
  }

  async function prune(r: CmsRepo, doc: CmsDoc) {
    const max = collection(doc.collection).versions?.max ?? 100;
    if (max > 0) await r.pruneVersions(doc.id, max, doc.publishedVersion ? [doc.publishedVersion] : []);
  }

  function checkOptions(o: WriteOptions) {
    if (o.publish && o.pr) throw new CmsError("invalid", "publish와 pr은 같이 쓸 수 없음 (pr이면 배포 때 게시됨)");
  }

  async function create(actor: Actor, col: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    checkOptions(o);
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
      covers: input.covers ?? [],
      fields: input.fields ?? {},
    });
    const at = nowIso();
    const doc = await repo.tx(async (r) => {
      if (await r.findDoc(col, content.slug)) throw new CmsError("conflict", `이미 있는 주소: ${content.slug}`);
      const publish = !!o.publish && !o.pr;
      const row = await r.insertDoc({
        collection: col,
        ...content,
        status: o.pr ? "pending" : publish ? "published" : "draft",
        version: 1,
        publishedVersion: publish ? 1 : null,
        published: publish ? content : null,
        needsReview: false,
        reviewReason: null,
        pendingPr: o.pr ?? null,
        publishedAt: publish ? at : null,
        updatedBy: who.label,
        updatedByKind: who.kind,
        createdAt: at,
        updatedAt: at,
      });
      await r.insertVersion({ documentId: row.id, version: 1, snapshot: content, authorKind: who.kind, authorId: who.id, authorLabel: who.label, note: o.note ?? null, pr: o.pr ?? null, createdAt: at });
      return row;
    });
    changed(doc);
    return doc;
  }

  /** Write a new version from `next`; decides the status. */
  async function commit(r: CmsRepo, actor: Actor, doc: CmsDoc, next: DocContent, o: WriteOptions & { restoredFrom?: number }): Promise<CmsDoc> {
    const who = actorRef(actor);
    const cfg = collection(doc.collection);
    const at = nowIso();
    const v = doc.version + 1;
    if (next.slug !== doc.slug && doc.publishedVersion !== null) throw new CmsError("invalid", "게시된 문서의 주소는 바꿀 수 없음");
    if (next.slug !== doc.slug && (await r.findDoc(doc.collection, next.slug))) throw new CmsError("conflict", `이미 있는 주소: ${next.slug}`);

    const inPlace = cfg.versions?.drafts === false && doc.publishedVersion !== null && doc.status !== "archived";
    const publish = !o.pr && (o.publish || inPlace);
    let patch: DocPatch = { ...next, version: v, updatedBy: who.label, updatedByKind: who.kind, updatedAt: at };
    if (o.pr) patch = { ...patch, status: "pending", pendingPr: o.pr };
    else if (publish)
      patch = { ...patch, status: "published", publishedVersion: v, published: next, publishedAt: doc.publishedAt ?? at, pendingPr: null, needsReview: false, reviewReason: null };
    else patch = { ...patch, status: doc.status === "archived" ? "archived" : "draft", pendingPr: null };

    const updated = await r.updateDoc(doc.id, patch, o.expectedVersion ?? doc.version);
    if (!updated) throw new CmsError("conflict", "다른 곳에서 바뀜. 다시 불러온 뒤 저장해 주세요");
    await r.insertVersion({
      documentId: doc.id,
      version: v,
      snapshot: next,
      authorKind: who.kind,
      authorId: who.id,
      authorLabel: who.label,
      note: o.note ?? (o.restoredFrom ? `v${o.restoredFrom}로 되돌림` : null),
      pr: o.pr ?? null,
      createdAt: at,
    });
    await prune(r, updated);
    return updated;
  }

  async function update(actor: Actor, col: string, slug: string, input: DocInput, o: WriteOptions = {}): Promise<CmsDoc> {
    checkOptions(o);
    const doc = await repo.tx(async (r) => {
      const cur = await r.findDoc(col, slug);
      if (!cur) throw new CmsError("not_found", "문서를 찾을 수 없음");
      assert(actor, col, "write", cur);
      if (o.publish || (collection(col).versions?.drafts === false && cur.publishedVersion !== null)) assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw new CmsError("conflict", "다른 곳에서 바뀜. 다시 불러온 뒤 저장해 주세요");
      const next = validate(col, {
        slug: input.slug ?? cur.slug,
        title: input.title ?? cur.title,
        summary: input.summary ?? cur.summary,
        body: input.body ?? cur.body,
        category: input.category !== undefined ? input.category : cur.category,
        keywords: input.keywords ?? cur.keywords,
        covers: input.covers ?? cur.covers,
        fields: input.fields ? { ...cur.fields, ...input.fields } : cur.fields,
      });
      if (same(next, cur)) {
        // Nothing changed. Still honour "publish" / "this PR covers it".
        if (o.pr && cur.status !== "published") return (await r.updateDoc(cur.id, { status: "pending", pendingPr: o.pr })) ?? cur;
        if (o.pr && cur.status === "published") {
          // Unchanged but reviewed for this PR: record it so the CI guard passes.
          return commit(r, actor, cur, next, { ...o, note: o.note ?? "변경 없음 확인" });
        }
        if (o.publish && cur.publishedVersion !== cur.version) return publishIn(r, actor, cur, cur.version);
        return cur;
      }
      return commit(r, actor, cur, next, o);
    });
    changed(doc);
    return doc;
  }

  async function publishIn(r: CmsRepo, actor: Actor, doc: CmsDoc, n: number): Promise<CmsDoc> {
    const v = n === doc.version ? { snapshot: contentOf(doc) } : await r.getVersion(doc.id, n);
    if (!v) throw new CmsError("not_found", `v${n} 없음`);
    const at = nowIso();
    const latest = n === doc.version;
    const updated = await r.updateDoc(doc.id, {
      status: latest ? "published" : "draft",
      publishedVersion: n,
      published: v.snapshot,
      publishedAt: doc.publishedAt ?? at,
      pendingPr: null,
      needsReview: false,
      reviewReason: null,
      updatedAt: at,
      updatedBy: actorRef(actor).label,
      updatedByKind: actorRef(actor).kind,
    });
    if (!updated) throw new CmsError("not_found", "문서를 찾을 수 없음");
    return updated;
  }

  async function publish(actor: Actor, col: string, slug: string, o: { version?: number; expectedVersion?: number } = {}): Promise<CmsDoc> {
    const doc = await repo.tx(async (r) => {
      const cur = await r.findDoc(col, slug);
      if (!cur) throw new CmsError("not_found", "문서를 찾을 수 없음");
      assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw new CmsError("conflict", "다른 곳에서 바뀜. 다시 불러온 뒤 게시해 주세요");
      return publishIn(r, actor, cur, o.version ?? cur.version);
    });
    changed(doc);
    return doc;
  }

  async function setArchived(actor: Actor, col: string, slug: string, archived: boolean): Promise<CmsDoc> {
    const doc = await repo.tx(async (r) => {
      const cur = await r.findDoc(col, slug);
      if (!cur) throw new CmsError("not_found", "문서를 찾을 수 없음");
      assert(actor, col, "publish", cur);
      if (archived) {
        if (cur.publishedVersion === null) throw new CmsError("invalid", "게시된 문서만 숨길 수 있음");
        return (await r.updateDoc(cur.id, { status: "archived", updatedAt: nowIso() }))!;
      }
      if (cur.status !== "archived") return cur;
      return (await r.updateDoc(cur.id, { status: cur.publishedVersion === cur.version ? "published" : "draft", updatedAt: nowIso() }))!;
    });
    changed(doc);
    return doc;
  }

  async function restore(actor: Actor, col: string, slug: string, n: number, o: WriteOptions = {}): Promise<CmsDoc> {
    const doc = await repo.tx(async (r) => {
      const cur = await r.findDoc(col, slug);
      if (!cur) throw new CmsError("not_found", "문서를 찾을 수 없음");
      assert(actor, col, "write", cur);
      if (o.publish || (collection(col).versions?.drafts === false && cur.publishedVersion !== null)) assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw new CmsError("conflict", "다른 곳에서 바뀜. 다시 불러온 뒤 되돌려 주세요");
      const v = await r.getVersion(cur.id, n);
      if (!v) throw new CmsError("not_found", `v${n} 없음`);
      return commit(r, actor, cur, validate(col, { ...v.snapshot, slug: cur.slug }), { ...o, restoredFrom: n });
    });
    changed(doc);
    return doc;
  }

  async function markReviewed(actor: Actor, col: string, slug: string): Promise<CmsDoc> {
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw new CmsError("not_found", "문서를 찾을 수 없음");
    assert(actor, col, "write", cur);
    const doc = (await repo.updateDoc(cur.id, { needsReview: false, reviewReason: null }))!;
    changed(doc);
    return doc;
  }

  async function remove(actor: Actor, col: string, slug: string): Promise<void> {
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw new CmsError("not_found", "문서를 찾을 수 없음");
    assert(actor, col, "publish", cur);
    await repo.deleteDoc(cur.id);
    changed(cur);
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
        // Stamp first: a change landing mid-build leaves a newer stamp behind.
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

  async function search(
    actor: Actor,
    cols: string[],
    query: string,
    o: { limit?: number; perDoc?: number; logGap?: boolean; filter?: (u: SearchHit["unit"]) => boolean } = {}
  ): Promise<SearchResult> {
    for (const c of cols) assert(actor, c, "read");
    const idx = await searchIndex();
    const limit = Math.max(1, Math.min(o.limit ?? 5, 50));
    const hits = idx
      .search(query, { limit, perDoc: o.perDoc ?? 2, filter: (u) => cols.includes(u.collection) && (!o.filter || o.filter(u)) })
      .filter((h) => h.coverage >= minCoverage);
    const empty = hits.length === 0;
    // Gaps are written only on request and never for anonymous callers, so a
    // public search box cannot fill the table.
    if (empty && o.logGap === true && actor.kind !== "anonymous" && query.trim()) {
      for (const c of cols) {
        if (collection(c).search?.gapLogging) void recordGap(c, "no_result", query, null, null);
      }
    }
    return { hits, empty };
  }

  // ── gaps ──────────────────────────────────────────────────────────────────

  async function recordGap(col: string, kind: CmsGap["kind"], query: string, note: string | null, slug: string | null) {
    const q = query.trim().slice(0, 300);
    if (!q) return;
    const normalized = normalizeQuery(q) || q.toLowerCase();
    await repo
      .upsertGap({ collection: col, kind, query: q, normalized: normalized.slice(0, 200), note: note?.slice(0, 1000) ?? null, documentSlug: slug, at: nowIso() })
      .catch((e) => report(e, "recordGap"));
  }

  async function reportGap(actor: Actor, col: string, g: { question: string; note?: string | null; slug?: string | null }) {
    // Any signed-in reader or key may report (the agent reports on behalf of
    // the user it serves); anonymous callers may not write.
    assert(actor, col, "read");
    if (actor.kind === "anonymous") throw new CmsError("unauthorized", "로그인이나 API 키가 필요함");
    await recordGap(col, "reported", g.question, g.note ?? null, g.slug ?? null);
  }

  async function gaps(actor: Actor, col: string, state?: CmsGap["state"]): Promise<CmsGap[]> {
    assert(actor, col, "write");
    const rows = await repo.listGaps({ collection: col, state });
    return rows.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async function setGapState(actor: Actor, col: string, id: string, state: CmsGap["state"]) {
    assert(actor, col, "write");
    const g = await repo.setGapState(id, state);
    if (!g || g.collection !== col) throw new CmsError("not_found", "항목을 찾을 수 없음");
    return g;
  }

  // ── usage counts ──────────────────────────────────────────────────────────

  async function recordHits(docIds: string[]) {
    if (!docIds.length) return;
    await repo.addHits([...new Set(docIds)], nowIso().slice(0, 10)).catch((e) => report(e, "recordHits"));
  }

  async function hitCounts(actor: Actor, col: string, days = 7): Promise<Map<string, number>> {
    assert(actor, col, "write");
    const since = new Date(now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return repo.hitCounts(since);
  }

  // ── coverage + deploy ─────────────────────────────────────────────────────

  async function coverage(actor: Actor, files: string[], pr: number | null): Promise<CoverageDoc[]> {
    // Coverage reveals working copies (drafts), so public readers may not call it:
    // only keys, system, or users with write access.
    if (actor.kind === "anonymous") throw new CmsError("unauthorized", "API 키가 필요함");
    const cols = [...collections.values()].filter(
      (c) => c.coverage && (actor.kind === "user" ? can(actor, c.slug, "write") : can(actor, c.slug, "read"))
    );
    if (!cols.length) throw new CmsError("forbidden", "읽을 수 있는 컬렉션 없음");
    const out: CoverageDoc[] = [];
    for (const c of cols) {
      for (const d of await repo.listDocs({ collection: c.slug })) {
        if (d.status === "archived" || !d.covers.length) continue;
        const matched = files.filter((f) => matchesAny(f, d.covers));
        if (!matched.length) continue;
        const updatedInPr = pr !== null && (d.pendingPr === pr || (await repo.listVersions(d.id)).some((v) => v.pr === pr));
        out.push({ collection: c.slug, slug: d.slug, title: d.title, status: d.status, matched, updatedInPr });
      }
    }
    return out;
  }

  /**
   * After a deploy: publish what waited for these PRs, and flag documents
   * whose code changed without them for review.
   */
  async function deploySync(actor: Actor, o: { prs: number[]; files: string[]; sha?: string | null }) {
    const cols = [...collections.values()].filter((c) => c.coverage && can(actor, c.slug, "publish"));
    if (!cols.length) throw new CmsError(actor.kind === "anonymous" ? "unauthorized" : "forbidden", "게시 권한이 있는 컬렉션 없음");
    const published: string[] = [];
    const flagged: string[] = [];
    for (const c of cols) {
      for (const d of await repo.listDocs({ collection: c.slug })) {
        if (d.status === "pending" && d.pendingPr !== null && o.prs.includes(d.pendingPr)) {
          const doc = await repo.tx((r) => publishIn(r, actor, d, d.version));
          changed(doc);
          published.push(`${c.slug}/${d.slug}`);
          continue;
        }
        // Never-published drafts have no public copy that could be stale.
        if (d.status === "archived" || d.publishedVersion === null || !d.covers.length) continue;
        const matched = o.files.filter((f) => matchesAny(f, d.covers));
        if (!matched.length) continue;
        const shippedWith = (await repo.listVersions(d.id)).some((v) => v.pr !== null && o.prs.includes(v.pr));
        if (shippedWith) continue;
        const doc = await repo.updateDoc(d.id, {
          needsReview: true,
          reviewReason: { pr: o.prs[0] ?? null, sha: o.sha ?? null, files: matched.slice(0, 20), at: nowIso() },
        });
        if (doc) changed(doc);
        flagged.push(`${c.slug}/${d.slug}`);
      }
    }
    return { published, flagged };
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  function assertKeyAdmin(actor: Actor) {
    const ok = actor.kind === "system" || (actor.kind === "user" && actor.isAdmin) || (actor.kind === "key" && actor.scopes.includes("admin"));
    if (!ok) throw new CmsError(actor.kind === "anonymous" ? "unauthorized" : "forbidden", "키 관리 권한 없음");
  }

  const toKey = (k: CmsKey & { hash?: string }): CmsKey => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    collections: k.collections,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  });

  async function createKey(actor: Actor, input: { name: string; scopes: KeyScope[]; collections?: string[] | null }) {
    assertKeyAdmin(actor);
    const name = input.name.trim();
    if (!name || name.length > 60) throw new CmsError("invalid", "이름은 1~60자");
    if (!input.scopes.length) throw new CmsError("invalid", "권한을 하나 이상 고르세요");
    for (const c of input.collections ?? []) collection(c);
    if (actor.kind === "key") {
      // A key may only mint keys that are a subset of itself.
      if (input.scopes.some((s) => !actor.scopes.includes(s))) throw new CmsError("forbidden", "이 키보다 넓은 권한은 줄 수 없음");
      if (actor.collections) {
        const asked = input.collections?.length ? input.collections : null;
        if (!asked || asked.some((c) => !actor.collections!.includes(c))) throw new CmsError("forbidden", "이 키가 못 보는 컬렉션은 줄 수 없음");
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
    });
    return { key: toKey(row), secret: raw };
  }

  async function listKeys(actor: Actor): Promise<CmsKey[]> {
    assertKeyAdmin(actor);
    return (await repo.listKeys()).map(toKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function revokeKey(actor: Actor, id: string) {
    assertKeyAdmin(actor);
    if (!(await repo.revokeKey(id, nowIso()))) throw new CmsError("not_found", "키를 찾을 수 없음");
  }

  /** Resolve a raw key to an actor (null when unknown or revoked). */
  async function authenticateKey(raw: string): Promise<Extract<Actor, { kind: "key" }> | null> {
    const row = await repo.findKeyByHash(hashKey(raw));
    if (!row || row.revokedAt) return null;
    const at = now();
    if (!row.lastUsedAt || at.getTime() - Date.parse(row.lastUsedAt) > 5 * 60_000) {
      void repo.touchKey(row.id, at.toISOString()).catch((e) => report(e, "touchKey"));
    }
    return { kind: "key", id: row.id, label: row.name, scopes: row.scopes, collections: row.collections };
  }

  return {
    collections: () => [...collections.values()],
    collection,
    can,
    get,
    list,
    versions,
    version,
    create,
    update,
    publish,
    archive: (a: Actor, c: string, s: string) => setArchived(a, c, s, true),
    unarchive: (a: Actor, c: string, s: string) => setArchived(a, c, s, false),
    restore,
    markReviewed,
    remove,
    search,
    reportGap,
    gaps,
    setGapState,
    recordHits,
    hitCounts,
    coverage,
    deploySync,
    createKey,
    listKeys,
    revokeKey,
    authenticateKey,
    /** Warm the search index (e.g. at boot) so the first agent call is fast. */
    warm: () => searchIndex().then(() => undefined),
    onChange(fn: (doc: CmsDoc) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    repo,
  };
}
