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
 *   GET    /export?collections=a,b&drafts=1&download=1  documents as markdown files: {files: [{path, text}], documents}
 *   POST   /import {files, dryRun?, diff?, onConflict?, publish?, collection?, only?}  → {items, applied}
 *   POST   /grep                                      {pattern, regex?, collections?, glob?, context?, output?} → matching lines
 *   GET    /collections/:c/:slug/read?offset&limit&outline=1  the document as a numbered file
 *   GET    /collections/:c/:slug/file                 the document as a file (text); PUT replaces it (If-Match)
 *   POST   /collections/:c/:slug/edit                 {edits:[{oldString,newString,replaceAll?}], expectedVersion?} → one version
 *   POST   /collections/:c/:slug/file-link            {method?} → a 10-minute /raw/:token link
 *   GET    /collections/:c/:slug/suggestions          agents' edits kept as suggestions; POST …/suggestions/:id/apply|reject
 *   POST   /collections/:c/:slug/checks               {doc?} → diagnostics and publish checks
 *   GET|PUT /raw/:token                               download or upload a document file through a link
 *   GET    /openapi.json                              this API as an OpenAPI 3.1 document (what the caller may read)
 *   GET    /_stats?days=7|14|30                       the dashboard's numbers (signed in)
 *   GET    /automations | POST {name, trigger, conditions, actions} | PATCH, DELETE /automations/:id
 *   GET    /automations/:id/runs | POST /automations/:id/test {collection, slug}
 *   GET    /roles | POST {name, admin?, permissions} | PATCH, DELETE /roles/:id | GET /roles/_users?q=
 *   POST   /roles/:id/members {id, label?} | DELETE /roles/:id/members/:userId
 *
 * Media library (only with `createCms({ media })`):
 *
 *   GET    /assets?store=&folder=&kind=image,video&q=&tag=&cursor=&limit=
 *   GET    /assets/_folders                           stores with their folders and file counts
 *   POST   /assets/_folders {store?, path}            DELETE /assets/_folders?store=&path= (empty folders only)
 *   POST   /assets/uploads {name, mime?, size, folder?, store?, alt?, tags?, field?}
 *                                                     → {asset, upload: {kind: "single", url, headers} | {kind: "multipart", partSize, partCount}}
 *   GET    /assets/uploads/:id                        which parts have arrived     DELETE: give up
 *   POST   /assets/uploads/:id/parts {parts: [1, 2]}  signed addresses for parts
 *   POST   /assets/uploads/:id/complete {width?, height?, duration?}
 *   POST   /assets/_import {url, name?, folder?, store?, alt?, tags?}
 *   GET    /assets/:id                                the file and the documents that use it
 *   PATCH  /assets/:id {alt?, tags?}
 *   POST   /assets/:id/move {folder?, name?}
 *   POST   /assets/:id/thumb                          body: a WebP, JPEG or PNG up to 512KB
 *   DELETE /assets/:id                                409 asset_in_use with the documents; ?confirm=1 deletes anyway
 *   GET    /files/:id/:name                           redirect to the file (?thumb=1, ?download=1, ?size=<name>); private files need a session or key
 *
 * File manager (the bucket as it is, also files the CMS did not upload):
 *
 *   GET    /stores/:store/files?prefix=&q=&cursor=&limit=   one folder: sub-folders and files, each with its asset when known
 *   GET    /stores/:store/files/_open?key=&download=1       redirect to a file by key
 *   POST   /stores/:store/files/_register {key, alt?, tags?}
 *   POST   /stores/:store/files/_move {keys?, folders?, to}  → {moved, failed: [{key, message}]}
 *   POST   /stores/:store/files/_delete {keys?, folders?, confirm?}   409 asset_in_use with the documents unless confirm
 *   POST   /assets/:id/share {ttl: "1h" | "24h" | "7d"}      → {url, expiresAt}
 *
 * Editing and publishing flow (0.10.0):
 *
 *   GET|POST /_cron                                    run what is due; `Authorization: Bearer <cronSecret>` (404 without `cronSecret`)
 *   POST   /collections/:c/_preview {doc, slug?}       blocks, toc, diagnostics, diff; nothing saved
 *   GET    /collections/:c/_presence                   who has which document open
 *   GET    /collections/:c/_filters | POST {name, query, shared?} | DELETE /collections/:c/_filters/:id
 *   POST   /collections/:c/:slug/schedule {publishAt?, unpublishAt?, expectedVersion?}   DELETE: cancel
 *   POST   /collections/:c/:slug/review/request {note?} | review/approve {publish?} | review/reject {note?}
 *   GET    /collections/:c/:slug/comments | POST {body, anchor?, quote?, threadId?}
 *   POST   /collections/:c/:slug/comments/:id/resolve {resolved?}
 *   POST   /collections/:c/:slug/presence {cursor?, selection?}   DELETE: leave
 *   PATCH  /collections/:c/:slug/versions/:n {label?, pinned?}
 *   GET    /reviews?collection=                        documents waiting for a review
 *   GET    /trash?kind=document|asset | POST /trash/_restore {items} | POST /trash/_purge {items | all: true}
 *   GET    /releases | POST {name}
 *   GET    /releases/:id | PATCH {name} | DELETE
 *   POST   /releases/:id/items {items: [{collection, slug, action?}]} | DELETE /releases/:id/items/:documentId
 *   POST   /releases/:id/publish                       all or nothing: 428 release_blocked lists what blocked
 *   POST   /releases/:id/schedule {publishAt | null}
 *   GET    /preview/comments?token= | POST {name?, body, anchor?, quote?, threadId?}   links made with comments: true
 */

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BULK_ACTIONS, coreOf, PREVIEW_TTLS, type CmsCore, type CmsLike } from "./cms";
import { CmsError, formatMessage, isCmsError } from "./errors";
import { keyFromHeader } from "./keys";
import { clientIp, ipAllowed } from "./limits";
import { handleMcp, toJsonSchema, type McpOptions } from "./mcp";
import { eventStream } from "./events";
import { openApiDocument } from "./openapi";
import { ASSET_KINDS, DOC_STATUSES, KEY_SCOPES, WEBHOOK_EVENTS, type Actor, type AssetKind, type CmsDoc } from "./types";

