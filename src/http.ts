/**
 * REST API + MCP endpoint over one catch-all route. Mount as
 * `app/api/cms/[...path]/route.ts`:
 *
 *   const handler = createCmsHandler({ cms, resolveUser });
 *   export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
 *
 * Auth: an `Authorization: Bearer sgk_…` key, else the app's session user
 * (`resolveUser`), else anonymous (published reads only).
 *
 * Concurrency: GET of a document sends `ETag: "v<n>"`; writes take
 * `If-Match: "v<n>"` (or `expectedVersion` in the body) and answer 409 with
 * the current working copy (`current`) when someone saved in between.
 *
 *   GET    /_me                                       who am I, what may I do
 *   GET    /collections/:c                            list (?fields=summary&state=&q=&category=&by=&limit=&cursor=&hits=1, ?drafts=1)
 *   POST   /collections/:c                            create {doc, publish?, note?}
 *   GET    /collections/:c/_counts                    numbers per state (editors)
 *   GET    /collections/:c/_schema                    fields as JSON Schema + admin hints
 *   POST   /collections/:c/_diagnose                  {doc, slug?} → every problem, nothing saved
 *   POST   /collections/:c/_bulk                      {action, items:[{slug, expectedVersion?}]}
 *   GET    /collections/:c/:slug                      read (?draft=1 for the working copy)
 *   PATCH  /collections/:c/:slug                      update {doc, expectedVersion?, publish?, note?}
 *   DELETE /collections/:c/:slug
 *   POST   /collections/:c/:slug/patch                {ops, expectedVersion?, dryRun?}
 *   GET    /collections/:c/:slug/sections
 *   PUT    /collections/:c/:slug/autosave             {doc, baseVersion}   DELETE: discard
 *   GET    /collections/:c/:slug/changes              agent changes waiting for review
 *   POST   /collections/:c/:slug/review               {hunks: [...] | "all", action?}
 *   POST   /collections/:c/:slug/preview              {ttl: "1h" | "24h" | "7d"}
 *   POST   /collections/:c/:slug/publish | archive | unarchive | unpublish
 *   GET    /collections/:c/:slug/versions[/:n]        (?fields=summary)
 *   GET    /collections/:c/:slug/diff?a=&b=
 *   POST   /collections/:c/:slug/versions/:n/restore  {publish?}
 *   GET    /search?q=&collections=a,b&miss=1          miss=1: call onSearchMiss when nothing is found
 *   GET    /preview?token=                            the version a preview link points at
 *   GET    /keys | POST /keys {name, scopes, collections?, expiresAt?} | DELETE /keys/:id
 *   GET    /audit?cursor=&action=&outcome=&actorKind= (also /_audit)
 *   POST   /mcp                                       MCP (official SDK, streamable HTTP, stateless)
 */

import { z } from "zod";
import { BULK_ACTIONS, coreOf, PREVIEW_TTLS, type CmsCore, type CmsLike } from "./cms";
import { CmsError, formatMessage, isCmsError } from "./errors";
import { keyFromHeader } from "./keys";
import { handleMcp, toJsonSchema, type McpOptions } from "./mcp";
import { DOC_STATUSES, KEY_SCOPES, type Actor, type CmsDoc } from "./types";

export interface CmsHandlerOptions {
  cms: CmsLike;
  /** The signed-in app user, if any. */
  resolveUser: (req: Request) => Promise<Extract<Actor, { kind: "user" }> | null>;
  /** Mount point, used to find the sub-path. Default "/api/cms". */
  basePath?: string;
  /** Refuse PATCH and DELETE of a document without If-Match / expectedVersion (428). Default false. */
  requireIfMatch?: boolean;
  /**
   * MCP options. `anonymous: "read"` lets requests without a key use the MCP
   * endpoint with read tools only (published documents of collections anyone
   * can read). Default: a key is required (401).
   */
  mcp?: McpOptions;
}

const DocInput = z
  .object({
    slug: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    category: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
    fields: z.record(z.unknown()).optional(),
  })
  .strict();

const WriteBody = z.object({
  doc: DocInput,
  expectedVersion: z.number().int().positive().optional(),
  publish: z.boolean().optional(),
  note: z.string().max(300).nullable().optional(),
});

const Expected = z.object({ expectedVersion: z.number().int().positive().optional() });

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export function errorResponse(err: unknown, cms?: CmsLike): Response {
  const core = cms ? coreOf(cms) : null;
  if (isCmsError(err)) {
    const body = { ...err.toJSON(), message: core ? core.message(err) : err.message };
    return json(body, err.status);
  }
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return json({ error: "invalid_request", kind: "invalid", message: formatMessage(core?.messages, "invalid_request", { issues }), params: { issues } }, 422);
  }
  console.error("[agent-cms] request failed:", err);
  return json({ error: "internal", kind: "internal", message: formatMessage(core?.messages, "internal"), params: {} }, 500);
}

