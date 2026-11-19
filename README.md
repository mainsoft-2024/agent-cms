# agent-cms

An add-on CMS that runs **inside your existing web app**: no separate server,
no new database. People edit in an admin UI; AI agents read and write the same
documents through tools. Use it for anything a CMS is for: a blog, release
notes, a help center, internal docs, a notice board.

- **Collections over one table set.** Every collection lives in the same
  `cms_*` tables, so adding one needs no migration. Typed per-collection
  `fields` (zod), categories, slugs, house-style checks.
- **Versions.** Every save is a full snapshot. Drafts, publish, unpublish,
  archive, restore. Two writers never overwrite each other: a stale save is a
  conflict (409) that carries the other person's copy, and the admin screen
  merges the two line by line.
- **Agents are first-class editors.** One tool list, four ways in:
  - **AI SDK tools** (`./ai`) for your own agent: `cmsTools(cms, actor)`
    in-process, or `remoteCmsTools({ url, key })` against another app. They
    are plain AI SDK `Tool`s, so they also work unchanged with anything built
    on the AI SDK, such as slash-agent-sdk.
  - **MCP** at `/api/cms/mcp` for coding agents (Claude Code, Cursor, …),
    served with the official MCP SDK.
  - **CLI** (`agent-cms put notes/launch.md --publish`) for agents with a shell.
  - **REST** for everything else.
  Agents change one section at a time (`patch_document`), check a draft
  before saving (`diagnose_document`), and people review what agents changed
  block by block.
- **Search built for answering.** In-memory, Korean-aware (particles, verb
  endings, 2-grams), returns *sections* with citation ids
  (`cms://guide/slack#connect`) rather than whole documents. Searches that
  found nothing are passed to your app through `onSearchMiss`; storing them is
  up to the app.
- **Admin screens you own.** `npx agent-cms add cms-doc-list` copies the
  screens (list, editor with split preview, merge, versions, API keys, audit
  log, ⌘K) into your app, built on your own shadcn/ui parts.
- **Safe defaults.** Every collection says whether it is `public` or
  `internal`; API keys are stored as sha256 only, can expire, and are scoped
  (`read` / `write` / `publish` / `admin`, optionally per collection). Key
  changes, publishing, deletes and refusals go to an audit log.

> Design follows [Payload](https://payloadcms.com)'s collection, version and
> MCP shapes, written to run on Next.js 14+/React 18 and Postgres + Drizzle.

Upgrading from 0.5? Read [UPGRADE-0.6.md](./UPGRADE-0.6.md) first (the
`cms_gaps` table needs moving before anything drops it). Changes are in
[CHANGELOG.md](./CHANGELOG.md).

## Install

```
npm i @mainsoft/agent-cms
npx agent-cms init
```

Peer dependencies: `drizzle-orm`, `zod` (`^3.25` or `^4`), and `ai` (only for
`./ai`). `init` writes `agent-cms.config.ts`, `lib/cms.ts`, the API route,
a schema re-export and `.env.example` lines, and never overwrites a file.

## Set up

**1. Tables.** Re-export them from your Drizzle schema so drizzle-kit sees
them, or put the SQL in a migration:

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit } from "@mainsoft/agent-cms/tables";
```

```
npx agent-cms migrate check   # what is missing, as SQL (exit 1 when behind)
npx agent-cms migrate apply   # or run the idempotent DDL directly
npx agent-cms doctor          # tables, columns, schema version, broken rows
```

`cmsTables({ prefix: "blog_", schema: "content" })` gives a set with another
name prefix or Postgres schema; pass it to `new DrizzleRepo(db, { tables })`
and to `defineConfig({ tables })`. The CMS checks `cms_meta.schema_version`
on its first call and answers `schema_outdated` (503) with the command to run
when the database is behind.

**2. An instance.**

```ts
import { createCms, defineCollection, DrizzleRepo } from "@mainsoft/agent-cms";
import { ko } from "@mainsoft/agent-cms/messages/ko";
import { z } from "zod";

export const posts = defineCollection({
  slug: "posts",
  label: "Blog",
  visibility: "public",                    // required: "public" or "internal"
  categories: ["News", "Engineering"],
  versions: { max: 100, drafts: true },    // edits wait for publish
  search: { enabled: true },
  fields: z.object({ cover: z.string().url().optional(), tags: z.array(z.string()).default([]) }),
  admin: { fields: { tags: { label: "Tags", widget: "tags" } } },
  url: (d) => `/blog/${d.slug}`,
  access: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin },
});

