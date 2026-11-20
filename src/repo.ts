/**
 * Storage behind the CMS. `cms.ts` holds every rule (states, access, versions,
 * validation) and talks only to this interface, so the rules are tested
 * against `MemoryRepo` and run in production on `DrizzleRepo`.
 */

import { SCHEMA_VERSION } from "./schema-version";
import type { AssetKind, AssetRef, AuditEntry, CmsAsset, CmsComment, CmsDoc, CmsKey, CmsRelease, CmsVersion, DocStatus, KeyScope, Presence, ReviewMark, SavedFilter } from "./types";

export type DocPatch = Partial<Omit<CmsDoc, "id" | "collection" | "createdAt">>;
type DocFlow = "deletedAt" | "deletedBy" | "schedule" | "dueAt" | "review";
export type NewDoc = Omit<CmsDoc, "id" | "createdAt" | "updatedAt" | "republishedAt" | "autosave" | "updatedByAgent" | DocFlow> & Partial<Pick<CmsDoc, DocFlow>> & {
  updatedByAgent?: string | null;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  republishedAt?: string | null;
  autosave?: CmsDoc["autosave"];
};
export type StoredVersion = Omit<CmsVersion, "published">;
export type NewVersion = Omit<CmsVersion, "id" | "createdAt" | "published" | "reviewed" | "changed" | "authorAgent" | "label" | "pinned" | "approvedBy" | "approvedAt"> & {
  label?: string | null;
  authorAgent?: string | null;
  createdAt?: string;
  changed?: CmsVersion["changed"];
};

export interface KeyRow extends CmsKey {
  hash: string;
  createdBy: string | null;
}

export type NewAudit = Omit<AuditEntry, "id" | "actorAgent"> & { actorAgent?: string | null };

export interface AuditQuery {
  /** Entries strictly older than this cursor (from the previous page). */
  before?: string | null;
  limit: number;
  action?: string;
  outcome?: AuditEntry["outcome"];
  actorKind?: AuditEntry["actorKind"];
}

export type NewAsset = Omit<CmsAsset, "createdAt" | "updatedAt" | "deletedAt" | "deletedBy" | "focalX" | "focalY" | "rev"> & { createdAt?: string; updatedAt?: string; focalX?: number | null; focalY?: number | null; rev?: number };
export type VersionPatch = Partial<Pick<CmsVersion, "label" | "pinned" | "approvedBy" | "approvedAt">>;
export type NewComment = Omit<CmsComment, "id" | "resolvedAt" | "resolvedBy">;
export type NewRelease = Pick<CmsRelease, "name" | "createdBy" | "createdById" | "createdAt">;
export type ReleasePatch = Partial<Omit<CmsRelease, "id" | "createdAt" | "createdBy" | "createdById">>;
export type NewFilter = Omit<SavedFilter, "id">;
/** `trashed`: also find rows that are in the trash. */
export interface FindOptions {
  trashed?: boolean;
}
export interface DocFilter {
  collection?: string;
  statuses?: DocStatus[];
  published?: boolean;
  /** true: only what is in the trash. Default: only what is not. */
  trashed?: boolean;
  /** Only documents whose schedule is due at or before this time. */
  dueBefore?: string;
}
export type AssetPatch = Partial<Omit<CmsAsset, "id" | "store" | "createdAt">>;

export interface AssetQuery {
  store?: string;
  /** Exactly this folder ("" = top level). */
  folder?: string;
  /** This folder and everything under it. */
  under?: string;
  kinds?: readonly AssetKind[];
  notKinds?: readonly AssetKind[];
  /** Part of the name, the alt text or a tag (case-insensitive). */
  q?: string;
  tag?: string;
  status?: CmsAsset["status"];
  /** Created strictly before this time. */
  createdBefore?: string;
  /** true: only what is in the trash. Default: only what is not. */
  trashed?: boolean;
  /** Entries strictly older than this cursor (`createdAt|id` of the last one). */
  before?: string | null;
  limit?: number;
}

/** True when `folder` is `under` or inside it. */
export const inFolder = (folder: string, under: string) => under === "" || folder === under || folder.startsWith(`${under}/`);

