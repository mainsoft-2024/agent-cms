import "server-only";
import { createCms, defineCollection, MemoryRepo, type Actor } from "@mainsoft/agent-cms";
import { MemoryStorage } from "@mainsoft/agent-cms/storage";

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
  // What an agent writes goes out only after a person approves it (the editor shows the request).
  review: { agents: "required" },
});

/** A drawn placeholder: the demo ships no photographs. */
const picture = (label: string, w: number, h: number, ink: string, paper: string) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${paper}"/><g stroke="${ink}" stroke-width="1" opacity=".18">${Array.from({ length: Math.ceil(w / 40) }, (_, i) => `<path d="M${i * 40} 0V${h}"/>`).join("")}${Array.from({ length: Math.ceil(h / 40) }, (_, i) => `<path d="M0 ${i * 40}H${w}"/>`).join("")}</g><rect x="${w * 0.12}" y="${h * 0.2}" width="${w * 0.76}" height="${h * 0.6}" rx="10" fill="none" stroke="${ink}" stroke-width="2"/><text x="50%" y="52%" text-anchor="middle" font-family="ui-monospace,monospace" font-size="${Math.round(h / 12)}" fill="${ink}">${label}</text></svg>`
  );

const PICTURES = [
  { name: "dashboard.svg", folder: "guides", alt: "The dashboard with three charts", tags: ["guide"], label: "dashboard", w: 1600, h: 900, ink: "#111111", paper: "#f3f1ec" },
  { name: "install-steps.svg", folder: "guides", alt: "Three install steps in a row", tags: ["guide", "install"], label: "install steps", w: 1200, h: 800, ink: "#1d4ed8", paper: "#eef2ff" },
  { name: "launch-hero.svg", folder: "news", alt: "Launch announcement banner", tags: ["launch"], label: "launch", w: 1920, h: 1080, ink: "#9a3412", paper: "#fff7ed" },
  { name: "team.svg", folder: "news", alt: "", tags: [], label: "team", w: 1200, h: 1200, ink: "#166534", paper: "#f0fdf4" },
  { name: "logo-mark.svg", folder: "brand", alt: "The ac mark", tags: ["brand"], label: "ac", w: 512, h: 512, ink: "#111111", paper: "#ffffff" },
];