export const cms = createCms({
  repo: new DrizzleRepo(db),
  collections: [posts],
  timeZone: "Asia/Seoul",
  messages: ko,                                   // error messages (default English)
  previewSecret: process.env.CMS_PREVIEW_SECRET,  // draft preview links (32+ chars)
  onSearchMiss: (e) => saveMiss(e),               // your table, your rules
});
```

`internal` collections must say who may read them (`access.read`); the CMS
refuses to start otherwise, so nothing is public by accident.

`cms` is typed by its collections: `cms.get(actor, "posts", slug)` returns
`fields` as the zod output, and an unknown collection name is a compile
error. On `update`, `fields` is a JSON Merge Patch: keys you send replace,
`null` removes, the rest stay.

`timeZone` (default `UTC`) decides which calendar day a usage count lands on.
`afterChange` hooks and `cms.onChange` listeners get a second argument
`{ contentChanged }`: false when only a draft changed and the public copy is
the same (skip revalidating pages then).

`managed: true` makes a collection writable only by your app code (the
`system` actor): users and keys can read it but not change it. Use it when the
app wraps saves in rules of its own.

**3. The route** (`app/api/cms/[...path]/route.ts`):

```ts
import { createCmsHandler } from "@mainsoft/agent-cms/http";

const handler = createCmsHandler({ cms, basePath: "/api/cms", resolveUser });
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
```

That gives you REST under `/api/cms/...` (route list at the top of
`src/http.ts`) and MCP at `/api/cms/mcp`. A document GET sends
`ETag: "v<n>"`; send it back as `If-Match` on PATCH/DELETE (or pass
`expectedVersion`). `requireIfMatch: true` refuses writes without one (428).

## Admin screens

The screens are source files you copy into your app and then own, like
shadcn/ui. They use your shadcn/ui parts (`components.json` decides where
they go and how imports are written) and talk to the CMS through
`createRestClient` from `./client`.

```
npx agent-cms add --list
npx agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command
npx agent-cms add --diff      # what a new release would change in your copies
npx agent-cms add --update    # update files you did not edit; yours get a .new copy
```

Missing shadcn parts are listed with the `npx shadcn add …` line to run
(`--yes` runs it). `agent-cms.json` records what was copied.

The same screens install with the shadcn CLI, from any host that serves the
registry (`npm run build:registry -- --base-url <url> --out <dir>` writes it).
Files go to `<components>/cms/`; the shadcn parts and the screens an item
needs come along:

```
npx shadcn@latest add <registry-url>/cms-doc-editor.json
```

`agent-cms add --diff` and `--update` only know about copies made with
`agent-cms add`.

| Item | What it is |
|---|---|
| `cms-shell` | Sidebar with collections, API keys and audit log, plus an `extraNav` slot for your own screens; a sheet menu on phones |
| `cms-doc-list` | State tabs (draft, published, modified since publish, hidden), filters, 7-day views, bulk publish / unpublish / hide / unhide / delete with a confirm and a result list; long-press to select on phones |
| `cms-doc-editor` | Fields form generated from the collection's zod schema, markdown with split preview, autosave and restore, problems list, agent change blocks (accept, revert, accept all), public link, draft preview link |
| `cms-merge` | When someone saved first: what merged by itself, and for each overlap theirs / mine / both |
| `cms-versions` | History, side-by-side or unified diff, restore, publish an old version |
| `cms-keys` | Keys with expiry; the secret is shown once with MCP and CLI set-up |
| `cms-audit` | Who did what, filterable |
| `cms-command` | ⌘K to find any document, drafts included |
| `cms-empty` | Empty collection: new document, or how to write with an agent |

UI text is English by default; a Korean catalog ships with the screens.

### Agent changes, merges, previews, bulk actions

- **Agent changes.** Each body hunk an API key or your assistant saved is a
  review item until a person accepts it (`cms.reviewChanges`) or reverts it in
  the editor (saved as one version). `cms.agentChanges(actor, col, slug)` lists
  what is open.
- **Merge.** A 409 carries `current`; `mergeDocs(base, mine, theirs)` from
  `./diff` (browser-safe) merges the body by lines and the other values by
  field. "Both" puts theirs first, then mine.
- **Draft preview links.** With `previewSecret`, `cms.createPreviewLink(actor,
  col, slug, { ttl: "1h" | "24h" | "7d" })` signs a link to that exact
  version. Your public page renders it:

  ```ts
  const token = searchParams.cms_preview;
  const doc = token ? (await cms.readPreview(token)).doc : await cms.get(anon, "posts", slug);
  ```

  Links cannot be revoked one by one; rotating `previewSecret` revokes all.
- **Bulk.** `cms.bulk(actor, col, "publish" | "unpublish" | "archive" |
  "unarchive" | "delete", items)` runs each document on its own and returns
  `{ slug, ok, error? }` for each.

## Agents

### Your own agent (AI SDK, slash-agent-sdk)

```ts
import { streamText } from "ai";
import { cmsTools } from "@mainsoft/agent-cms/ai";

