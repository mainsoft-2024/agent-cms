/** `CmsRepo` on Postgres via Drizzle (node-postgres, pglite and other `PgDatabase` drivers with transactions). */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgDatabase } from "drizzle-orm/pg-core";
import { CmsError } from "./errors";
import type { AssetPatch, AssetQuery, AuditQuery, CmsRepo, PruneTarget, DocFilter, DocPatch, FindOptions, KeyRow, NewAsset, NewAudit, NewComment, NewDoc, JobPatch, NewFilter, NewJob, NewRelease, NewWebhook, WebhookPatch, NewVersion, ReleasePatch, StoredVersion, VersionPatch, NewRecord, RecordPatch, RecordQuery, VersionStamp, NewChange, ChangeRow, DocPageQuery, DocPage, NewRedirect, RedirectPatch } from "./repo";
import type { CmsRedirect, DocRef } from "./types";
import { SCHEMA_VERSION } from "./schema-version";
import { defaultTables, LEGACY_COLUMNS, type CmsTables } from "./tables";
import type { AssetKind, AssetRef, AuditEntry, CmsAsset, CmsComment, CmsDoc, CmsJob, CmsRecord, CmsRelease, CmsWebhook, WebhookDelivery, WebhookEvent, DocStatus, KeyScope, Presence, ReviewMark, SavedFilter } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

const iso = (d: Date | string | null | undefined) => (d == null ? null : typeof d === "string" ? new Date(d).toISOString() : d.toISOString());
const date = (s: string | null | undefined) => (s == null ? null : new Date(s));

/** A unique-index race (two creates with one slug) is a 409, not a 500. */
async function uniq<T>(p: Promise<T>, slug?: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if (err?.code === "23505" || err?.cause?.code === "23505") throw new CmsError("slug_taken", { slug: slug ?? "" });
    throw e;
  }
}

export interface DrizzleRepoOptions {
  /** A table set from `cmsTables({ prefix, schema })`. Default: the `cms_*` tables. */
  tables?: CmsTables;
  /**
   * Whether the driver has transactions (0.17.0). `"auto"` (default) uses them and, on a driver
   * that refuses them (`drizzle-orm/neon-http`), runs each change as separate statements and
   * warns once. Every write still checks the version it read, so two saves never both win; what
   * is lost is all-or-nothing when a statement fails half way (`doctor` finds and reports that).
   * Prefer a driver with transactions (`@neondatabase/serverless` Pool, node-postgres, postgres.js).
   */
  transactions?: "auto" | boolean;
  /** Told once when transactions turn out to be missing. Default `console.warn`. */
  warn?: (message: string) => void;
}

export class DrizzleRepo implements CmsRepo {
  readonly t: CmsTables;
  constructor(
    readonly db: Db,
    o: DrizzleRepoOptions = {}
  ) {
    this.t = o.tables ?? defaultTables;
    this.txMode = o.transactions ?? "auto";
    this.warn = o.warn ?? ((m) => console.warn(`[agent-cms] ${m}`));
  }
  private txMode: "auto" | boolean;
  private warn: (m: string) => void;

  private toDoc(r: typeof this.t.documents.$inferSelect): CmsDoc {
    return {
      id: r.id,
      collection: r.collection,
      slug: r.slug,
      status: r.status as DocStatus,
      title: r.title,
      summary: r.summary,
      body: r.body,
      ...(r.format === "html" ? { format: "html" as const } : {}),
      category: r.category,
      keywords: r.keywords ?? [],
      fields: r.fields ?? {},
      version: r.version,
      publishedVersion: r.publishedVersion,
      published: r.published ?? null,
      publishedAt: iso(r.publishedAt),
      republishedAt: iso(r.republishedAt),
      createdAt: iso(r.createdAt)!,
      updatedAt: iso(r.updatedAt)!,
      updatedBy: r.updatedBy,
      updatedByKind: (r.updatedByKind as CmsDoc["updatedByKind"]) ?? null,
      updatedByAgent: r.updatedByAgent ?? null,
      autosave: r.autosave ? { content: r.autosave, at: iso(r.autosaveAt)!, by: r.autosaveBy, baseVersion: r.autosaveBaseVersion ?? r.version } : null,
      deletedAt: iso(r.deletedAt),
      deletedBy: r.deletedBy ?? null,
      schedule: r.schedule ?? null,
      dueAt: iso(r.dueAt),
      review: r.review ?? null,
      ...(r.parentId != null ? { parentId: r.parentId } : {}),
      ...(r.position != null ? { position: r.position } : {}),
      ...(r.seo != null ? { seo: r.seo } : {}),
    };
  }

  private toRedirect(r: typeof this.t.redirects.$inferSelect): CmsRedirect {
    return {
      id: r.id,
      from: r.fromPath,
      to: r.toPath,
      toDocumentId: r.toDocumentId ?? null,
      status: r.status === 302 ? 302 : 301,
      source: r.source === "auto" ? "auto" : "manual",
      hits: r.hits,
      lastHitAt: iso(r.lastHitAt),
      createdBy: r.createdBy ?? null,
      createdAt: iso(r.createdAt)!,
      updatedAt: iso(r.updatedAt)!,
    };
  }

  async setDocRefs(fromId: string, refs: readonly Omit<DocRef, "fromId">[]) {
    const R = this.t.docRefs;
    await this.db.delete(R).where(eq(R.fromId, fromId));
    const rows = new Map<string, typeof R.$inferInsert>();
    for (const r of refs) if (r.inDraft || r.inPublished) rows.set(`${r.toId}|${r.field}`, { fromId, toId: r.toId, field: r.field, inDraft: r.inDraft, inPublished: r.inPublished });
    if (rows.size) await this.db.insert(R).values([...rows.values()]);
  }
  async listDocRefsTo(toId: string) {
    const R = this.t.docRefs;
    return (await this.db.select().from(R).where(eq(R.toId, toId))).map((r) => ({ fromId: r.fromId, toId: r.toId, field: r.field, inDraft: r.inDraft, inPublished: r.inPublished }));
  }
  async addAnchorAliases(documentId: string, rows: readonly { old: string; current: string }[]) {
    if (!rows.length) return;
    const A = this.t.anchorAliases;
    await this.db
      .insert(A)
      .values(rows.map((r) => ({ documentId, old: r.old, current: r.current })))
      .onConflictDoUpdate({ target: [A.documentId, A.old], set: { current: sql`excluded.current` } });
  }
  async listAnchorAliases(documentId: string) {
    const A = this.t.anchorAliases;
    return (await this.db.select().from(A).where(eq(A.documentId, documentId))).map((r) => ({ documentId: r.documentId, old: r.old, current: r.current, createdAt: iso(r.createdAt)! }));
  }
  async listRedirects() {
    const R = this.t.redirects;
    return (await this.db.select().from(R).orderBy(desc(R.createdAt), desc(R.id))).map((r) => this.toRedirect(r));
  }
  async insertRedirect(r: NewRedirect) {
    const [row] = await this.db
      .insert(this.t.redirects)
      .values({ fromPath: r.from, toPath: r.to, toDocumentId: r.toDocumentId, status: r.status, source: r.source, createdBy: r.createdBy })
      .returning();
    return this.toRedirect(row);
  }
  async updateRedirect(id: string, p: RedirectPatch) {
    const R = this.t.redirects;
    const set: Partial<typeof R.$inferInsert> = { updatedAt: new Date() };
    if (p.from !== undefined) set.fromPath = p.from;
    if (p.to !== undefined) set.toPath = p.to;
    if (p.toDocumentId !== undefined) set.toDocumentId = p.toDocumentId;
    if (p.status !== undefined) set.status = p.status;
    if (p.source !== undefined) set.source = p.source;
    const [row] = await this.db.update(R).set(set).where(eq(R.id, id)).returning();
    return row ? this.toRedirect(row) : null;
  }
  async deleteRedirect(id: string) {
    await this.db.delete(this.t.redirects).where(eq(this.t.redirects.id, id));
  }
  async addRedirectHits(hits: ReadonlyMap<string, number>, at: string) {
    const R = this.t.redirects;
    for (const [id, n] of hits)
      await this.db
        .update(R)
        .set({ hits: sql`${R.hits} + ${n}`, lastHitAt: new Date(at) })
        .where(eq(R.id, id));
  }

