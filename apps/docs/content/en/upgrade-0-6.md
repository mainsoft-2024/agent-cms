---
title: Upgrade to 0.6 and 0.7
summary: What changed, what to run, and how to move cms_gaps before anything drops it.
category: Upgrade
order: 1
---
> [!warning]
> If you used 0.5 search gaps, copy `cms_gaps` into a table of your own **before** you change your schema. Removing `cmsGaps` from your Drizzle schema can make drizzle-kit generate a `DROP TABLE`.

## New package name

The package is now `@mainsoft/agent-cms` on npmjs.com. Remove the `@mainsoft-2024` lines from `.npmrc`, then:

```sh
npm uninstall @mainsoft-2024/agent-cms
npm i @mainsoft/agent-cms
```

Import paths change their scope only: `@mainsoft-2024/agent-cms/http` becomes `@mainsoft/agent-cms/http`. Copied screens: run `npx @mainsoft/agent-cms add --update`.

## Database

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply
```

0.6 adds columns and the `cms_audit` table. Until you run it, the CMS answers `schema_outdated` (503).

## Code

- Every collection needs `visibility: "public"` or `"internal"`; internal ones need `access.read`.
- Errors: `error` is now a fine code (`conflict_version`), the old value is in `kind`.
- `update` treats `fields` as a JSON Merge Patch (`null` removes a key).
- Gaps are gone from the library. Use `onSearchMiss` and your own table (see [Search](/docs/search)).
- Peer `zod` is `^3.25` or `^4`.

## Moving cms_gaps

1. Create your own table (for example `app_search_misses`).
2. Copy the rows with one `INSERT … SELECT` and compare the counts.
3. Keep `cms_gaps` while you switch; agent-cms never reads, writes or drops it, and `doctor` only warns.
4. Collect new misses with `onSearchMiss`.
5. Drop `cms_gaps` last, when you no longer need it.

The full SQL, the Drizzle table and an `onSearchMiss` upsert are in [UPGRADE-0.6.md](https://github.com/mainsoft-2024/agent-cms/blob/main/UPGRADE-0.6.md).

## 0.7

Nothing to change. `mcp: { anonymous: "read" }` is new and off by default.
