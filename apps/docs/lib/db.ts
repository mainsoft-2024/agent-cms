// The site's database. Production and preview deployments use Neon (DATABASE_URL);
// local development and CI use pglite (Postgres in WASM, in memory or in a folder).
import "server-only";
import { sql } from "drizzle-orm";
import { cmsDdl, splitSql } from "@mainsoft/agent-cms/tables";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const g = globalThis as unknown as { __docsDb?: Promise<Db>; __docsReady?: Promise<void> };

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    return drizzle(new Pool({ connectionString: url }));
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  // The workspace may hold two pglite copies; the driver only needs the instance.
  return drizzle(new PGlite(process.env.PGLITE_DIR || undefined) as never);
}

export function db(): Promise<Db> {
  return (g.__docsDb ??= connect());
}

/** The site's own table: searches that found nothing (fed by `onSearchMiss`). */
export const SEARCH_MISSES_DDL = `CREATE TABLE IF NOT EXISTS site_search_misses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL,
  query text NOT NULL,
  normalized text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection, normalized)
)`;

/**
 * Create the tables once per process. Every statement is `IF NOT EXISTS`, so
 * this is safe on Neon too (what `npx agent-cms migrate apply` would run).
 */
export function ready(): Promise<void> {
  g.__docsReady ??= (async () => {
    const d = await db();
    for (const s of splitSql(cmsDdl())) await d.execute(sql.raw(s));
    await d.execute(sql.raw(SEARCH_MISSES_DDL));
  })().catch((e) => {
    g.__docsReady = undefined;
    throw e;
  });
  return g.__docsReady;
}
