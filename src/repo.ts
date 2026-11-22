/**
 * Storage behind the CMS. `cms.ts` holds every rule (states, access, versions,
 * validation) and talks only to this interface, so the rules are tested
 * against `MemoryRepo` and run in production on `DrizzleRepo`.
 */

import { SCHEMA_VERSION } from "./schema-version";
import type { AssetKind, AssetRef, AuditEntry, CmsAsset, CmsComment, CmsDoc, CmsKey, CmsRelease, CmsVersion, DocStatus, KeyScope, Presence, ReviewMark, SavedFilter, CmsJob, CmsRecord, CmsWebhook, WebhookDelivery } from "./types";

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

export type PruneTarget = "audit" | "hits" | "keys" | "deliveries";

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
  /** All actions of one kind: `doc.` matches `doc.publish`, `doc.delete`, … (0.18.0). */
  actionPrefix?: string;
  outcome?: AuditEntry["outcome"];
  actorKind?: AuditEntry["actorKind"];
  /** One person or key by id (0.18.0). */
  actorId?: string;
  /** Words in the name shown for who did it (0.18.0). */
  who?: string;
  /** What it was done to (0.18.0). */
  collection?: string;
  slug?: string;
  /** A period: entries at or after `since` and before `until` (ISO times, 0.18.0). */
  since?: string;
  until?: string;
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

export type AssetSort = "new" | "old" | "name" | "size";

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
  /** No document uses it (draft or published). */
  unused?: boolean;
  /** Images without alt text. */
  missingAlt?: boolean;
  /** Order. Default "new" (newest first, with `before` as the cursor); the others page with `offset`. */
  sort?: AssetSort;
  offset?: number;
  /** Entries strictly older than this cursor (`createdAt|id` of the last one). */
  before?: string | null;
  limit?: number;
}

/** True when `folder` is `under` or inside it. */
export const inFolder = (folder: string, under: string) => under === "" || folder === under || folder.startsWith(`${under}/`);

export interface CmsRepo {
  /** Run `fn` atomically (one DB transaction). */
  /**
   * Run `fn` in a transaction. With `atomic`, a store that cannot promise all-or-nothing (a
   * driver without transactions) refuses with `transactions_required` instead of running the
   * steps one by one: used where half a change would be wrong (publishing a release).
   */
  tx<T>(fn: (repo: CmsRepo) => Promise<T>, o?: { atomic?: boolean }): Promise<T>;

  /** Documents in the trash are not found unless `trashed` is set. */
  findDoc(collection: string, slug: string, o?: FindOptions): Promise<CmsDoc | null>;
  findDocById(id: string, o?: FindOptions): Promise<CmsDoc | null>;
  listDocs(filter: DocFilter): Promise<CmsDoc[]>;
  insertDoc(doc: NewDoc): Promise<CmsDoc>;
  /** Returns null when `expectedVersion` is given and the row moved on. */
  /** With `expectedVersion`: only if the row is still at that version and not in the trash (else null). */
  updateDoc(id: string, patch: DocPatch, expectedVersion?: number): Promise<CmsDoc | null>;
  deleteDoc(id: string): Promise<void>;

  insertVersion(v: NewVersion): Promise<void>;
  listVersions(documentId: string): Promise<StoredVersion[]>;
  /**
   * One page of a document's versions, newest first, older than `before` (0.18.0). Optional:
   * without it the CMS pages `listVersions` in memory.
   */
  pageVersions?(documentId: string, o: { limit: number; before?: number | null }): Promise<{ versions: StoredVersion[]; total: number }>;
  getVersion(documentId: string, version: number): Promise<StoredVersion | null>;
  setVersionReviewed(documentId: string, version: number, reviewed: ReviewMark[]): Promise<void>;
  updateVersion(documentId: string, version: number, patch: VersionPatch): Promise<void>;
  /** Delete all but the newest `keep` versions, never one in `protect` and never a pinned one. */
  pruneVersions(documentId: string, keep: number, protect: number[]): Promise<void>;

  insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null; expiresAt: string | null }): Promise<KeyRow>;
  listKeys(): Promise<KeyRow[]>;
  findKeyByHash(hash: string): Promise<KeyRow | null>;
  touchKey(id: string, at: string): Promise<void>;
  /** `at` may be in the future: the key works until then (key rotation). False when it is already revoked at or before `at`. */
  revokeKey(id: string, at: string): Promise<boolean>;
  /**
   * Delete old rows (retention): audit entries and deliveries before an instant, hit counts before a
   * day (`YYYY-MM-DD`), keys revoked before an instant. With `dryRun` nothing is deleted. Returns how many.
   */
  prune(what: PruneTarget, before: string, dryRun?: boolean): Promise<number>;

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
  /**
   * `expected`: the state the release must still be in, or `{ state, updatedAt }` (0.18.0): the
   * release must be exactly as it was read (its `updatedAt` is its revision). Null when it is not.
   */
  updateRelease(id: string, patch: ReleasePatch, expected?: CmsRelease["state"] | { state?: CmsRelease["state"]; updatedAt?: string }): Promise<CmsRelease | null>;
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

  // jobs
  insertJob(j: NewJob): Promise<CmsJob>;
  /**
   * Take up to `limit` jobs whose time has come and that nobody holds: sets their lock and counts
   * the attempt in one statement, so two callers never get the same job.
   */
  claimJobs(now: string, lockUntil: string, limit: number): Promise<CmsJob[]>;
  updateJob(id: string, patch: JobPatch): Promise<void>;
  listJobs(q: { state?: "waiting" | "failed" | "done"; kind?: string; limit?: number }): Promise<CmsJob[]>;
  countJobs(): Promise<{ waiting: number; failed: number }>;
  /** Drop finished jobs older than `doneBefore`. */
  pruneJobs(doneBefore: string): Promise<number>;

  // webhooks
  insertWebhook(w: NewWebhook): Promise<CmsWebhook>;
  findWebhook(id: string): Promise<CmsWebhook | null>;
  listWebhooks(): Promise<CmsWebhook[]>;
  updateWebhook(id: string, patch: WebhookPatch): Promise<CmsWebhook | null>;
  deleteWebhook(id: string): Promise<void>;
  /** Count one more failed delivery and return the new count. One statement: deliveries run side by side. */
  failWebhook(id: string): Promise<number>;
  insertDelivery(d: Omit<WebhookDelivery, "id">): Promise<WebhookDelivery>;
  findDelivery(id: string): Promise<WebhookDelivery | null>;
  /** Newest first. */
  listDeliveries(webhookId: string, limit: number): Promise<WebhookDelivery[]>;
  pruneDeliveries(before: string): Promise<number>;

  /** Changes whenever any document changes (for cross-process index refresh). */
  changeStamp(): Promise<string>;

  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;

  /** Records (`cms_records`): small objects of the CMS itself. A second row with the same `kind` and `key` is refused. */
  insertRecord(r: NewRecord): Promise<CmsRecord>;
  findRecord(kind: string, id: string): Promise<CmsRecord | null>;
  findRecordByKey(kind: string, key: string): Promise<CmsRecord | null>;
  /** Newest first unless `order` is "asc". Default limit 200. */
  listRecords(q: RecordQuery): Promise<CmsRecord[]>;
  updateRecord(kind: string, id: string, patch: RecordPatch): Promise<CmsRecord | null>;
  /** By id, by scope, older than `before`, or a whole kind. Returns how many went. */
  deleteRecords(q: { kind: string; id?: string; scope?: string; before?: string }): Promise<number>;
  /** Versions made since an instant, newest first, without their content. */
  versionsSince(since: string, limit: number): Promise<VersionStamp[]>;

  // ── 0.17.0: optional, so a repo written for an older version keeps working ──
  /** Add a row to the change log (`cms_changes`) and return its number. */
  appendChange?(c: NewChange): Promise<number>;
  /** Rows after `seq`, oldest first. */
  changesSince?(seq: number, limit: number): Promise<ChangeRow[]>;
  /**
   * True when change numbers become visible in order (0.18.0): seeing number N means every smaller
   * number is either visible or will never exist. Without it, the CMS waits a few seconds at a
   * missing number in case a slower transaction still commits it.
   */
  readonly changesInCommitOrder?: boolean;
  /** The newest number (0 when empty). */
  lastChange?(): Promise<number>;
  /** Drop rows older than `before`; returns how many went. */
  pruneChanges?(before: string): Promise<number>;
  /** Several documents by id in one query (missing ones are left out). */
  findDocsByIds?(ids: readonly string[]): Promise<CmsDoc[]>;
  /** A name for this database's tables, so caches shared by several CMSs keep them apart. */
  cacheNamespace?(): string;
  /** One page of a list, filtered, sorted and cut in the database. */
  pageDocs?(q: DocPageQuery): Promise<DocPage>;
}

