/**
 * For servers that speak Node's `(req, res)` instead of the web `Request`/`Response`:
 * Express, Fastify (through middie or a raw route), Koa's `ctx.req`, or plain `node:http`.
 *
 *   import { toNodeHandler } from "@mainsoft/agent-cms/adapters/node";
 *   const handler = createCmsHandler({ cms, resolveUser, basePath: "/api/cms" });
 *   app.use("/api/cms", toNodeHandler(handler));          // Express
 *   http.createServer(toNodeHandler(handler)).listen(3000);
 *
 * Frameworks that already hand out a web `Request` (Hono, Remix, SvelteKit, Astro, Nitro, Bun,
 * Deno) need no adapter: pass their request straight to the handler.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface NodeHandlerOptions {
  /** The address people open, e.g. "https://cms.example.com". Default: from `X-Forwarded-Proto` / `Host`. */
  origin?: string;
  /** Largest request body read into memory, in bytes. Default 8MB (an import bundle is at most 4MB). */
  maxBodyBytes?: number;
  /**
   * Believe `X-Forwarded-For` / `X-Real-IP` from the caller. Default false: the socket's
   * address is the caller's (what rate limits and key address rules use), and those headers
   * are replaced. Set true only behind a proxy you run that sets them.
   */
  trustProxy?: boolean;
  /**
   * Where the CMS handler is mounted, as in `createCmsHandler({ basePath })`. Default "/api/cms".
   * Used to refuse a form submission (`POST {basePath}/forms/:slug`) past 64 KB while it is still
   * arriving, instead of reading up to `maxBodyBytes` first.
   */
  basePath?: string;
}

/** A form submission's body limit (the same as the handler's `FORM_MAX_BODY`). */
const FORM_BODY_BYTES = 64 * 1024;

/** The body limit for this request: 64 KB for a form submission, else `maxBodyBytes`. */
export function bodyLimit(method: string, pathname: string, o: NodeHandlerOptions = {}): number {
  const max = o.maxBodyBytes ?? 8 * 1024 * 1024;
  const base = (o.basePath ?? "/api/cms").replace(/\/$/, "");
  if (method !== "POST" || !pathname.startsWith(base + "/")) return max;
  return /^\/forms\/[^/]+\/?$/.test(pathname.slice(base.length)) ? Math.min(max, FORM_BODY_BYTES) : max;
}

type Req = IncomingMessage & { originalUrl?: string; body?: unknown };

const tooLarge = () => Object.assign(new Error("request body too large"), { status: 413 });

/**
 * The body, up to `max` bytes. Review 0.22 (3rd round): past the limit (a chunked body has no
 * length to check first) reading stops without destroying the socket, so the 413 still reaches the
 * caller; the rest is let through unread and the connection closes after the answer.
 */
function readBody(req: Req, max: number): Promise<Uint8Array[]> {
  return new Promise((ok, no) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const done = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (c: Buffer | string) => {
      const chunk = typeof c === "string" ? new TextEncoder().encode(c) : (c as Uint8Array);
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      done();
      req.on("error", () => undefined);
      // Nothing more is kept. On a real connection the rest is let through and dropped (not
      // destroyed), so the 413 reaches the caller before the connection closes; a bare stream is
      // just left paused.
      if (req.socket) req.resume();
      else req.pause();
      no(tooLarge());
    };
    const onEnd = () => {
      done();
      ok(chunks);
    };
    const onError = (e: Error) => {
      done();
      no(e);
    };
    req.on("data", onData).on("end", onEnd).on("error", onError);
  });
}

/** The web `Request` a Node request stands for. Use it in `resolveUser` code shared with other hosts. */
export async function toWebRequest(req: Req, o: NodeHandlerOptions = {}): Promise<Request> {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwarded || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http");
  // Express removes the mount path from `url`; `originalUrl` still has it.
  const url = new URL(req.originalUrl ?? req.url ?? "/", o.origin ?? `${proto}://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  if (!o.trustProxy) {
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    const peer = req.socket?.remoteAddress;
    if (peer) headers.set("x-forwarded-for", peer.replace(/^::ffff:/, ""));
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const max = bodyLimit(method, url.pathname, o);
  let body: Uint8Array | string;
  if (req.body !== undefined && req.readableEnded) {
    // A body parser ran before us (express.json()): send what it read on.
    body = req.body instanceof Uint8Array ? req.body : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const size = typeof body === "string" ? new TextEncoder().encode(body).length : body.length;
    if (size > max) throw tooLarge();
  } else {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw tooLarge();
    const chunks = await readBody(req, max);
    const size = chunks.reduce((n, c) => n + c.length, 0);
    body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.length;
    }
  }
  headers.delete("content-length");
  return new Request(url, { method, headers, body: body as BodyInit });
}

/** Write a web `Response` to a Node response. */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  response.headers.forEach((v, k) => {
    if (k.toLowerCase() !== "set-cookie") res.setHeader(k, v);
  });
  if (cookies.length) res.setHeader("set-cookie", cookies);
  if (!response.body) return void res.end();
  // Stream it: an event stream never ends, and a big file should not sit in memory.
  // When the caller goes away the body is cancelled, which ends the stream on our side.
  const reader = response.body.getReader();
  let closed = false;
  const onClose = () => {
    closed = true;
    void reader.cancel().catch(() => undefined);
  };
  res.on("close", onClose);
  // A body that fails (an events stream dropping a client that does not read) ends the response at
  // once, even while a write waits for the socket to drain.
  let failed = false;
  let wake: (() => void) | null = null;
  void reader.closed.catch(() => {
    failed = true;
    wake?.();
  });
  try {
    res.flushHeaders?.();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!res.write(value))
        await new Promise<void>((ok) => {
          const fin = () => {
            res.off("drain", fin);
            res.off("close", fin);
            wake = null;
            ok();
          };
          wake = fin;
          res.once("drain", fin).once("close", fin);
          if (failed) fin();
        });
      if (failed) break;
    }
  } catch {
    failed = true;
  } finally {
    res.off("close", onClose);
    if (failed && !closed) res.destroy();
    else if (!closed) res.end();
  }
}

/** A `(req, res, next?)` function around a web handler such as `createCmsHandler(...)`. */
export function toNodeHandler(handler: (req: Request) => Response | Promise<Response>, o: NodeHandlerOptions = {}) {
  return async function nodeHandler(req: Req, res: ServerResponse, next?: (err?: unknown) => void): Promise<void> {
    try {
      await sendWebResponse(res, await handler(await toWebRequest(req, o)));
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 413) {
        if (res.headersSent) return void res.destroy();
        res.statusCode = 413;
        res.setHeader("content-type", "application/json; charset=utf-8");
        // The rest of the body is not read: this connection takes no further request.
        res.setHeader("connection", "close");
        return void res.end(JSON.stringify({ error: "body_too_large", kind: "invalid", message: "The request body is too large.", params: {} }));
      }
      if (next) return next(err);
      console.error("[agent-cms] request failed:", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };
}
