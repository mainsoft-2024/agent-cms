/**
 * Changes across servers (0.17.0).
 *
 * Every event the CMS emits is also written to the change log (`cms_changes`, schema 9) with a
 * number. Each process follows the log from the number it last saw, so a document published on
 * one server reaches the events stream, the read cache and the search index of every other
 * server. Following is a cheap query every `pollMs`; a `signal` (Postgres `LISTEN/NOTIFY`, Redis
 * pub/sub, anything with publish and subscribe) wakes the followers at once instead.
 *
 *   createCms({ ..., changes: { signal: pgChangeSignal(listenClient) }, cache: memoryCache() })
 */

/** Wakes the other processes when a change is written. Optional: without it they poll. */
export interface ChangeSignal {
  /** Tell the others that something changed. Must not throw (errors are reported and ignored). */
  publish(): void | Promise<void>;
  /** Called when another process published. Returns the function that stops listening. */
  subscribe(fn: () => void): (() => void) | Promise<() => void>;
}

export interface ChangesOptions {
  /** How long rows stay in the change log. Default 7 days. A client away longer reloads everything. */
  keepDays?: number;
  /** How often a following process looks for changes made elsewhere (ms). Default 2000. */
  pollMs?: number;
  /** Wake followers immediately (see `pgChangeSignal`, `postgresJsChangeSignal`). */
  signal?: ChangeSignal;
  /** `false`: do not write the change log (one process only; the events stream then hears this process alone). */
  log?: boolean;
}

/** What `GET /_changes` and the events stream send for a row of the log. */
export interface ChangeEvent {
  seq: number;
  at: string;
  event: string;
  collection: string | null;
  slug: string | null;
  version: number | null;
  url: string | null;
  actor: { kind: string; id: string | null; label: string; agent: string | null } | null;
  detail?: Record<string, unknown>;
  /** 0.22.0: the document's language (localized collections only). */
  locale?: string;
}

/**
 * A cache for what readers see (published documents and lists). Values are plain JSON. `get`
 * returns `undefined` for a miss. Any store works: memory (`memoryCache`), Redis, Next's cache.
 */
export interface CacheAdapter {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export interface CacheOptions {
  /** Keeps this CMS's entries apart in a store others share. Default: the table prefix and schema (DrizzleRepo). */
  namespace?: string;
  /** How long an entry lives even if nothing changes (ms). Default 5 minutes. */
  ttlMs?: number;
}

/** An in-process cache with a size limit (least recently used goes first). */
export function memoryCache(o: { max?: number } = {}): CacheAdapter & { size(): number; clear(): void } {
  const max = Math.max(1, o.max ?? 1000);
  const map = new Map<string, { v: string; until: number }>();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.until < Date.now()) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit);
      // A copy, so a caller changing what it got does not change the cache.
      return JSON.parse(hit.v);
    },
    set(key, value, ttlMs) {
      map.delete(key);
      map.set(key, { v: JSON.stringify(value), until: Date.now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
    delete(key) {
      map.delete(key);
    },
    size: () => map.size,
    clear: () => map.clear(),
  };
}

const CHANNEL = "agent_cms_changes";

/** Minimal shape of a node-postgres `Client` (a dedicated, connected one: `LISTEN` holds it). */
interface PgClientLike {
  query(text: string): Promise<unknown>;
  on(event: "notification", fn: (msg: { channel: string }) => void): unknown;
  removeListener?(event: "notification", fn: (msg: { channel: string }) => void): unknown;
}

/**
 * `LISTEN/NOTIFY` with node-postgres. Give it a client of its own (not one from a pool that
 * others borrow): `const c = new pg.Client(url); await c.connect(); pgChangeSignal(c)`.
 */
export function pgChangeSignal(client: PgClientLike, o: { channel?: string } = {}): ChangeSignal {
  const channel = o.channel ?? CHANNEL;
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`[agent-cms] pgChangeSignal: channel must be a plain name, got "${channel}"`);
  return {
    async publish() {
      await client.query(`NOTIFY ${channel}`);
    },
    async subscribe(fn) {
      const on = (msg: { channel: string }) => {
        if (msg.channel === channel) fn();
      };
      client.on("notification", on);
      await client.query(`LISTEN ${channel}`);
      return () => {
        client.removeListener?.("notification", on);
        void client.query(`UNLISTEN ${channel}`).catch(() => {});
      };
    },
  };
}

/** Minimal shape of a postgres.js `sql`. */
interface PostgresJsLike {
  listen(channel: string, fn: (payload: string) => void): Promise<{ unlisten(): Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
}

/** `LISTEN/NOTIFY` with postgres.js (`postgres(url)`), which keeps its own listening connection. */
export function postgresJsChangeSignal(sql: PostgresJsLike, o: { channel?: string } = {}): ChangeSignal {
  const channel = o.channel ?? CHANNEL;
  return {
    async publish() {
      await sql.notify(channel, "");
    },
    async subscribe(fn) {
      const l = await sql.listen(channel, () => fn());
      return () => void l.unlisten().catch(() => {});
    },
  };
}

/** Events a reader may hear about (the public copy changed). */
export const PUBLIC_EVENTS: ReadonlySet<string> = new Set(["doc.published", "doc.unpublished", "doc.archived", "doc.deleted", "doc.restored"]);