/** Largest request body accepted (bytes). Documents cap at 60k chars. */
const MAX_BODY_BYTES = 512 * 1024;

export async function resolveActor(cms: CmsLike, req: Request, resolveUser: CmsHandlerOptions["resolveUser"]): Promise<Actor> {
  const core = coreOf(cms);
  // Only a header that carries an `sgk_` key is a key login; anything else
  // (another auth scheme from a proxy) falls through to the session.
  const raw = keyFromHeader(req.headers.get("authorization"));
  if (raw) {
    const actor = await core.authenticateKey(raw);
    if (!actor) throw new CmsError("invalid_key", {}, { messages: core.messages });
    return actor;
  }
  if (/\bsgk_/.test(req.headers.get("authorization") ?? "")) throw new CmsError("invalid_key", {}, { messages: core.messages });
  const user = await resolveUser(req);
  if (user && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    // Cookie sessions: refuse cross-site writes.
    const site = req.headers.get("sec-fetch-site");
    const origin = req.headers.get("origin");
    if (site === "cross-site" || (origin && new URL(req.url).host !== safeHost(origin))) throw new CmsError("cross_site", {}, { messages: core.messages });
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
  if (text.length > MAX_BODY_BYTES) throw new CmsError("body_too_large", {}, { status: 413 });
  if (!text.trim()) {
    if (optional) return {};
    throw new CmsError("invalid_json");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CmsError("invalid_json");
  }
}

async function body<T>(req: Request, schema: z.ZodType<T>, optional = false): Promise<T> {
  return schema.parse(await readJson(req, optional));
}

/** `If-Match: "v12"` (or W/"v12", or 12) → 12. */
export function versionFromIfMatch(h: string | null): number | undefined {
  if (!h) return undefined;
  const m = /^(?:W\/)?"?v?(\d+)"?$/.exec(h.trim());
  if (!m) throw new CmsError("invalid_version", {}, { status: 400 });
  return Number(m[1]);
}

const etag = (d: { version: number }) => `"v${d.version}"`;

/** A doc on the wire: editors see the autosave, nobody else does. */
const wire = (d: CmsDoc) => d;

export function createCmsHandler(opts: CmsHandlerOptions) {
  const core: CmsCore = coreOf(opts.cms);
  const base = (opts.basePath ?? "/api/cms").replace(/\/$/, "");

  return async function handler(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname !== base && !url.pathname.startsWith(base + "/")) throw new CmsError("route_not_found");
      const path = url.pathname.slice(base.length);
      let seg: string[];
      try {
        seg = path.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new CmsError("invalid_request", { issues: "path encoding" }, { status: 400 });
      }
      const m = req.method.toUpperCase();
      const client = req.headers.get("x-agent-cms-client");
      const who = await resolveActor(core, req, opts.resolveUser);
      const actor: Actor = { ...who, via: seg[0] === "mcp" ? (client === "cli" ? "cli" : "mcp") : client === "cli" ? "cli" : "rest" };
      const q = url.searchParams;
      /** expectedVersion from If-Match, else from the body. */
      const expected = (fromBody?: number) => versionFromIfMatch(req.headers.get("if-match")) ?? fromBody;
      const needMatch = (v: number | undefined) => {
        if (opts.requireIfMatch && v === undefined) throw new CmsError("precondition_required", {}, { messages: core.messages });
        return v;
      };

      if (seg[0] === "mcp" && seg.length === 1) return handleMcp(core, actor, req, opts.mcp);

      if (seg[0] === "_me" && m === "GET") {
        return json({
          actor: actor.kind === "anonymous" ? { kind: "anonymous" } : { kind: actor.kind, label: actor.label, id: "id" in actor ? actor.id : null },
          isAdmin: core.isAdmin(actor),
          previewLinks: core.previewEnabled(),
          collections: core
            .collections()
            .filter((c) => core.can(actor, c.slug, "read"))
            .map((c) => ({ slug: c.slug, label: c.label, visibility: c.visibility, canWrite: core.can(actor, c.slug, "write"), canPublish: core.can(actor, c.slug, "publish") })),
        });
      }

      if (seg[0] === "search" && m === "GET") {
        const cols = (q.get("collections") ?? "").split(",").filter(Boolean);
        const readable = core.collections().map((c) => c.slug).filter((c) => core.can(actor, c, "read"));
        if (q.has("log")) console.warn("[agent-cms] /search?log=1 was renamed to ?miss=1 in 0.6.0");
        const r = await core.search(actor, cols.length ? cols : readable, q.get("q") ?? "", {
          limit: Math.max(1, Math.min(Number(q.get("limit") ?? 8) || 8, 20)),
          reportMiss: q.get("miss") === "1" || q.get("log") === "1",
        });
        return json({
          empty: r.empty,
          hits: r.hits.map((h) => ({ collection: h.unit.collection, slug: h.unit.slug, title: h.unit.title, summary: h.unit.summary, category: h.unit.category, heading: h.unit.heading, anchor: h.unit.anchor, score: Number(h.score.toFixed(3)) })),
        });
      }

      if (seg[0] === "preview" && seg.length === 1 && m === "GET") return json(await core.readPreview(q.get("token") ?? ""));

      if ((seg[0] === "audit" || seg[0] === "_audit") && seg.length === 1 && m === "GET") {
        const outcome = q.get("outcome");
        return json(
          await core.audit(actor, {
            cursor: q.get("cursor"),
            limit: Number(q.get("limit") ?? 50) || 50,
            action: q.get("action") ?? undefined,
            outcome: outcome === "ok" || outcome === "denied" || outcome === "failed" ? outcome : undefined,
            actorKind: (["user", "key", "system", "anonymous"] as const).find((k) => k === q.get("actorKind")),
          })
        );
      }

      if (seg[0] === "keys") {
        if (seg.length === 1 && m === "GET") return json({ keys: await core.listKeys(actor) });
        if (seg.length === 1 && m === "POST") {
          const b = await body(req, z.object({ name: z.string(), scopes: z.array(z.enum(KEY_SCOPES)).min(1), collections: z.array(z.string()).nullable().optional(), expiresAt: z.string().nullable().optional() }));
          return json(await core.createKey(actor, b), 201);
        }
        if (seg.length === 2 && m === "DELETE") {
          await core.revokeKey(actor, seg[1]);
          return json({ ok: true });
        }
      }

      if (seg[0] === "collections" && seg[1]) {
        const col = seg[1];
        const cfg = core.collection(col);

        if (seg.length === 3 && seg[2] === "_counts" && m === "GET") return json({ counts: await core.counts(actor, col) });
        if (seg.length === 3 && seg[2] === "_schema" && m === "GET") {
          return json({
            slug: cfg.slug,
            label: cfg.label,
            visibility: cfg.visibility,
            categories: cfg.categories ?? null,
            draftsMode: cfg.versions?.drafts !== false,
            hasUrl: !!cfg.url,
            fields: cfg.fields ? toJsonSchema(cfg.fields) : null,
            admin: cfg.admin?.fields ?? {},
            forbiddenChars: cfg.forbiddenChars ?? [],
            canWrite: core.can(actor, col, "write"),
            canPublish: core.can(actor, col, "publish"),
          });
        }
        if (seg.length === 3 && seg[2] === "_diagnose" && m === "POST") {
          const b = await body(req, z.object({ doc: DocInput, slug: z.string().optional() }));
          return json({ diagnostics: await core.diagnose(actor, col, b.doc, { slug: b.slug }) });
        }
        if (seg.length === 3 && seg[2] === "_bulk" && m === "POST") {
          const b = await body(req, z.object({ action: z.enum(BULK_ACTIONS), items: z.array(z.object({ slug: z.string(), expectedVersion: z.number().int().positive().optional() })).min(1).max(200) }));
          return json({ results: await core.bulk(actor, col, b.action, b.items) });
        }

        if (seg.length === 2) {
          if (m === "GET") {
            const status = q.get("status");
            const state = q.get("state");
            const by = q.get("by");
            const lo = {
              drafts: q.get("drafts") === "1" || q.get("fields") === "summary",
              status: (DOC_STATUSES as readonly string[]).includes(status ?? "") ? (status as (typeof DOC_STATUSES)[number]) : undefined,
              state: (["draft", "published", "modified", "archived"] as const).find((x) => x === state),
              by: (["user", "key", "system"] as const).find((x) => x === by),
              category: q.get("category") ?? undefined,
              q: q.get("q") ?? undefined,
            };
            if (q.get("fields") === "summary") {
              return json(await core.page(actor, col, { ...lo, limit: Number(q.get("limit") ?? 50) || 50, cursor: q.get("cursor"), hits: q.get("hits") === "1" }));
            }
            const docs = await core.list(actor, col, lo);
            let counts: Map<string, number> | null = null;
            if (q.get("hits") === "1" && core.can(actor, col, "write")) counts = await core.hitCounts(actor, col, 7);
            return json({ docs: docs.map((d) => ({ ...wire(d), hits7d: counts?.get(d.id) ?? undefined })) });
          }
          if (m === "POST") {
            const b = await body(req, WriteBody);
            return json({ doc: wire(await core.create(actor, col, b.doc, b)) }, 201);
          }
        }

        const slug = seg[2];
        if (slug && seg.length === 3) {
          if (m === "GET" || m === "HEAD") {
            const doc = await core.get(actor, col, slug, { draft: q.get("draft") === "1" });
            const tag = etag(doc);
            if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { etag: tag } });
            return json({ doc: wire(doc) }, 200, { etag: tag });
          }
          if (m === "PATCH") {
            const b = await body(req, WriteBody);
            const doc = await core.update(actor, col, slug, b.doc, { ...b, expectedVersion: needMatch(expected(b.expectedVersion)) });
            return json({ doc: wire(doc) }, 200, { etag: etag(doc) });
          }
          if (m === "DELETE") {
            await core.remove(actor, col, slug, { expectedVersion: needMatch(expected(Number(q.get("expectedVersion")) || undefined)) });
            return json({ ok: true });
          }
        }

        if (slug && seg.length === 4) {
          const action = seg[3];
          if (action === "patch" && m === "POST") {
            const b = await body(
              req,
              z.object({
                ops: z.array(z.object({ op: z.enum(["replace", "insert_after", "insert_before", "delete", "append"]), anchor: z.string().optional(), markdown: z.string().optional(), heading: z.string().optional() })).min(1).max(50),
                expectedVersion: z.number().int().positive().optional(),
                dryRun: z.boolean().optional(),
                note: z.string().max(300).optional(),
              })
            );
            return json(await core.patch(actor, col, slug, b.ops as never, { ...b, expectedVersion: expected(b.expectedVersion) }));
          }
          if (action === "sections" && m === "GET") return json({ sections: await core.sections(actor, col, slug) });
          if (action === "autosave" && m === "PUT") {
            const b = await body(req, z.object({ doc: DocInput, baseVersion: z.number().int().positive() }));
            return json({ autosave: await core.autosave(actor, col, slug, b.doc, b.baseVersion) });
          }
          if (action === "autosave" && m === "DELETE") {
            await core.discardAutosave(actor, col, slug);
            return json({ ok: true });
          }
          if (action === "changes" && m === "GET") return json({ changes: await core.agentChanges(actor, col, slug) });
          if (action === "review" && m === "POST") {
            const b = await body(req, z.object({ hunks: z.union([z.literal("all"), z.array(z.string()).min(1)]), action: z.enum(["accepted", "reverted"]).optional() }));
            return json(await core.reviewChanges(actor, col, slug, b));
          }
          if (action === "preview" && m === "POST") {
            const b = await body(req, z.object({ ttl: z.enum(Object.keys(PREVIEW_TTLS) as [keyof typeof PREVIEW_TTLS]).optional() }), true);
            return json(await core.createPreviewLink(actor, col, slug, b), 201);
          }
          if (action === "diff" && m === "GET") {
            const a = Number(q.get("a"));
            const b = Number(q.get("b"));
            if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) throw new CmsError("invalid_version", {}, { messages: core.messages });
            return json(await core.diff(actor, col, slug, a, b));
          }
          if (m === "POST" && ["publish", "archive", "unarchive", "unpublish"].includes(action)) {
            const b = await body(req, z.object({ version: z.number().int().positive().optional(), expectedVersion: z.number().int().positive().optional() }), true);
            const o = { expectedVersion: expected(b.expectedVersion) };
            const doc =
              action === "publish"
                ? await core.publish(actor, col, slug, { ...o, version: b.version })
                : action === "archive"
                  ? await core.archive(actor, col, slug, o)
                  : action === "unarchive"
                    ? await core.unarchive(actor, col, slug, o)
                    : await core.unpublish(actor, col, slug, o);
            return json({ doc: wire(doc) }, 200, { etag: etag(doc) });
          }
        }

        if (slug && seg[3] === "versions") {
          if (seg.length === 4 && m === "GET") return json({ versions: q.get("fields") === "summary" ? await core.versionList(actor, col, slug) : await core.versions(actor, col, slug) });
          const n = Number(seg[4]);
          if (!Number.isInteger(n) || n < 1) throw new CmsError("invalid_version", {}, { messages: core.messages });
          if (seg.length === 5 && m === "GET") return json({ version: await core.version(actor, col, slug, n) });
          if (seg.length === 6 && seg[5] === "restore" && m === "POST") {
            const b = await body(req, Expected.extend({ publish: z.boolean().optional() }), true);
            const doc = await core.restore(actor, col, slug, n, { ...b, expectedVersion: expected(b.expectedVersion) });
            return json({ doc: wire(doc) }, 200, { etag: etag(doc) });
          }
        }
      }

      throw new CmsError("route_not_found");
    } catch (err) {
      return errorResponse(err, core);
    }
  };
}