export interface CmsRepo {
  /** Run `fn` atomically (one DB transaction). */
  tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T>;

  /** Documents in the trash are not found unless `trashed` is set. */
  findDoc(collection: string, slug: string, o?: FindOptions): Promise<CmsDoc | null>;
  findDocById(id: string, o?: FindOptions): Promise<CmsDoc | null>;
  listDocs(filter: DocFilter): Promise<CmsDoc[]>;
  insertDoc(doc: NewDoc): Promise<CmsDoc>;
  /** Returns null when `expectedVersion` is given and the row moved on. */
  updateDoc(id: string, patch: DocPatch, expectedVersion?: number): Promise<CmsDoc | null>;
  deleteDoc(id: string): Promise<void>;

  insertVersion(v: NewVersion): Promise<void>;
  listVersions(documentId: string): Promise<StoredVersion[]>;
  getVersion(documentId: string, version: number): Promise<StoredVersion | null>;
  setVersionReviewed(documentId: string, version: number, reviewed: ReviewMark[]): Promise<void>;
  updateVersion(documentId: string, version: number, patch: VersionPatch): Promise<void>;
  /** Delete all but the newest `keep` versions, never one in `protect` and never a pinned one. */
  pruneVersions(documentId: string, keep: number, protect: number[]): Promise<void>;

  insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null; expiresAt: string | null }): Promise<KeyRow>;
  listKeys(): Promise<KeyRow[]>;
  findKeyByHash(hash: string): Promise<KeyRow | null>;
  touchKey(id: string, at: string): Promise<void>;
  revokeKey(id: string, at: string): Promise<boolean>;

  addHits(documentIds: string[], day: string, source: string): Promise<void>;
  /** Hits per document since `sinceDay` (inclusive); only documents of `collection` when given. */
  hitCounts(sinceDay: string, collection?: string): Promise<Map<string, number>>;

  insertAudit(e: NewAudit): Promise<void>;
  /** Newest first. */
  listAudit(q: AuditQuery): Promise<AuditEntry[]>;

  /** Throws when `(store, key)` is taken. */
  insertAsset(a: NewAsset): Promise<CmsAsset>;
  /** Files in the trash are not found unless `trashed` is set. */
  findAsset(id: string, o?: FindOptions): Promise<CmsAsset | null>;
  /** Never returns files in the trash. */
  findAssets(ids: readonly string[]): Promise<CmsAsset[]>;
  findAssetByKey(store: string, key: string): Promise<CmsAsset | null>;
  findAssetsByKeys(store: string, keys: readonly string[]): Promise<CmsAsset[]>;
  /** Newest first. */
  listAssets(q: AssetQuery): Promise<CmsAsset[]>;
  /** Ready files per folder and kind (folder rows included). */
  countAssets(store?: string): Promise<{ store: string; folder: string; kind: AssetKind; n: number }[]>;
  updateAsset(id: string, patch: AssetPatch): Promise<CmsAsset | null>;
  deleteAsset(id: string): Promise<void>;
  /** Replace what `documentId` uses. Files that do not exist are skipped. */
  setAssetRefs(documentId: string, refs: readonly Omit<AssetRef, "documentId">[]): Promise<void>;
  listAssetRefs(assetId: string): Promise<AssetRef[]>;

  insertComment(c: NewComment): Promise<CmsComment>;
  findComment(id: string): Promise<CmsComment | null>;
  /** Oldest first. */
  listComments(documentId: string): Promise<CmsComment[]>;
  updateComment(id: string, patch: Pick<CmsComment, "resolvedAt" | "resolvedBy">): Promise<CmsComment | null>;
  /** Open (unresolved) top-level comments per document. */
  countComments(documentIds: readonly string[]): Promise<Map<string, number>>;

  insertRelease(r: NewRelease): Promise<CmsRelease>;
  findRelease(id: string): Promise<CmsRelease | null>;
  /** Newest first. */
  listReleases(): Promise<CmsRelease[]>;
  /** With `expectedState`, null when the release is no longer in that state (someone else ran it). */
  updateRelease(id: string, patch: ReleasePatch, expectedState?: CmsRelease["state"]): Promise<CmsRelease | null>;
  deleteRelease(id: string): Promise<void>;

  insertFilter(f: NewFilter): Promise<SavedFilter>;
  findFilter(id: string): Promise<SavedFilter | null>;
  listFilters(collection: string): Promise<SavedFilter[]>;
  deleteFilter(id: string): Promise<void>;

  /** Insert or refresh one person's row for a document. */
  touchPresence(p: Presence): Promise<void>;
  /** Rows seen at or after `since`, for these documents (all when omitted). */
  listPresence(since: string, documentIds?: readonly string[]): Promise<Presence[]>;
  dropPresence(documentId: string, actorId: string): Promise<void>;
  /** Remove rows last seen before `before`. */
  prunePresence(before: string): Promise<void>;

  /** Changes whenever any document changes (for cross-process index refresh). */
  changeStamp(): Promise<string>;

  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

