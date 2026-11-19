---
title: Install
summary: Add the package, run init, and create the tables.
category: Get started
order: 2
---
## Install the package

```sh
npm i @mainsoft/agent-cms drizzle-orm zod
npx agent-cms init
```

Peer dependencies: `drizzle-orm`, `zod` (`^3.25` or `^4`), and `ai` only if you use the AI SDK tools (`@mainsoft/agent-cms/ai`).

`init` writes `agent-cms.config.ts`, `lib/cms.ts`, the API route, a schema re-export and `.env.example` lines. It never overwrites a file.

## Create the tables

Re-export the tables from your Drizzle schema so drizzle-kit sees them, or put the SQL in a migration:

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit } from "@mainsoft/agent-cms/tables";
```

```sh
npx agent-cms migrate check
npx agent-cms migrate apply
npx agent-cms doctor
```

`migrate check` prints what is missing as SQL and exits with 1 when the database is behind. `migrate apply` runs the idempotent DDL. `doctor` checks tables, columns, the schema version and broken rows.

> [!note]
> The CMS checks `cms_meta.schema_version` on its first call. When the database is behind, it answers `schema_outdated` (503) with the command to run.

## Other table names

`cmsTables({ prefix: "blog_", schema: "content" })` gives a set with another prefix or Postgres schema. Pass it to `new DrizzleRepo(db, { tables })` and to `defineConfig({ tables })`.