/** What the handler needs from the CMS's own sign-in (`createAuth` from `@mainsoft/agent-cms/auth`). */
export interface HandlerAuth {
  resolveUser(req: Request): Promise<Extract<Actor, { kind: "user" }> | null>;
  handle(req: Request, seg: string[]): Promise<Response>;
  confirmed(req: Request): Promise<boolean>;
  hasSession(req: Request): Promise<boolean>;
  describe(): { passwords: boolean; passkeys: boolean; sso: { label: string } | null; mail: boolean; adminPath: string };
}

export interface CmsHandlerOptions {
  cms: CmsLike;
  /** The signed-in app user, if any. Not needed with `auth` (the CMS's own sign-in answers it). */
  resolveUser?: (req: Request) => Promise<Extract<Actor, { kind: "user" }> | null>;
  /**
   * The CMS's own sign-in (`createAuth` from `@mainsoft/agent-cms/auth`): adds `/auth/*` (sign-in,
   * passkeys, two-step, SSO, account) and `/users/*` (people and invitations), and reads the
   * session cookie when `resolveUser` is not given.
   */
  auth?: HandlerAuth;
  /** Mount point, used to find the sub-path. Default "/api/cms". */
  basePath?: string;
  /** Refuse PATCH and DELETE of a document without If-Match / expectedVersion (428). Default false. */
  requireIfMatch?: boolean;
  /**
   * Other addresses whose pages may write with a person's session, e.g.
   * `["https://admin.example.com"]`. The app's own address needs no entry:
   * it is read from the request (`Host`, `X-Forwarded-Host`).
   */
  trustedOrigins?: readonly string[];
  /**
   * MCP options. `anonymous: "read"` lets requests without a key use the MCP
   * endpoint with read tools only (published documents of collections anyone
   * can read). Default: a key is required (401).
   */
  mcp?: McpOptions;
  /**
   * The caller's address, for request limits and a key's allowed addresses. Default: the first
   * entry of `X-Forwarded-For`, else `X-Real-IP`. Give your own when the server is not behind a
   * proxy that sets those (a client could send the header itself).
   */
  clientIp?: (req: Request) => string | null;
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
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}

export function errorResponse(err: unknown, cms?: CmsLike): Response {
  const core = cms ? coreOf(cms) : null;
  if (isCmsError(err)) {
    const body = { ...err.toJSON(), message: core ? core.message(err) : err.message };
    const wait = err.status === 429 ? Number(err.params.retryAfter ?? err.params.seconds ?? 60) : null;
    return json(body, err.status, wait ? { "retry-after": String(wait) } : undefined);
  }
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    const list = err.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), code: i.code, message: i.message }));
    return json({ error: "invalid_request", kind: "invalid", message: formatMessage(core?.messages, "invalid_request", { issues }), params: { issues }, issues: list }, 422);
  }
  console.error("[agent-cms] request failed:", err);
  return json({ error: "internal", kind: "internal", message: formatMessage(core?.messages, "internal"), params: {} }, 500);
}

/** Largest request body accepted (bytes). Documents cap at 60k chars. */
const MAX_BODY_BYTES = 512 * 1024;
/** An import bundle may be larger: 4MB. Bigger sets go through the CLI, which sends them in parts. */
const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Is this write from a page of the app itself? Browsers put the page's
 * address in `Origin`; a page elsewhere cannot change it, nor `Host`, nor
 * add `X-Forwarded-Host`. Behind a proxy (and under `next start`) `req.url`
 * holds the address the server listens on, not the one people open, so the
 * address is also read from those two headers.
 */
export function sameSite(req: Request, trusted: readonly string[] = []): boolean {
  const origin = req.headers.get("origin");
  const from = origin ? safeHost(origin) : null;
  if (from && trusted.some((o) => safeHost(o) === from || o === from)) return true;
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  if (!origin) return true; // not a browser page: nothing rides along by itself
  if (!from) return false; // "null" (a sandboxed frame) or not an address
  // A plain-http page may not write to an https app of the same name.
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() || safeProto(req.url);
  if (proto === "https:" || proto === "https") {
    if (safeProto(origin) === "http:" && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(from)) return false;
  }
  const own = [safeHost(req.url), req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || null, req.headers.get("host")];
  return own.some((h) => !!h && h.toLowerCase() === from.toLowerCase());
}

export async function resolveActor(cms: CmsLike, req: Request, resolveUser: NonNullable<CmsHandlerOptions["resolveUser"]>, trustedOrigins?: readonly string[], ipOf: (req: Request) => string | null = clientIp): Promise<Actor> {
  const core = coreOf(cms);
  const limited = async (who: string, perMinute: number | null) => {
    const v = await core.limits.check(who, perMinute);
    if (!v.ok) throw new CmsError("rate_limited", { retryAfter: v.retryAfter, limit: v.limit }, { status: 429, messages: core.messages });
  };
  // Only a header that carries an `sgk_` key is a key login; anything else
  // (another auth scheme from a proxy) falls through to the session.
  const raw = keyFromHeader(req.headers.get("authorization"));
  if (raw) {
    const actor = await core.authenticateKey(raw);
    if (!actor) {
      // Guessing keys from one address runs into a limit (30 wrong keys a minute).
      await limited(`badkey:${ipOf(req) ?? "unknown"}`, 30);
      throw new CmsError("invalid_key", {}, { messages: core.messages });
    }
    const policy = await core.keyPolicy(actor.id);
    if (policy.allowedIps.length && !ipAllowed(ipOf(req), policy.allowedIps)) throw new CmsError("forbidden_ip", {}, { messages: core.messages });
    await limited(`key:${actor.id}`, policy.perMinute);
    return actor;
  }
  if (/\bsgk_/.test(req.headers.get("authorization") ?? "")) throw new CmsError("invalid_key", {}, { messages: core.messages });
  const user = await resolveUser(req);
  if (user && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    // Cookie sessions: refuse cross-site writes.
    if (!sameSite(req, trustedOrigins)) throw new CmsError("cross_site", {}, { messages: core.messages });
  }
  if (!user) {
    // Without a key or a session the address is all there is to count by.
    if (core.limits.anonymousPerMinute) await limited(`ip:${ipOf(req) ?? "unknown"}`, core.limits.anonymousPerMinute);
    return { kind: "anonymous" };
  }
  // "An agent acting for this person" can only be said by code in the app
  // that calls the CMS directly; a request never carries it.
  const { agent: _agent, ...person } = user;
  return person;
}

