/**
 * The CMS as a server of its own: the REST API, MCP and the prebuilt admin
 * (dist/admin) behind one Node HTTP server, with the CMS's own sign-in.
 *
 *   npx @mainsoft/agent-cms dev     a local CMS in a minute (no database needed)
 *   npx @mainsoft/agent-cms serve   production: the `server` part of agent-cms.config.ts
 *
 * Or from code:
 *
 *   import { startServer } from "@mainsoft/agent-cms/serve";
 *   await startServer({ cms, port: 3000 });
 *
 * What it adds around the handler: security headers (a strict Content
 * Security Policy for the admin), `GET /healthz`, cache headers for the
 * admin's files, a body size limit, the scheduler (publishing at a time,
 * webhooks, automations) every minute, and a graceful stop on SIGTERM
 * (requests in flight finish, up to 10 seconds).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "./crypto";
import { createMetrics } from "./metrics";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { toNodeHandler } from "./adapters/node";
import { createAuth, type AuthOptions } from "./auth/index";
import type { Cms } from "./cms";
import { createCmsHandler, type CmsHandlerOptions } from "./http";
import { VERSION } from "./version";

export interface ServeOptions {
  cms: Cms;
  /** Default 3000 (or `PORT`). */
  port?: number;
  /** Default "0.0.0.0" for `serve`, "127.0.0.1" for `dev`. */
  host?: string;
  /** Where the admin is. Default "/admin". */
  adminPath?: string;
  /** Where the REST API is. Default "/api/cms". */
  basePath?: string;
  /** Shown in the admin, mails and passkey prompts. Default "agent-cms". */
  appName?: string;
  /**
   * The CMS's own sign-in (default). Pass `false` with `resolveUser` to sign
   * people in yourself.
   */
  auth?: Omit<AuthOptions, "cms" | "adminPath" | "basePath" | "appName"> | false;
  /** Your own sign-in instead of the CMS's (with `auth: false`). */
  resolveUser?: CmsHandlerOptions["resolveUser"];
  /** Where the site shows documents (`${publicUrl}/<collection>/<slug>`), for "View" links. */
  publicUrl?: string;
  /** Run the scheduler every minute. Default true. */
  cron?: boolean;
  /** Largest request body. Default 8 MB (uploads go straight to storage). */
  maxBodyBytes?: number;
  /** Lines the server prints (address, setup code). Default console.log. */
  log?: (line: string) => void;
  /** The built admin. Default: dist/admin next to this file. */
  adminDir?: string;
  /** Behind a proxy that sets X-Forwarded-For / -Proto. Default false. */
  trustProxy?: boolean;
  /**
   * Serve Prometheus numbers on `GET /metrics` for callers that send `Authorization: Bearer <this>`
   * (at least 16 characters). Default: no `/metrics`.
   */
  metricsToken?: string;
  /**
   * More origins the admin may connect to (its Content-Security-Policy `connect-src`), e.g.
   * `["https://uploads.example.com"]`. Storage origins come from each store (`browserOrigins`); this is
   * for anything else, or `["https:"]` to allow every https address on purpose.
   */
  connectSrc?: readonly string[];
}

export interface RunningServer {
  server: Server;
  url: string;
  stop(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function defaultAdminDir(): string {
  const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "admin"), join(here, "..", "dist", "admin")]) if (existsSync(join(p, "index.html"))) return p;
  return join(here, "admin");
}

/** Headers every answer gets. */
function baseHeaders(res: ServerResponse, https: boolean) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

