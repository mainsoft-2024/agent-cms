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
  /** Told when a tenant's handler is dropped from memory (close what `create` opened). */
  dispose?: (tenant: string) => void | Promise<void>;
}

const notFound = () => new Response(JSON.stringify({ error: "not_found", message: "No such site" }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });

/** One request handler for every tenant: finds the tenant, makes its CMS on first use, passes the request on. */
export function createTenantHandler(o: TenantHandlerOptions): TenantRequestHandler & { tenants(): string[]; forget(tenant: string): Promise<void> } {
  const max = Math.max(1, o.max ?? 200);
  const live = new Map<string, Promise<TenantRequestHandler>>();
  async function forget(tenant: string) {
    if (!live.delete(tenant)) return;
    await Promise.resolve(o.dispose?.(tenant)).catch(() => {});
  }
  async function handlerOf(tenant: string): Promise<TenantRequestHandler> {
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
    try {
      h = await handlerOf(raw);
    } catch {
      return notFound();
    }
    return h(req);
  };
  return Object.assign(handle, { tenants: () => [...live.keys()], forget });
}
