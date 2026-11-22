/**
 * Connect to Postgres with the driver you already have (0.17.0).
 *
 *   import { connectPostgres } from "@mainsoft/agent-cms/db";
 *   const { db, repo, signal, close } = await connectPostgres(process.env.DATABASE_URL!);
 *   const cms = createCms({ repo, changes: { signal }, ... });
 *
 * Drivers (installed by you, loaded only when picked):
 * - `pg`              node-postgres Pool. Transactions; `LISTEN/NOTIFY` on a client of its own.
 * - `postgres-js`     postgres.js. Transactions; `LISTEN/NOTIFY` built in.
 * - `neon-serverless` `@neondatabase/serverless` Pool over WebSockets. Transactions. For serverless and Edge.
 * - `neon-http`       `@neondatabase/serverless` over HTTP: one request per query, no transactions
 *                     (the repo then runs each change as separate statements; see `DrizzleRepo`).
 * - `pglite`          `@electric-sql/pglite`: Postgres in the process (a folder, or memory). For
 *                     development and tests.
 *
 * Without `driver`: `pglite` for `pglite:` URLs and `memory:`, `neon-serverless` for `*.neon.tech`
 * when `@neondatabase/serverless` is installed, else `pg`, else `postgres-js`.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ChangeSignal } from "./changes";
import { pgChangeSignal, postgresJsChangeSignal } from "./changes";
import { DrizzleRepo, type DrizzleRepoOptions } from "./drizzle-repo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;
export type PostgresDriver = "pg" | "postgres-js" | "neon-serverless" | "neon-http" | "pglite";

export interface ConnectOptions extends DrizzleRepoOptions {
  driver?: PostgresDriver;
  /** Pool size where the driver has one. Default: the driver's. */
  max?: number;
  /** Also open what carries `LISTEN/NOTIFY` (a `ChangeSignal` for `createCms({ changes: { signal } })`). Default true where the driver can. */
  listen?: boolean;
}

export interface Connection {
  driver: PostgresDriver;
  db: Db;
  repo: DrizzleRepo;
  /** Wakes the other servers at once (`createCms({ changes: { signal } })`). Null where the driver cannot listen. */
  signal: ChangeSignal | null;
  /** Ends the pool and the listening connection. */
  close(): Promise<void>;
}

async function load<T>(name: string, driver: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND" || (e as { code?: string }).code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(String(e))) {
      throw new Error(`[agent-cms] the "${driver}" driver needs the package "${name}". Install it next to @mainsoft/agent-cms (npm install ${name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/")}).`);
    }
    throw e;
  }
}

async function installed(name: string): Promise<boolean> {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

/** Which driver `connectPostgres` picks for a URL when none is named. */
export async function pickDriver(url: string): Promise<PostgresDriver> {
  if (url === "memory:" || url.startsWith("pglite:")) return "pglite";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // not a URL: a pglite folder
    return "pglite";
  }
  if (/\.neon\.tech$/.test(host) && (await installed("@neondatabase/serverless"))) return "neon-serverless";
  if (await installed("pg")) return "pg";
  if (await installed("postgres")) return "postgres-js";
  throw new Error('[agent-cms] no Postgres driver found. Install one: npm install pg (or postgres, or @neondatabase/serverless).');
}

