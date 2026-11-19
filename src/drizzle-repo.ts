/** `CmsRepo` on Postgres via Drizzle (node-postgres, pglite and other `PgDatabase` drivers with transactions). */

import { and, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { CmsError } from "./errors";
import type { AssetPatch, AssetQuery, AuditQuery, CmsRepo, DocPatch, KeyRow, NewAsset, NewAudit, NewDoc, NewVersion, StoredVersion } from "./repo";
import { SCHEMA_VERSION } from "./schema-version";
import { defaultTables, LEGACY_COLUMNS, type CmsTables } from "./tables";
import type { AssetKind, AssetRef, AuditEntry, CmsAsset, CmsDoc, DocStatus, KeyScope, ReviewMark } from "./types";

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
}

export class DrizzleRepo implements CmsRepo {
  readonly t: CmsTables;
  constructor(
    readonly db: Db,
    o: DrizzleRepoOptions = {}
  ) {
    this.t = o.tables ?? defaultTables;
  }

  private toDoc(r: typeof this.t.documents.$inferSelect): CmsDoc {
    return {
      id: r.id,
      collection: r.collection,
      slug: r.slug,
      status: r.status as DocStatus,
      title: r.title,
      summary: r.summary,
      body: r.body,
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
    };
  }

  private patchRow(p: DocPatch): Partial<typeof this.t.documents.$inferInsert> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (k === "publishedAt" || k === "updatedAt" || k === "republishedAt") out[k] = date(v as string | null);
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
      status: r.status as CmsAsset["status"],
      uploadId: r.uploadId,
      createdBy: r.createdBy,
      createdByKind: (r.createdByKind as CmsAsset["createdByKind"]) ?? null,
      createdByAgent: r.createdByAgent ?? null,
      createdAt: iso(r.createdAt)!,
      updatedAt: iso(r.updatedAt)!,
    };
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

  tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T> {
    return this.db.transaction((t) => fn(new DrizzleRepo(t as unknown as Db, { tables: this.t })));
  }

  async findDoc(collection: string, slug: string) {
    const D = this.t.documents;
    const [r] = await this.db.select().from(D).where(and(eq(D.collection, collection), eq(D.slug, slug))).limit(1);
    return r ? this.toDoc(r) : null;
  }
  async findDocById(id: string) {
    const D = this.t.documents;
    const [r] = await this.db.select().from(D).where(eq(D.id, id)).limit(1);
    return r ? this.toDoc(r) : null;
  }
  async listDocs(f: { collection?: string; statuses?: DocStatus[]; published?: boolean }) {
    const D = this.t.documents;
    const conds = [];
    if (f.collection) conds.push(eq(D.collection, f.collection));
    if (f.statuses) conds.push(inArray(D.status, f.statuses));
    if (f.published === true) conds.push(isNotNull(D.publishedVersion), ne(D.status, "archived"));
    const rows = await this.db.select().from(D).where(conds.length ? and(...conds) : undefined);
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
    const where = expectedVersion === undefined ? eq(D.id, id) : and(eq(D.id, id), eq(D.version, expectedVersion));
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
  async getVersion(documentId: string, version: number) {
    const V = this.t.versions;
    const [r] = await this.db.select().from(V).where(and(eq(V.documentId, documentId), eq(V.version, version))).limit(1);
    return r ? this.toVersion(r) : null;
  }
  async setVersionReviewed(documentId: string, version: number, reviewed: ReviewMark[]) {
    const V = this.t.versions;
    await this.db.update(V).set({ reviewed }).where(and(eq(V.documentId, documentId), eq(V.version, version)));
  }
  async pruneVersions(documentId: string, keep: number, protect: number[]) {
    const V = this.t.versions;
    const rows = await this.db.select({ id: V.id, version: V.version }).from(V).where(eq(V.documentId, documentId)).orderBy(desc(V.version));
    const drop = rows.slice(keep).filter((r) => !protect.includes(r.version)).map((r) => r.id);
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
      .where(and(eq(K.id, id), sql`${K.revokedAt} is null`))
      .returning({ id: K.id });
    return rows.length > 0;
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
    if (q.outcome) conds.push(eq(A.outcome, q.outcome));
    if (q.actorKind) conds.push(eq(A.actorKind, q.actorKind));
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
  async findAsset(id: string) {
    const A = this.t.assets;
    const [r] = await this.db.select().from(A).where(eq(A.id, id)).limit(1);
    return r ? this.toAsset(r) : null;
  }
  async findAssets(ids: readonly string[]) {
    if (!ids.length) return [];
    const A = this.t.assets;
    return (await this.db.select().from(A).where(inArray(A.id, [...ids]))).map((r) => this.toAsset(r));
  }
  async findAssetByKey(store: string, key: string) {
    const A = this.t.assets;
    const [r] = await this.db.select().from(A).where(and(eq(A.store, store), eq(A.key, key))).limit(1);
    return r ? this.toAsset(r) : null;
  }
  async listAssets(q: AssetQuery) {
    const A = this.t.assets;
    const conds = [];
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
    const rows = await this.db
      .select()
      .from(A)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(A.createdAt), desc(A.id))
      .limit(q.limit ?? 1000);
    return rows.map((r) => this.toAsset(r));
  }
  async countAssets(store?: string) {
    const A = this.t.assets;
    const rows = await this.db
      .select({ store: A.store, folder: A.folder, kind: A.kind, n: sql<number>`count(*)::int` })
      .from(A)
      .where(store ? and(eq(A.status, "ready"), eq(A.store, store)) : eq(A.status, "ready"))
      .groupBy(A.store, A.folder, A.kind);
    return rows.map((r) => ({ store: r.store, folder: r.folder, kind: r.kind as AssetKind, n: Number(r.n) }));
  }
  async updateAsset(id: string, patch: AssetPatch) {
    const A = this.t.assets;
    const { updatedAt, ...rest } = patch;
    const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
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
    for (const [key, tbl] of Object.entries({ documents: this.t.documents, versions: this.t.versions, api_keys: this.t.apiKeys, hits: this.t.hits, meta: this.t.meta, audit: this.t.audit, assets: this.t.assets, asset_refs: this.t.assetRefs })) {
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
    };
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
}
