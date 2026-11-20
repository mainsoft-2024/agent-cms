// The example's database: pglite (Postgres in WASM, in memory), so the app runs
// with no server. A real app passes its own Drizzle db instead.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { cmsDdl, splitSql } from "@mainsoft/agent-cms/tables";

const g = globalThis as unknown as { __exampleDb?: ReturnType<typeof drizzle>; __exampleReady?: Promise<void> };

export const db = (g.__exampleDb ??= drizzle(new PGlite()));

/** Create the tables once per process (what `npx @mainsoft/agent-cms migrate apply` does). */
export function ready(): Promise<void> {
  g.__exampleReady ??= (async () => {
    for (const s of splitSql(cmsDdl())) await db.execute(sql.raw(s));
    await db.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS app_search_misses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        collection text NOT NULL,
        query text NOT NULL,
        normalized text NOT NULL,
        count integer NOT NULL DEFAULT 1,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (collection, normalized)
      )`)
    );
  })();
  return g.__exampleReady;
}
