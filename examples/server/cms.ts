// The CMS this server runs: your collections, a Postgres database, files in S3 (MinIO here).
import { createCms, defineCollection, DrizzleRepo } from "@mainsoft/agent-cms";
import { s3Storage } from "@mainsoft/agent-cms/storage-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";

export const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }));

export const posts = defineCollection({
  slug: "posts",
  label: "Posts",
  visibility: "public",
  fields: z.object({ tags: z.array(z.string()).default([]) }),
});

export const cms = createCms({
  repo: new DrizzleRepo(db),
  collections: [posts],
  previewSecret: process.env.CMS_PREVIEW_SECRET!,
  secretsKey: process.env.CMS_SECRETS_KEY!,
  media: {
    stores: {
      public: {
        visibility: "public",
        adapter: s3Storage({
          bucket: process.env.S3_BUCKET!,
          endpoint: process.env.S3_ENDPOINT,
          region: process.env.S3_REGION ?? "us-east-1",
          accessKeyId: process.env.S3_KEY!,
          secretAccessKey: process.env.S3_SECRET!,
          publicUrl: process.env.S3_PUBLIC_URL,
        }),
      },
    },
  },
});