  private patchRow(p: DocPatch): Partial<typeof this.t.documents.$inferInsert> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (k === "publishedAt" || k === "updatedAt" || k === "republishedAt" || k === "deletedAt" || k === "dueAt") out[k] = date(v as string | null);
      else if (k === "autosave") {
        const a = v as CmsDoc["autosave"];
        out.autosave = a?.content ?? null;
        out.autosaveAt = a ? new Date(a.at) : null;
        out.autosaveBy = a?.by ?? null;
        out.autosaveBaseVersion = a?.baseVersion ?? null;
      } else out[k] = v;
    }
    return out;
  }

  private toVersion(r: typeof this.t.versions.$inferSelect): StoredVersion {
    return {
      id: r.id,
      documentId: r.documentId,
      version: r.version,
      snapshot: r.snapshot,
      authorKind: r.authorKind as StoredVersion["authorKind"],
      authorId: r.authorId,
      authorLabel: r.authorLabel,
      authorAgent: r.authorAgent ?? null,
      note: r.note,
      changed: r.changed ?? null,
      reviewed: r.reviewed ?? [],
      label: r.label ?? null,
      pinned: !!r.pinned,
      approvedBy: r.approvedBy ?? null,
      approvedAt: iso(r.approvedAt),
      createdAt: iso(r.createdAt)!,
    };
  }

  private toAsset(r: typeof this.t.assets.$inferSelect): CmsAsset {
    return {
      id: r.id,
      store: r.store,
      key: r.key,
      folder: r.folder,
      name: r.name,
      kind: r.kind as AssetKind,
      mime: r.mime,
      size: Number(r.size),
      width: r.width,
      height: r.height,
      duration: r.duration,
      alt: r.alt,
      tags: r.tags ?? [],
      thumbKey: r.thumbKey,
      focalX: r.focalX ?? null,
      focalY: r.focalY ?? null,
      rev: r.rev ?? 0,
      status: r.status as CmsAsset["status"],
      uploadId: r.uploadId,
      createdBy: r.createdBy,
      createdByKind: (r.createdByKind as CmsAsset["createdByKind"]) ?? null,
      createdByAgent: r.createdByAgent ?? null,
      createdAt: iso(r.createdAt)!,
      updatedAt: iso(r.updatedAt)!,
      deletedAt: iso(r.deletedAt),
      deletedBy: r.deletedBy ?? null,
    };
  }

  private toComment(r: typeof this.t.comments.$inferSelect): CmsComment {
    return { id: r.id, documentId: r.documentId, threadId: r.threadId, anchor: r.anchor, quote: r.quote, body: r.body, authorKind: r.authorKind as CmsComment["authorKind"], authorId: r.authorId, authorLabel: r.authorLabel, authorAgent: r.authorAgent ?? null, createdAt: iso(r.createdAt)!, resolvedAt: iso(r.resolvedAt), resolvedBy: r.resolvedBy ?? null };
  }

  private toRelease(r: typeof this.t.releases.$inferSelect): CmsRelease {
    return { id: r.id, name: r.name, state: r.state as CmsRelease["state"], publishAt: iso(r.publishAt), items: r.items ?? [], createdBy: r.createdBy, createdById: r.createdById, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!, publishedAt: iso(r.publishedAt), publishedBy: r.publishedBy ?? null, lastError: r.lastError ?? null };
  }

  private toFilter(r: typeof this.t.savedFilters.$inferSelect): SavedFilter {
    return { id: r.id, collection: r.collection, name: r.name, query: r.query ?? {}, ownerId: r.ownerId, ownerLabel: r.ownerLabel, shared: r.shared, createdAt: iso(r.createdAt)! };
  }

  private toKey(r: typeof this.t.apiKeys.$inferSelect): KeyRow {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      hash: r.hash,
      scopes: r.scopes as KeyScope[],
      collections: r.collections ?? null,
      createdBy: r.createdBy,
      lastUsedAt: iso(r.lastUsedAt),
      revokedAt: iso(r.revokedAt),
      expiresAt: iso(r.expiresAt),
      createdAt: iso(r.createdAt)!,
    };
  }

  tx<T>(fn: (repo: CmsRepo) => Promise<T>, o: { atomic?: boolean } = {}): Promise<T> {
    if (this.txMode === false) {
      if (o.atomic) return Promise.reject(new CmsError("transactions_required"));
      return fn(this);
    }
    let started = false;
    const run = (async () =>
      this.db.transaction((t) => {
        started = true;
        return fn(new DrizzleRepo(t as unknown as Db, { tables: this.t, transactions: true }));
      }))();
    if (this.txMode === true) return run;
    return run.catch((e: unknown) => {
      // neon-http and other one-request drivers refuse before running anything.
      if (started || !/no transactions support|transactions? (are|is) not supported/i.test(e instanceof Error ? e.message : String(e))) throw e;
      this.txMode = false;
      this.warn("this database driver has no transactions: each change runs as separate statements (see DrizzleRepo `transactions`). A driver with transactions is safer: @neondatabase/serverless Pool, node-postgres or postgres.js.");
      if (o.atomic) throw new CmsError("transactions_required");
      return fn(this);
    });
  }

  async findDoc(collection: string, slug: string, o: FindOptions = {}) {
    const D = this.t.documents;
    const [r] = await this.db.select().from(D).where(and(eq(D.collection, collection), eq(D.slug, slug))).limit(1);
    return r && (!r.deletedAt || o.trashed) ? this.toDoc(r) : null;
  }
  async findDocById(id: string, o: FindOptions = {}) {
    const D = this.t.documents;
    const [r] = await this.db.select().from(D).where(eq(D.id, id)).limit(1);
    return r && (!r.deletedAt || o.trashed) ? this.toDoc(r) : null;
  }
  async listDocs(f: DocFilter) {
    const D = this.t.documents;
    const conds = [f.trashed ? isNotNull(D.deletedAt) : isNull(D.deletedAt)];
    if (f.dueBefore) conds.push(lte(D.dueAt, new Date(f.dueBefore)));
    if (f.collection) conds.push(eq(D.collection, f.collection));
    if (f.statuses) conds.push(inArray(D.status, f.statuses));
    if (f.published === true) conds.push(isNotNull(D.publishedVersion), ne(D.status, "archived"));
    const rows = await this.db.select().from(D).where(and(...conds));
    const docs = rows.map((r) => this.toDoc(r));
    return f.published === false ? docs.filter((d) => d.publishedVersion === null || d.status === "archived") : docs;
  }
  async insertDoc(doc: NewDoc) {
    const [r] = await uniq(
      this.db
        .insert(this.t.documents)
        .values({
          ...this.patchRow(doc as DocPatch),
          ...(doc.id ? { id: doc.id } : {}),
          collection: doc.collection,
          slug: doc.slug,
          title: doc.title,
          createdAt: date(doc.createdAt ?? null) ?? undefined,
        })
        .returning(),
      doc.slug
    );
    return this.toDoc(r);
  }
  async updateDoc(id: string, p: DocPatch, expectedVersion?: number) {
    const D = this.t.documents;
    // With an expected version the row must also still be live (not in the trash): a guarded write
    // never lands on a document deleted after it was checked.
    const where = expectedVersion === undefined ? eq(D.id, id) : and(eq(D.id, id), eq(D.version, expectedVersion), isNull(D.deletedAt));
    const [r] = await uniq(
      this.db
        .update(D)
        .set({ ...this.patchRow(p), updatedAt: date(p.updatedAt ?? null) ?? new Date() })
        .where(where)
        .returning(),
      p.slug
    );
    return r ? this.toDoc(r) : null;
  }
  async deleteDoc(id: string) {
    await this.db.delete(this.t.documents).where(eq(this.t.documents.id, id));
  }
  async insertVersion(v: NewVersion) {
    await uniq(
      this.db.insert(this.t.versions).values({
        documentId: v.documentId,
        version: v.version,
        snapshot: v.snapshot,
        authorKind: v.authorKind,
        authorId: v.authorId,
        authorLabel: v.authorLabel,
        authorAgent: v.authorAgent ?? null,
        note: v.note,
        label: v.label ?? null,
        changed: v.changed ?? null,
        createdAt: date(v.createdAt ?? null) ?? undefined,
      })
    );
  }
  async listVersions(documentId: string) {
    const V = this.t.versions;
    const rows = await this.db.select().from(V).where(eq(V.documentId, documentId)).orderBy(desc(V.version));
    return rows.map((r) => this.toVersion(r));
  }
  async pageVersions(documentId: string, o: { limit: number; before?: number | null }) {
    const V = this.t.versions;
    const where = o.before == null ? eq(V.documentId, documentId) : and(eq(V.documentId, documentId), lt(V.version, o.before));
    const rows = await this.db.select().from(V).where(where).orderBy(desc(V.version)).limit(o.limit);
    const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(V).where(eq(V.documentId, documentId));
    return { versions: rows.map((r) => this.toVersion(r)), total: Number(c?.n ?? 0) };
  }
  async getVersion(documentId: string, version: number) {
    const V = this.t.versions;
    const [r] = await this.db.select().from(V).where(and(eq(V.documentId, documentId), eq(V.version, version))).limit(1);
    return r ? this.toVersion(r) : null;
  }
  async setVersionReviewed(documentId: string, version: number, reviewed: ReviewMark[]) {
    const V = this.t.versions;
    await this.db.update(V).set({ reviewed }).where(and(eq(V.documentId, documentId), eq(V.version, version)));
  }
  async updateVersion(documentId: string, version: number, patch: VersionPatch) {
    const V = this.t.versions;
    const { approvedAt, ...rest } = patch;
    const set = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(approvedAt !== undefined ? { approvedAt: date(approvedAt) } : {}) };
    if (Object.keys(set).length) await this.db.update(V).set(set).where(and(eq(V.documentId, documentId), eq(V.version, version)));
  }
  async pruneVersions(documentId: string, keep: number, protect: number[]) {
    const V = this.t.versions;
    const rows = await this.db.select({ id: V.id, version: V.version, pinned: V.pinned }).from(V).where(eq(V.documentId, documentId)).orderBy(desc(V.version));
    const drop = rows.slice(keep).filter((r) => !protect.includes(r.version) && !r.pinned).map((r) => r.id);
    if (drop.length) await this.db.delete(V).where(inArray(V.id, drop));
  }
  async insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null; expiresAt: string | null }) {
    const [r] = await this.db
      .insert(this.t.apiKeys)
      .values({ ...k, expiresAt: date(k.expiresAt) })
      .returning();
    return this.toKey(r);
  }
  async listKeys() {
    return (await this.db.select().from(this.t.apiKeys)).map((r) => this.toKey(r));
  }
  async findKeyByHash(hash: string) {
    const K = this.t.apiKeys;
    const [r] = await this.db.select().from(K).where(eq(K.hash, hash)).limit(1);
    return r ? this.toKey(r) : null;
  }
  async touchKey(id: string, at: string) {
    const K = this.t.apiKeys;
    await this.db.update(K).set({ lastUsedAt: new Date(at) }).where(eq(K.id, id));
  }
  async revokeKey(id: string, at: string) {
    const K = this.t.apiKeys;
    const rows = await this.db
      .update(K)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(K.id, id), sql`(${K.revokedAt} is null or ${K.revokedAt} > ${new Date(at)})`))
      .returning({ id: K.id });
    return rows.length > 0;
  }
  async prune(what: PruneTarget, before: string, dryRun = false) {
    const t = this.t;
    const [table, where] =
      what === "audit"
        ? ([t.audit, lt(t.audit.at, new Date(before))] as const)
        : what === "deliveries"
          ? ([t.webhookDeliveries, lt(t.webhookDeliveries.at, new Date(before))] as const)
          : what === "keys"
            ? ([t.apiKeys, lt(t.apiKeys.revokedAt, new Date(before))] as const)
            : ([t.hits, lt(t.hits.day, before)] as const);
    if (dryRun) {
      const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
      return r?.n ?? 0;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await this.db.delete(table as any).where(where).returning({ one: sql<number>`1` })).length;
  }
  async addHits(ids: string[], day: string, source: string) {
    if (!ids.length) return;
    const H = this.t.hits;
    await this.db
      .insert(H)
      .values(ids.map((documentId) => ({ documentId, day, source, count: 1 })))
      .onConflictDoUpdate({ target: [H.documentId, H.day, H.source], set: { count: sql`${H.count} + 1` } });
  }
  async hitCounts(sinceDay: string, collection?: string) {
    const H = this.t.hits;
    const D = this.t.documents;
    const rows = collection
      ? await this.db
          .select({ id: H.documentId, n: sql<number>`sum(${H.count})::int` })
          .from(H)
          .innerJoin(D, eq(D.id, H.documentId))
          .where(and(gte(H.day, sinceDay), eq(D.collection, collection)))
          .groupBy(H.documentId)
      : await this.db
          .select({ id: H.documentId, n: sql<number>`sum(${H.count})::int` })
          .from(H)
          .where(gte(H.day, sinceDay))
          .groupBy(H.documentId);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }
  async insertAudit(e: NewAudit) {
    await this.db.insert(this.t.audit).values({ ...e, at: new Date(e.at) });
  }
  async listAudit(q: AuditQuery) {
    const A = this.t.audit;
    const conds = [];
    if (q.before) {
      const [at, id] = q.before.split("|");
      conds.push(or(lt(A.at, new Date(at)), and(eq(A.at, new Date(at)), lt(A.id, id))));
    }
    if (q.action) conds.push(eq(A.action, q.action));
    const esc = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
    if (q.actionPrefix) conds.push(sql`${A.action} like ${`${esc(q.actionPrefix)}%`}`);
    if (q.outcome) conds.push(eq(A.outcome, q.outcome));
    if (q.actorKind) conds.push(eq(A.actorKind, q.actorKind));
    if (q.actorId) conds.push(eq(A.actorId, q.actorId));
    if (q.who) conds.push(sql`${A.actorLabel} ilike ${`%${esc(q.who)}%`}`);
    if (q.collection) conds.push(eq(A.collection, q.collection));
    if (q.slug) conds.push(eq(A.slug, q.slug));
    if (q.since) conds.push(gte(A.at, new Date(q.since)));
    if (q.until) conds.push(lt(A.at, new Date(q.until)));
    const rows = await this.db
      .select()
      .from(A)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(A.at), desc(A.id))
      .limit(q.limit);
    return rows.map((r) => ({
      id: r.id,
      at: iso(r.at)!,
      actorKind: r.actorKind as AuditEntry["actorKind"],
      actorId: r.actorId,
      actorLabel: r.actorLabel,
      actorAgent: r.actorAgent ?? null,
      action: r.action as AuditEntry["action"],
      collection: r.collection,
      slug: r.slug,
      version: r.version,
      outcome: r.outcome as AuditEntry["outcome"],
      via: (r.via as AuditEntry["via"]) ?? null,
      detail: r.detail ?? {},
    }));
  }
  async insertAsset(a: NewAsset) {
    const { createdAt, updatedAt, ...rest } = a;
    const [r] = await this.db
      .insert(this.t.assets)
      .values({ ...rest, ...(createdAt ? { createdAt: new Date(createdAt) } : {}), ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {}) })
      .returning();
    return this.toAsset(r);
  }
  async findAsset(id: string, o: FindOptions = {}) {
    const A = this.t.assets;
    const [r] = await this.db.select().from(A).where(eq(A.id, id)).limit(1);
    return r && (!r.deletedAt || o.trashed) ? this.toAsset(r) : null;
  }
  async findAssets(ids: readonly string[]) {
    if (!ids.length) return [];
    const A = this.t.assets;
    return (await this.db.select().from(A).where(and(inArray(A.id, [...ids]), isNull(A.deletedAt)))).map((r) => this.toAsset(r));
  }
  async findAssetByKey(store: string, key: string) {
    const A = this.t.assets;
    const [r] = await this.db.select().from(A).where(and(eq(A.store, store), eq(A.key, key))).limit(1);
    return r ? this.toAsset(r) : null;
  }
  async findAssetsByKeys(store: string, keys: readonly string[]) {
    const A = this.t.assets;
    const out: CmsAsset[] = [];
    // In chunks: a folder listing can hold a thousand keys.
    for (let i = 0; i < keys.length; i += 200) out.push(...(await this.db.select().from(A).where(and(eq(A.store, store), inArray(A.key, keys.slice(i, i + 200))))).map((r) => this.toAsset(r)));
    return out;
  }
  async listAssets(q: AssetQuery) {
    const A = this.t.assets;
    const conds: (SQL | undefined)[] = [q.trashed ? isNotNull(A.deletedAt) : isNull(A.deletedAt)];
    if (q.store) conds.push(eq(A.store, q.store));
    if (q.folder !== undefined) conds.push(eq(A.folder, q.folder));
    if (q.under) conds.push(or(eq(A.folder, q.under), sql`starts_with(${A.folder}, ${`${q.under}/`})`));
    if (q.kinds) conds.push(inArray(A.kind, [...q.kinds]));
    if (q.notKinds) conds.push(notInArray(A.kind, [...q.notKinds]));
    if (q.status) conds.push(eq(A.status, q.status));
    if (q.tag) conds.push(sql`${A.tags} @> ${JSON.stringify([q.tag])}::jsonb`);
    if (q.createdBefore) conds.push(lt(A.createdAt, new Date(q.createdBefore)));
    const needle = q.q?.trim().toLowerCase();
    if (needle) conds.push(sql`(strpos(lower(${A.name}), ${needle}) > 0 or strpos(lower(${A.alt}), ${needle}) > 0 or strpos(lower(${A.tags}::text), ${needle}) > 0)`);
    if (q.before) {
      const [at, id] = q.before.split("|");
      conds.push(or(lt(A.createdAt, new Date(at)), and(eq(A.createdAt, new Date(at)), lt(A.id, id))));
    }
    if (q.unused) {
      const R = this.t.assetRefs;
      conds.push(sql`not exists (select 1 from ${R} where ${R.assetId} = ${A.id})`);
    }
    if (q.missingAlt) conds.push(and(eq(A.kind, "image"), sql`btrim(${A.alt}) = ''`));
    const order = q.sort === "name" ? [sql`lower(${A.name})`, A.id] : q.sort === "size" ? [desc(A.size), A.id] : q.sort === "old" ? [A.createdAt, A.id] : [desc(A.createdAt), desc(A.id)];
    const rows = await this.db
      .select()
      .from(A)
      .where(and(...conds))
      .orderBy(...order)
      .limit(q.limit ?? 1000)
      .offset(q.offset ?? 0);
    return rows.map((r) => this.toAsset(r));
  }
  async countAssets(store?: string) {
    const A = this.t.assets;
    const rows = await this.db
      .select({ store: A.store, folder: A.folder, kind: A.kind, n: sql<number>`count(*)::int` })
      .from(A)
      .where(and(eq(A.status, "ready"), isNull(A.deletedAt), store ? eq(A.store, store) : undefined))
      .groupBy(A.store, A.folder, A.kind);
    return rows.map((r) => ({ store: r.store, folder: r.folder, kind: r.kind as AssetKind, n: Number(r.n) }));
  }
  async updateAsset(id: string, patch: AssetPatch) {
    const A = this.t.assets;
    const { updatedAt, deletedAt, ...rest } = patch;
    const set = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(deletedAt !== undefined ? { deletedAt: date(deletedAt) } : {}) };
    const [r] = await this.db
      .update(A)
      .set({ ...set, updatedAt: updatedAt ? new Date(updatedAt) : new Date() })
      .where(eq(A.id, id))
      .returning();
    return r ? this.toAsset(r) : null;
  }
  async deleteAsset(id: string) {
    await this.db.delete(this.t.assets).where(eq(this.t.assets.id, id));
  }
  async setAssetRefs(documentId: string, refs: readonly Omit<AssetRef, "documentId">[]) {
    const R = this.t.assetRefs;
    await this.db.delete(R).where(eq(R.documentId, documentId));
    const wanted = new Map(refs.filter((r) => r.inDraft || r.inPublished).map((r) => [r.assetId, r]));
    if (!wanted.size) return;
    // Only files that exist: a document may name a file that was deleted.
    const A = this.t.assets;
    const have = await this.db.select({ id: A.id }).from(A).where(inArray(A.id, [...wanted.keys()]));
    const rows = have.map((h) => ({ assetId: h.id, documentId, inDraft: wanted.get(h.id)!.inDraft, inPublished: wanted.get(h.id)!.inPublished }));
    if (rows.length) await this.db.insert(R).values(rows);
  }
  async listAssetRefs(assetId: string) {
    const R = this.t.assetRefs;
    return (await this.db.select().from(R).where(eq(R.assetId, assetId))).map((r) => ({ assetId: r.assetId, documentId: r.documentId, inDraft: r.inDraft, inPublished: r.inPublished }));
  }
  async insertComment(c: NewComment) {
    const [r] = await this.db.insert(this.t.comments).values({ ...c, createdAt: new Date(c.createdAt) }).returning();
    return this.toComment(r);
  }
  async findComment(id: string) {
    const C = this.t.comments;
    const [r] = await this.db.select().from(C).where(eq(C.id, id)).limit(1);
    return r ? this.toComment(r) : null;
  }
  async listComments(documentId: string) {
    const C = this.t.comments;
    return (await this.db.select().from(C).where(eq(C.documentId, documentId)).orderBy(asc(C.createdAt), asc(C.id))).map((r) => this.toComment(r));
  }
  async updateComment(id: string, patch: Pick<CmsComment, "resolvedAt" | "resolvedBy">) {
    const C = this.t.comments;
    const [r] = await this.db.update(C).set({ resolvedAt: date(patch.resolvedAt), resolvedBy: patch.resolvedBy }).where(eq(C.id, id)).returning();
    return r ? this.toComment(r) : null;
  }
  async countComments(documentIds: readonly string[]) {
    if (!documentIds.length) return new Map<string, number>();
    const C = this.t.comments;
    const rows = await this.db
      .select({ id: C.documentId, n: sql<number>`count(*)::int` })
      .from(C)
      .where(and(inArray(C.documentId, [...documentIds]), isNull(C.threadId), isNull(C.resolvedAt)))
      .groupBy(C.documentId);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }
  async insertRelease(n: NewRelease) {
    const [r] = await this.db.insert(this.t.releases).values({ name: n.name, createdBy: n.createdBy, createdById: n.createdById, createdAt: new Date(n.createdAt), updatedAt: new Date(n.createdAt) }).returning();
    return this.toRelease(r);
  }
  async findRelease(id: string) {
    const R = this.t.releases;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [r] = await this.db.select().from(R).where(eq(R.id, id)).limit(1);
    return r ? this.toRelease(r) : null;
  }
  async listReleases() {
    const R = this.t.releases;
    return (await this.db.select().from(R).orderBy(desc(R.createdAt))).map((r) => this.toRelease(r));
  }
  async updateRelease(id: string, patch: ReleasePatch, expected?: CmsRelease["state"] | { state?: CmsRelease["state"]; updatedAt?: string }) {
    const e = typeof expected === "string" ? { state: expected } : (expected ?? {});
    const R = this.t.releases;
    const { publishAt, publishedAt, updatedAt, ...rest } = patch;
    const set = {
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(publishAt !== undefined ? { publishAt: date(publishAt) } : {}),
      ...(publishedAt !== undefined ? { publishedAt: date(publishedAt) } : {}),
      updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
    };
    const conds = [eq(R.id, id)];
    if (e.state) conds.push(eq(R.state, e.state));
    // The revision is the time to the millisecond (older rows may hold microseconds).
    if (e.updatedAt) conds.push(sql`date_trunc('milliseconds', ${R.updatedAt}) = ${new Date(e.updatedAt).toISOString()}::timestamptz`);
    const [r] = await this.db.update(R).set(set).where(and(...conds)).returning();
    return r ? this.toRelease(r) : null;
  }
  async deleteRelease(id: string) {
    await this.db.delete(this.t.releases).where(eq(this.t.releases.id, id));
  }
  async insertFilter(f: NewFilter) {
    const [r] = await this.db.insert(this.t.savedFilters).values({ ...f, createdAt: new Date(f.createdAt) }).returning();
    return this.toFilter(r);
  }
  async findFilter(id: string) {
    const F = this.t.savedFilters;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [r] = await this.db.select().from(F).where(eq(F.id, id)).limit(1);
    return r ? this.toFilter(r) : null;
  }
  async listFilters(collection: string) {
    const F = this.t.savedFilters;
    return (await this.db.select().from(F).where(eq(F.collection, collection)).orderBy(asc(F.name))).map((r) => this.toFilter(r));
  }
  async deleteFilter(id: string) {
    await this.db.delete(this.t.savedFilters).where(eq(this.t.savedFilters.id, id));
  }
  async touchPresence(p: Presence) {
    const P = this.t.presence;
    const row = { label: p.label, kind: p.kind, agent: p.agent, cursor: p.cursor, selection: p.selection, seenAt: new Date(p.seenAt) };
    await this.db
      .insert(P)
      .values({ documentId: p.documentId, actorId: p.actorId, ...row })
      .onConflictDoUpdate({ target: [P.documentId, P.actorId], set: row });
  }
  async listPresence(since: string, documentIds?: readonly string[]) {
    const P = this.t.presence;
    if (documentIds && !documentIds.length) return [];
    const rows = await this.db.select().from(P).where(and(gte(P.seenAt, new Date(since)), documentIds ? inArray(P.documentId, [...documentIds]) : undefined));
    return rows.map((r) => ({ documentId: r.documentId, actorId: r.actorId, label: r.label, kind: r.kind as Presence["kind"], agent: r.agent ?? null, cursor: r.cursor ?? null, selection: r.selection ?? null, seenAt: iso(r.seenAt)! }));
  }
  async dropPresence(documentId: string, actorId: string) {
    const P = this.t.presence;
    await this.db.delete(P).where(and(eq(P.documentId, documentId), eq(P.actorId, actorId)));
  }
  async prunePresence(before: string) {
    await this.db.delete(this.t.presence).where(lt(this.t.presence.seenAt, new Date(before)));
  }
  async changeStamp() {
    const D = this.t.documents;
    const [r] = await this.db.select({ n: sql<number>`count(*)::int`, max: sql<string | null>`max(${D.updatedAt})::text` }).from(D);
    return `${r?.n ?? 0}:${r?.max ?? ""}`;
  }
  async getMeta(key: string) {
    const M = this.t.meta;
    try {
      const [r] = await this.db.select().from(M).where(eq(M.key, key)).limit(1);
      return r?.value ?? null;
    } catch (e) {
      // A missing meta table reads as "no value" (the schema check then says what to run).
      if ((e as { code?: string; cause?: { code?: string } })?.code === "42P01" || (e as { cause?: { code?: string } })?.cause?.code === "42P01") return null;
      throw e;
    }
  }
  async setMeta(key: string, value: unknown) {
    const M = this.t.meta;
    await this.db
      .insert(M)
      .values({ key, value })
      .onConflictDoUpdate({ target: M.key, set: { value, updatedAt: new Date() } });
  }

  // ── doctor ────────────────────────────────────────────────────────────────

  /** Raw rows of a SQL query, across drivers (node-postgres returns `{ rows }`, pglite too, postgres.js an array). */
  private async rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
    const r = (await this.db.execute(q)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(r) ? r : (r.rows ?? []);
  }

  /** What `agent-cms doctor` checks. Read-only. */
  private iso = (d: Date | null) => (d ? d.toISOString() : null);
  private uuidLike = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
  private toJob(r: typeof this.t.jobs.$inferSelect): CmsJob {
    return { id: r.id, kind: r.kind, payload: r.payload, runAt: r.runAt.toISOString(), attempts: r.attempts, maxAttempts: r.maxAttempts, lockedUntil: this.iso(r.lockedUntil), lastError: r.lastError, doneAt: this.iso(r.doneAt), failedAt: this.iso(r.failedAt), createdAt: r.createdAt.toISOString() };
  }
  private toWebhook(r: typeof this.t.webhooks.$inferSelect): CmsWebhook {
    return { ...r, events: r.events as WebhookEvent[], createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
  }
  private toDelivery(r: typeof this.t.webhookDeliveries.$inferSelect): WebhookDelivery {
    return { ...r, at: r.at.toISOString() };
  }

  async insertJob(j: NewJob) {
    const [r] = await this.db.insert(this.t.jobs).values({ kind: j.kind, payload: j.payload, runAt: new Date(j.runAt), maxAttempts: j.maxAttempts, createdAt: new Date(j.createdAt) }).returning();
    return this.toJob(r);
  }
  async claimJobs(now: string, lockUntil: string, limit: number) {
    const J = this.t.jobs;
    const at = new Date(now);
    // One statement: the inner select skips rows another caller holds, the update takes the rest.
    const due = this.db
      .select({ id: J.id })
      .from(J)
      .where(and(isNull(J.doneAt), isNull(J.failedAt), lte(J.runAt, at), or(isNull(J.lockedUntil), lt(J.lockedUntil, at))))
      .orderBy(asc(J.runAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const rows = await this.db.update(J).set({ lockedUntil: new Date(lockUntil), attempts: sql`${J.attempts} + 1` }).where(inArray(J.id, due)).returning();
    return rows.map((r) => this.toJob(r)).sort((a, b) => a.runAt.localeCompare(b.runAt));
  }
  async updateJob(id: string, patch: JobPatch) {
    const d = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));
    await this.db
      .update(this.t.jobs)
      .set({ runAt: patch.runAt === undefined ? undefined : new Date(patch.runAt), lockedUntil: d(patch.lockedUntil), lastError: patch.lastError, doneAt: d(patch.doneAt), failedAt: d(patch.failedAt) })
      .where(eq(this.t.jobs.id, id));
  }
  async listJobs(q: { state?: "waiting" | "failed" | "done"; kind?: string; limit?: number }) {
    const J = this.t.jobs;
    const w: (SQL | undefined)[] = [q.kind ? eq(J.kind, q.kind) : undefined];
    if (q.state === "done") w.push(isNotNull(J.doneAt));
    if (q.state === "failed") w.push(isNotNull(J.failedAt));
    if (q.state === "waiting") w.push(isNull(J.doneAt), isNull(J.failedAt));
    return (await this.db.select().from(J).where(and(...w)).orderBy(desc(J.createdAt)).limit(q.limit ?? 100)).map((r) => this.toJob(r));
  }
  async countJobs() {
    const J = this.t.jobs;
    const [r] = await this.db
      .select({ waiting: sql<number>`count(*) filter (where ${J.doneAt} is null and ${J.failedAt} is null)::int`, failed: sql<number>`count(*) filter (where ${J.failedAt} is not null)::int` })
      .from(J);
    return { waiting: Number(r?.waiting ?? 0), failed: Number(r?.failed ?? 0) };
  }
  async pruneJobs(doneBefore: string) {
    const J = this.t.jobs;
    return (await this.db.delete(J).where(lt(J.doneAt, new Date(doneBefore))).returning({ id: J.id })).length;
  }

  async insertWebhook(w: NewWebhook) {
    const [r] = await this.db.insert(this.t.webhooks).values({ ...w, createdAt: new Date(w.createdAt), updatedAt: new Date(w.updatedAt) }).returning();
    return this.toWebhook(r);
  }
  async findWebhook(id: string) {
    if (!this.uuidLike(id)) return null;
    const [r] = await this.db.select().from(this.t.webhooks).where(eq(this.t.webhooks.id, id)).limit(1);
    return r ? this.toWebhook(r) : null;
  }
  async listWebhooks() {
    return (await this.db.select().from(this.t.webhooks).orderBy(asc(this.t.webhooks.createdAt))).map((r) => this.toWebhook(r));
  }
  async updateWebhook(id: string, patch: WebhookPatch) {
    if (!this.uuidLike(id)) return null;
    const { updatedAt, ...rest } = patch;
    const [r] = await this.db.update(this.t.webhooks).set({ ...rest, ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {}) }).where(eq(this.t.webhooks.id, id)).returning();
    return r ? this.toWebhook(r) : null;
  }
  async failWebhook(id: string) {
    const W = this.t.webhooks;
    const [r] = await this.db.update(W).set({ failures: sql`${W.failures} + 1` }).where(eq(W.id, id)).returning({ failures: W.failures });
    return r?.failures ?? 0;
  }
  async deleteWebhook(id: string) {
    if (this.uuidLike(id)) await this.db.delete(this.t.webhooks).where(eq(this.t.webhooks.id, id));
  }
  async insertDelivery(d: Omit<WebhookDelivery, "id">) {
    const [r] = await this.db.insert(this.t.webhookDeliveries).values({ ...d, at: new Date(d.at) }).returning();
    return this.toDelivery(r);
  }
  async findDelivery(id: string) {
    if (!this.uuidLike(id)) return null;
    const [r] = await this.db.select().from(this.t.webhookDeliveries).where(eq(this.t.webhookDeliveries.id, id)).limit(1);
    return r ? this.toDelivery(r) : null;
  }
  async listDeliveries(webhookId: string, limit: number) {
    const D = this.t.webhookDeliveries;
    if (!this.uuidLike(webhookId)) return [];
    return (await this.db.select().from(D).where(eq(D.webhookId, webhookId)).orderBy(desc(D.at)).limit(limit)).map((r) => this.toDelivery(r));
  }
  async pruneDeliveries(before: string) {
    const D = this.t.webhookDeliveries;
    return (await this.db.delete(D).where(lt(D.at, new Date(before))).returning({ id: D.id })).length;
  }

  private toRecord(r: typeof this.t.records.$inferSelect): CmsRecord {
    return { id: r.id, kind: r.kind, scope: r.scope, key: r.key, data: r.data, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
  }
  async insertRecord(r: NewRecord) {
    const at = new Date(r.at);
    const [row] = await this.db.insert(this.t.records).values({ kind: r.kind, scope: r.scope ?? "", key: r.key ?? null, data: r.data, createdAt: at, updatedAt: at }).returning();
    return this.toRecord(row);
  }
  async findRecord(kind: string, id: string) {
    const R = this.t.records;
    if (!this.uuidLike(id)) return null;
    const [r] = await this.db.select().from(R).where(and(eq(R.kind, kind), eq(R.id, id))).limit(1);
    return r ? this.toRecord(r) : null;
  }
  async findRecordByKey(kind: string, key: string) {
    const R = this.t.records;
    const [r] = await this.db.select().from(R).where(and(eq(R.kind, kind), eq(R.key, key))).limit(1);
    return r ? this.toRecord(r) : null;
  }
  async listRecords(q: RecordQuery) {
    const R = this.t.records;
    const where = [eq(R.kind, q.kind), ...(q.scope !== undefined ? [eq(R.scope, q.scope)] : []), ...(q.before ? [lt(R.createdAt, new Date(q.before))] : [])];
    const rows = await this.db.select().from(R).where(and(...where)).orderBy(...(q.order === "asc" ? [asc(R.createdAt), asc(R.id)] : [desc(R.createdAt), desc(R.id)])).limit(q.limit ?? 200);
    return rows.map((r) => this.toRecord(r));
  }
  async updateRecord(kind: string, id: string, patch: RecordPatch) {
    const R = this.t.records;
    if (!this.uuidLike(id)) return null;
    const [r] = await this.db.update(R).set({ ...(patch.data !== undefined ? { data: patch.data } : {}), ...(patch.key !== undefined ? { key: patch.key } : {}), updatedAt: new Date(patch.at) }).where(and(eq(R.kind, kind), eq(R.id, id))).returning();
    return r ? this.toRecord(r) : null;
  }
  async deleteRecords(q: { kind: string; id?: string; scope?: string; before?: string }) {
    const R = this.t.records;
    if (q.id !== undefined && !this.uuidLike(q.id)) return 0;
    const where = [eq(R.kind, q.kind), ...(q.id !== undefined ? [eq(R.id, q.id)] : []), ...(q.scope !== undefined ? [eq(R.scope, q.scope)] : []), ...(q.before !== undefined ? [lt(R.createdAt, new Date(q.before))] : [])];
    return (await this.db.delete(R).where(and(...where)).returning({ id: R.id })).length;
  }
  /**
   * Change numbers are handed out in commit order (0.18.0): the row is added under a transaction
   * advisory lock on this table, taken in the same statement and held until the commit. So a reader
   * that sees number N has also seen every smaller number that will ever exist (gaps are rolled-back
   * writes, never late ones), and an events stream can hand out N as a resume point.
   */
  readonly changesInCommitOrder = true;
  async appendChange(c: NewChange) {
    const C = this.t.changes;
    const cfg = getTableConfig(C);
    const lockName = `agent-cms:${cfg.schema ?? "public"}.${cfg.name}`;
    const res = await this.db.execute(sql`with l as (select pg_advisory_xact_lock(hashtext(${lockName}))) insert into ${C} (${sql.identifier("at")}, ${sql.identifier("event")}, ${sql.identifier("collection")}, ${sql.identifier("slug")}, ${sql.identifier("version")}, ${sql.identifier("origin")}, ${sql.identifier("data")}) select ${c.at ? new Date(c.at).toISOString() : new Date().toISOString()}::timestamptz, ${c.event}, ${c.collection}, ${c.slug}, ${c.version}::integer, ${c.origin}, ${JSON.stringify(c.data ?? {})}::jsonb from l returning ${sql.identifier("seq")}`);
    const rows = ((res as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as { seq: string | number }[];
    return Number(rows[0].seq);
  }
  async changesSince(seq: number, limit: number): Promise<ChangeRow[]> {
    const C = this.t.changes;
    const rows = await this.db.select().from(C).where(sql`${C.seq} > ${seq}`).orderBy(asc(C.seq)).limit(limit);
    return rows.map((r) => ({ seq: Number(r.seq), at: r.at.toISOString(), event: r.event, collection: r.collection, slug: r.slug, version: r.version, origin: r.origin, data: r.data }));
  }
  async lastChange() {
    const C = this.t.changes;
    const [r] = await this.db.select({ n: sql<string | null>`max(${C.seq})::text` }).from(C);
    return Number(r?.n ?? 0);
  }
  async pruneChanges(before: string) {
    const C = this.t.changes;
    return (await this.db.delete(C).where(lt(C.at, new Date(before))).returning({ seq: C.seq })).length;
  }
  cacheNamespace() {
    return `${this.t.options.schema ?? "public"}.${this.t.options.prefix}`;
  }
  async findDocsByIds(ids: readonly string[]) {
    const D = this.t.documents;
    const ok = ids.filter((id) => this.uuidLike(id));
    if (!ok.length) return [];
    const rows = await this.db.select().from(D).where(and(inArray(D.id, ok), isNull(D.deletedAt)));
    return rows.map((r) => this.toDoc(r));
  }
  async pageDocs(q: DocPageQuery): Promise<DocPage> {
    const D = this.t.documents;
    const conds: SQL[] = [isNull(D.deletedAt), eq(D.collection, q.collection)];
    if (q.published) conds.push(isNotNull(D.publishedVersion), ne(D.status, "archived"), isNotNull(D.published));
    if (q.statuses?.length) conds.push(inArray(D.status, q.statuses));
    if (q.by) conds.push(eq(D.updatedByKind, q.by));
    const title = q.published ? sql`(${D.published}->>'title')` : sql`${D.title}`;
    const summary = q.published ? sql`(${D.published}->>'summary')` : sql`${D.summary}`;
    const category = q.published ? sql`(${D.published}->>'category')` : sql`${D.category}`;
    if (q.category) conds.push(sql`${category} = ${q.category}`);
    const needle = q.q?.trim();
    if (needle) {
      const like = `%${needle.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      conds.push(sql`(${title} ilike ${like} or ${D.slug} ilike ${like} or coalesce(${summary}, '') ilike ${like})`);
    }
    // Milliseconds: the cursor carries a JavaScript time, the column may hold microseconds.
    const key = q.published ? sql`date_trunc('milliseconds', coalesce(${D.publishedAt}, ${D.updatedAt}))` : sql`date_trunc('milliseconds', ${D.updatedAt})`;
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(D).where(and(...conds));
    const page = [...conds];
    if (q.after && !this.uuidLike(q.after.id)) return { docs: [], total: Number(n) };
    if (q.after) page.push(sql`(${key} < ${new Date(q.after.at)} or (${key} = ${new Date(q.after.at)} and ${D.id} < ${q.after.id}))`);
    const rows = await this.db.select().from(D).where(and(...page)).orderBy(sql`${key} desc`, desc(D.id)).limit(q.limit);
    return { docs: rows.map((r) => this.toDoc(r)), total: Number(n) };
  }
  async versionsSince(since: string, limit: number): Promise<VersionStamp[]> {
    const V = this.t.versions;
    const rows = await this.db.select({ documentId: V.documentId, version: V.version, createdAt: V.createdAt, authorKind: V.authorKind, authorLabel: V.authorLabel, authorAgent: V.authorAgent }).from(V).where(gte(V.createdAt, new Date(since))).orderBy(desc(V.createdAt)).limit(limit);
    return rows.map((r) => ({ ...r, authorKind: r.authorKind as VersionStamp["authorKind"], authorAgent: r.authorAgent ?? null, createdAt: r.createdAt.toISOString() }));
  }

  async inspect(): Promise<DoctorReport> {
    const { prefix, schema } = this.t.options;
    const sch = schema ?? null;
    const cols = await this.rows<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_schema = coalesce(${sch}, current_schema()) and table_name like ${prefix.replace(/_/g, "\\_") + "%"}`
    );
    const have = new Map<string, Set<string>>();
    for (const c of cols) {
      if (!have.has(c.table_name)) have.set(c.table_name, new Set());
      have.get(c.table_name)!.add(c.column_name);
    }
    const expected: Record<string, string[]> = {};
    for (const [key, tbl] of Object.entries({ documents: this.t.documents, versions: this.t.versions, api_keys: this.t.apiKeys, hits: this.t.hits, meta: this.t.meta, audit: this.t.audit, assets: this.t.assets, asset_refs: this.t.assetRefs, comments: this.t.comments, releases: this.t.releases, saved_filters: this.t.savedFilters, presence: this.t.presence, jobs: this.t.jobs, webhooks: this.t.webhooks, webhook_deliveries: this.t.webhookDeliveries, records: this.t.records, changes: this.t.changes })) {
      expected[prefix + key] = Object.values(tbl).filter((c) => c && typeof c === "object" && "name" in c && "columnType" in c).map((c) => (c as { name: string }).name);
    }
    const missingTables = Object.keys(expected).filter((t) => !have.has(t));
    const missingColumns = Object.entries(expected).flatMap(([t, cs]) => (have.has(t) ? cs.filter((c) => !have.get(t)!.has(c)).map((c) => `${t}.${c}`) : []));
    const legacyColumns = LEGACY_COLUMNS.filter((l) => have.get(prefix + l.table)?.has(l.column)).map((l) => `${prefix}${l.table}.${l.column}`);
    const gapsTable = have.has(`${prefix}gaps`);
    let gapsRows: number | null = null;
    if (gapsTable) {
      const tbl = sch ? `"${sch}"."${prefix}gaps"` : `"${prefix}gaps"`;
      const [r] = await this.rows<{ n: number }>(sql.raw(`select count(*)::int as n from ${tbl}`));
      gapsRows = Number(r?.n ?? 0);
    }
    const found = missingTables.includes(`${prefix}meta`) ? null : await this.getMeta("schema_version");
    let badPublished = 0;
    let orphanVersions = 0;
    if (!missingTables.length) {
      const D = this.t.documents;
      const V = this.t.versions;
      const [bp] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(D)
        .where(sql`${D.publishedVersion} is not null and (${D.publishedVersion} > ${D.version} or ${D.published} is null)`);
      badPublished = Number(bp?.n ?? 0);
      const [ov] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(V)
        .where(sql`not exists (select 1 from ${D} d where d.id = ${V.documentId})`);
      orphanVersions = Number(ov?.n ?? 0);
    }
    // 0.17.0: indexes, published pointers without their version, rows left behind.
    let missingIndexes: string[] = [];
    let publishedWithoutVersion = 0;
    let orphanAssetRefs = 0;
    let orphanComments = 0;
    let changeRows: number | null = null;
    if (!missingTables.length) {
      const idx = await this.rows<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = coalesce(${sch}, current_schema()) and indexname like ${prefix.replace(/_/g, "\\_") + "%"}`);
      const haveIdx = new Set(idx.map((r) => r.indexname));
      missingIndexes = EXPECTED_INDEXES.map((n) => prefix + n).filter((n) => !haveIdx.has(n));
      const D = this.t.documents;
      const V = this.t.versions;
      const [pv] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(D)
        .where(sql`${D.publishedVersion} is not null and not exists (select 1 from ${V} v where v.document_id = ${D.id} and v.version = ${D.publishedVersion})`);
      publishedWithoutVersion = Number(pv?.n ?? 0);
      const R = this.t.assetRefs;
      const A = this.t.assets;
      const [ar] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(R)
        .where(sql`not exists (select 1 from ${D} d where d.id = ${R.documentId}) or not exists (select 1 from ${A} a where a.id = ${R.assetId})`);
      orphanAssetRefs = Number(ar?.n ?? 0);
      const C = this.t.comments;
      const [oc] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(C)
        .where(sql`not exists (select 1 from ${D} d where d.id = ${C.documentId})`);
      orphanComments = Number(oc?.n ?? 0);
      const [cr] = await this.db.select({ n: sql<number>`count(*)::int` }).from(this.t.changes);
      changeRows = Number(cr?.n ?? 0);
    }
    return {
      schemaVersion: typeof found === "number" ? found : found == null ? null : Number(found),
      expectedSchemaVersion: SCHEMA_VERSION,
      missingTables,
      missingColumns,
      legacyColumns,
      gapsTable,
      gapsRows,
      badPublished,
      orphanVersions,
      missingIndexes,
      publishedWithoutVersion,
      orphanAssetRefs,
      orphanComments,
      changeRows,
    };
  }

  /** Safe repairs for what `inspect` found: rows that point at nothing. Returns how many went per kind. */
  async repair(): Promise<{ orphanVersions: number; orphanAssetRefs: number; orphanComments: number }> {
    const D = this.t.documents;
    const V = this.t.versions;
    const R = this.t.assetRefs;
    const A = this.t.assets;
    const C = this.t.comments;
    const ov = await this.db.delete(V).where(sql`not exists (select 1 from ${D} d where d.id = ${V.documentId})`).returning({ id: V.documentId });
    const ar = await this.db.delete(R).where(sql`not exists (select 1 from ${D} d where d.id = ${R.documentId}) or not exists (select 1 from ${A} a where a.id = ${R.assetId})`).returning({ id: R.assetId });
    const oc = await this.db.delete(C).where(sql`not exists (select 1 from ${D} d where d.id = ${C.documentId})`).returning({ id: C.id });
    return { orphanVersions: ov.length, orphanAssetRefs: ar.length, orphanComments: oc.length };
  }
}

export interface DoctorReport {
  schemaVersion: number | null;
  expectedSchemaVersion: number;
  missingTables: string[];
  missingColumns: string[];
  /** 0.4.0 columns nothing reads any more. */
  legacyColumns: string[];
  /** A `cms_gaps` table from 0.5.x is still there (move it to the app, then drop it yourself). */
  gapsTable: boolean;
  gapsRows: number | null;
  /** Documents whose published pointer is broken. */
  badPublished: number;
  orphanVersions: number;
  /** 0.17.0: indexes the DDL makes that the database does not have. */
  missingIndexes?: string[];
  /** Documents whose published version has no row in the version table. */
  publishedWithoutVersion?: number;
  /** File uses whose document or file is gone. */
  orphanAssetRefs?: number;
  /** Comments whose document is gone (deleted for good). */
  orphanComments?: number;
  /** Rows in the change log (null: no table). */
  changeRows?: number | null;
}

/** Index names (without the prefix) the DDL creates; `doctor` reports the ones missing. */
export const EXPECTED_INDEXES = ["changes_at_idx", "changes_doc_idx", "documents_list_idx", "documents_public_idx", "documents_trash_idx", "documents_updated_idx", "versions_created_idx", "audit_doc_idx", "jobs_done_idx", "assets_trash_idx", "comments_thread_idx"];
