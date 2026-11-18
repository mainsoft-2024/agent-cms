/** `CmsRepo` on Postgres via Drizzle (node-postgres driver). */

import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CmsRepo, DocPatch, KeyRow, NewDoc } from "./repo";
import { cmsApiKeys, cmsDocuments, cmsGaps, cmsHits, cmsMeta, cmsVersions } from "./tables";
import { CmsError, type CmsDoc, type CmsGap, type CmsVersion, type DocStatus, type KeyScope } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const iso = (d: Date | string | null | undefined) => (d == null ? null : typeof d === "string" ? new Date(d).toISOString() : d.toISOString());
const date = (s: string | null | undefined) => (s == null ? null : new Date(s));

type DocRow = typeof cmsDocuments.$inferSelect;
function toDoc(r: DocRow): CmsDoc {
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
    covers: r.covers ?? [],
    fields: r.fields ?? {},
    version: r.version,
    publishedVersion: r.publishedVersion,
    published: r.published ?? null,
    needsReview: r.needsReview,
    reviewReason: r.reviewReason ?? null,
    pendingPr: r.pendingPr,
    publishedAt: iso(r.publishedAt),
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    updatedBy: r.updatedBy,
    updatedByKind: (r.updatedByKind as CmsDoc["updatedByKind"]) ?? null,
  };
}

function patchRow(p: DocPatch): Partial<typeof cmsDocuments.$inferInsert> {
  const out: Partial<typeof cmsDocuments.$inferInsert> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (k === "publishedAt" || k === "updatedAt") (out as Record<string, unknown>)[k] = date(v as string | null);
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

type VersionRow = typeof cmsVersions.$inferSelect;
const toVersion = (r: VersionRow): Omit<CmsVersion, "published"> => ({
  id: r.id,
  documentId: r.documentId,
  version: r.version,
  snapshot: r.snapshot,
  authorKind: r.authorKind as CmsVersion["authorKind"],
  authorId: r.authorId,
  authorLabel: r.authorLabel,
  note: r.note,
  pr: r.pr,
  createdAt: iso(r.createdAt)!,
});

type GapRow = typeof cmsGaps.$inferSelect;
const toGap = (r: GapRow): CmsGap => ({
  id: r.id,
  collection: r.collection,
  kind: r.kind as CmsGap["kind"],
  query: r.query,
  note: r.note,
  documentSlug: r.documentSlug,
  count: r.count,
  state: r.state as CmsGap["state"],
  firstSeenAt: iso(r.firstSeenAt)!,
  lastSeenAt: iso(r.lastSeenAt)!,
});

type KeyDbRow = typeof cmsApiKeys.$inferSelect;
const toKey = (r: KeyDbRow): KeyRow => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  hash: r.hash,
  scopes: r.scopes as KeyScope[],
  collections: r.collections ?? null,
  createdBy: r.createdBy,
  lastUsedAt: iso(r.lastUsedAt),
  revokedAt: iso(r.revokedAt),
  createdAt: iso(r.createdAt)!,
});

/** A unique-index race (two creates with one slug) is a 409, not a 500. */
async function uniq<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if (err?.code === "23505" || err?.cause?.code === "23505") throw new CmsError("conflict", "같은 주소나 버전이 이미 있음");
    throw e;
  }
}

export class DrizzleRepo implements CmsRepo {
  constructor(private db: Db) {}

  tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T> {
    return this.db.transaction((t) => fn(new DrizzleRepo(t as unknown as Db)));
  }

