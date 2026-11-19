import "server-only";
import { createCms, DrizzleRepo, type Actor, type CmsDoc } from "@mainsoft/agent-cms";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { collections } from "./collections";
import { db, ready } from "./db";

/** Searches stored per day at most (one bad bot must not fill the table). */
const MISSES_PER_DAY = 500;

function make(d: Awaited<ReturnType<typeof db>>) {
  const cms = createCms({
    repo: new DrizzleRepo(d),
    collections,
    timeZone: "Asia/Seoul",
    previewSecret: process.env.CMS_PREVIEW_SECRET || (process.env.NODE_ENV === "production" ? undefined : "local-preview-secret-for-development-only"),
    // The site keeps searches that found nothing in its own table.
    onSearchMiss: async (e) => {
      if (e.actor.kind !== "anonymous" && e.actor.kind !== "user") return;
      const [{ n }] = (await d.execute(sql`select count(*)::int as n from site_search_misses where last_seen_at > now() - interval '1 day'`)).rows as { n: number }[];
      if (n >= MISSES_PER_DAY) return;
      for (const c of e.collections) {
        await d.execute(sql`INSERT INTO site_search_misses (collection, query, normalized) VALUES (${c}, ${e.query.slice(0, 200)}, ${e.normalized.slice(0, 200)})
          ON CONFLICT (collection, normalized) DO UPDATE SET count = site_search_misses.count + 1, last_seen_at = now(), query = excluded.query`);
      }
    },
    onError: (err, where) => console.error(`[cms] ${where}`, err),
  });
  // A publish (or anything the public sees) refreshes the cached pages.
  cms.onChange((doc: CmsDoc, info) => {
    if (!info.contentChanged) return;
    try {
      revalidatePath("/", "layout");
    } catch {
      // Outside a request (seed script, tests): nothing to revalidate.
    }
    void doc;
  });
  return cms;
}

export type SiteCms = ReturnType<typeof make>;

const g = globalThis as unknown as { __docsCms?: Promise<SiteCms> };

/** The CMS, after the tables exist. */
export function getCms(): Promise<SiteCms> {
  return (g.__docsCms ??= (async () => {
    await ready();
    const cms = make(await db());
    // Local and CI databases start empty: fill them with the starter pages.
    if (!process.env.DATABASE_URL || process.env.DOCS_SEED === "1") {
      const { seedIfEmpty } = await import("./seed");
      await seedIfEmpty(cms);
    }
    return cms;
  })().catch((e) => {
    g.__docsCms = undefined;
    throw e;
  }));
}

export const anonymous: Actor = { kind: "anonymous" };
/** Scripts (seed, backup) write as the system. */
export const system: Actor = { kind: "system", label: "docs seed" };