/** A row of the change log. */
export interface ChangeRow {
  seq: number;
  at: string;
  event: string;
  collection: string | null;
  slug: string | null;
  version: number | null;
  origin: string;
  data: Record<string, unknown>;
}
export type NewChange = Omit<ChangeRow, "seq" | "at"> & { at?: string };

/**
 * A page of documents. Editors (`published: false`) see rows as they are, newest change first;
 * readers (`published: true`) the published copy, newest publish first. `after` is the last row
 * of the previous page (keyset paging: a page never repeats or skips rows when others are added).
 */
export interface DocPageQuery {
  collection: string;
  published: boolean;
  statuses?: DocStatus[];
  category?: string;
  /** Title, slug or summary contains (case-insensitive). On the published copy for readers. */
  q?: string;
  by?: "user" | "key" | "system";
  limit: number;
  after?: { at: string; id: string } | null;
}
export interface DocPage {
  docs: CmsDoc[];
  total: number;
}

/** Documents by id (not in the trash) in one query when the repo can, else one by one in parallel. */
export async function docsById(repo: CmsRepo, ids: readonly string[]): Promise<Map<string, CmsDoc>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const found = repo.findDocsByIds ? await repo.findDocsByIds(uniq) : (await Promise.all(uniq.map((id) => repo.findDocById(id)))).filter((d): d is CmsDoc => !!d);
  return new Map(found.map((d) => [d.id, d]));
}

/** Sort key of a document in `pageDocs`. */
export function pageKey(d: CmsDoc, published: boolean): string {
  return published ? (d.publishedAt ?? d.updatedAt) : d.updatedAt;
}

