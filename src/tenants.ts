/**
 * Several sites (tenants) in one app (0.17.0).
 *
 * Each tenant gets its own Postgres schema (`tenant_<id>`) with the full set of CMS tables, its own
 * CMS and handler, and its own storage prefix. Nothing is shared but the database server, so a
 * bug or a wrong filter in one place cannot show one tenant's documents to another, and a tenant
 * can be exported, restored or dropped on its own (`DROP SCHEMA tenant_acme CASCADE`).
 *
 *   const handler = createTenantHandler({
 *     resolve: (req) => new URL(req.url).hostname.split(".")[0],          // acme.example.com → "acme"
 *     create: async (tenant) => {
 *       const tables = tenantTables(tenant);
 *       await migrateTenant(db, tenant);                                     // CREATE SCHEMA + tables, once
 *       const cms = createCms({ repo: new DrizzleRepo(db, { tables }), collections, media: mediaFor(tenant) });
 *       return createCmsHandler({ cms, resolveUser: (req) => userOf(req, tenant) });
 *     },
 *   });
 *
 * Why a schema per tenant and not a `tenant` column on every table: a column must be added to
 * every query, forever; one forgotten filter leaks data. A schema keeps the CMS code unchanged
 * and the boundary in the database. The cost is one set of tables per tenant, fine up to a few
 * thousand tenants on one server.
 */
import { cmsDdl, cmsTables, splitSql, type CmsTables } from "./tables";

/** A tenant id: lowercase letters, digits and dashes, starting with a letter or digit, at most 40 characters. */
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function assertTenantId(id: string): string {
  if (!TENANT_ID.test(id)) throw new Error(`[agent-cms] tenant id "${id}" is not allowed: lowercase letters, digits and dashes, at most 40 characters`);
  return id;
}

/** The Postgres schema of a tenant (`tenant_acme`, dashes become underscores). */
export function tenantSchema(id: string): string {
  return `tenant_${assertTenantId(id).replace(/-/g, "_")}`;
}

/** The CMS tables of one tenant: the usual `cms_*` tables in the tenant's schema. */
export function tenantTables(id: string, o: { prefix?: string } = {}): CmsTables {
  return cmsTables({ schema: tenantSchema(id), prefix: o.prefix });
}

/** SQL that creates (or brings up to date) one tenant's schema and tables. Safe to run again. */
export function tenantDdl(id: string, o: { prefix?: string } = {}): string {
  return cmsDdl(tenantTables(id, o));
}

/** Run `tenantDdl` on a Drizzle database. */
export async function migrateTenant(db: { execute(q: unknown): Promise<unknown> }, id: string, o: { prefix?: string } = {}): Promise<void> {
  const { sql } = await import("drizzle-orm");
  for (const stmt of splitSql(tenantDdl(id, o))) await db.execute(sql.raw(stmt));
}

/** A storage prefix for the tenant's files (`tenants/acme/`), for `s3Storage({ prefix })` and the like. */
export function tenantPrefix(id: string): string {
  return `tenants/${assertTenantId(id)}`;
}

export type TenantRequestHandler = (req: Request) => Promise<Response> | Response;

export interface TenantHandlerOptions {
  /** Which tenant a request is for (a subdomain, a path segment, a header, the user's workspace). `null`: none (404). */
  resolve: (req: Request) => string | null | undefined | Promise<string | null | undefined>;
  /** Makes the handler of one tenant. Called once per tenant while it stays in memory. Throw to refuse an unknown tenant. */
  create: (tenant: string) => TenantRequestHandler | Promise<TenantRequestHandler>;
  /** Tenants kept in memory; the one used least recently is dropped first. Default 200. */
  max?: number;
  /**
   * Told when a tenant's handler is dropped from memory (close what `create` opened). Called
   * once the tenant's requests in progress have finished, streams included, or after `drainMs`.
   */
  dispose?: (tenant: string) => void | Promise<void>;
  /** How long a dropped tenant's requests in progress may still run before `dispose` anyway. Default 30 s. */
  drainMs?: number;
}

const notFound = () => new Response(JSON.stringify({ error: "not_found", message: "No such site" }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });

/** One request handler for every tenant: finds the tenant, makes its CMS on first use, passes the request on. */
export function createTenantHandler(o: TenantHandlerOptions): TenantRequestHandler & { tenants(): string[]; forget(tenant: string): Promise<void> } {
  const max = Math.max(1, o.max ?? 200);
  const live = new Map<string, Promise<TenantRequestHandler>>();
  // Requests in progress per handler (until the response body has been read or cancelled).
  const busy = new Map<Promise<TenantRequestHandler>, { n: number; idle: (() => void)[] }>();
  const drainMs = o.drainMs ?? 30_000;
  async function forget(tenant: string) {
    const h = live.get(tenant);
    if (!h || !live.delete(tenant)) return;
    // Wait for what that handler is still answering (a long upload, an events stream) first.
    const b = busy.get(h);
    if (b?.n) {
      await new Promise<void>((done) => {
        const t = setTimeout(done, drainMs);
        (t as { unref?: () => void }).unref?.();
        b.idle.push(() => (clearTimeout(t), done()));
      });
    }
    busy.delete(h);
    await Promise.resolve(o.dispose?.(tenant)).catch(() => {});
  }
  function enter(h: Promise<TenantRequestHandler>) {
    const b = busy.get(h) ?? { n: 0, idle: [] };
    busy.set(h, b);
    b.n++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--b.n === 0) for (const f of b.idle.splice(0)) f();
    };
  }
  /** The response, with its body watched so the request counts as finished only when the body is done. */
  function watched(res: Response, leave: () => void): Response {
    if (!res.body) {
      leave();
      return res;
    }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            leave();
            c.close();
          } else c.enqueue(r.value);
        } catch (e) {
          leave();
          c.error(e);
        }
      },
      cancel(reason) {
        leave();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  function handlerOfPromise(tenant: string): Promise<TenantRequestHandler> {
    const have = live.get(tenant);
    if (have) {
      live.delete(tenant);
      live.set(tenant, have);
      return have;
    }
    const made = Promise.resolve().then(() => o.create(tenant));
    live.set(tenant, made);
    // A tenant that failed to start is tried again on the next request.
    made.catch(() => live.get(tenant) === made && live.delete(tenant));
    while (live.size > max) void forget(live.keys().next().value as string);
    return made;
  }
  const handle = async (req: Request): Promise<Response> => {
    const raw = await o.resolve(req);
    if (!raw || !TENANT_ID.test(raw)) return notFound();
    let h: TenantRequestHandler;
    let made: Promise<TenantRequestHandler>;
    try {
      made = handlerOfPromise(raw);
      h = await made;
    } catch {
      return notFound();
    }
    const leave = enter(made);
    try {
      return watched(await h(req), leave);
    } catch (e) {
      leave();
      throw e;
    }
  };
  return Object.assign(handle, { tenants: () => [...live.keys()], forget });
}
