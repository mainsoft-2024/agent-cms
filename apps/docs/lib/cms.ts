import "server-only";
import { createCms, DrizzleRepo, type Actor, type CmsDoc } from "@mainsoft/agent-cms";
import { s3Storage } from "@mainsoft/agent-cms/storage-s3";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { collections } from "./collections";
import { db, ready } from "./db";

/** Searches stored per day at most (one bad bot must not fill the table). */
const MISSES_PER_DAY = 500;

/**
 * The media library is on when the deployment has a bucket: any S3-compatible
 * storage (Cloudflare R2, AWS S3, MinIO). Without these variables the feature
 * is off, the sidebar has no "Media", and pages render as before.
 *
 *   MEDIA_S3_BUCKET, MEDIA_S3_KEY, MEDIA_S3_SECRET   required
 *   MEDIA_S3_ENDPOINT   R2 or MinIO (leave out for AWS)
 *   MEDIA_S3_REGION     AWS region, or "auto" for R2
 *   MEDIA_PUBLIC_URL    the bucket's public address; without it files open
 *                       through /api/cms/files with a short-lived signed link
 *
 * The bucket needs a CORS rule for this site: `npx agent-cms storage check --origin <site>` prints it.
 */
function mediaFromEnv() {
  const { MEDIA_S3_BUCKET: bucket, MEDIA_S3_KEY: accessKeyId, MEDIA_S3_SECRET: secretAccessKey } = process.env;
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;
  const adapter = s3Storage({ bucket, accessKeyId, secretAccessKey, endpoint: process.env.MEDIA_S3_ENDPOINT || undefined, region: process.env.MEDIA_S3_REGION || undefined, publicUrl: process.env.MEDIA_PUBLIC_URL || undefined });
  return {
    // Docs need pictures, short screen recordings and the odd PDF; nothing else gets in.
    stores: { site: { label: "Site media", visibility: "public" as const, adapter } },
    accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "video/mp4", "video/webm", ".pdf"],
    maxFileSize: 200 * 1024 ** 2,
  };
}

function make(d: Awaited<ReturnType<typeof db>>) {
  const cms = createCms({
    repo: new DrizzleRepo(d),
    collections,
    timeZone: "Asia/Seoul",
    media: mediaFromEnv(),
    // Scheduled publishing and emptying the trash run when something calls /api/cms/_cron with
    // `Authorization: Bearer $CRON_SECRET`: Vercel's cron once a day (vercel.json; the Hobby plan allows no more)
    // and a GitHub schedule every ten minutes (.github/workflows/docs-cron.yml). Without the variable the route answers 404.
    cronSecret: process.env.CRON_SECRET || undefined,
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
      const { syncStarter } = await import("./seed");
      await syncStarter(cms);
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