  async findDoc(collection: string, slug: string) {
    const [r] = await this.db.select().from(cmsDocuments).where(and(eq(cmsDocuments.collection, collection), eq(cmsDocuments.slug, slug))).limit(1);
    return r ? toDoc(r) : null;
  }
  async findDocById(id: string) {
    const [r] = await this.db.select().from(cmsDocuments).where(eq(cmsDocuments.id, id)).limit(1);
    return r ? toDoc(r) : null;
  }
  async listDocs(f: { collection?: string; statuses?: DocStatus[]; published?: boolean; needsReview?: boolean }) {
    const conds = [];
    if (f.collection) conds.push(eq(cmsDocuments.collection, f.collection));
    if (f.statuses) conds.push(inArray(cmsDocuments.status, f.statuses));
    if (f.published === true) conds.push(isNotNull(cmsDocuments.publishedVersion), ne(cmsDocuments.status, "archived"));
    if (f.needsReview !== undefined) conds.push(eq(cmsDocuments.needsReview, f.needsReview));
    const rows = await this.db.select().from(cmsDocuments).where(conds.length ? and(...conds) : undefined);
    const docs = rows.map(toDoc);
    return f.published === false ? docs.filter((d) => d.publishedVersion === null || d.status === "archived") : docs;
  }
  async insertDoc(doc: NewDoc) {
    const [r] = await uniq(
      this.db
        .insert(cmsDocuments)
        .values({
          ...patchRow(doc as DocPatch),
          ...(doc.id ? { id: doc.id } : {}),
          collection: doc.collection,
          slug: doc.slug,
          title: doc.title,
          createdAt: date(doc.createdAt ?? null) ?? undefined,
        })
        .returning()
    );
    return toDoc(r);
  }
  async updateDoc(id: string, p: DocPatch, expectedVersion?: number) {
    const where = expectedVersion === undefined ? eq(cmsDocuments.id, id) : and(eq(cmsDocuments.id, id), eq(cmsDocuments.version, expectedVersion));
    const [r] = await uniq(
      this.db
        .update(cmsDocuments)
        .set({ ...patchRow(p), updatedAt: date(p.updatedAt ?? null) ?? new Date() })
        .where(where)
        .returning()
    );
    return r ? toDoc(r) : null;
  }
  async deleteDoc(id: string) {
    await this.db.delete(cmsDocuments).where(eq(cmsDocuments.id, id));
  }
  async insertVersion(v: Omit<CmsVersion, "id" | "createdAt" | "published"> & { createdAt?: string }) {
    await uniq(
      this.db.insert(cmsVersions).values({
        documentId: v.documentId,
        version: v.version,
        snapshot: v.snapshot,
        authorKind: v.authorKind,
        authorId: v.authorId,
        authorLabel: v.authorLabel,
        note: v.note,
        pr: v.pr,
        createdAt: date(v.createdAt ?? null) ?? undefined,
      })
    );
  }
  async listVersions(documentId: string) {
    const rows = await this.db.select().from(cmsVersions).where(eq(cmsVersions.documentId, documentId)).orderBy(desc(cmsVersions.version));
    return rows.map(toVersion);
  }
  async getVersion(documentId: string, version: number) {
    const [r] = await this.db.select().from(cmsVersions).where(and(eq(cmsVersions.documentId, documentId), eq(cmsVersions.version, version))).limit(1);
    return r ? toVersion(r) : null;
  }
  async pruneVersions(documentId: string, keep: number, protect: number[]) {
    const rows = await this.db
      .select({ id: cmsVersions.id, version: cmsVersions.version })
      .from(cmsVersions)
      .where(eq(cmsVersions.documentId, documentId))
      .orderBy(desc(cmsVersions.version));
    const drop = rows.slice(keep).filter((r) => !protect.includes(r.version)).map((r) => r.id);
    if (drop.length) await this.db.delete(cmsVersions).where(inArray(cmsVersions.id, drop));
  }
  async upsertGap(g: { collection: string; kind: CmsGap["kind"]; query: string; normalized: string; note: string | null; documentSlug: string | null; at: string }) {
    await this.db
      .insert(cmsGaps)
      .values({ collection: g.collection, kind: g.kind, query: g.query, normalized: g.normalized, note: g.note, documentSlug: g.documentSlug, firstSeenAt: new Date(g.at), lastSeenAt: new Date(g.at) })
      .onConflictDoUpdate({
        target: [cmsGaps.collection, cmsGaps.kind, cmsGaps.normalized],
        set: {
          count: sql`${cmsGaps.count} + 1`,
          query: g.query,
          note: sql`coalesce(${g.note}, ${cmsGaps.note})`,
          documentSlug: sql`coalesce(${g.documentSlug}, ${cmsGaps.documentSlug})`,
          lastSeenAt: new Date(g.at),
          state: sql`case when ${cmsGaps.state} = 'done' then 'open' else ${cmsGaps.state} end`,
        },
      });
  }
  async listGaps(f: { collection?: string; state?: CmsGap["state"] }) {
    const conds = [];
    if (f.collection) conds.push(eq(cmsGaps.collection, f.collection));
    if (f.state) conds.push(eq(cmsGaps.state, f.state));
    const rows = await this.db.select().from(cmsGaps).where(conds.length ? and(...conds) : undefined).orderBy(desc(cmsGaps.lastSeenAt)).limit(500);
    return rows.map(toGap);
  }
  async setGapState(id: string, state: CmsGap["state"]) {
    const [r] = await this.db.update(cmsGaps).set({ state }).where(eq(cmsGaps.id, id)).returning();
    return r ? toGap(r) : null;
  }
  async insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null }) {
    const [r] = await this.db.insert(cmsApiKeys).values(k).returning();
    return toKey(r);
  }
  async listKeys() {
    return (await this.db.select().from(cmsApiKeys)).map(toKey);
  }
  async findKeyByHash(hash: string) {
    const [r] = await this.db.select().from(cmsApiKeys).where(eq(cmsApiKeys.hash, hash)).limit(1);
    return r ? toKey(r) : null;
  }
  async touchKey(id: string, at: string) {
    await this.db.update(cmsApiKeys).set({ lastUsedAt: new Date(at) }).where(eq(cmsApiKeys.id, id));
  }
  async revokeKey(id: string, at: string) {
    const rows = await this.db
      .update(cmsApiKeys)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(cmsApiKeys.id, id), sql`${cmsApiKeys.revokedAt} is null`))
      .returning({ id: cmsApiKeys.id });
    return rows.length > 0;
  }
  async addHits(ids: string[], day: string) {
    if (!ids.length) return;
    await this.db
      .insert(cmsHits)
      .values(ids.map((documentId) => ({ documentId, day, count: 1 })))
      .onConflictDoUpdate({ target: [cmsHits.documentId, cmsHits.day], set: { count: sql`${cmsHits.count} + 1` } });
  }
  async hitCounts(sinceDay: string) {
    const rows = await this.db
      .select({ id: cmsHits.documentId, n: sql<number>`sum(${cmsHits.count})::int` })
      .from(cmsHits)
      .where(gte(cmsHits.day, sinceDay))
      .groupBy(cmsHits.documentId);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }
  async changeStamp() {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int`, max: sql<string | null>`max(${cmsDocuments.updatedAt})::text` })
      .from(cmsDocuments);
    return `${r?.n ?? 0}:${r?.max ?? ""}`;
  }
  async getMeta(key: string) {
    const [r] = await this.db.select().from(cmsMeta).where(eq(cmsMeta.key, key)).limit(1);
    return r?.value ?? null;
  }
  async setMeta(key: string, value: unknown) {
    await this.db
      .insert(cmsMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: cmsMeta.key, set: { value, updatedAt: new Date() } });
  }
}