/** In-memory repo for tests and examples. Starts at the current schema version. */
export interface NewRecord {
  kind: string;
  scope?: string;
  key?: string | null;
  data: Record<string, unknown>;
  at: string;
}
export interface RecordPatch {
  data?: Record<string, unknown>;
  key?: string | null;
  at: string;
}
export interface RecordQuery {
  kind: string;
  scope?: string;
  /** Rows created before this instant (paging backwards). */
  before?: string | null;
  limit?: number;
  order?: "asc" | "desc";
}
/** One version without its content: who made it and when (the dashboard). */
export interface VersionStamp {
  documentId: string;
  version: number;
  createdAt: string;
  authorKind: "user" | "key" | "system";
  authorLabel: string;
  authorAgent: string | null;
}
export type NewJob = Pick<CmsJob, "kind" | "payload" | "runAt" | "maxAttempts" | "createdAt">;
export type JobPatch = Partial<Pick<CmsJob, "runAt" | "lockedUntil" | "lastError" | "doneAt" | "failedAt">>;
export type NewWebhook = Omit<CmsWebhook, "id" | "failures" | "disabledReason">;
export type WebhookPatch = Partial<Omit<CmsWebhook, "id" | "createdAt" | "createdBy">>;

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
  jobs: CmsJob[] = [];
  webhooks: CmsWebhook[] = [];
  deliveries: WebhookDelivery[] = [];
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
      changesTop: this.changeBase,
    };
    try {
      return await fn(this);
    } catch (e) {
      // Change rows of a rolled-back write go too; their numbers are not handed out again.
      this.changes = this.changes.filter((c) => c.seq <= snap.changesTop);
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
    if (expectedVersion !== undefined && (d.version !== expectedVersion || d.deletedAt)) return null;
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
  async pageVersions(documentId: string, o: { limit: number; before?: number | null }) {
    const all = this.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version);
    const rows = all.filter((v) => o.before == null || v.version < o.before).slice(0, o.limit);
    return { versions: rows.map((v) => structuredClone(v)), total: all.length };
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
    if (!k || (k.revokedAt && k.revokedAt <= at)) return false;
    k.revokedAt = at;
    return true;
  }
  async prune(what: PruneTarget, before: string, dryRun = false) {
    if (what === "audit") {
      const keep = this.audit.filter((e) => e.at >= before);
      const n = this.audit.length - keep.length;
      if (!dryRun) this.audit = keep;
      return n;
    }
    if (what === "deliveries") {
      const keep = this.deliveries.filter((d) => d.at >= before);
      const n = this.deliveries.length - keep.length;
      if (!dryRun) this.deliveries = keep;
      return n;
    }
    if (what === "keys") {
      const keep = this.keys.filter((k) => !(k.revokedAt && k.revokedAt < before));
      const n = this.keys.length - keep.length;
      if (!dryRun) this.keys = keep;
      return n;
    }
    let n = 0;
    for (const k of [...this.hits.keys()]) {
      if (k.split("|")[1] >= before) continue;
      n++;
      if (!dryRun) this.hits.delete(k);
    }
    return n;
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
      .filter(
        (e) =>
          (!q.before || `${e.at}|${e.id}` < q.before) &&
          (!q.action || e.action === q.action) &&
          (!q.actionPrefix || e.action.startsWith(q.actionPrefix)) &&
          (!q.outcome || e.outcome === q.outcome) &&
          (!q.actorKind || e.actorKind === q.actorKind) &&
          (!q.actorId || e.actorId === q.actorId) &&
          (!q.who || e.actorLabel.toLowerCase().includes(q.who.toLowerCase())) &&
          (!q.collection || e.collection === q.collection) &&
          (!q.slug || e.slug === q.slug) &&
          (!q.since || e.at >= q.since) &&
          (!q.until || e.at < q.until)
      )
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
          (!q.before || `${a.createdAt}|${a.id}` < q.before) &&
          (!q.unused || !this.assetRefs.some((r) => r.assetId === a.id)) &&
          (!q.missingAlt || (a.kind === "image" && !a.alt.trim()))
      )
      .sort((x, y) =>
        q.sort === "name"
          ? x.name.toLowerCase().localeCompare(y.name.toLowerCase()) || x.id.localeCompare(y.id)
          : q.sort === "size"
            ? y.size - x.size || x.id.localeCompare(y.id)
            : q.sort === "old"
              ? `${x.createdAt}|${x.id}`.localeCompare(`${y.createdAt}|${y.id}`)
              : `${y.createdAt}|${y.id}`.localeCompare(`${x.createdAt}|${x.id}`)
      )
      .slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 1000))
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
  async updateRelease(id: string, patch: ReleasePatch, expected?: CmsRelease["state"] | { state?: CmsRelease["state"]; updatedAt?: string }) {
    const r = this.releases.find((x) => x.id === id);
    const e = typeof expected === "string" ? { state: expected } : (expected ?? {});
    if (!r || (e.state && r.state !== e.state) || (e.updatedAt && Date.parse(r.updatedAt) !== Date.parse(e.updatedAt))) return null;
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

  async insertJob(j: NewJob) {
    const row: CmsJob = { ...structuredClone(j), id: this.id(), attempts: 0, lockedUntil: null, lastError: null, doneAt: null, failedAt: null };
    this.jobs.push(row);
    return structuredClone(row);
  }
  async claimJobs(now: string, lockUntil: string, limit: number) {
    const due = this.jobs
      .filter((j) => !j.doneAt && !j.failedAt && j.runAt <= now && (!j.lockedUntil || j.lockedUntil < now))
      .sort((a, b) => a.runAt.localeCompare(b.runAt))
      .slice(0, limit);
    for (const j of due) {
      j.lockedUntil = lockUntil;
      j.attempts += 1;
    }
    return due.map((j) => structuredClone(j));
  }
  async updateJob(id: string, patch: JobPatch) {
    const j = this.jobs.find((x) => x.id === id);
    if (j) Object.assign(j, patch);
  }
  async listJobs(q: { state?: "waiting" | "failed" | "done"; kind?: string; limit?: number }) {
    const state = (j: CmsJob) => (j.doneAt ? "done" : j.failedAt ? "failed" : "waiting");
    return this.jobs
      .filter((j) => (!q.state || state(j) === q.state) && (!q.kind || j.kind === q.kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit ?? 100)
      .map((j) => structuredClone(j));
  }
  async countJobs() {
    return { waiting: this.jobs.filter((j) => !j.doneAt && !j.failedAt).length, failed: this.jobs.filter((j) => j.failedAt).length };
  }
  async pruneJobs(doneBefore: string) {
    const n = this.jobs.length;
    this.jobs = this.jobs.filter((j) => !(j.doneAt && j.doneAt < doneBefore));
    return n - this.jobs.length;
  }

  async insertWebhook(w: NewWebhook) {
    const row: CmsWebhook = { ...structuredClone(w), id: this.id(), failures: 0, disabledReason: null };
    this.webhooks.push(row);
    return structuredClone(row);
  }
  async findWebhook(id: string) {
    const w = this.webhooks.find((x) => x.id === id);
    return w ? structuredClone(w) : null;
  }
  async listWebhooks() {
    return this.webhooks.map((w) => structuredClone(w)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async updateWebhook(id: string, patch: WebhookPatch) {
    const w = this.webhooks.find((x) => x.id === id);
    if (!w) return null;
    Object.assign(w, structuredClone(patch));
    return structuredClone(w);
  }
  async failWebhook(id: string) {
    const w = this.webhooks.find((x) => x.id === id);
    return w ? ++w.failures : 0;
  }
  async deleteWebhook(id: string) {
    this.webhooks = this.webhooks.filter((w) => w.id !== id);
    this.deliveries = this.deliveries.filter((d) => d.webhookId !== id);
  }
  async insertDelivery(d: Omit<WebhookDelivery, "id">) {
    const row = { ...structuredClone(d), id: this.id() };
    this.deliveries.push(row);
    return structuredClone(row);
  }
  async findDelivery(id: string) {
    const d = this.deliveries.find((x) => x.id === id);
    return d ? structuredClone(d) : null;
  }
  async listDeliveries(webhookId: string, limit: number) {
    return this.deliveries.filter((d) => d.webhookId === webhookId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).map((d) => structuredClone(d));
  }
  async pruneDeliveries(before: string) {
    const n = this.deliveries.length;
    this.deliveries = this.deliveries.filter((d) => d.at >= before);
    return n - this.deliveries.length;
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

  private records: CmsRecord[] = [];
  async insertRecord(r: NewRecord) {
    if (r.key != null && this.records.some((x) => x.kind === r.kind && x.key === r.key)) throw new Error(`duplicate record key: ${r.kind}/${r.key}`);
    const row: CmsRecord = { id: this.id(), kind: r.kind, scope: r.scope ?? "", key: r.key ?? null, data: structuredClone(r.data), createdAt: r.at, updatedAt: r.at };
    this.records.push(row);
    return structuredClone(row);
  }
  async findRecord(kind: string, id: string) {
    const r = this.records.find((x) => x.kind === kind && x.id === id);
    return r ? structuredClone(r) : null;
  }
  async findRecordByKey(kind: string, key: string) {
    const r = this.records.find((x) => x.kind === kind && x.key === key);
    return r ? structuredClone(r) : null;
  }
  async listRecords(q: RecordQuery) {
    const rows = this.records.filter((x) => x.kind === q.kind && (q.scope === undefined || x.scope === q.scope) && (!q.before || x.createdAt < q.before));
    rows.sort((a, b) => (q.order === "asc" ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
    return rows.slice(0, q.limit ?? 200).map((r) => structuredClone(r));
  }
  async updateRecord(kind: string, id: string, patch: RecordPatch) {
    const r = this.records.find((x) => x.kind === kind && x.id === id);
    if (!r) return null;
    if (patch.data !== undefined) r.data = structuredClone(patch.data);
    if (patch.key !== undefined) r.key = patch.key;
    r.updatedAt = patch.at;
    return structuredClone(r);
  }
  async deleteRecords(q: { kind: string; id?: string; scope?: string; before?: string }) {
    const n = this.records.length;
    this.records = this.records.filter((x) => !(x.kind === q.kind && (q.id === undefined || x.id === q.id) && (q.scope === undefined || x.scope === q.scope) && (q.before === undefined || x.createdAt < q.before)));
    return n - this.records.length;
  }
  private changes: ChangeRow[] = [];
  /**
   * Rows are added and seen at once, in order. The memory repo is for one process and tests: its
   * transactions share live state, so it makes no promise for writes that overlap in time.
   */
  readonly changesInCommitOrder = true;
  async appendChange(c: NewChange) {
    const seq = Math.max(this.changes.at(-1)?.seq ?? 0, this.changeBase) + 1;
    this.changeBase = seq;
    this.changes.push({ seq, at: c.at ?? new Date().toISOString(), event: c.event, collection: c.collection, slug: c.slug, version: c.version, origin: c.origin, data: structuredClone(c.data) });
    return seq;
  }
  /** The highest number handed out: numbers keep going after a prune or a rollback, like a database sequence. */
  private changeBase = 0;
  async changesSince(seq: number, limit: number) {
    return this.changes.filter((c) => c.seq > seq).slice(0, limit).map((c) => structuredClone(c));
  }
  async lastChange() {
    return this.changes.at(-1)?.seq ?? this.changeBase;
  }
  async pruneChanges(before: string) {
    const n = this.changes.length;
    this.changes = this.changes.filter((c) => c.at >= before);
    return n - this.changes.length;
  }
  async findDocsByIds(ids: readonly string[]) {
    const out: CmsDoc[] = [];
    for (const id of ids) {
      const d = this.docs.get(id);
      if (d) out.push(structuredClone(d));
    }
    return out;
  }
  async pageDocs(q: DocPageQuery): Promise<DocPage> {
    const needle = q.q?.trim().toLowerCase();
    const rows = [...this.docs.values()].filter((d) => {
      if (d.deletedAt || d.collection !== q.collection) return false;
      if (q.published && (d.publishedVersion === null || d.status === "archived" || !d.published)) return false;
      if (q.statuses && !q.statuses.includes(d.status)) return false;
      const view = q.published && d.published ? d.published : d;
      if (q.category && (view.category ?? null) !== q.category) return false;
      if (needle && !((view.title ?? "").toLowerCase().includes(needle) || d.slug.includes(needle) || (view.summary ?? "").toLowerCase().includes(needle))) return false;
      if (q.by && d.updatedByKind !== q.by) return false;
      return true;
    });
    const cmp = (a: CmsDoc, b: CmsDoc) => pageKey(b, q.published).localeCompare(pageKey(a, q.published)) || b.id.localeCompare(a.id);
    rows.sort(cmp);
    const after = q.after;
    const start = after ? rows.filter((d) => { const k = pageKey(d, q.published); return k < after.at || (k === after.at && d.id < after.id); }) : rows;
    return { docs: start.slice(0, q.limit).map((d) => structuredClone(d)), total: rows.length };
  }
  async versionsSince(since: string, limit: number) {
    const out: VersionStamp[] = [];
    for (const v of this.versions) if (v.createdAt >= since) out.push({ documentId: v.documentId, createdAt: v.createdAt, authorKind: v.authorKind, authorLabel: v.authorLabel, authorAgent: v.authorAgent ?? null, version: v.version });
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}
