/**
 * agent-cms in a Hono app. Hono hands over a web `Request`, so the CMS handler needs no adapter.
 * Runs on Node (`npm start`), Bun, Deno, Cloudflare Workers and Vercel Edge alike.
 */
import { Hono } from "hono";
import { createCms, defineCollection, MemoryRepo, type Actor } from "@mainsoft/agent-cms";
import { createCmsHandler } from "@mainsoft/agent-cms/http";
type CmsUser = Extract<Actor, { kind: "user" }>;

export function createApp(o: { cms?: ReturnType<typeof createCms>; user?: (req: Request) => Promise<CmsUser | null> } = {}) {
  const cms =
    o.cms ??
    createCms({
      // Swap for DrizzleRepo + connectPostgres from "@mainsoft/agent-cms/db" in production.
      repo: new MemoryRepo(),
      collections: [defineCollection({ slug: "posts", label: "Posts", visibility: "public", url: (d) => `/posts/${d.slug}` })],
    });
  // Your sign-in decides who is an editor; here a header stands in for it.
  const handler = createCmsHandler({ cms, resolveUser: o.user ?? (async (req) => (req.headers.get("x-demo-user") ? { kind: "user" as const, id: "demo", label: "Demo", isAdmin: true } : null)) });

  const app = new Hono();
  app.all("/api/cms/*", (c) => handler(c.req.raw));
  app.all("/api/cms", (c) => handler(c.req.raw));
  // Your own pages read published content straight from the CMS.
  app.get("/posts/:slug", async (c) => {
    const doc = await cms.get({ kind: "anonymous" }, "posts", c.req.param("slug")).catch(() => null);
    if (!doc) return c.text("Not found", 404);
    return c.html(`<!doctype html><title>${escape(doc.title)}</title><h1>${escape(doc.title)}</h1>`);
  });
  return { app, cms };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
