---
title: Several servers, caching and sites
summary: The change log carries events between servers; a read cache, paging in the database, drivers, Edge, several sites and metrics.
category: Guides
order: 16
---
Since 0.17.0 (schema 9) every change is written to a numbered **change log** (`cms_changes`). Each server follows it, so the events stream, the read cache and the search index hear what any server did.

## Following other servers

Nothing to set up: a server that has listeners (an open events stream, a cache) looks at the log every 2 seconds. To hear at once, give it a signal:

```ts
import { connectPostgres } from "@mainsoft/agent-cms/db";
import { memoryCache } from "@mainsoft/agent-cms/changes";

const { repo, signal } = await connectPostgres(process.env.DATABASE_URL!); // pg or postgres.js: LISTEN/NOTIFY
const cms = createCms({ repo, collections, cache: memoryCache({ max: 2000 }), changes: { signal, keepDays: 7 } });
```

On serverless hosts there is no long-lived listener: followers poll. Clients can poll too: `GET /api/cms/_changes?since=<last>` returns `{ changes, last, more, reset }`. `reset: true` means the log no longer reaches back that far: reload.

The events stream (`/_events`) uses the same numbers as message ids. A browser that reconnects sends its last id and gets the events it missed, in order. Since 0.18 the numbers are handed out in commit order (a short lock on the log at the end of each write), so a resume point never passes a change that is still committing; a custom repository says so with `changesInCommitOrder: true`, otherwise the CMS waits up to 15 seconds at a missing number.

## Read cache

`cache` takes `memoryCache()` or any store with `get(key)` and `set(key, value, ttlMs)` (Redis, Upstash, Next's cache). Readers' documents and lists are cached; editors never read from it. A publish, unpublish, archive, delete or restore empties the collection's entries at once on this server and within one poll elsewhere. Collections with their own `access.read` rule are not cached.

## Paging and indexes

Lists are filtered, sorted and cut in the database; the cursor is the last row (`k.…`), so a page never repeats or skips documents when new ones arrive. `doctor` checks the eleven indexes schema 9 adds and `doctor --fix` removes rows that point at nothing (versions, file uses and comments of documents that are gone).

## Drivers

`connectPostgres(url, { driver })`: `pg`, `postgres-js`, `neon-serverless` (WebSocket, transactions), `neon-http` (no transactions: each change runs as separate statements and version checks still prevent lost updates), `pglite` (`memory:` or a folder).

## Edge

The core and the REST handler need no Node built-ins: run them on Vercel Edge or Cloudflare Workers with a driver that works there (`neon-http`, `neon-serverless`). Webhooks need Node's crypto for their sealed secret (Workers: `nodejs_compat`).

Webhook addresses are checked against private networks before each delivery. Without `node:dns` (Edge) the name is resolved with DNS over HTTPS at `https://cloudflare-dns.com/dns-query`: the host names your webhooks call are sent there. Where that is not acceptable, run deliveries on Node, or keep webhooks off on Edge.

## Several sites

```ts
import { createTenantHandler, migrateTenant, tenantTables } from "@mainsoft/agent-cms/tenants";

export const handler = createTenantHandler({
  resolve: (req) => new URL(req.url).hostname.split(".")[0],
  create: async (site) => {
    await migrateTenant(db, site);
    const cms = createCms({ repo: new DrizzleRepo(db, { tables: tenantTables(site) }), collections });
    return createCmsHandler({ cms, resolveUser });
  },
});
```

Each site has its own Postgres schema (`tenant_<id>`), so no query can mix them up, and a site can be dumped or dropped on its own.

## Metrics

`server.metricsToken` (or `CMS_METRICS_TOKEN`) turns on `GET /metrics` on the standalone server (Prometheus text, bearer token). In your own app: `const m = createMetrics(); createCms({ onEvent: m.onEvent })` and serve `m.text()`. Paths are grouped (`/collections/:c/:slug`).

## Measuring

`npm run bench -- --docs 10000` in the repository times reads, lists, search, saves and publishes (PGlite, or `DATABASE_URL`).
