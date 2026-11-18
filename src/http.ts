/**
 * REST API + MCP endpoint over one catch-all route. Mount as
 * `app/api/cms/[...path]/route.ts`:
 *
 *   const handler = createCmsHandler({ cms, resolveUser });
 *   export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
 *
 * Auth: an `Authorization: Bearer sgk_…` key, else the app's session user
 * (`resolveUser`), else anonymous (published reads only).
 *
 *   GET    /collections/:c                      list (?drafts=1&status=&category=)
 *   POST   /collections/:c                      create {doc, publish?, pr?, note?}
 *   GET    /collections/:c/:slug                read (?draft=1 for the working copy)
 *   PATCH  /collections/:c/:slug                update {doc, expectedVersion?, publish?, pr?, note?}
 *   DELETE /collections/:c/:slug
 *   POST   /collections/:c/:slug/publish        {version?}
 *   POST   /collections/:c/:slug/archive | unarchive | reviewed
 *   GET    /collections/:c/:slug/versions[/:n]
 *   POST   /collections/:c/:slug/versions/:n/restore {publish?}
 *   GET    /collections/:c/_gaps                (?state=open)
 *   POST   /collections/:c/_gaps                {question, note?, slug?}
 *   PATCH  /collections/:c/_gaps/:id            {state}
 *   GET    /search?q=&collections=a,b
 *   POST   /coverage                            {files, pr?}
 *   POST   /deploy-sync                         {prs, files, sha?}
 *   GET    /keys | POST /keys {name, scopes, collections?} | DELETE /keys/:id
 *   POST   /mcp                                 MCP (JSON-RPC over streamable HTTP, stateless)
 */

import { z } from "zod";
import type { Cms } from "./cms";
import { keyFromHeader } from "./keys";
import { handleMcp } from "./mcp";
import { CmsError, DOC_STATUSES, KEY_SCOPES, type Actor } from "./types";

export interface CmsHandlerOptions {
  cms: Cms;
  /** The signed-in app user, if any. */
  resolveUser: (req: Request) => Promise<Extract<Actor, { kind: "user" }> | null>;
  /** Mount point, used to find the sub-path. Default "/api/cms". */
  basePath?: string;
}

const DocInput = z
  .object({
    slug: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    category: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
    covers: z.array(z.string()).optional(),
    fields: z.record(z.unknown()).optional(),
  })
  .strict();

