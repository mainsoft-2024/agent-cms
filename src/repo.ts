/**
 * Storage behind the CMS. `cms.ts` holds every rule (states, access, versions,
 * validation) and talks only to this interface, so the rules are tested
 * against `MemoryRepo` and run in production on `DrizzleRepo`.
 */

import type { CmsDoc, CmsGap, CmsKey, CmsVersion, DocStatus, KeyScope } from "./types";

export type DocPatch = Partial<Omit<CmsDoc, "id" | "collection" | "createdAt">>;
export type NewDoc = Omit<CmsDoc, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string; updatedAt?: string };

export interface KeyRow extends CmsKey {
  hash: string;
  createdBy: string | null;
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

  insertVersion(v: Omit<CmsVersion, "id" | "createdAt" | "published"> & { createdAt?: string }): Promise<void>;
  listVersions(documentId: string): Promise<Omit<CmsVersion, "published">[]>;
  getVersion(documentId: string, version: number): Promise<Omit<CmsVersion, "published"> | null>;
  /** Delete all but the newest `keep` versions, never one in `protect`. */
  pruneVersions(documentId: string, keep: number, protect: number[]): Promise<void>;

  upsertGap(g: { collection: string; kind: CmsGap["kind"]; query: string; normalized: string; note: string | null; documentSlug: string | null; at: string }): Promise<void>;
  listGaps(filter: { collection?: string; state?: CmsGap["state"] }): Promise<CmsGap[]>;
  /** Only a gap of `collection` changes; null when there is none with that id there. */
  setGapState(id: string, state: CmsGap["state"], collection: string): Promise<CmsGap | null>;

  insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null }): Promise<KeyRow>;
  listKeys(): Promise<KeyRow[]>;
  findKeyByHash(hash: string): Promise<KeyRow | null>;
  touchKey(id: string, at: string): Promise<void>;
  revokeKey(id: string, at: string): Promise<boolean>;

  addHits(documentIds: string[], day: string): Promise<void>;
  hitCounts(sinceDay: string): Promise<Map<string, number>>;

  /** Changes whenever any document changes (for cross-process index refresh). */
  changeStamp(): Promise<string>;

  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

/** In-memory repo for tests and examples. */
export class MemoryRepo implements CmsRepo {
  docs = new Map<string, CmsDoc>();
  versions: Omit<CmsVersion, "published">[] = [];
  gaps: (CmsGap & { normalized: string })[] = [];
  keys: KeyRow[] = [];
  hits = new Map<string, number>();
  meta = new Map<string, unknown>();
  private seq = 0;
  private id = () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;

  async tx<T>(fn: (repo: CmsRepo) => Promise<T>): Promise<T> {
    // Snapshot + restore on failure keeps the "atomic" contract in tests.
    const snap = { docs: new Map([...this.docs].map(([k, v]) => [k, structuredClone(v)])), versions: [...this.versions] };
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
    const row: CmsDoc = { ...doc, id: doc.id ?? this.id(), createdAt: doc.createdAt ?? now, updatedAt: doc.updatedAt ?? now };
    this.docs.set(row.id, row);
    return structuredClone(row);
  }
  async updateDoc(id: string, patch: DocPatch, expectedVersion?: number) {
    const d = this.docs.get(id);
    if (!d) return null;
    if (expectedVersion !== undefined && d.version !== expectedVersion) return null;
    if (patch.slug && patch.slug !== d.slug) {
      for (const o of this.docs.values()) if (o.id !== id && o.collection === d.collection && o.slug === patch.slug) throw new Error("duplicate slug");
    }
    Object.assign(d, patch, { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    return structuredClone(d);
  }
  async deleteDoc(id: string) {
    this.docs.delete(id);
    this.versions = this.versions.filter((v) => v.documentId !== id);
  }
  async insertVersion(v: Omit<CmsVersion, "id" | "createdAt" | "published"> & { createdAt?: string }) {
    if (this.versions.some((x) => x.documentId === v.documentId && x.version === v.version)) throw new Error("duplicate version");
    this.versions.push({ ...structuredClone(v), id: this.id(), createdAt: v.createdAt ?? new Date().toISOString() });
  }
  async listVersions(documentId: string) {
    return this.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version).map((v) => structuredClone(v));
  }
  async getVersion(documentId: string, version: number) {
    const v = this.versions.find((x) => x.documentId === documentId && x.version === version);
    return v ? structuredClone(v) : null;
  }
  async pruneVersions(documentId: string, keep: number, protect: number[]) {
    const mine = this.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.version - a.version);
    const drop = new Set(mine.slice(keep).filter((v) => !protect.includes(v.version)).map((v) => v.id));
    this.versions = this.versions.filter((v) => !drop.has(v.id));
  }
  async upsertGap(g: { collection: string; kind: CmsGap["kind"]; query: string; normalized: string; note: string | null; documentSlug: string | null; at: string }) {
    const hit = this.gaps.find((x) => x.collection === g.collection && x.kind === g.kind && x.normalized === g.normalized);
    if (hit) {
      hit.count += 1;
      hit.query = g.query;
      hit.note = g.note ?? hit.note;
      hit.documentSlug = g.documentSlug ?? hit.documentSlug;
      hit.lastSeenAt = g.at;
      if (hit.state === "done") hit.state = "open";
      return;
    }
    this.gaps.push({ id: this.id(), collection: g.collection, kind: g.kind, query: g.query, note: g.note, documentSlug: g.documentSlug, count: 1, state: "open", firstSeenAt: g.at, lastSeenAt: g.at, normalized: g.normalized });
  }
  async listGaps(f: { collection?: string; state?: CmsGap["state"] }) {
    return this.gaps.filter((g) => (!f.collection || g.collection === f.collection) && (!f.state || g.state === f.state)).map((g) => ({ ...g }));
  }
  async setGapState(id: string, state: CmsGap["state"], collection: string) {
    const g = this.gaps.find((x) => x.id === id && x.collection === collection);
    if (!g) return null;
    g.state = state;
    return { ...g };
  }
  async insertKey(k: { name: string; prefix: string; hash: string; scopes: KeyScope[]; collections: string[] | null; createdBy: string | null }) {
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
  async addHits(ids: string[], day: string) {
    for (const id of ids) this.hits.set(`${id}|${day}`, (this.hits.get(`${id}|${day}`) ?? 0) + 1);
  }
  async hitCounts(sinceDay: string) {
    const out = new Map<string, number>();
    for (const [k, n] of this.hits) {
      const [id, day] = k.split("|");
      if (day >= sinceDay) out.set(id, (out.get(id) ?? 0) + n);
    }
    return out;
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