const result = streamText({
  model,
  tools: {
    ...myTools,
    // Every tool this actor may use; `only` and `prefix` narrow and rename.
    ...cmsTools(cms, { kind: "system", label: "assistant" }, { prefix: "cms_" }),
  },
  messages,
});
```

From another process (a script, a scheduled job, another service), use a key:

```ts
import { remoteCmsTools } from "@mainsoft/agent-cms/ai";

const tools = remoteCmsTools(
  { url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! },
  { only: ["search_documents", "get_document", "patch_document"] }
);
```

`await remoteCmsToolsFor(client, opts)` does the same but first asks the
server which tools the key may use (`tools/list`), so a read-only key is
offered read tools only.

Tool errors come back as results, not throws, so the model can re-read and
retry: `{ error: "conflict_version", kind: "conflict", message, params: {
expected, current } }`. Every code is in `./errors` (`ERROR_CODES`).

| Tool | Needs |
|---|---|
| `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document` | read |
| `create_document`, `update_document`, `patch_document`, `diagnose_document`, `list_versions`, `restore_version` | write |
| `publish_document`, `unpublish_document`, `archive_document`, `delete_document`, `bulk_documents` | publish |

`lookupForAgent(cms, actor, collections, question, { budget, countTokens })`
(`./agent`) is the answer-a-user helper behind `read_for_answer`: matching
sections with citation ids, resolved `[[link:key|label]]` links, the URL of
each section, whether a person or an agent wrote it, and `context`, the
sections wrapped in `<cms-document>` tags that tell the model the text is
reference, not instructions. With a budget and your tokenizer it packs
sections to fit. `verifyCitations(citations, lookup)` checks an answer's
citation ids and quotes.

### Search misses

```ts
createCms({
  onSearchMiss: async (e) => {
    // { query, normalized, collections, actor, source, at, nearest }
    if (e.actor.kind === "anonymous") return;
    await db.insert(searchMisses).values({ query: e.query, normalized: e.normalized, collection: e.collections[0] })
      .onConflictDoUpdate({ target: [searchMisses.collection, searchMisses.normalized], set: { count: sql`${searchMisses.count} + 1` } });
  },
});
```

It is called only when the caller asked (`search(..., { reportMiss: true })`,
`GET /search?miss=1`, `read_for_answer`), never awaited, and its errors go to
`onError`. `normalized` ignores particles and word order, so group by it.
`search_documents` (a duplicate check before writing) never reports.

### Coding agents (MCP)

Register `https://app.example.com/api/cms/mcp` with the header
`Authorization: Bearer sgk_…`. The key's scopes decide which tools it sees.
Published documents are also resources (`cms://<collection>/<slug>`), and
two prompts (`answer_from_cms`, `edit_document`) show the safe way to work.

### CLI

```
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx agent-cms collections
npx agent-cms search "slack 연결" --collections guide
npx agent-cms get posts hello-world --draft
npx agent-cms put posts ./hello-world.md --publish --note "launch post"
npx agent-cms patch posts hello-world ./ops.json --expected-version 3 --dry-run
npx agent-cms call archive_document '{"collection":"posts","slug":"old","archived":true}'
```

`put` creates the document. To update one that exists, pass the version you
read (`get <collection> <slug> --draft` shows it) as `--expected-version N`;
if someone saved since, `put` fails with a conflict instead of overwriting
their edit. `--force` skips that check. The file is markdown with
frontmatter; keys other than `slug`, `title`, `summary`, `category` and
`keywords` go into `fields`:

```
---
title: Hello, world
summary: Our first post
category: News
tags: [launch]
---
Body in **markdown**.
```

`--env <file>` reads `AGENT_CMS_URL` / `AGENT_CMS_KEY` from a file instead.

## Rendering

`@mainsoft/agent-cms/markdown` is browser-safe: `parseMarkdown` gives a
small block tree (headings with stable anchors, lists, callouts `> [!tip]`,
code, link rows) and `extractToc` a table of contents. Render it with your
own components.

## Develop

```
npm ci
npm run typecheck && npm test && npm run build
npm run test:db        # pglite, or a server with DATABASE_URL
npm run test:ui        # admin screens (jsdom, Testing Library, axe)
npm run test:e2e       # browser tests against examples/next (Playwright)
bash scripts/pack-smoke.sh   # install the packed tarball into a fresh app
npm run check:pack     # publint and arethetypeswrong
```

`examples/next` is a Next.js 14 app made with `init` and `add`, on pglite;
the browser tests run against it.

Release: bump `version` in `package.json`, push a `v<version>` tag; the
Publish workflow publishes it to npmjs.com with provenance.

`bash scripts/shadcn-smoke.sh` (`npm run test:shadcn`) builds the shadcn
registry, serves it locally and installs a screen into a fresh Next.js app
with `npx shadcn add`, then type-checks and builds that app.

The roadmap is in [TODO.md](./TODO.md).

## License

MIT
