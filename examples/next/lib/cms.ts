// What `npx agent-cms init` writes, filled in for the example.
import { createCms, defineCollection, DrizzleRepo, type Actor } from "@mainsoft-2024/agent-cms";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, ready } from "./db";

export const posts = defineCollection({
  slug: "posts",
  label: "Blog",
  visibility: "public",
  categories: ["News", "Engineering"],
  url: (d) => `/posts/${d.slug}`,
  fields: z.object({ tags: z.array(z.string()).default([]), featured: z.boolean().default(false) }),
  admin: { fields: { tags: { label: "Tags", widget: "tags" }, featured: { label: "Featured", widget: "switch" } } },
});

export const guide = defineCollection({
  slug: "guide",
  label: "Guide",
  visibility: "internal",
  access: { read: ({ actor }) => actor.kind !== "anonymous" },
});

const g = globalThis as unknown as { __exampleCms?: ReturnType<typeof make> };

function make() {
  return createCms({
    repo: new DrizzleRepo(db),
    collections: [posts, guide],
    previewSecret: process.env.CMS_PREVIEW_SECRET ?? "example-preview-secret-at-least-32-chars",
    timeZone: "Asia/Seoul",
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
