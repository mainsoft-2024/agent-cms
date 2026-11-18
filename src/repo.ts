/**
 * Storage behind the CMS. `cms.ts` holds every rule (states, access, versions,
 * validation) and talks only to this interface, so the rules are tested
 * against `MemoryRepo` and run in production on `DrizzleRepo`.
 */

import { SCHEMA_VERSION } from "./schema-version";
import type { AuditEntry, CmsDoc, CmsKey, CmsVersion, DocStatus, KeyScope, ReviewMark } from "./types";

export type DocPatch = Partial<Omit<CmsDoc, "id" | "collection" | "createdAt">>;
export type NewDoc = Omit<CmsDoc, "id" | "createdAt" | "updatedAt" | "republishedAt" | "autosave"> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  republishedAt?: string | null;
  autosave?: CmsDoc["autosave"];
};
export type StoredVersion = Omit<CmsVersion, "published">;
export type NewVersion = Omit<CmsVersion, "id" | "createdAt" | "published" | "reviewed" | "changed"> & {
  createdAt?: string;
  changed?: CmsVersion["changed"];
};

export interface KeyRow extends CmsKey {
  hash: string;
  createdBy: string | null;
}

export interface AuditQuery {
  /** Entries strictly older than this cursor (from the previous page). */
  before?: string | null;
  limit: number;
  action?: string;
  outcome?: AuditEntry["outcome"];
  actorKind?: AuditEntry["actorKind"];
}

export interface CmsRepo {
  /** Run `fn` atomically (one DB transaction). */
  tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T>;

  findDoc(collection: string, slug: string): Promise<CmsDoc | null>;
  findDocById(id: string): Promise<CmsDoc | null>;
  listDocs(filter: { collection?: string; statuses?: DocStatus[]; published?: boolean }): Promise<CmsDoc[]>;
  insertDoc(doc: NewDoc): Promise<CmsDoc>;
  /** Returns null when `expectedVersion` is given and the row moved on. */
  updateDoc(id: string, patch: DocPatch, expectedVersion?: number): Promise<CmsDoc | null>;
  deleteDoc(id: string): Promise<void>;

  insertVersion(v: NewVersion): Promise<void>;
  listVersions(documentId: string): Promise<StoredVersion[]>;
  getVersion(documentId: string, version: number): Promise<StoredVersion | null>;
  setVersionReviewed(documentId: string, version: number, reviewed: ReviewMark[]): Promise<void>;
  /** Delete all but the newest `keep` versions, never one in `protect`. */
  pruneVersions(documentId: string, keep: number, protect: number[]): Promise<void>;

  insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null; expiresAt: string | null }): Promise<KeyRow>;
  listKeys(): Promise<KeyRow[]>;
  findKeyByHash(hash: string): Promise<KeyRow | null>;
  touchKey(id: string, at: string): Promise<void>;
  revokeKey(id: string, at: string): Promise<boolean>;

  addHits(documentIds: string[], day: string, source: string): Promise<void>;
  /** Hits per document since `sinceDay` (inclusive); only documents of `collection` when given. */
  hitCounts(sinceDay: string, collection?: string): Promise<Map<string, number>>;

  insertAudit(e: Omit<AuditEntry, "id">): Promise<void>;
  /** Newest first. */
  listAudit(q: AuditQuery): Promise<AuditEntry[]>;

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
  meta = new Map<string, unknown>([["schema_version", SCHEMA_VERSION]]);
  private seq = 0;
  private id = () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;

  async tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T> {
    // Snapshot + restore on failure keeps the "atomic" contract in tests.
    const snap = { docs: new Map([...this.docs].map(([k, v]) => [k, structuredClone(v)])), versions: this.versions.map((v) => structuredClone(v)) };
    try {
      return await fn(this);
    } catch (e) {
      this.docs = snap.docs;
      this.versions = snap.versions;
      throw e;
    }
  }
  async findDoc(collection: string, slug: string) {
    for (const d of this.docs.values()) if (d.collection === collection && d.slug === slug) return structuredClone(d);
    return null;
  }
  async findDocById(id: string) {
    const d = this.docs.get(id);
    return d ? structuredClone(d) : null;
  }
  async listDocs(f: { collection?: string; statuses?: DocStatus[]; published?: boolean }) {
    return [...this.docs.values()]
      .filter(
        (d) =>
          (!f.collection || d.collection === f.collection) &&
          (!f.statuses || f.statuses.includes(d.status)) &&
          (f.published === undefined || (d.publishedVersion !== null && d.status !== "archived") === f.published)
      )
      .map((d) => structuredClone(d));
  }
  async insertDoc(doc: NewDoc) {
    for (const d of this.docs.values()) if (d.collection === doc.collection && d.slug === doc.slug) throw new Error("duplicate slug");
    const now = new Date().toISOString();
    const row: CmsDoc = { republishedAt: null, autosave: null, ...doc, id: doc.id ?? this.id(), createdAt: doc.createdAt ?? now, updatedAt: doc.updatedAt ?? now };
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
  }
  async insertVersion(v: NewVersion) {
    if (this.versions.some((x) => x.documentId === v.documentId && x.version === v.version)) throw new Error("duplicate version");
    this.versions.push({ changed: null, ...structuredClone(v), reviewed: [], id: this.id(), createdAt: v.createdAt ?? new Date().toISOString() });
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
  async pruneVersions(documentId: string, keep: number, protect: number[]) {
    const mine = this.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version);
    const drop = new Set(mine.slice(keep).filter((v) => !protect.includes(v.version)).map((v) => v.id));
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
  async insertAudit(e: Omit<AuditEntry, "id">) {
    this.audit.push({ ...structuredClone(e), id: this.id() });
  }
  async listAudit(q: AuditQuery) {
    return this.audit
      .filter((e) => (!q.before || `${e.at}|${e.id}` < q.before) && (!q.action || e.action === q.action) && (!q.outcome || e.outcome === q.outcome) && (!q.actorKind || e.actorKind === q.actorKind))
      .sort((a, b) => `${b.at}|${b.id}`.localeCompare(`${a.at}|${a.id}`))
      .slice(0, q.limit)
      .map((e) => structuredClone(e));
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
