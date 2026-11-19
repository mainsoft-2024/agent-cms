import "server-only";
import { createCms, defineCollection, MemoryRepo, type Actor } from "@mainsoft/agent-cms";

/**
 * The gallery's live demo: a CMS in memory, reset every 30 minutes. Visitors act
 * as a demo admin, so every screen works; nothing reaches the docs database.
 */
const RESET_MS = 30 * 60 * 1000;
export const demoAdmin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "demo", label: "You (demo)", isAdmin: true };

const posts = defineCollection({
  slug: "posts",
  label: "Posts",
  visibility: "public",
  categories: ["Guides", "News", "Notices"],
  url: (d) => `/posts/${d.slug}`,
});

async function seed() {
  const cms = createCms({ repo: new MemoryRepo(), collections: [posts], previewSecret: "demo-preview-secret-not-for-production" });
  const a = demoAdmin;
  await cms.create(a, "posts", { slug: "welcome", title: "Welcome to the demo", category: "Guides", summary: "Click around: nothing here is saved for long.", body: "## What this is\n\nA live copy of the agent-cms admin screens.\n\n## Try\n\n- Edit this page and publish it.\n- Open the version history.\n" }, { publish: true });
  await cms.create(a, "posts", { slug: "release-notes", title: "Release notes", category: "News", body: "## 0.7.0\n\nAgents can read public docs over MCP without a key.\n" }, { publish: true });
  await cms.create(a, "posts", { slug: "maintenance", title: "Maintenance on Sunday", category: "Notices", body: "The site is read-only from 02:00 to 03:00.\n" });
  await cms.create(a, "posts", { slug: "install-guide", title: "Install guide", category: "Guides", body: "## Install\n\nRun npm i @mainsoft/agent-cms.\n\n## Tables\n\nRun npx agent-cms migrate check.\n" }, { publish: true });
  // An agent edits a published page: the editor shows its change for review.
  const { secret } = await cms.createKey(a, { name: "docs-bot", scopes: ["write"] });
  const bot = await cms.authenticateKey(secret);
  if (bot) {
    const doc = await cms.get(a, "posts", "install-guide", { draft: true });
    await cms.update(bot, "posts", "install-guide", { body: doc.body.replace("Run npm i @mainsoft/agent-cms.", "Run npm i @mainsoft/agent-cms drizzle-orm zod.\n\nPeer dependencies: drizzle-orm and zod (^3.25 or ^4).") }, { expectedVersion: doc.version, note: "add peer dependencies" });
  }
  return cms;
}

const g = globalThis as unknown as { __demo?: { at: number; cms: ReturnType<typeof seed> } };

export function demoCms() {
  if (!g.__demo || Date.now() - g.__demo.at > RESET_MS) g.__demo = { at: Date.now(), cms: seed() };
  return g.__demo.cms;
}