async function seed() {
  // The demo library is read-only: visitors share one demo, and the docs site does not host what strangers upload.
  const store = new MemoryStorage({ name: "demo", publicUrl: "/api/demo-files" });
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [posts],
    previewSecret: "demo-preview-secret-not-for-production",
    media: { stores: { demo: { label: "Demo pictures", visibility: "public", adapter: store, access: { write: ({ actor }) => actor.kind === "system", delete: ({ actor }) => actor.kind === "system" } } }, accept: ["image/*"], filesUrl: "/api/demo/files" },
  });
  const a = demoAdmin;
  const ids: Record<string, string> = {};
  for (const p of PICTURES) {
    const made = await cms.assets.put({ kind: "system", label: "demo" }, { name: p.name, mime: "image/svg+xml", bytes: picture(p.label, p.w, p.h, p.ink, p.paper), folder: p.folder, alt: p.alt, tags: p.tags, width: p.w, height: p.h } as never);
    ids[p.name] = made.id;
  }
  await cms.create(a, "posts", { slug: "welcome", title: "Welcome to the demo", category: "Guides", summary: "Click around: nothing here is saved for long.", body: "## What this is\n\nA live copy of the agent-cms admin screens.\n\n## Try\n\n- Edit this page and publish it.\n- Open the version history.\n" }, { publish: true });
  await cms.create(a, "posts", { slug: "release-notes", title: "Release notes", category: "News", body: "## 0.10.0\n\nScheduled publishing, review requests, comments, releases and a trash.\n\n## 0.8.0\n\nA media library: pictures, video and files in your own bucket.\n\n## 0.7.0\n\nAgents can read public docs over MCP without a key.\n" }, { publish: true });
  await cms.create(a, "posts", { slug: "maintenance", title: "Maintenance on Sunday", category: "Notices", body: "The site is read-only from 02:00 to 03:00.\n" });
  await cms.create(a, "posts", { slug: "install-guide", title: "Install guide", category: "Guides", body: `![Three install steps in a row](asset:${ids["install-steps.svg"]}/install-steps.svg "The three steps")\n\n` + "## Install\n\nRun npm i @mainsoft/agent-cms.\n\n## Tables\n\nRun npx agent-cms migrate check.\n" }, { publish: true });
  // An agent edits a published page: the editor shows its change for review.
  const { secret } = await cms.createKey(a, { name: "docs-bot", scopes: ["write"] });
  const bot = await cms.authenticateKey(secret);
  if (bot) {
    const doc = await cms.get(a, "posts", "install-guide", { draft: true });
    await cms.update(bot, "posts", "install-guide", { body: doc.body.replace("Run npm i @mainsoft/agent-cms.", "Run npm i @mainsoft/agent-cms drizzle-orm zod.\n\nPeer dependencies: drizzle-orm and zod (^3.25 or ^4).") }, { expectedVersion: doc.version, note: "add peer dependencies" });
  }
  const day = 24 * 60 * 60 * 1000;
  // Review: the agent asks a person to look at its change before it goes out.
  if (bot) await cms.requestReview(bot, "posts", "install-guide", { note: "Added the peer dependencies. Please check the versions." });
  // Comments: one on a sentence, with a reply.
  const thread = await cms.addComment(a, "posts", "welcome", { body: "Say how long: the demo resets every 30 minutes.", quote: "nothing here is saved for long" });
  if (bot) await cms.addComment(bot, "posts", "welcome", { body: "I can change it to \"resets every 30 minutes\" if you like.", threadId: thread.id });
  // A schedule, a release that goes out together, a version with a name, a saved filter, and two pages in the trash.
  await cms.schedule(a, "posts", "maintenance", { publishAt: new Date(Date.now() + 2 * day).toISOString(), unpublishAt: new Date(Date.now() + 5 * day).toISOString() });
  await cms.create(a, "posts", { slug: "pricing-2027", title: "Pricing in 2027", category: "News", body: "## Plans\n\nThe free plan stays free.\n\n## Changes\n\nTeams pay per editor.\n" });
  await cms.create(a, "posts", { slug: "migration-guide", title: "Moving to the new plans", category: "Guides", body: "## Before you start\n\nCheck which plan you are on.\n" });
  const release = await cms.releases.create(a, { name: "New pricing" });
  await cms.releases.add(a, release.id, [
    { collection: "posts", slug: "pricing-2027", action: "publish" },
    { collection: "posts", slug: "migration-guide", action: "publish" },
    { collection: "posts", slug: "release-notes", action: "unpublish" },
  ]);
  await cms.releases.schedule(a, release.id, { publishAt: new Date(Date.now() + 3 * day).toISOString() });
  await cms.releases.create(a, { name: "Spring cleanup" });
  await cms.labelVersion(a, "posts", "welcome", 1, { label: "First public version", pinned: true });
  await cms.filters.save(a, "posts", { name: "News drafts", query: { state: "draft", category: "News" }, shared: true });
  for (const [slug, title] of [["old-pricing", "Pricing in 2025"], ["beta-notes", "Beta notes"]] as const) {
    await cms.create(a, "posts", { slug, title, category: "News", body: "This page is out of date.\n" }, { publish: slug === "old-pricing" });
    await cms.remove(a, "posts", slug);
  }
  return { cms, store };
}

const g = globalThis as unknown as { __demo3?: { at: number; made: ReturnType<typeof seed> } };

function demo() {
  if (!g.__demo3 || Date.now() - g.__demo3.at > RESET_MS) g.__demo3 = { at: Date.now(), made: seed() };
  return g.__demo3.made;
}

export async function demoCms() {
  return (await demo()).cms;
}

/** One object of the demo library (the route /api/demo-files serves these). */
export async function demoFile(key: string): Promise<{ body: Uint8Array; mime: string } | null> {
  const o = (await demo()).store.objects.get(key);
  return o ? { body: o.body, mime: o.mime ?? "application/octet-stream" } : null;
}