export async function connectPostgres(url: string, o: ConnectOptions = {}): Promise<Connection> {
  const driver = o.driver ?? (await pickDriver(url));
  const repoOpts: DrizzleRepoOptions = { tables: o.tables, transactions: o.transactions, warn: o.warn };
  const listen = o.listen !== false;

  if (driver === "pg") {
    const pg = await load<{ default?: unknown; Pool: new (c: object) => PgPool; Client: new (c: object) => PgClient }>("pg", driver);
    const mod = ((pg as { default?: typeof pg }).default ?? pg) as typeof pg;
    const pool = new mod.Pool({ connectionString: url, ...(o.max ? { max: o.max } : {}) });
    const { drizzle } = await load<{ drizzle: (p: unknown) => Db }>("drizzle-orm/node-postgres", driver);
    const db = drizzle(pool);
    let client: PgClient | null = null;
    let signal: ChangeSignal | null = null;
    if (listen) {
      // Connected on first use, so a CMS that never follows changes never opens it.
      let ready: Promise<PgClient> | null = null;
      const get = () => (ready ??= (async () => {
        const c = new mod.Client({ connectionString: url });
        await c.connect();
        client = c;
        return c;
      })());
      signal = {
        publish: async () => void (await pool.query("NOTIFY agent_cms_changes")),
        subscribe: async (fn) => pgChangeSignal(await get()).subscribe(fn),
      };
    }
    return { driver, db, repo: new DrizzleRepo(db, repoOpts), signal, close: async () => void (await Promise.all([pool.end(), (client as PgClient | null)?.end()])) };
  }

  if (driver === "postgres-js") {
    const mod = await load<{ default: (url: string, o?: object) => PostgresJs }>("postgres", driver);
    const sql = mod.default(url, o.max ? { max: o.max } : {});
    const { drizzle } = await load<{ drizzle: (c: unknown) => Db }>("drizzle-orm/postgres-js", driver);
    const db = drizzle(sql);
    return { driver, db, repo: new DrizzleRepo(db, repoOpts), signal: listen ? postgresJsChangeSignal(sql) : null, close: () => sql.end() };
  }

  if (driver === "neon-serverless") {
    const neon = await load<{ Pool: new (c: object) => PgPool; neonConfig?: { webSocketConstructor?: unknown } }>("@neondatabase/serverless", driver);
    if (neon.neonConfig && !neon.neonConfig.webSocketConstructor && typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function") {
      neon.neonConfig.webSocketConstructor = (globalThis as { WebSocket?: unknown }).WebSocket;
    }
    const pool = new neon.Pool({ connectionString: url, ...(o.max ? { max: o.max } : {}) });
    const { drizzle } = await load<{ drizzle: (p: unknown) => Db }>("drizzle-orm/neon-serverless", driver);
    const db = drizzle(pool);
    // No long-lived listener on serverless: followers poll the change log.
    return { driver, db, repo: new DrizzleRepo(db, repoOpts), signal: null, close: () => pool.end() };
  }

  if (driver === "neon-http") {
    const neon = await load<{ neon: (url: string) => unknown }>("@neondatabase/serverless", driver);
    const { drizzle } = await load<{ drizzle: (c: unknown) => Db }>("drizzle-orm/neon-http", driver);
    const db = drizzle(neon.neon(url));
    return { driver, db, repo: new DrizzleRepo(db, { ...repoOpts, transactions: o.transactions ?? false }), signal: null, close: async () => {} };
  }

  if (driver === "pglite") {
    const { PGlite } = await load<{ PGlite: new (dir?: string) => PGliteLike }>("@electric-sql/pglite", driver);
    const dir = url === "memory:" ? undefined : url.replace(/^pglite:(\/\/)?/, "") || undefined;
    const client = new PGlite(dir);
    const { drizzle } = await load<{ drizzle: (c: unknown) => Db }>("drizzle-orm/pglite", driver);
    const db = drizzle(client);
    // One process: nothing to wake.
    return { driver, db, repo: new DrizzleRepo(db, repoOpts), signal: null, close: () => client.close() };
  }

  throw new Error(`[agent-cms] unknown driver "${driver as string}" (pg, postgres-js, neon-serverless, neon-http, pglite)`);
}

interface PgPool {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<unknown>;
  on(event: "notification", fn: (msg: { channel: string }) => void): unknown;
  removeListener?(event: "notification", fn: (msg: { channel: string }) => void): unknown;
}
interface PostgresJs {
  listen(channel: string, fn: (payload: string) => void): Promise<{ unlisten(): Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
  end(): Promise<void>;
}
interface PGliteLike {
  close(): Promise<void>;
}