const WriteBody = z.object({
  doc: DocInput,
  expectedVersion: z.number().int().positive().optional(),
  publish: z.boolean().optional(),
  pr: z.number().int().positive().nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof CmsError) return json({ error: err.code, message: err.message }, err.status);
  if (err instanceof z.ZodError) return json({ error: "invalid", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 422);
  console.error("[agent-cms] request failed:", err);
  return json({ error: "internal", message: "처리 중 오류" }, 500);
}

/** Largest request body accepted (bytes). Documents cap at 60k chars. */
const MAX_BODY_BYTES = 512 * 1024;

export async function resolveActor(cms: Cms, req: Request, resolveUser: CmsHandlerOptions["resolveUser"]): Promise<Actor> {
  // Only a header that carries an `sgk_` key is a key login; anything else
  // (another auth scheme from a proxy) falls through to the session.
  const raw = keyFromHeader(req.headers.get("authorization"));
  if (raw) {
    const actor = await cms.authenticateKey(raw);
    if (!actor) throw new CmsError("unauthorized", "API 키가 올바르지 않거나 폐기됨");
    return actor;
  }
  if (/\bsgk_/.test(req.headers.get("authorization") ?? "")) throw new CmsError("unauthorized", "API 키 형식이 올바르지 않음");
  const user = await resolveUser(req);
  if (user && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    // Cookie sessions: refuse cross-site writes.
    const site = req.headers.get("sec-fetch-site");
    const origin = req.headers.get("origin");
    if (site === "cross-site" || (origin && new URL(req.url).host !== safeHost(origin))) throw new CmsError("forbidden", "다른 사이트에서 온 요청");
  }
  return user ?? { kind: "anonymous" };
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

async function readJson(req: Request, optional: boolean): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new CmsError("invalid", "요청이 너무 큼", 413);
  if (!text.trim()) {
    if (optional) return {};
    throw new CmsError("invalid", "JSON 본문이 필요함");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CmsError("invalid", "JSON 형식이 올바르지 않음");
  }
}

async function body<T>(req: Request, schema: z.ZodType<T>, optional = false): Promise<T> {
  return schema.parse(await readJson(req, optional));
}

export function createCmsHandler(opts: CmsHandlerOptions) {
  const { cms } = opts;
  const base = (opts.basePath ?? "/api/cms").replace(/\/$/, "");

  return async function handler(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return json({ error: "not_found", message: "없는 경로" }, 404);
      const path = url.pathname.slice(base.length);
      let seg: string[];
      try {
        seg = path.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new CmsError("invalid", "주소 인코딩이 올바르지 않음", 400);
      }
      const m = req.method.toUpperCase();
      const actor = await resolveActor(cms, req, opts.resolveUser);
      const q = url.searchParams;

      if (seg[0] === "mcp" && seg.length === 1) {
        if (m !== "POST") return json({ error: "method_not_allowed" }, 405);
        return handleMcp(cms, actor, req);
      }

      if (seg[0] === "search" && m === "GET") {
        const cols = (q.get("collections") ?? "").split(",").filter(Boolean);
        const readable = cms.collections().map((c) => c.slug).filter((c) => cms.can(actor, c, "read"));
        const r = await cms.search(actor, cols.length ? cols : readable, q.get("q") ?? "", {
          limit: Math.max(1, Math.min(Number(q.get("limit") ?? 8) || 8, 20)),
          logGap: q.get("log") === "1",
        });
        return json({
          empty: r.empty,
          hits: r.hits.map((h) => ({ collection: h.unit.collection, slug: h.unit.slug, title: h.unit.title, summary: h.unit.summary, category: h.unit.category, heading: h.unit.heading, anchor: h.unit.anchor, score: Number(h.score.toFixed(3)) })),
        });
      }

      if (seg[0] === "coverage" && m === "POST") {
        const b = await body(req, z.object({ files: z.array(z.string()).max(5000), pr: z.number().int().positive().nullable().optional() }));
        return json({ docs: await cms.coverage(actor, b.files, b.pr ?? null) });
      }
      if (seg[0] === "deploy-sync" && m === "POST") {
        const b = await body(req, z.object({ prs: z.array(z.number().int().positive()).max(200), files: z.array(z.string()).max(5000), sha: z.string().max(80).nullable().optional() }));
        return json(await cms.deploySync(actor, b));
      }

      if (seg[0] === "keys") {
        if (seg.length === 1 && m === "GET") return json({ keys: await cms.listKeys(actor) });
        if (seg.length === 1 && m === "POST") {
          const b = await body(req, z.object({ name: z.string(), scopes: z.array(z.enum(KEY_SCOPES)).min(1), collections: z.array(z.string()).nullable().optional() }));
          return json(await cms.createKey(actor, b), 201);
        }
        if (seg.length === 2 && m === "DELETE") {
          await cms.revokeKey(actor, seg[1]);
          return json({ ok: true });
        }
      }

      if (seg[0] === "collections" && seg[1]) {
        const col = seg[1];
        cms.collection(col);

        if (seg[2] === "_gaps") {
          if (seg.length === 3 && m === "GET") {
            const state = q.get("state");
            return json({ gaps: await cms.gaps(actor, col, state === "open" || state === "done" || state === "ignored" ? state : undefined) });
          }
          if (seg.length === 3 && m === "POST") {
            const b = await body(req, z.object({ question: z.string().min(1).max(300), note: z.string().max(1000).nullable().optional(), slug: z.string().max(80).nullable().optional() }));
            await cms.reportGap(actor, col, b);
            return json({ ok: true }, 201);
          }
          if (seg.length === 4 && m === "PATCH") {
            const b = await body(req, z.object({ state: z.enum(["open", "done", "ignored"]) }));
            return json({ gap: await cms.setGapState(actor, col, seg[3], b.state) });
          }
        }

        if (seg.length === 2) {
          if (m === "GET") {
            const status = q.get("status");
            const docs = await cms.list(actor, col, {
              drafts: q.get("drafts") === "1",
              status: (DOC_STATUSES as readonly string[]).includes(status ?? "") ? (status as (typeof DOC_STATUSES)[number]) : undefined,
              needsReview: q.get("needsReview") === "1" ? true : undefined,
              category: q.get("category") ?? undefined,
            });
            let counts: Map<string, number> | null = null;
            if (q.get("hits") === "1" && cms.can(actor, col, "write")) counts = await cms.hitCounts(actor, col, 7);
            return json({ docs: docs.map((d) => ({ ...d, hits7d: counts?.get(d.id) ?? undefined })) });
          }
          if (m === "POST") {
            const b = await body(req, WriteBody);
            return json({ doc: await cms.create(actor, col, b.doc, b) }, 201);
          }
        }

        const slug = seg[2];
        if (slug && seg.length === 3) {
          if (m === "GET") return json({ doc: await cms.get(actor, col, slug, { draft: q.get("draft") === "1" }) });
          if (m === "PATCH") {
            const b = await body(req, WriteBody);
            return json({ doc: await cms.update(actor, col, slug, b.doc, b) });
          }
          if (m === "DELETE") {
            await cms.remove(actor, col, slug);
            return json({ ok: true });
          }
        }
        if (slug && seg.length === 4 && m === "POST") {
          if (seg[3] === "publish") {
            const b = await body(req, z.object({ version: z.number().int().positive().optional(), expectedVersion: z.number().int().positive().optional() }), true);
            return json({ doc: await cms.publish(actor, col, slug, b) });
          }
          if (seg[3] === "archive") return json({ doc: await cms.archive(actor, col, slug) });
          if (seg[3] === "unarchive") return json({ doc: await cms.unarchive(actor, col, slug) });
          if (seg[3] === "reviewed") return json({ doc: await cms.markReviewed(actor, col, slug) });
        }
        if (slug && seg[3] === "versions") {
          if (seg.length === 4 && m === "GET") return json({ versions: await cms.versions(actor, col, slug) });
          const n = Number(seg[4]);
          if (!Number.isInteger(n) || n < 1) throw new CmsError("invalid", "버전 번호가 올바르지 않음");
          if (seg.length === 5 && m === "GET") return json({ version: await cms.version(actor, col, slug, n) });
          if (seg.length === 6 && seg[5] === "restore" && m === "POST") {
            const b = await body(req, z.object({ publish: z.boolean().optional(), expectedVersion: z.number().int().positive().optional() }), true);
            return json({ doc: await cms.restore(actor, col, slug, n, b) });
          }
        }
      }

      return json({ error: "not_found", message: "없는 경로" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
