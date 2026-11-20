// What `npx agent-cms init` writes, filled in for the example.
import { assetId, createCms, defineCollection, DrizzleRepo, type Actor, type MediaOptions } from "@mainsoft/agent-cms";
import { sharpTransforms } from "@mainsoft/agent-cms/image-sharp";
import { s3Storage } from "@mainsoft/agent-cms/storage-s3";
import { vercelBlobStorage } from "@mainsoft/agent-cms/storage-vercel-blob";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, ready } from "./db";

export const posts = defineCollection({
  slug: "posts",
  label: "Blog",
  visibility: "public",
  categories: ["News", "Engineering"],
  url: (d) => `/posts/${d.slug}`,
  fields: z.object({ cover: assetId().optional(), tags: z.array(z.string()).default([]), featured: z.boolean().default(false) }),
  admin: { fields: { cover: { label: "Cover", widget: "image" }, tags: { label: "Tags", widget: "tags" }, featured: { label: "Featured", widget: "switch" } } },
});

export const guide = defineCollection({
  slug: "guide",
  label: "Guide",
  visibility: "internal",
  access: { read: ({ actor }) => actor.kind !== "anonymous" },
  // What an agent writes here goes out only after a person approved it.
  review: { agents: "required" },
});

// The media library is on when the app is given a storage: `npm run s3:dev`
// in the repository root starts a local one, then
//   S3_ENDPOINT=http://127.0.0.1:9100 S3_KEY=test S3_SECRET=testsecret1 npm run dev
// A real bucket with a public address would also set `publicUrl` on the adapter.
const s3 = (bucket: string) => s3Storage({ bucket, endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, accessKeyId: process.env.S3_KEY ?? "", secretAccessKey: process.env.S3_SECRET ?? "" });
// Or Vercel Blob: BLOB_READ_WRITE_TOKEN of a public store and, for private files,
// BLOB_PRIVATE_READ_WRITE_TOKEN of a private one (`npm install @vercel/blob`).
const blob = process.env.BLOB_READ_WRITE_TOKEN;
const blobPrivate = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
const stores: MediaOptions["stores"] | null = blob
  ? {
      public: { visibility: "public", adapter: vercelBlobStorage({ token: blob, access: "public", prefix: process.env.BLOB_PREFIX }) },
      ...(blobPrivate ? { private: { visibility: "private" as const, adapter: vercelBlobStorage({ token: blobPrivate, access: "private", prefix: process.env.BLOB_PREFIX }) } } : {}),
    }
  : process.env.S3_ENDPOINT
    ? { public: { visibility: "public", adapter: s3(process.env.S3_BUCKET ?? "media") }, private: { visibility: "private", adapter: s3(process.env.S3_PRIVATE_BUCKET ?? "private") } }
    : null;
export const media: MediaOptions | undefined = stores
  ? {
      stores,
      // Named image sizes, made by sharp the first time one is asked for: /api/cms/files/<id>/<name>?size=card
      transforms: sharpTransforms({ presets: { thumb: { width: 480 }, card: { width: 800, height: 450, fit: "cover" }, full: { width: 1600 } } }),
      // Photos lose their location and device data in the browser, before they are sent.
      stripMetadata: true,
    }
  : undefined;

const g = globalThis as unknown as { __exampleCms?: ReturnType<typeof make> };

function make() {
  return createCms({
    repo: new DrizzleRepo(db),
    collections: [posts, guide],
    media,
    previewSecret: process.env.CMS_PREVIEW_SECRET ?? "example-preview-secret-at-least-32-chars",
    timeZone: "Asia/Seoul",
    // Scheduled publishing runs when a cron job calls POST /api/cms/_cron with this secret.
    cronSecret: process.env.CMS_CRON_SECRET,
    // The app keeps search misses in its own table (see UPGRADE-0.6.md).
    onSearchMiss: async (e) => {
      for (const c of e.collections) {
        await db.execute(sql`INSERT INTO app_search_misses (collection, query, normalized) VALUES (${c}, ${e.query}, ${e.normalized})
          ON CONFLICT (collection, normalized) DO UPDATE SET count = app_search_misses.count + 1, last_seen_at = now()`);
      }
    },
  });
}

export const cms = (g.__exampleCms ??= make());

/** The example has no login: everyone is the demo admin. Use your session here. */
export const demoAdmin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "demo", label: "Demo admin", isAdmin: true };

let seeded: Promise<void> | null = null;
/** Tables plus a few documents, once per process. */
export function seed(): Promise<void> {
  seeded ??= (async () => {
    await ready();
    if ((await cms.list(demoAdmin, "posts", { drafts: true })).length) return;
    await cms.create(demoAdmin, "posts", { slug: "hello-world", title: "Hello, world", summary: "Our first post", category: "News", body: "## Welcome\n\nThis blog runs on agent-cms.\n\n## What next\n\nWrite with people and agents." }, { publish: true });
    await cms.create(demoAdmin, "posts", { slug: "draft-ideas", title: "Draft ideas", category: "Engineering", body: "## Ideas\n\n- one\n- two" });
    await cms.create(demoAdmin, "guide", { slug: "slack-connect", title: "Connect Slack", body: "## Connect\n\nOpen settings and press connect." }, { publish: true });
  })();
  return seeded;
}
