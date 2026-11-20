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

/** The site's own table: which version of each starter page (content/*.md) the database has seen. */
export const STARTER_PAGES_DDL = `CREATE TABLE IF NOT EXISTS site_starter_pages (
  collection text NOT NULL,
  slug text NOT NULL,
  hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, slug)
)`;

/**
 * Create the tables once per process. `cmsDdl()` also adds what a newer
 * agent-cms release needs (new columns and tables) and records the schema
 * version, so a deploy with a newer package upgrades the database by itself. Every statement is `IF NOT EXISTS`, so
 * this is safe on Neon too (what `npx @mainsoft/agent-cms migrate apply` would run).
 */
export function ready(): Promise<void> {
  g.__docsReady ??= (async () => {
    const d = await db();
    for (const s of splitSql(cmsDdl())) await d.execute(sql.raw(s));
    await d.execute(sql.raw(SEARCH_MISSES_DDL));
    await d.execute(sql.raw(STARTER_PAGES_DDL));
  })().catch((e) => {
    g.__docsReady = undefined;
    throw e;
  });
  return g.__docsReady;
}
