# Upgrading to agent-cms 0.6

0.6 changes a few contracts on purpose (0.x). Read the `cms_gaps` part first:
it is the one step where data could be lost if done in the wrong order.

## 1. `cms_gaps`: move it to your app before anything drops it

Questions people asked are your app's data, so 0.6 no longer stores them. The
library now only calls `onSearchMiss` when a search found nothing, and your app
decides what to keep.

> **Do not drop `cms_gaps` yet.** 0.6 never reads, writes or drops this table,
> and `agent-cms doctor` only reminds you it is there. Move the rows, check
> them, and drop the table yourself at the very end, if at all.

> **drizzle-kit warning.** If your schema re-exported `cmsGaps` and you delete
> that line, `drizzle-kit generate` / `push` will plan `DROP TABLE cms_gaps`.
> Until the rows are moved, keep a table with the same name in your own schema
> (the definition in step 3, named `cms_gaps`), or review the migration before
> applying it.

### Step 1. Copy the rows

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS app_search_misses (LIKE cms_gaps INCLUDING ALL);
INSERT INTO app_search_misses SELECT * FROM cms_gaps ON CONFLICT DO NOTHING;
SELECT (SELECT count(*) FROM cms_gaps) AS before, (SELECT count(*) FROM app_search_misses) AS after;
COMMIT;
```

`before` and `after` must match. (`src/db/drizzle.test.ts` runs this exact SQL
against a 0.5 database.)

### Step 2. Keep `cms_gaps` while you switch

Leave it in place until your screens read `app_search_misses`.

### Step 3. The table in your schema

```ts
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const searchMisses = pgTable(
  "app_search_misses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collection: text("collection").notNull(),
    kind: text("kind").notNull().default("no_result"),
    query: text("query").notNull(),
    normalized: text("normalized").notNull(),
    note: text("note"),
    documentSlug: text("document_slug"),
    count: integer("count").notNull().default(1),
    state: text("state").notNull().default("open"), // open | done | ignored
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ group: uniqueIndex("app_search_misses_group_idx").on(t.collection, t.kind, t.normalized) })
);
```

### Step 4. Keep collecting with `onSearchMiss`

This reproduces what 0.5 did (same question → `count + 1`, a closed question
asked again opens again), plus the filtering that is now yours to decide:

```ts
import { sql } from "drizzle-orm";

let today = "";
let todayCount = 0;

export const cms = createCms({
  // ...
  onSearchMiss: async (e) => {
    if (e.actor.kind === "anonymous") return;              // public search boxes stay out
    const day = e.at.slice(0, 10);
    if (day !== today) [today, todayCount] = [day, 0];
    if (++todayCount > 500) return;                         // a daily cap
    for (const collection of e.collections) {
      await db
        .insert(searchMisses)
        .values({ collection, kind: "no_result", query: e.query, normalized: e.normalized })
        .onConflictDoUpdate({
          target: [searchMisses.collection, searchMisses.kind, searchMisses.normalized],
          set: {
            count: sql`${searchMisses.count} + 1`,
            query: e.query,
            lastSeenAt: new Date(e.at),
            state: sql`case when ${searchMisses.state} = 'done' then 'open' else ${searchMisses.state} end`,
          },
        });
    }
  },
});
```

`onSearchMiss` is called only when the caller asked for it: `search(...,
{ reportMiss: true })` (was `logGap`), `GET /search?miss=1` (was `?log=1`),
`lookupForAgent(..., { reportMiss: true })` and the `read_for_answer` tool. It
is not awaited; its errors go to `onError(err, "onSearchMiss")`. `e.nearest`
holds the best results that scored too low.

### Step 5. Agents that reported gaps themselves

`POST /collections/:c/_gaps` is gone. If an agent should report "I could not
answer this", give it a tool of your own:

```ts
import { tool } from "ai";
import { z } from "zod";

