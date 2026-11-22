/**
 * agent-cms in an Express app (5 or 4). Express speaks Node's request and response, so the CMS
 * handler goes through `toNodeHandler` from "@mainsoft/agent-cms/adapters/node". Mount it before
 * body parsers, or keep them: the adapter reads a parsed body too.
 */
import express from "express";
import { createCms, defineCollection, MemoryRepo, type Actor } from "@mainsoft/agent-cms";
import { createCmsHandler } from "@mainsoft/agent-cms/http";
type CmsUser = Extract<Actor, { kind: "user" }>;
import { toNodeHandler } from "@mainsoft/agent-cms/adapters/node";

export function createApp(o: { cms?: ReturnType<typeof createCms>; user?: (req: Request) => Promise<CmsUser | null> } = {}) {
  const cms =
    o.cms ??
    createCms({
      repo: new MemoryRepo(),
      collections: [defineCollection({ slug: "posts", label: "Posts", visibility: "public", url: (d) => `/posts/${d.slug}` })],
    });
  const handler = createCmsHandler({ cms, resolveUser: o.user ?? (async (req) => (req.headers.get("x-demo-user") ? { kind: "user" as const, id: "demo", label: "Demo", isAdmin: true } : null)) });

  const app = express();
  // Behind a proxy (Heroku, Render, nginx): app.set("trust proxy", 1) and toNodeHandler(handler, { trustProxy: true }).
  app.use("/api/cms", toNodeHandler(handler));
  app.use(express.json());
  app.get("/posts/:slug", async (req, res) => {
    const doc = await cms.get({ kind: "anonymous" }, "posts", req.params.slug).catch(() => null);
    if (!doc) return void res.status(404).send("Not found");
    res.type("html").send(`<!doctype html><title>${escape(doc.title)}</title><h1>${escape(doc.title)}</h1>`);
  });
  return { app, cms };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