export async function startServer(o: ServeOptions): Promise<RunningServer> {
  const log = o.log ?? ((l: string) => console.log(l));
  const adminPath = (o.adminPath ?? "/admin").replace(/\/+$/, "") || "/admin";
  const basePath = (o.basePath ?? "/api/cms").replace(/\/+$/, "");
  const appName = o.appName ?? "agent-cms";
  const port = o.port ?? (Number(process.env.PORT) || 3000);
  const host = o.host ?? "0.0.0.0";
  const auth = o.auth === false ? undefined : createAuth({ ...(o.auth || {}), cms: o.cms, adminPath, basePath, appName, log });
  const handler = createCmsHandler({ cms: o.cms, basePath, ...(auth ? { auth } : { resolveUser: o.resolveUser }) });
  // Review 0.22 (3rd round): the adapter knows the mount, so the 64 KB form limit holds on any basePath.
  const api = toNodeHandler(handler, { maxBodyBytes: o.maxBodyBytes ?? 8 * 1024 * 1024, trustProxy: o.trustProxy, basePath });

  // The admin: index.html with the settings and the hash of its one inline script in the policy.
  const dir = o.adminDir ?? defaultAdminDir();
  const hasAdmin = existsSync(join(dir, "index.html"));
  if (!hasAdmin) log(`[agent-cms] no admin build in ${dir}; serving the API only`);
  const settings = JSON.stringify({ basePath, adminPath, appName, publicUrl: o.publicUrl ?? null }).replace(/</g, "\\u003c");
  const page = hasAdmin
    ? readFileSync(join(dir, "index.html"), "utf8")
        .replace("<!--settings-->", `<script type="application/json" id="agent-cms-settings">${settings}</script>`)
        .replace(/<title>[^<]*<\/title>/, `<title>${appName.replace(/[<&]/g, "")}</title>`)
        .replace(/(href|src)="\.\//g, `$1="${adminPath}/`)
    : "";
  // Uploads go from the browser straight to the storage (signed URLs): the origins each store names,
  // plus `connectSrc`. A store that names none is not guessed at (no blanket `https:`): it is reported.
  const connect = [...new Set([...o.cms.assets.browserOrigins(), ...(o.connectSrc ?? [])])].filter((x) => /^[\w*.:/[\]-]+$/.test(x));
  const unknown = o.cms.assets.storesWithoutOrigins();
  if (hasAdmin && unknown.length && !o.connectSrc?.length)
    log(`[agent-cms] warning: storage ${unknown.map((n) => `"${n}"`).join(", ")} does not say which origins browsers upload to, so the admin's Content-Security-Policy blocks those uploads. Set media.stores.<name>.browserOrigins or server.connectSrc`);
  const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inline.join(" ")}`.trim(),
    // Inline styles: element positions (popovers, focal points) are set from script.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob: https: http:",
    "font-src 'self' data:",
    `connect-src 'self' ${connect.join(" ")}`.trim(),
    // The preview of HTML blocks runs in a sandboxed frame; embeds the HTML policy allows.
    "frame-src 'self' blob: https:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self' https:",
    "object-src 'none'",
  ].join("; ");

  function sendFile(res: ServerResponse, file: string, immutable: boolean) {
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "content-length": statSync(file).size });
    res.end(readFileSync(file));
  }

  if (o.metricsToken !== undefined && o.metricsToken.length < 16) throw new Error("[agent-cms] server.metricsToken must be at least 16 characters");
  const metrics = o.metricsToken ? createMetrics() : null;
  const unhear = metrics ? o.cms.onTelemetry(metrics.onEvent) : null;
  let stopping = false;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const https = req.headers["x-forwarded-proto"] === "https" && !!o.trustProxy;
    baseHeaders(res, https);
    if (stopping) res.setHeader("Connection", "close");
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (path === "/healthz" || path === "/readyz") {
        const ok = !stopping;
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ ok, version: VERSION }));
      }
      if (path === "/metrics" && metrics) {
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
        if (!m || !timingSafeEqual(m[1], o.metricsToken!)) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "www-authenticate": "Bearer", "cache-control": "no-store" });
          return res.end("metrics need the token (server.metricsToken)\n");
        }
        res.writeHead(200, { "content-type": metrics.contentType, "cache-control": "no-store" });
        return res.end(metrics.text());
      }
      if (path === basePath || path.startsWith(`${basePath}/`)) return await api(req, res);
      if (path === "/" && hasAdmin) {
        res.writeHead(302, { location: adminPath });
        return res.end();
      }
      if ((path === adminPath || path.startsWith(`${adminPath}/`)) && hasAdmin) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { allow: "GET, HEAD" });
          return res.end();
        }
        const rel = path.slice(adminPath.length + 1);
        // Built files (with a hash in the name) are cached for a year; anything else is the app.
        if (rel && /^[\w.-]+\.(js|css|svg|png|ico|woff2)$/.test(rel)) {
          const file = normalize(join(dir, rel));
          if (file.startsWith(dir + sep) && existsSync(file)) return sendFile(res, file, /-[A-Za-z0-9_-]{8}\./.test(rel));
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("not found");
        }
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store", "content-security-policy": csp, "x-frame-options": "DENY" });
        return res.end(req.method === "HEAD" ? undefined : page);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: `Nothing at ${path}. The admin is at ${adminPath}, the API at ${basePath}.` }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal", message: "The server failed to answer" }));
      log(`[agent-cms] ${req.method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = `http://${shown}:${typeof addr === "object" && addr ? addr.port : port}`;
  log(`[agent-cms] ${appName} on ${url}${adminPath} (API ${url}${basePath}, health ${url}/healthz)`);
  // Wakes the sign-in so a fresh CMS prints its setup code right away.
  if (auth) void handler(new Request(`${url}${basePath}/auth/state`)).catch(() => undefined);

  // The scheduler: publishing at a time, webhook deliveries, automations, retention.
  const timer = o.cron === false ? null : setInterval(() => void o.cms.cron({ budgetMs: 20_000 }).catch((e: unknown) => log(`[agent-cms] scheduler: ${e instanceof Error ? e.message : String(e)}`)), 60_000);
  timer?.unref();

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => (server.closeAllConnections?.(), resolve()), 10_000);
      force.unref();
      server.close(() => (clearTimeout(force), resolve()));
      server.closeIdleConnections?.();
    });
    unhear?.();
    await o.cms.settle?.().catch(() => undefined);
  }
  return { server, url, stop };
}

/** Stops on SIGTERM / SIGINT after requests in flight finish. */
export function stopOnSignals(s: RunningServer, log: (l: string) => void = console.log): void {
  const on = (sig: string) => {
    log(`[agent-cms] ${sig}: finishing requests, then stopping`);
    void s.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => on("SIGTERM"));
  process.once("SIGINT", () => on("SIGINT"));
}
