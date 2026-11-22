/**
 * Numbers for a dashboard (80, 0.17.0): count what the CMS reports through `onEvent` and print it
 * in the Prometheus text format (Grafana, Datadog, New Relic and most hosts read it).
 *
 *   const metrics = createMetrics();
 *   const cms = createCms({ ..., onEvent: metrics.onEvent });
 *   // Next.js: app/metrics/route.ts →  export const GET = () => new Response(metrics.text(), { headers: { "content-type": metrics.contentType } });
 *
 * The standalone server serves it on `/metrics` when `server.metrics` is set (a bearer token).
 * Paths are grouped (`/collections/:c/:slug`), so a crawler cannot make the series list grow
 * without end.
 */
import type { CmsTelemetry } from "./cms";

const KNOWN = new Set(["_me", "_events", "_changes", "_cron", "_stats", "_schema", "openapi.json", "keys", "assets", "files", "storage", "trash", "releases", "audit", "webhooks", "automations", "roles", "search", "grep", "raw", "auth", "users", "transfer", "export", "import", "mcp", "retention", "comments", "saved-filters", "plugins"]);
const KNOWN_SUB = new Set(["rotate", "upload", "complete", "move", "restore", "purge", "publish", "items", "deliveries", "test", "runs", "members", "invite", "resend", "sessions", "state", "login", "logout", "setup", "mfa", "reset", "passkey", "oidc", "me", "policy", "reauth", "_zip", "folders", "usage", "replace"]);
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}
const histogram = (): Histogram => ({ buckets: BUCKETS.map(() => 0), sum: 0, count: 0 });
function observe(h: Histogram, ms: number) {
  h.sum += ms;
  h.count++;
  for (let i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]) h.buckets[i]++;
}

/** `/collections/guide/hello/versions` → `/collections/:c/:slug/versions`. */
export function routeOf(path: string): string {
  const seg = path.split("?")[0].split("/").filter(Boolean);
  const base = seg.indexOf("collections");
  const s = base >= 0 ? seg.slice(base) : seg;
  if (s[0] === "collections") {
    const out = ["collections"];
    if (s[1]) out.push(":c");
    if (s[2]) out.push(":slug");
    if (s[3]) out.push(s[3].length <= 24 && /^[a-z_-]+$/.test(s[3]) ? s[3] : ":x");
    if (s[4]) out.push(":id");
    if (s[5]) out.push(s[5].length <= 24 && /^[a-z_-]+$/.test(s[5]) ? s[5] : ":x");
    return `/${out.join("/")}`;
  }
  // Other routes: a known first segment names it; everything after it is folded, so labels stay few.
  const first = s[0] ?? "";
  if (!KNOWN.has(first)) return first ? "/other" : "/";
  return `/${[first, ...s.slice(1, 3).map((x) => (KNOWN_SUB.has(x) ? x : ":id"))].join("/")}`;
}

export interface Metrics {
  /** Pass to `createCms({ onEvent })` (call your own handler from it too if you have one). */
  onEvent(e: CmsTelemetry): void;
  /** The Prometheus text format. */
  text(): string;
  contentType: string;
  /** Plain numbers, for a health page or tests. */
  snapshot(): { requests: number; errors: number; cacheHits: number; cacheMisses: number; searches: number; events: number };
}