function safeProto(u: string): string | null {
  try {
    return new URL(u).protocol;
  } catch {
    return null;
  }
}

/** The path for logs: secrets in it (raw file links) become placeholders. */
export function redactPath(path: string): string {
  return path.replace(/^\/raw\/[^/]+/, "/raw/:token").replace(/\/(preview|share)\/[A-Za-z0-9_-]{16,}/g, "/$1/:token");
}

/** A caller's own request id if it looks like one, else a new one. */
function requestId(req: Request): string {
  const given = req.headers.get("x-request-id");
  if (given && /^[A-Za-z0-9._:-]{8,64}$/.test(given)) return given;
  return crypto.randomUUID();
}

/** The body as text, refusing more than `max` bytes before it is all read. */
export async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new CmsError("body_too_large", {}, { status: 413 });
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      void reader.cancel().catch(() => undefined);
      throw new CmsError("body_too_large", {}, { status: 413 });
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.byteLength));
  return new TextDecoder().decode(all);
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

async function readJson(req: Request, optional: boolean, max = MAX_BODY_BYTES): Promise<unknown> {
  const text = await readLimited(req, max);
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
  const resolveUser = opts.resolveUser ?? opts.auth?.resolveUser.bind(opts.auth) ?? (async () => null);
  /** Making or rotating keys with a session of the CMS's own sign-in needs a recent confirmation. */
  const confirmFirst = async (req: Request, actor: Actor) => {
    if (opts.auth && actor.kind === "user" && (await opts.auth.hasSession(req)) && !(await opts.auth.confirmed(req))) throw new CmsError("reauth_required", {}, { status: 401, messages: core.messages });
  };
  const base = (opts.basePath ?? "/api/cms").replace(/\/$/, "");

  return async function handler(req: Request): Promise<Response> {
    const t0 = Date.now();
    const id = requestId(req);
    let seen: { kind: string; via: string | null } = { kind: "anonymous", via: null };
    const res = await handle(req, (a) => (seen = a));
    try {
      res.headers.set("x-request-id", id);
    } catch {
      /* a response with fixed headers (a redirect from fetch) */
    }
    core.telemetry({ type: "request", id, method: req.method.toUpperCase(), path: redactPath(new URL(req.url).pathname.slice(base.length) || "/"), status: res.status, ms: Date.now() - t0, actor: seen.kind, via: seen.via });
    return res;
  };

  async function handle(req: Request, note: (a: { kind: string; via: string | null }) => void): Promise<Response> {
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
      if (seg[0] === "_cron" && seg.length === 1 && (m === "GET" || m === "POST")) {
        // Its own secret, not a session or a key: a cron service calls this.
        if (!core.cronSecret) throw new CmsError("route_not_found");
        const given = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
        const want = Buffer.from(core.cronSecret);
        if (given.length !== want.length || !timingSafeEqual(given, want)) throw new CmsError("unauthorized", {}, { messages: core.messages });
        note({ kind: "cron", via: null });
        return json(await core.cron());
      }
      if (seg[0] === "raw" && seg.length === 2 && (m === "GET" || m === "PUT")) {
        // A short-lived link from document_file_link: the token is the permission.
        const link = await core.ax.rawOpen(seg[1], m);
        note({ kind: link.actor.kind, via: "raw" });
        if (m === "GET") {
          const f = await core.ax.file(link.actor, link.collection, link.slug);
          return new Response(f.text, { status: 200, headers: { "content-type": `${f.format === "html" ? "text/html" : "text/markdown"}; charset=utf-8`, "content-disposition": `attachment; filename="${f.path.split("/").pop()}"`, etag: `"${f.version}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        }
        const text = await readLimited(req, MAX_BODY_BYTES);
        // The link is for the version it was made from; a different If-Match is refused, not obeyed.
        const asked = versionFromIfMatch(req.headers.get("if-match"));
        if (asked !== undefined && asked !== link.version) throw new CmsError("conflict_version", { expected: link.version, actual: asked }, { status: 409, messages: core.messages });
        const r = await core.ax.write(link.actor, link.collection, link.slug, text, { expectedVersion: link.version, note: "uploaded file" });
        return json(r);
      }
      if ((seg[0] === "auth" || seg[0] === "users") && opts.auth) {
        // Signing in rides on cookies too: a page elsewhere may not post here (login CSRF).
        if (m !== "GET" && m !== "HEAD" && !sameSite(req, opts.trustedOrigins)) throw new CmsError("cross_site", {}, { messages: core.messages });
        note({ kind: "user", via: "auth" });
        return await opts.auth.handle(req, seg[0] === "auth" ? seg.slice(1) : seg);
      }
      if (seg[0] === "auth" || seg[0] === "users") throw new CmsError("auth_off", {}, { messages: core.messages });
      const client = req.headers.get("x-agent-cms-client");
      const who = await resolveActor(core, req, resolveUser, opts.trustedOrigins, opts.clientIp);
      const actor: Actor = { ...who, via: seg[0] === "mcp" ? (client === "cli" ? "cli" : "mcp") : client === "cli" ? "cli" : "rest" };
      note({ kind: actor.kind, via: actor.via ?? null });
      void core.roles.seen(actor);
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
          actor: actor.kind === "anonymous" ? { kind: "anonymous" } : { kind: actor.kind, label: actor.label, id: "id" in actor ? actor.id : null, ...(actor.kind === "user" && actor.email ? { email: actor.email } : {}) },
          isAdmin: core.isAdmin(actor),
          previewLinks: core.previewEnabled(),
          trashDays: core.trash.days,
          timeZone: core.timeZone,
          media: core.assets.describe(actor),
          /** True when webhooks can be made (a `secretsKey` is set) and this caller may manage them. */
          webhooks: core.webhooks.enabled() && core.isAdmin(actor),
          /** The dashboard, automations and roles screens exist in this version. */
          dashboard: actor.kind !== "anonymous",
          automations: core.isAdmin(actor),
          roles: core.isAdmin(actor),
          /** The CMS's own sign-in, when it is on: how people sign in, and whether this caller manages people. */
          auth: opts.auth ? { ...opts.auth.describe(), people: core.isAdmin(actor) && actor.kind === "user" } : null,
          nav: core.plugins.nav.filter((n) => !n.admin || core.isAdmin(actor)).map(({ label, href, plugin }) => ({ label, href, plugin })),
          plugins: Object.fromEntries(await Promise.all(core.plugins.names.map(async (name) => [name, Object.assign({}, ...(await Promise.all(core.plugins.me.filter((x) => x.plugin === name).map((x) => x.fn(actor)))))] as const))),
          collections: core
            .collections()
            .filter((c) => core.can(actor, c.slug, "read"))
            .map((c) => ({ slug: c.slug, label: c.label, visibility: c.visibility, canWrite: core.can(actor, c.slug, "write"), canPublish: core.can(actor, c.slug, "publish") })),
        });
      }

      if (seg[0] === "grep" && seg.length === 1 && m === "POST") {
        const b = await body(
          req,
          z.object({
            pattern: z.string().min(1).max(1000),
            regex: z.boolean().optional(),
            ignoreCase: z.boolean().optional(),
            collections: z.array(z.string()).max(50).optional(),
            slugs: z.array(z.string()).max(500).optional(),
            glob: z.string().max(300).optional(),
            context: z.number().int().min(0).max(5).optional(),
            output: z.enum(["lines", "files", "count"]).optional(),
            drafts: z.boolean().optional(),
            limit: z.number().int().positive().max(2000).optional(),
          })
        );
        return json(await core.ax.grep(actor, b));
      }

      if (seg[0] === "openapi.json" && seg.length === 1 && m === "GET") {
        // The address people open, not the one the server listens on (see sameSite).
        const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
        const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
        return json(openApiDocument(core, { basePath: base, origin: host ? `${proto}://${host}` : url.origin, actor, auth: !!opts.auth }), 200, { "cache-control": "private, max-age=60" });
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
      const CommentBody = z.object({ body: z.string().max(8000), anchor: z.string().max(300).nullable().optional(), quote: z.string().max(2000).nullable().optional(), threadId: z.string().max(60).nullable().optional() });
      if (seg[0] === "preview" && seg[1] === "comments" && seg.length === 2) {
        const token = q.get("token") ?? "";
        if (m === "GET") return json({ comments: await core.previewComments(token) });
        if (m === "POST") return json({ comment: await core.addPreviewComment(token, await body(req, CommentBody.extend({ name: z.string().max(120).nullable().optional() }))) }, 201);
      }

      if (seg[0] === "reviews" && seg.length === 1 && m === "GET") return json({ requests: await core.reviewRequests(actor, { collection: q.get("collection") ?? undefined }) });

      if (seg[0] === "trash") {
        const Items = z.array(z.object({ kind: z.enum(["document", "asset"]), id: z.string().max(60) })).min(1).max(200);
        const kind = q.get("kind");
        if (seg.length === 1 && m === "GET") return json(await core.trash.list(actor, { kind: kind === "document" || kind === "asset" ? kind : undefined }));
        if (seg[1] === "_restore" && seg.length === 2 && m === "POST") return json(await core.trash.restore(actor, (await body(req, z.object({ items: Items }))).items));
        if (seg[1] === "_purge" && seg.length === 2 && m === "POST") {
          const b = await body(req, z.object({ items: Items.optional(), all: z.boolean().optional() }));
          if (!b.all && !b.items) throw new CmsError("invalid_request", { issues: "items or all" }, { messages: core.messages });
          return json(await core.trash.purge(actor, b.all ? "all" : b.items!));
        }
      }

      if (seg[0] === "releases") {
        const rel = core.releases;
        const Name = z.object({ name: z.string().max(200) });
        if (seg.length === 1 && m === "GET") return json({ releases: await rel.list(actor) });
        if (seg.length === 1 && m === "POST") return json({ release: await rel.create(actor, await body(req, Name)) }, 201);
        const id = seg[1];
        if (id && seg.length === 2) {
          if (m === "GET") return json({ release: await rel.get(actor, id) });
          if (m === "PATCH") return json({ release: await rel.rename(actor, id, await body(req, Name)) });
          if (m === "DELETE") {
            await rel.remove(actor, id);
            return json({ ok: true });
          }
        }
        if (id && seg[2] === "items" && seg.length === 3 && m === "POST") {
          const b = await body(req, z.object({ items: z.array(z.object({ collection: z.string(), slug: z.string(), action: z.enum(["publish", "unpublish"]).optional() })).min(1).max(200) }));
          return json({ release: await rel.add(actor, id, b.items) });
        }
        if (id && seg[2] === "items" && seg.length === 4 && m === "DELETE") return json({ release: await rel.removeItem(actor, id, seg[3]) });
        if (id && seg[2] === "publish" && seg.length === 3 && m === "POST") return json({ release: await rel.publish(actor, id) });
        if (id && seg[2] === "schedule" && seg.length === 3 && m === "POST") return json({ release: await rel.schedule(actor, id, await body(req, z.object({ publishAt: z.string().max(40).nullable() }))) });
      }

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
          const b = await body(req, z.object({ name: z.string(), scopes: z.array(z.enum(KEY_SCOPES)).min(1), collections: z.array(z.string()).nullable().optional(), expiresAt: z.string().nullable().optional(), rateLimit: z.number().nullable().optional(), allowedIps: z.array(z.string().max(60)).max(50).nullable().optional() }));
          await confirmFirst(req, actor);
          return json(await core.createKey(actor, b), 201);
        }
        if (seg.length === 3 && seg[2] === "rotate" && m === "POST") {
          const b = await body(req, z.object({ graceMinutes: z.number().int().min(0).max(10080).optional() }), true);
          await confirmFirst(req, actor);
          return json(await core.rotateKey(actor, seg[1], b), 201);
        }
        if (seg.length === 2 && m === "DELETE") {
          await core.revokeKey(actor, seg[1], { reason: q.get("reason") });
          return json({ ok: true });
        }
      }

      if (seg[0] === "retention" && seg.length === 1) {
        if (m === "GET") {
          if (!core.isAdmin(actor)) throw new CmsError(actor.kind === "anonymous" ? "unauthorized" : "forbidden_admin", {}, { messages: core.messages });
          return json({ rules: core.retention.rules() });
        }
        if (m === "POST") {
          const b = await body(req, z.object({ dryRun: z.boolean().optional() }), true);
          return json(await core.retention.run(actor, b));
        }
      }

      if (seg[0] === "_events" && seg.length === 1 && m === "GET") {
        return eventStream(core, actor, { collections: q.get("collections")?.split(",").filter(Boolean), since: q.get("since") ?? req.headers.get("last-event-id"), signal: req.signal, request: req });
      }

      if (seg[0] === "files" && seg[1] && seg.length <= 3 && (m === "GET" || m === "HEAD")) {
        const to = await core.assets.open(actor, seg[1], { thumb: q.get("thumb") === "1", download: q.get("download") === "1", size: q.get("size") });
        // A public address may be cached briefly; a signed one is for this request only.
        return new Response(null, { status: 302, headers: { location: to.url, "cache-control": to.visibility === "public" && q.get("download") !== "1" ? "public, max-age=300" : "private, no-store" } });
      }

      if (seg[0] === "stores" && seg[1] && seg[2] === "files") {
        const assets = core.assets;
        const store = seg[1];
        const pick = z.object({ keys: z.array(z.string().max(1024)).max(1000).optional(), folders: z.array(z.string().max(1024)).max(1000).optional() });
        if (seg.length === 3 && m === "GET") return json(await assets.browse(actor, { store, prefix: q.get("prefix"), q: q.get("q"), cursor: q.get("cursor"), limit: Number(q.get("limit") ?? 200) || 200 }));
        if (seg[3] === "_open" && seg.length === 4 && (m === "GET" || m === "HEAD")) {
          const to = await assets.openKey(actor, { store, key: q.get("key") ?? "", download: q.get("download") === "1" });
          return new Response(null, { status: 302, headers: { location: to.url, "cache-control": "private, no-store" } });
        }
        if (seg[3] === "_register" && seg.length === 4 && m === "POST") {
          const b = await body(req, z.object({ key: z.string().min(1).max(1024), alt: z.string().max(500).optional(), tags: z.array(z.string().max(40)).max(30).optional() }));
          return json({ asset: await assets.register(actor, { store, ...b }) }, 201);
        }
        if (seg[3] === "_move" && seg.length === 4 && m === "POST") return json(await assets.moveMany(actor, { store, ...(await body(req, pick.extend({ to: z.string().max(1024).nullable() }))) }));
        if (seg[3] === "_delete" && seg.length === 4 && m === "POST") return json(await assets.removeMany(actor, { store, ...(await body(req, pick.extend({ confirm: z.boolean().optional(), check: z.boolean().optional() }))) }));
      }

      if (seg[0] === "assets") {
        const assets = core.assets;
        const tags = z.array(z.string().max(40)).max(30).optional();
        if (seg.length === 1 && m === "GET") {
          const kinds = (q.get("kind") ?? "").split(",").filter((k): k is AssetKind => (ASSET_KINDS as readonly string[]).includes(k) && k !== "folder");
          return json(await assets.list(actor, { store: q.get("store"), folder: q.get("folder"), kinds, q: q.get("q") ?? undefined, tag: q.get("tag") ?? undefined, unused: q.get("unused") === "true" || q.get("unused") === "1", missingAlt: q.get("missingAlt") === "true" || q.get("missingAlt") === "1", sort: (["new", "old", "name", "size"] as const).find((x) => x === q.get("sort")), cursor: q.get("cursor"), limit: Number(q.get("limit") ?? 48) || 48 }));
        }
        if (seg[1] === "_zip" && seg.length === 2 && m === "GET") {
          const z1 = await assets.zip(actor, (q.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
          return new Response(z1.data as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${z1.name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
        }
        if (seg[1] === "_folders" && seg.length === 2) {
          if (m === "GET") return json({ stores: await assets.folders(actor) });
          if (m === "POST") return json(await assets.createFolder(actor, await body(req, z.object({ store: z.string().nullable().optional(), path: z.string().min(1).max(400) }))), 201);
          if (m === "DELETE") {
            await assets.deleteFolder(actor, { store: q.get("store"), path: q.get("path") ?? "" });
            return json({ ok: true });
          }
        }
        if (seg[1] === "_import" && seg.length === 2 && m === "POST") {
          const b = await body(req, z.object({ url: z.string().max(2000), name: z.string().max(300).nullable().optional(), folder: z.string().max(400).nullable().optional(), store: z.string().nullable().optional(), alt: z.string().max(500).optional(), tags }));
          return json({ asset: await assets.import(actor, b) }, 201);
        }
        if (seg[1] === "uploads") {
          if (seg.length === 2 && m === "POST") {
            const b = await body(
              req,
              z.object({
                name: z.string().min(1).max(300),
                mime: z.string().max(200).nullable().optional(),
                size: z.number().int().positive(),
                folder: z.string().max(400).nullable().optional(),
                store: z.string().nullable().optional(),
                alt: z.string().max(500).optional(),
                tags,
                field: z.object({ collection: z.string(), path: z.string() }).nullable().optional(),
                replace: z.string().max(40).nullable().optional(),
              })
            );
            return json(await assets.requestUpload(actor, b), 201);
          }
          const id = seg[2];
          if (id && seg.length === 3 && m === "GET") return json(await assets.uploadStatus(actor, id));
          if (id && seg.length === 3 && m === "DELETE") {
            await assets.abortUpload(actor, id);
            return json({ ok: true });
          }
          if (id && seg[3] === "parts" && seg.length === 4 && m === "POST") {
            const b = await body(req, z.object({ parts: z.array(z.number().int().positive()).min(1).max(200) }));
            return json({ parts: await assets.partUrls(actor, id, b.parts) });
          }
          if (id && seg[3] === "complete" && seg.length === 4 && m === "POST") {
            const n = z.number().nonnegative().nullable().optional();
            return json({ asset: await assets.completeUpload(actor, id, await body(req, z.object({ width: n, height: n, duration: n }), true)) });
          }
        }
        const id = seg[1];
        if (id && !id.startsWith("_") && id !== "uploads") {
          if (seg.length === 2 && m === "GET") return json({ asset: await assets.get(actor, id) });
          if (seg.length === 2 && m === "PATCH") return json({ asset: await assets.update(actor, id, await body(req, z.object({ alt: z.string().max(500).optional(), tags, focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional() }))) });
          if (seg.length === 2 && m === "DELETE") {
            await assets.remove(actor, id, { confirm: q.get("confirm") === "1" });
            return json({ ok: true });
          }
          if (seg[2] === "move" && seg.length === 3 && m === "POST") {
            return json({ asset: await assets.move(actor, id, await body(req, z.object({ folder: z.string().max(400).nullable().optional(), name: z.string().max(300).nullable().optional() }))) });
          }
          if (seg[2] === "share" && seg.length === 3 && m === "POST") return json(await assets.share(actor, id, await body(req, z.object({ ttl: z.enum(["1h", "24h", "7d"]).optional() }), true)));
          if (seg[2] === "thumb" && seg.length === 3 && m === "POST") {
            const bytes = new Uint8Array(await req.arrayBuffer());
            if (bytes.length > MAX_BODY_BYTES) throw new CmsError("body_too_large", {}, { status: 413 });
            return json({ asset: await assets.setThumb(actor, id, bytes) });
          }
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
            requireAlt: !!cfg.media?.requireAlt,
            review: cfg.review ?? null,
            needsReview: core.needsReview(actor, col),
            forbiddenChars: cfg.forbiddenChars ?? [],
            canWrite: core.can(actor, col, "write"),
            canPublish: core.can(actor, col, "publish"),
            formats: cfg.body?.formats ?? ["markdown"],
            html: { render: cfg.html?.render ?? "safe", iframeHosts: cfg.html?.iframeHosts ?? null, allowStyle: cfg.html?.allowStyle ?? false, classPrefix: cfg.html?.classPrefix ?? null },
            canHtml: core.canHtml(actor, col, "html"),
            canHtmlScripts: core.canHtml(actor, col, "html_scripts"),
            agentEdits: cfg.agentEdits ?? "apply",
            publishChecks: (cfg.publishChecks?.length ?? 0) > 0,
          });
        }
        if (seg.length === 3 && seg[2] === "_diagnose" && m === "POST") {
          const b = await body(req, z.object({ doc: DocInput, slug: z.string().optional() }));
          return json({ diagnostics: await core.diagnose(actor, col, b.doc, { slug: b.slug }) });
        }
        if (seg.length === 3 && seg[2] === "_preview" && m === "POST") {
          const b = await body(req, z.object({ doc: DocInput, slug: z.string().optional() }));
          return json(await core.preview(actor, col, b.doc, { slug: b.slug }));
        }
        if (seg.length === 3 && seg[2] === "_presence" && m === "GET") return json({ presence: await core.presence.in(actor, col) });
        if (seg[2] === "_filters") {
          if (seg.length === 3 && m === "GET") return json({ filters: await core.filters.list(actor, col) });
          if (seg.length === 3 && m === "POST") return json({ filter: await core.filters.save(actor, col, await body(req, z.object({ name: z.string().max(200), query: z.record(z.unknown()), shared: z.boolean().optional() }))) }, 201);
          if (seg.length === 4 && m === "DELETE") {
            await core.filters.remove(actor, seg[3]);
            return json({ ok: true });
          }
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
              state: (["draft", "published", "modified", "archived", "scheduled", "review"] as const).find((x) => x === state),
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
            // Editors also learn which open release the document is in.
            const release = q.get("draft") === "1" && core.can(actor, col, "write", doc) ? await core.releases.of(doc.id) : undefined;
            return json({ doc: wire(doc), release }, 200, { etag: tag });
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
          if (action === "read" && m === "GET") {
            const n = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
            return json(await core.ax.read(actor, col, slug, { offset: n("offset"), limit: n("limit"), outline: q.get("outline") === "1" }));
          }
          if (action === "file" && m === "GET") {
            const f = await core.ax.file(actor, col, slug);
            return new Response(f.text, { status: 200, headers: { "content-type": `${f.format === "html" ? "text/html" : "text/markdown"}; charset=utf-8`, etag: `"${f.version}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
          }
          if (action === "file" && m === "PUT") {
            const text = await readLimited(req, MAX_BODY_BYTES);
            return json(await core.ax.write(actor, col, slug, text, { expectedVersion: expected(), note: q.get("note") ?? undefined }));
          }
          if (action === "file-link" && m === "POST") {
            const b = await body(req, z.object({ method: z.enum(["GET", "PUT"]).optional() }), true);
            return json(await core.ax.rawLink(actor, col, slug, b), 201);
          }
          if (action === "edit" && m === "POST") {
            const b = await body(
              req,
              z.object({
                edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() })).min(1).max(50),
                expectedVersion: z.number().int().positive().optional(),
                note: z.string().max(300).optional(),
                dryRun: z.boolean().optional(),
              })
            );
            return json(await core.ax.edit(actor, col, slug, b.edits, { expectedVersion: expected(b.expectedVersion), note: b.note, dryRun: b.dryRun }));
          }
          if (action === "suggestions" && m === "GET") return json({ suggestions: await core.ax.suggestions(actor, col, slug) });
          if (action === "checks" && m === "POST") {
            const b = await body(req, z.object({ doc: DocInput.optional() }), true);
            return json(await core.publishChecks(actor, col, slug, (b.doc ?? {}) as never));
          }
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
            const b = await body(req, z.object({ ttl: z.enum(Object.keys(PREVIEW_TTLS) as [keyof typeof PREVIEW_TTLS]).optional(), comments: z.boolean().optional() }), true);
            return json(await core.createPreviewLink(actor, col, slug, b), 201);
          }
          if (action === "schedule" && m === "POST") {
            const b = await body(req, z.object({ publishAt: z.string().max(40).nullable().optional(), unpublishAt: z.string().max(40).nullable().optional(), expectedVersion: z.number().int().positive().optional() }));
            const doc = await core.schedule(actor, col, slug, { ...b, expectedVersion: expected(b.expectedVersion) });
            return json({ doc: wire(doc) }, 200, { etag: etag(doc) });
          }
          if (action === "schedule" && m === "DELETE") return json({ doc: wire(await core.unschedule(actor, col, slug)) });
          if (action === "comments" && m === "GET") return json({ comments: await core.comments(actor, col, slug) });
          if (action === "comments" && m === "POST") return json({ comment: await core.addComment(actor, col, slug, await body(req, CommentBody)) }, 201);
          if (action === "presence" && m === "POST") {
            const at = z.object({ line: z.number().int(), ch: z.number().int() }).nullable().optional();
            return json(await core.presence.touch(actor, col, slug, await body(req, z.object({ cursor: at, selection: at }), true)));
          }
          if (action === "presence" && m === "DELETE") {
            await core.presence.leave(actor, col, slug);
            return json({ ok: true });
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

        if (slug && seg[3] === "review" && seg.length === 5 && m === "POST") {
          const b = await body(req, z.object({ note: z.string().max(2000).nullable().optional(), publish: z.boolean().optional() }), true);
          const doc = seg[4] === "request" ? await core.requestReview(actor, col, slug, b) : seg[4] === "approve" ? await core.approveReview(actor, col, slug, b) : seg[4] === "reject" ? await core.rejectReview(actor, col, slug, b) : null;
          if (doc) return json({ doc: wire(doc) }, 200, { etag: etag(doc) });
        }
        if (slug && seg[3] === "suggestions" && seg.length === 6 && m === "POST" && (seg[5] === "apply" || seg[5] === "reject")) {
          if (seg[5] === "reject") {
            await core.ax.rejectSuggestion(actor, col, slug, seg[4]);
            return json({ ok: true });
          }
          const b = await body(req, z.object({ edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() })).min(1).max(50).optional(), note: z.string().max(300).optional() }), true);
          return json(await core.ax.applySuggestion(actor, col, slug, seg[4], b));
        }
        if (slug && seg[3] === "comments" && seg[5] === "resolve" && seg.length === 6 && m === "POST") {
          const b = await body(req, z.object({ resolved: z.boolean().optional() }), true);
          return json({ comment: await core.resolveComment(actor, col, slug, seg[4], b) });
        }

        if (slug && seg[3] === "versions") {
          if (seg.length === 4 && m === "GET") return json({ versions: q.get("fields") === "summary" ? await core.versionList(actor, col, slug) : await core.versions(actor, col, slug) });
          const n = Number(seg[4]);
          if (!Number.isInteger(n) || n < 1) throw new CmsError("invalid_version", {}, { messages: core.messages });
          if (seg.length === 5 && m === "GET") return json({ version: await core.version(actor, col, slug, n) });
          if (seg.length === 5 && m === "PATCH") return json({ version: await core.labelVersion(actor, col, slug, n, await body(req, z.object({ label: z.string().max(200).nullable().optional(), pinned: z.boolean().optional() }))) });
          if (seg.length === 6 && seg[5] === "restore" && m === "POST") {
            const b = await body(req, Expected.extend({ publish: z.boolean().optional() }), true);
            const doc = await core.restore(actor, col, slug, n, { ...b, expectedVersion: expected(b.expectedVersion) });
            return json({ doc: wire(doc) }, 200, { etag: etag(doc) });
          }
        }
      }

      if (seg[0] === "_stats" && seg.length === 1 && m === "GET") {
        if (actor.kind === "anonymous") throw new CmsError("unauthorized", {}, { messages: core.messages });
        return json(await core.stats(actor, { days: Number(q.get("days")) || undefined }));
      }

      if (seg[0] === "export" && seg.length === 1 && m === "GET") {
        const r = await core.transfer.export(actor, { collections: (q.get("collections") ?? "").split(",").filter(Boolean), drafts: q.get("drafts") === "1" });
        return json(r, 200, q.get("download") === "1" ? { "content-disposition": `attachment; filename="cms-export-${new Date().toISOString().slice(0, 10)}.json"` } : {});
      }
      if (seg[0] === "import" && seg.length === 1 && m === "POST") {
        const text = await readLimited(req, IMPORT_MAX_BYTES);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new CmsError("invalid_json");
        }
        const b = z
          .object({
            files: z.array(z.object({ path: z.string().max(400), text: z.string() })).max(2000),
            dryRun: z.boolean().optional(),
            diff: z.boolean().optional(),
            publish: z.boolean().optional(),
            onConflict: z.enum(["file-wins", "db-wins", "newest"]).optional(),
            collection: z.string().optional(),
            only: z.array(z.string()).optional(),
            assetMap: z.record(z.string()).optional(),
          })
          .parse(raw);
        return json(await core.transfer.import(actor, b.files, b));
      }

      // ── automations and roles (admins) ──
      if (seg[0] === "automations") {
        const a = core.automations;
        const input = z.object({
          name: z.string().optional(),
          enabled: z.boolean().optional(),
          trigger: z.object({ event: z.string(), collection: z.string().nullable() }).optional(),
          conditions: z.array(z.object({ field: z.string(), op: z.enum(["is", "is_not", "contains", "empty", "not_empty"]), value: z.string().optional() })).max(10).optional(),
          actions: z.array(z.object({ type: z.string(), target: z.string().optional(), name: z.string().optional(), value: z.string().optional() })).max(10).optional(),
        });
        if (seg.length === 1 && m === "GET") return json(await a.list(actor));
        if (seg.length === 1 && m === "POST") return json({ automation: await a.create(actor, (await body(req, input)) as never) }, 201);
        if (seg.length === 2 && m === "PATCH") return json({ automation: await a.update(actor, seg[1], (await body(req, input)) as never) });
        if (seg.length === 2 && m === "DELETE") {
          await a.remove(actor, seg[1]);
          return json({ ok: true });
        }
        if (seg.length === 3 && seg[2] === "runs" && m === "GET") return json({ runs: await a.runs(actor, seg[1], { limit: Number(q.get("limit")) || undefined }) });
        if (seg.length === 3 && seg[2] === "test" && m === "POST") return json(await a.test(actor, seg[1], await body(req, z.object({ collection: z.string(), slug: z.string() }))));
      }
      if (seg[0] === "roles") {
        const r = core.roles;
        const input = z.object({ name: z.string().optional(), admin: z.boolean().optional(), permissions: z.record(z.record(z.boolean())).optional() });
        if (seg.length === 1 && m === "GET") return json(await r.list(actor));
        if (seg.length === 1 && m === "POST") return json({ role: await r.create(actor, await body(req, input)) }, 201);
        if (seg.length === 2 && seg[1] === "_users" && m === "GET") return json({ users: await r.searchUsers(actor, q.get("q") ?? "") });
        if (seg.length === 2 && m === "PATCH") return json({ role: await r.update(actor, seg[1], await body(req, input)) });
        if (seg.length === 2 && m === "DELETE") {
          await r.remove(actor, seg[1]);
          return json({ ok: true });
        }
        if (seg.length === 3 && seg[2] === "members" && m === "POST") return json({ role: await r.addMember(actor, seg[1], await body(req, z.object({ id: z.string().min(1).max(200).optional(), email: z.string().max(254).optional(), label: z.string().max(120).optional() }).refine((x) => !!x.id || !!x.email, { message: "id or email" }))) });
        if (seg.length === 4 && seg[2] === "members" && m === "DELETE") return json({ role: await r.removeMember(actor, seg[1], seg[3]) });
      }

      // ── webhooks and jobs (admins) ──
      if (seg[0] === "webhooks") {
        const input = z.object({ name: z.string(), url: z.string(), events: z.array(z.enum(WEBHOOK_EVENTS)).optional(), collections: z.array(z.string()).optional(), enabled: z.boolean().optional() });
        if (seg.length === 1 && m === "GET") return json({ webhooks: await core.webhooks.list(actor), events: WEBHOOK_EVENTS, enabled: core.webhooks.enabled() });
        if (seg.length === 1 && m === "POST") return json(await core.webhooks.create(actor, await body(req, input)), 201);
        if (seg[1] === "deliveries" && seg.length === 4 && seg[3] === "retry" && m === "POST") return json(await core.webhooks.retry(actor, seg[2]), 202);
        if (seg.length === 2 && m === "PATCH") return json({ webhook: await core.webhooks.update(actor, seg[1], await body(req, input.partial())) });
        if (seg.length === 2 && m === "DELETE") {
          await core.webhooks.remove(actor, seg[1]);
          return json({ ok: true });
        }
        if (seg.length === 3 && seg[2] === "secret" && m === "GET") return json(await core.webhooks.secret(actor, seg[1]), 200, { "cache-control": "no-store" });
        if (seg.length === 3 && seg[2] === "test" && m === "POST") return json({ delivery: await core.webhooks.test(actor, seg[1]) });
        if (seg.length === 3 && seg[2] === "deliveries" && m === "GET") return json({ deliveries: await core.webhooks.deliveries(actor, seg[1], { limit: Number(q.get("limit")) || undefined }) });
      }
      if (seg[0] === "jobs") {
        if (!core.isAdmin(actor)) throw new CmsError(actor.kind === "anonymous" ? "unauthorized" : "forbidden", {}, { messages: core.messages });
        const state = q.get("state");
        if (seg.length === 1 && m === "GET") return json({ ...(await core.jobs.stats()), jobs: await core.jobs.list({ state: state === "failed" || state === "done" || state === "waiting" ? state : undefined, kind: q.get("kind") ?? undefined, limit: Number(q.get("limit")) || 50 }) });
        if (seg.length === 3 && seg[2] === "retry" && m === "POST") {
          if (!(await core.jobs.retry(seg[1]))) throw new CmsError("not_found", {}, { messages: core.messages });
          return json({ ok: true });
        }
      }

      // ── plugin routes: /<plugin name>/… ──
      if (seg[0] && core.plugins.names.includes(seg[0])) {
        const rest = seg.slice(1);
        const route = core.plugins.routes
          .filter((r) => r.plugin === seg[0] && r.method === m && r.path.length <= rest.length && r.path.every((p, i) => p === rest[i]))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (route) return await route.handler({ req, actor, path: rest.slice(route.path.length), url, cms: core });
      }

      throw new CmsError("route_not_found");
    } catch (err) {
      return errorResponse(err, core);
    }
  }
}