/** In-memory repo for tests and examples. Starts at the current schema version. */
export class MemoryRepo implements CmsRepo {
  docs = new Map<string, CmsDoc>();
  versions: StoredVersion[] = [];
  keys: KeyRow[] = [];
  hits = new Map<string, number>();
  audit: AuditEntry[] = [];
  assets = new Map<string, CmsAsset>();
  assetRefs: AssetRef[] = [];
  comments: CmsComment[] = [];
  releases: CmsRelease[] = [];
  filters: SavedFilter[] = [];
  presence: Presence[] = [];
  meta = new Map<string, unknown>([["schema_version", SCHEMA_VERSION]]);
  private seq = 0;
  private id = () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;

  async tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T> {
    // Snapshot + restore on failure keeps the "atomic" contract in tests.
    const snap = {
      docs: new Map([...this.docs].map(([k, v]) => [k, structuredClone(v)])),
      versions: this.versions.map((v) => structuredClone(v)),
      assets: new Map([...this.assets].map(([k, v]) => [k, structuredClone(v)])),
      assetRefs: this.assetRefs.map((r) => ({ ...r })),
      releases: structuredClone(this.releases),
      comments: structuredClone(this.comments),
    };
    try {
      return await fn(this);
    } catch (e) {
      this.docs = snap.docs;
      this.versions = snap.versions;
      this.assets = snap.assets;
      this.assetRefs = snap.assetRefs;
      this.releases = snap.releases;
      this.comments = snap.comments;
      throw e;
    }
  }
  async findDoc(collection: string, slug: string, o: FindOptions = {}) {
    for (const d of this.docs.values()) if (d.collection === collection && d.slug === slug) return d.deletedAt && !o.trashed ? null : structuredClone(d);
    return null;
  }
  async findDocById(id: string, o: FindOptions = {}) {
    const d = this.docs.get(id);
    return d && (!d.deletedAt || o.trashed) ? structuredClone(d) : null;
  }
  async listDocs(f: DocFilter) {
    return [...this.docs.values()]
      .filter(
        (d) =>
          !!d.deletedAt === !!f.trashed &&
          (!f.dueBefore || (d.dueAt !== null && d.dueAt <= f.dueBefore)) &&
          (!f.collection || d.collection === f.collection) &&
          (!f.statuses || f.statuses.includes(d.status)) &&
          (f.published === undefined || (d.publishedVersion !== null && d.status !== "archived") === f.published)
      )
      .map((d) => structuredClone(d));
  }
  async insertDoc(doc: NewDoc) {
    for (const d of this.docs.values()) if (d.collection === doc.collection && d.slug === doc.slug) throw new Error("duplicate slug");
    const now = new Date().toISOString();
    const row: CmsDoc = { republishedAt: null, autosave: null, updatedByAgent: null, deletedAt: null, deletedBy: null, schedule: null, dueAt: null, review: null, ...doc, id: doc.id ?? this.id(), createdAt: doc.createdAt ?? now, updatedAt: doc.updatedAt ?? now };
    this.docs.set(row.id, structuredClone(row));
    return structuredClone(row);
  }
  async updateDoc(id: string, patch: DocPatch, expectedVersion?: number) {
    const d = this.docs.get(id);
    if (!d) return null;
    if (expectedVersion !== undefined && d.version !== expectedVersion) return null;
    if (patch.slug && patch.slug !== d.slug) {
      for (const o of this.docs.values()) if (o.id !== id && o.collection === d.collection && o.slug === patch.slug) throw new Error("duplicate slug");
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(d, structuredClone(clean), { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    return structuredClone(d);
  }
  async deleteDoc(id: string) {
    this.docs.delete(id);
    this.versions = this.versions.filter((v) => v.documentId !== id);
    for (const k of [...this.hits.keys()]) if (k.startsWith(`${id}|`)) this.hits.delete(k);
    this.assetRefs = this.assetRefs.filter((r) => r.documentId !== id);
    this.comments = this.comments.filter((c) => c.documentId !== id);
    this.presence = this.presence.filter((p) => p.documentId !== id);
  }
  async insertVersion(v: NewVersion) {
    if (this.versions.some((x) => x.documentId === v.documentId && x.version === v.version)) throw new Error("duplicate version");
    this.versions.push({ changed: null, authorAgent: null, label: null, pinned: false, approvedBy: null, approvedAt: null, ...structuredClone(v), reviewed: [], id: this.id(), createdAt: v.createdAt ?? new Date().toISOString() });
  }
  async listVersions(documentId: string) {
    return this.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version).map((v) => structuredClone(v));
  }
  async getVersion(documentId: string, version: number) {
    const v = this.versions.find((x) => x.documentId === documentId && x.version === version);
    return v ? structuredClone(v) : null;
  }
  async setVersionReviewed(documentId: string, version: number, reviewed: ReviewMark[]) {
    const v = this.versions.find((x) => x.documentId === documentId && x.version === version);
    if (v) v.reviewed = structuredClone(reviewed);
  }
  async updateVersion(documentId: string, version: number, patch: VersionPatch) {
    const v = this.versions.find((x) => x.documentId === documentId && x.version === version);
    if (v) Object.assign(v, Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)));
  }
  async pruneVersions(documentId: string, keep: number, protect: number[]) {
    const mine = this.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version);
    const drop = new Set(mine.slice(keep).filter((v) => !protect.includes(v.version) && !v.pinned).map((v) => v.id));
    this.versions = this.versions.filter((v) => !drop.has(v.id));
  }
  async insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null; expiresAt: string | null }) {
    const row: KeyRow = { ...k, id: this.id(), lastUsedAt: null, revokedAt: null, createdAt: new Date().toISOString() };
    this.keys.push(row);
    return { ...row };
  }
  async listKeys() {
    return this.keys.map((k) => ({ ...k }));
  }
  async findKeyByHash(hash: string) {
    const k = this.keys.find((x) => x.hash === hash);
    return k ? { ...k } : null;
  }
  async touchKey(id: string, at: string) {
    const k = this.keys.find((x) => x.id === id);
    if (k) k.lastUsedAt = at;
  }
  async revokeKey(id: string, at: string) {
    const k = this.keys.find((x) => x.id === id);
    if (!k || k.revokedAt) return false;
    k.revokedAt = at;
    return true;
  }
  async addHits(ids: string[], day: string, source: string) {
    for (const id of ids) {
      const key = `${id}|${day}|${source}`;
      this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
    }
  }
  async hitCounts(sinceDay: string, collection?: string) {
    const out = new Map<string, number>();
    for (const [k, n] of this.hits) {
      const [id, day] = k.split("|");
      if (collection && this.docs.get(id)?.collection !== collection) continue;
      if (day >= sinceDay) out.set(id, (out.get(id) ?? 0) + n);
    }
    return out;
  }
  async insertAudit(e: NewAudit) {
    this.audit.push({ actorAgent: null, ...structuredClone(e), id: this.id() });
  }
  async listAudit(q: AuditQuery) {
    return this.audit
      .filter((e) => (!q.before || `${e.at}|${e.id}` < q.before) && (!q.action || e.action === q.action) && (!q.outcome || e.outcome === q.outcome) && (!q.actorKind || e.actorKind === q.actorKind))
      .sort((a, b) => `${b.at}|${b.id}`.localeCompare(`${a.at}|${a.id}`))
      .slice(0, q.limit)
      .map((e) => structuredClone(e));
  }
  async insertAsset(a: NewAsset) {
    if (this.assets.has(a.id)) throw new Error("duplicate asset id");
    for (const o of this.assets.values()) if (o.store === a.store && o.key === a.key) throw new Error("duplicate asset key");
    const now = new Date().toISOString();
    const row: CmsAsset = { deletedAt: null, deletedBy: null, focalX: null, focalY: null, rev: 0, ...structuredClone(a), createdAt: a.createdAt ?? now, updatedAt: a.updatedAt ?? now };
    this.assets.set(row.id, row);
    return structuredClone(row);
  }
  async findAsset(id: string, o: FindOptions = {}) {
    const a = this.assets.get(id);
    return a && (!a.deletedAt || o.trashed) ? structuredClone(a) : null;
  }
  async findAssets(ids: readonly string[]) {
    return ids.map((id) => this.assets.get(id)).filter((a): a is CmsAsset => !!a && !a.deletedAt).map((a) => structuredClone(a));
  }
  async findAssetByKey(store: string, key: string) {
    for (const a of this.assets.values()) if (a.store === store && a.key === key) return structuredClone(a);
    return null;
  }
  async findAssetsByKeys(store: string, keys: readonly string[]) {
    const want = new Set(keys);
    return [...this.assets.values()].filter((a) => a.store === store && want.has(a.key)).map((a) => structuredClone(a));
  }
  async listAssets(q: AssetQuery) {
    const needle = q.q?.trim().toLowerCase();
    return [...this.assets.values()]
      .filter(
        (a) =>
          !!a.deletedAt === !!q.trashed &&
          (!q.store || a.store === q.store) &&
          (q.folder === undefined || a.folder === q.folder) &&
          (q.under === undefined || inFolder(a.folder, q.under)) &&
          (!q.kinds || q.kinds.includes(a.kind)) &&
          (!q.notKinds || !q.notKinds.includes(a.kind)) &&
          (!q.status || a.status === q.status) &&
          (!q.tag || a.tags.includes(q.tag)) &&
          (!q.createdBefore || a.createdAt < q.createdBefore) &&
          (!needle || a.name.toLowerCase().includes(needle) || a.alt.toLowerCase().includes(needle) || a.tags.some((t) => t.toLowerCase().includes(needle))) &&
          (!q.before || `${a.createdAt}|${a.id}` < q.before)
      )
      .sort((x, y) => `${y.createdAt}|${y.id}`.localeCompare(`${x.createdAt}|${x.id}`))
      .slice(0, q.limit ?? 1000)
      .map((a) => structuredClone(a));
  }
  async countAssets(store?: string) {
    const out = new Map<string, { store: string; folder: string; kind: AssetKind; n: number }>();
    for (const a of this.assets.values()) {
      if (a.status !== "ready" || a.deletedAt || (store && a.store !== store)) continue;
      const k = `${a.store}|${a.folder}|${a.kind}`;
      const cur = out.get(k) ?? { store: a.store, folder: a.folder, kind: a.kind, n: 0 };
      cur.n++;
      out.set(k, cur);
    }
    return [...out.values()];
  }
  async updateAsset(id: string, patch: AssetPatch) {
    const a = this.assets.get(id);
    if (!a) return null;
    if (patch.key !== undefined && patch.key !== a.key) {
      for (const o of this.assets.values()) if (o.id !== id && o.store === a.store && o.key === patch.key) throw new Error("duplicate asset key");
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(a, structuredClone(clean), { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    return structuredClone(a);
  }
  async deleteAsset(id: string) {
    this.assets.delete(id);
    this.assetRefs = this.assetRefs.filter((r) => r.assetId !== id);
  }
  async setAssetRefs(documentId: string, refs: readonly Omit<AssetRef, "documentId">[]) {
    this.assetRefs = this.assetRefs.filter((r) => r.documentId !== documentId);
    const seen = new Set<string>();
    for (const r of refs) {
      if (seen.has(r.assetId) || !this.assets.has(r.assetId) || (!r.inDraft && !r.inPublished)) continue;
      seen.add(r.assetId);
      this.assetRefs.push({ assetId: r.assetId, documentId, inDraft: r.inDraft, inPublished: r.inPublished });
    }
  }
  async listAssetRefs(assetId: string) {
    return this.assetRefs.filter((r) => r.assetId === assetId).map((r) => ({ ...r }));
  }
  async insertComment(c: NewComment) {
    const row: CmsComment = { ...structuredClone(c), id: this.id(), resolvedAt: null, resolvedBy: null };
    this.comments.push(row);
    return structuredClone(row);
  }
  async findComment(id: string) {
    const c = this.comments.find((x) => x.id === id);
    return c ? structuredClone(c) : null;
  }
  async listComments(documentId: string) {
    return this.comments.filter((c) => c.documentId === documentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => structuredClone(c));
  }
  async updateComment(id: string, patch: Pick<CmsComment, "resolvedAt" | "resolvedBy">) {
    const c = this.comments.find((x) => x.id === id);
    if (!c) return null;
    Object.assign(c, patch);
    return structuredClone(c);
  }
  async countComments(documentIds: readonly string[]) {
    const out = new Map<string, number>();
    for (const c of this.comments) if (!c.threadId && !c.resolvedAt && documentIds.includes(c.documentId)) out.set(c.documentId, (out.get(c.documentId) ?? 0) + 1);
    return out;
  }
  async insertRelease(r: NewRelease) {
    const row: CmsRelease = { ...r, id: this.id(), state: "open", publishAt: null, items: [], updatedAt: r.createdAt, publishedAt: null, publishedBy: null, lastError: null };
    this.releases.push(row);
    return structuredClone(row);
  }
  async findRelease(id: string) {
    const r = this.releases.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }
  async listReleases() {
    return this.releases.map((r) => structuredClone(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async updateRelease(id: string, patch: ReleasePatch, expectedState?: CmsRelease["state"]) {
    const r = this.releases.find((x) => x.id === id);
    if (!r || (expectedState && r.state !== expectedState)) return null;
    Object.assign(r, structuredClone(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))));
    return structuredClone(r);
  }
  async deleteRelease(id: string) {
    this.releases = this.releases.filter((r) => r.id !== id);
  }
  async insertFilter(f: NewFilter) {
    const row: SavedFilter = { ...structuredClone(f), id: this.id() };
    this.filters.push(row);
    return structuredClone(row);
  }
  async findFilter(id: string) {
    const f = this.filters.find((x) => x.id === id);
    return f ? structuredClone(f) : null;
  }
  async listFilters(collection: string) {
    return this.filters.filter((f) => f.collection === collection).sort((a, b) => a.name.localeCompare(b.name)).map((f) => structuredClone(f));
  }
  async deleteFilter(id: string) {
    this.filters = this.filters.filter((f) => f.id !== id);
  }
  async touchPresence(p: Presence) {
    this.presence = [...this.presence.filter((x) => !(x.documentId === p.documentId && x.actorId === p.actorId)), structuredClone(p)];
  }
  async listPresence(since: string, documentIds?: readonly string[]) {
    return this.presence.filter((p) => p.seenAt >= since && (!documentIds || documentIds.includes(p.documentId))).map((p) => structuredClone(p));
  }
  async dropPresence(documentId: string, actorId: string) {
    this.presence = this.presence.filter((x) => !(x.documentId === documentId && x.actorId === actorId));
  }
  async prunePresence(before: string) {
    this.presence = this.presence.filter((p) => p.seenAt >= before);
  }
  async changeStamp() {
    let max = "";
    for (const d of this.docs.values()) if (d.updatedAt > max) max = d.updatedAt;
    return `${this.docs.size}:${max}`;
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
  }
}