const reportMiss = tool({
  description: "Report a question the CMS could not answer",
  inputSchema: z.object({ collection: z.string(), question: z.string() }),
  execute: async ({ collection, question }) => {
    await db.insert(searchMisses).values({ collection, kind: "reported", query: question, normalized: normalizeQuery(question) }).onConflictDoNothing();
    return { ok: true };
  },
});
```

(`normalizeQuery` is exported from the package root.)

### Step 6. Your screen

Show `app_search_misses` in your own admin, and link it from the CMS sidebar
with `extraNav` on `cms-shell`:

```tsx
<CmsShell extraNav={[{ label: "My app", items: [{ label: "Unanswered questions", href: "/admin/misses" }] }]} />
```

### Step 7 (optional, last). Drop the old table

Only after the rows are moved and nothing reads `cms_gaps`:

```sql
DROP TABLE cms_gaps;
```

## 2. Database

```
npx @mainsoft/agent-cms migrate check     # prints the SQL (new columns, cms_audit), exit 1 when behind
npx @mainsoft/agent-cms migrate apply     # or run it directly
npx @mainsoft/agent-cms doctor
```

New: `cms_documents.autosave`, `autosave_at`, `autosave_by`,
`autosave_base_version`, `republished_at`; `cms_versions.changed`,
`reviewed`; `cms_api_keys.expires_at`; `cms_hits.source` (the primary key
becomes `(document_id, day, source)`); tables `cms_meta` (if missing) and
`cms_audit`. All statements are `IF NOT EXISTS`. Until this runs, the CMS
answers `schema_outdated` (503) with the command to run.

If you re-export the tables for drizzle-kit, also add `cmsAudit` (and
`cmsMeta` if you did not have it), and remove `cmsGaps` only as described above.

`doctor` also lists 0.4-era columns nothing reads any more, with `DROP COLUMN`
lines you may run.

## 3. Code

1. **Collections need `visibility`.** `"public"` (published documents are
   readable by anyone unless `access.read` says otherwise) or `"internal"`
   (requires `access.read`). The CMS refuses to start without it.
2. **Error codes are finer.** `err.code` is now e.g. `invalid_slug`,
   `conflict_version`, `forbidden_write`, `key_expired`; the old coarse value
   is `err.kind` (`invalid`, `conflict`, `forbidden`, …). HTTP statuses are the
   same. Wire shape: `{ error, kind, message, params, diagnostics?, current? }`.
3. **Messages are English by default.** For Korean:
   `createCms({ messages: ko })` with
   `import { ko } from "@mainsoft/agent-cms/messages/ko"`.
4. **`update` treats `fields` as a JSON Merge Patch.** Keys you send replace,
   `null` removes, keys you leave out stay. (Before, `fields` replaced the
   whole object.)
5. **Gaps are gone:** `cmsGaps`, `CmsGap`, `cms.reportGap`, `cms.gaps`,
   `cms.setGapState`, REST `/_gaps`, tools `list_gaps` and `resolve_gap`,
   `search.gapLogging` (ignored with a warning). `logGap` → `reportMiss`,
   `?log=1` → `?miss=1` (the old names still work and warn once). A custom
   `CmsRepo` drops `upsertGap`, `listGaps`, `setGapState` and adds
   `setVersionReviewed`, `insertAudit`, `listAudit`, `getMeta`, `setMeta`;
   `addHits` takes a `source`; `insertKey` takes `expiresAt`.
6. **Peer `zod` is `^3.25 || ^4`** (the MCP SDK needs it).
7. **MCP answers in the SDK's format.** Tool names and inputs are unchanged
   (minus the gap tools; plus `patch_document`, `diagnose_document`,
   `bulk_documents`). Tool errors carry `structuredContent` with the error
   JSON.
8. **Restore notes** read `restored v3` (were Korean).

## New name on npmjs: `@mainsoft/agent-cms` (0.6.1)

From 0.6.1 the package is `@mainsoft/agent-cms` on npmjs.com, installable
without a token. `@mainsoft-2024/agent-cms` on GitHub Packages stays at 0.6.0
and gets no more releases.

1. Delete these lines from `.npmrc` (and the `GITHUB_TOKEN` you set for them
   in CI or Vercel, if nothing else uses it):

   ```
   @mainsoft-2024:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

2. Swap the package:

   ```
   npm uninstall @mainsoft-2024/agent-cms
   npm i @mainsoft/agent-cms@^0.6.1
   ```

3. Replace the import paths. Every entry point keeps its name, only the scope
   changes (`@mainsoft-2024/agent-cms/http` → `@mainsoft/agent-cms/http`):

   ```
   grep -rl "@mainsoft-2024/agent-cms" --include='*.ts' --include='*.tsx' --include='*.json' . \
     | grep -v node_modules | xargs sed -i 's#@mainsoft-2024/agent-cms#@mainsoft/agent-cms#g'
   ```

   Screens copied with `agent-cms add` import the package too; the same
   replacement covers them, or run `npx @mainsoft/agent-cms add --update`.

No other code changes.

## Checklist for servicer

- [ ] `.npmrc`: remove the GitHub Packages lines; `npm uninstall @mainsoft-2024/agent-cms`, `npm i @mainsoft/agent-cms@^0.6.1`; replace import paths (`@mainsoft-2024/agent-cms` → `@mainsoft/agent-cms`)
- [ ] `visibility` on the guide and notice collections (`public`), `messages: ko`
- [ ] Copy `cms_gaps` to `app_search_misses` (step 1), add the table (step 3)
- [ ] `onSearchMiss` writing to it (step 4); `logGap` → `reportMiss`
- [ ] Unanswered-questions screen in the app, linked via `extraNav` (step 6)
- [ ] `npx @mainsoft/agent-cms migrate check`, put the SQL in a migration, `doctor`
- [ ] Code that reads `err.code === "invalid"` / `"conflict"`: switch to `err.kind`
- [ ] Later, optionally: `DROP TABLE cms_gaps` (step 7)
