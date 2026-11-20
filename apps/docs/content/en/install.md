---
title: Install
summary: Add the package, run init, and create the tables.
category: Get started
order: 2
---
## Install the package

```sh
npm i @mainsoft/agent-cms drizzle-orm zod
npx @mainsoft/agent-cms init
```

Peer dependencies: `drizzle-orm`, `zod` (`^3.25` or `^4`), nothing else. The package never calls a model, so there is no model library to install.

`init` writes `agent-cms.config.ts`, `lib/cms.ts`, the API route, a schema re-export and `.env.example` lines. It never overwrites a file.

### The full name, and other package managers

Write the full name after `npx`. The scope is part of the command: `agent-cms` without `@mainsoft/` is another project's package on npm, so leaving it out stops with `could not determine executable to run` in any folder where this package is not installed (a monorepo root, an agent's shell, a new project).

```sh
bunx @mainsoft/agent-cms init
pnpm dlx @mainsoft/agent-cms init     # or `pnpm exec agent-cms init` once it is installed
yarn agent-cms init                   # after `yarn add @mainsoft/agent-cms drizzle-orm zod`
```

Two things to know:

- **yarn 1** does not install peer dependencies by itself. Without `drizzle-orm` and `zod` the CLI stops and names the missing package.
- **pnpm 11 and later** skip versions published in the last day by default (`minimumReleaseAge`), so on the day of a release `pnpm add` gives you the one before it.

## Create the tables

Re-export the tables from your Drizzle schema so drizzle-kit sees them, or put the SQL in a migration:

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit } from "@mainsoft/agent-cms/tables";
```

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply
npx @mainsoft/agent-cms doctor
```

`migrate check` prints what is missing as SQL and exits with 1 when the database is behind. `migrate apply` runs the idempotent DDL. `doctor` checks tables, columns, the schema version and broken rows.

> [!note]
> The CMS checks `cms_meta.schema_version` on its first call. When the database is behind, it answers `schema_outdated` (503) with the command to run.

## Other table names

`cmsTables({ prefix: "blog_", schema: "content" })` gives a set with another prefix or Postgres schema. Pass it to `new DrizzleRepo(db, { tables })` and to `defineConfig({ tables })`.
