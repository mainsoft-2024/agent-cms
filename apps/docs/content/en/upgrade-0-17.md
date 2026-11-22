---
title: Upgrading to 0.17
summary: Schema 9 adds the change log and indexes. Events reach every server; lists are paged in the database.
category: Upgrade
order: 10
---
**Schema 9**: one new table (`cms_changes`, the change log) and eleven indexes. Run

```sh
npx @mainsoft/agent-cms migrate check   # prints the SQL
npx @mainsoft/agent-cms migrate apply   # or run it yourself
```

The step is safe to run again (`IF NOT EXISTS`). On big tables, create the indexes `CONCURRENTLY` yourself first if writes must not wait. `npx @mainsoft/agent-cms doctor` reports any index that is still missing.

## What changes without you doing anything

- **Lists are paged in the database.** `cms.page()`, `GET /collections/<c>` and `list_documents` filter, sort and cut in SQL and page by the last row (cursor `k.…`). Old numeric cursors still work. `total` is still there.
- **Events reach every server.** Every event is written to the change log; the events stream (`/_events`) follows it, so a browser hears what any server did. Message ids are numbers in the log; a client that comes back gets exactly what it missed. The log keeps 7 days (`changes.keepDays`), pruned by the cron call.
- **The core no longer imports `node:crypto`.** It runs on Edge runtimes. Webhook secrets still need Node's crypto (Node, Bun, Deno, Workers with `nodejs_compat`).
- **Links like `/\host`** are no longer links (browsers read them as another site).
- **`afterRead` runs on list rows too** (`ctx.list` is true there).

## New, when you want it

| Option | What it does |
|---|---|
| `createCms({ cache: memoryCache() })` | Readers are served from a cache; publishing empties it here at once and on other servers within `changes.pollMs` |
| `createCms({ changes: { signal } })` | Other servers hear changes at once (`pgChangeSignal`, `postgresJsChangeSignal`), not on the next look (2 s) |
| `@mainsoft/agent-cms/db` | `connectPostgres(url)` with `pg`, `postgres`, `@neondatabase/serverless` (WebSocket or HTTP) or PGlite |
| `DrizzleRepo(db, { transactions: "auto" })` | Works on drivers without transactions (neon-http), with a warning |
| `@mainsoft/agent-cms/tenants` | Several sites in one app: a Postgres schema per site |
| `fieldAccess`, `fieldHooks`, `hooks.beforeRead` | Hide or lock single fields per reader; field hooks; refuse reads |
| Roles on media stores | A role can let people upload (`write`) and delete without being an admin |
| `slots.editorActions`, `editorPanel`, `fieldAddon` | Your buttons and panels in the document editor |
| `server.metricsToken` / `CMS_METRICS_TOKEN` | Prometheus numbers on `/metrics`; or `createMetrics()` with `onEvent` |
| `GET /_changes?since=` | Polling instead of the stream |
| `config.plugins` | `migrate` includes plugin tables |
| CLI | `doctor --fix`, `import --from notion`, `user create`, `user reset-link`, `npm run bench` |