export function createMetrics(o: { prefix?: string } = {}): Metrics {
  const p = o.prefix ?? "agent_cms_";
  const requests = new Map<string, number>();
  const durations = new Map<string, Histogram>();
  const events = new Map<string, number>();
  const errors = new Map<string, number>();
  const cache = new Map<string, number>();
  const search = histogram();
  let searchEmpty = 0;
  const index = histogram();
  let indexUnits = 0;
  const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const labels = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;

  return {
    contentType: "text/plain; version=0.0.4; charset=utf-8",
    onEvent(e) {
      switch (e.type) {
        case "request": {
          const route = routeOf(e.path);
          bump(requests, JSON.stringify([e.method, route, String(e.status), e.via ?? "app"]));
          const key = JSON.stringify([e.method, route]);
          const h = durations.get(key) ?? histogram();
          observe(h, e.ms);
          durations.set(key, h);
          break;
        }
        case "event":
          bump(events, JSON.stringify([e.event, e.collection ?? ""]));
          break;
        case "error":
          bump(errors, e.where);
          break;
        case "cache":
          bump(cache, JSON.stringify([e.collection, e.hit ? "hit" : "miss"]));
          break;
        case "search":
          observe(search, e.ms);
          if (!e.hits) searchEmpty++;
          break;
        case "index":
          observe(index, e.ms);
          indexUnits = e.units;
          break;
        default:
          break;
      }
    },
    text() {
      const out: string[] = [];
      const counter = (name: string, help: string, rows: [Record<string, string>, number][]) => {
        out.push(`# HELP ${p}${name} ${help}`, `# TYPE ${p}${name} counter`);
        for (const [l, v] of rows) out.push(`${p}${name}${Object.keys(l).length ? labels(l) : ""} ${v}`);
      };
      const hist = (name: string, help: string, rows: [Record<string, string>, Histogram][]) => {
        out.push(`# HELP ${p}${name} ${help}`, `# TYPE ${p}${name} histogram`);
        for (const [l, h] of rows) {
          BUCKETS.forEach((b, i) => out.push(`${p}${name}_bucket${labels({ ...l, le: String(b / 1000) })} ${h.buckets[i]}`));
          out.push(`${p}${name}_bucket${labels({ ...l, le: "+Inf" })} ${h.count}`);
          out.push(`${p}${name}_sum${Object.keys(l).length ? labels(l) : ""} ${(h.sum / 1000).toFixed(6)}`);
          out.push(`${p}${name}_count${Object.keys(l).length ? labels(l) : ""} ${h.count}`);
        }
      };
      counter("requests_total", "REST requests by method, route, status and source.", [...requests].map(([k, v]) => {
        const [method, route, status, via] = JSON.parse(k) as string[];
        return [{ method, route, status, via }, v];
      }));
      hist("request_duration_seconds", "REST request time.", [...durations].map(([k, h]) => {
        const [method, route] = JSON.parse(k) as string[];
        return [{ method, route }, h];
      }));
      counter("events_total", "Content events (saved, published, …) by event and collection.", [...events].map(([k, v]) => {
        const [event, collection] = JSON.parse(k) as string[];
        return [{ event, collection }, v];
      }));
      counter("errors_total", "Errors the CMS reported, by where they happened.", [...errors].map(([where, v]) => [{ where }, v]));
      counter("cache_total", "Read cache lookups by collection and result.", [...cache].map(([k, v]) => {
        const [collection, result] = JSON.parse(k) as string[];
        return [{ collection, result }, v];
      }));
      hist("search_duration_seconds", "Search time (including building the index when it is stale).", [[{}, search]]);
      counter("search_empty_total", "Searches that found nothing.", [[{}, searchEmpty]]);
      hist("index_build_seconds", "Building the search index.", [[{}, index]]);
      out.push(`# HELP ${p}index_units Passages in the search index.`, `# TYPE ${p}index_units gauge`, `${p}index_units ${indexUnits}`);
      return `${out.join("\n")}\n`;
    },
    snapshot() {
      const sum = (m: Map<string, number>, f: (k: string) => boolean = () => true) => [...m].filter(([k]) => f(k)).reduce((a, [, v]) => a + v, 0);
      return {
        requests: sum(requests),
        errors: sum(errors),
        cacheHits: sum(cache, (k) => k.endsWith('"hit"]')),
        cacheMisses: sum(cache, (k) => k.endsWith('"miss"]')),
        searches: search.count,
        events: sum(events),
      };
    },
  };
}
