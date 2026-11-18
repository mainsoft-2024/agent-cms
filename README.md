# agent-cms

An add-on CMS that runs **inside your existing web app**: no separate server,
no new database. People edit in an admin UI; AI agents read and write the same
documents through tools. Use it for anything a CMS is for: a blog, release
notes, a help center, internal docs, a notice board.

- **Collections over one table set.** Every collection lives in the same
  `cms_*` tables, so adding one needs no migration. Typed per-collection
  `fields` (zod), categories, slugs, house-style checks.
- **Versions.** Every save is a full snapshot. Drafts, publish, unpublish,
  archive, restore. Two writers never overwrite each other: pass
  `expectedVersion` and a stale save is a conflict (409), not a silent loss.
- **Agents are first-class editors.** One tool list, three ways in:
  - **AI SDK tools** (`./ai`) for your own agent: `cmsTools(cms, actor)`
    in-process, or `remoteCmsTools({ url, key })` against another app. They
    are plain AI SDK `Tool`s, so they also work unchanged with anything built
    on the AI SDK, such as slash-agent-sdk.
  - **MCP** at `/api/cms/mcp` for coding agents (Claude Code, Cursor, …).
  - **CLI** (`agent-cms put notes/launch.md --publish`) for agents with a shell.
- **Search built for answering.** In-memory, Korean-aware (particles, verb
  endings, 2-grams), returns *sections* rather than whole documents, so an
  agent can quote the part that answers. Searches nothing answered are kept as
  "gaps": ideas for the next document.
- **API keys.** Stored as sha256 only, scopes `read` / `write` / `publish` /
  `admin`, optionally limited to some collections. One key works for REST,
  MCP, the remote tools and the CLI.

> Design follows [Payload](https://payloadcms.com)'s collection, version and
> MCP shapes, written to run on Next.js 14+/React 18 and Postgres + Drizzle.

## Install

Published to GitHub Packages:

```
# .npmrc
@mainsoft-2024:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```
npm i @mainsoft-2024/agent-cms
```

Peer dependencies: `drizzle-orm`, `zod`, and `ai` (only for `./ai`).

## Set up

**1. Tables.** Re-export them from your Drizzle schema, or run `cmsDdl()`
(idempotent `CREATE TABLE IF NOT EXISTS …`) in a migration.

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsGaps, cmsHits, cmsMeta } from "@mainsoft-2024/agent-cms/tables";
```

**2. An instance.**

```ts
import { createCms, defineCollection, DrizzleRepo } from "@mainsoft-2024/agent-cms";
import { z } from "zod";

export const posts = defineCollection({
  slug: "posts",
  label: "Blog",
  categories: ["News", "Engineering"],
  versions: { max: 100, drafts: true },   // edits wait for publish
  search: { enabled: true, gapLogging: true },
  fields: z.object({ cover: z.string().url().optional(), tags: z.array(z.string()).default([]) }),
  url: (d) => `/blog/${d.slug}`,
  access: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin },
});

export const cms = createCms({ repo: new DrizzleRepo(db), collections: [posts] });
```

`managed: true` makes a collection writable only by your app code (the
`system` actor): users and keys can read it but not change it. Use it when the
app wraps saves in rules of its own.

**3. The route** (`app/api/cms/[...path]/route.ts`):

```ts
import { createCmsHandler } from "@mainsoft-2024/agent-cms/http";

const handler = createCmsHandler({ cms, basePath: "/api/cms", resolveUser });
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
```

That gives you REST under `/api/cms/...` and MCP at `/api/cms/mcp`.

## Agents

### Your own agent (AI SDK, slash-agent-sdk)

```ts
import { streamText } from "ai";
import { cmsTools } from "@mainsoft-2024/agent-cms/ai";

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
import { remoteCmsTools } from "@mainsoft-2024/agent-cms/ai";

const tools = remoteCmsTools(
  { url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! },
  { only: ["search_documents", "get_document", "update_document"] }
);
```

Tool errors (a conflict, a missing permission) come back as
`{ error, message }` results, so the model can re-read and retry.

| Tool | Needs |
|---|---|
| `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document` | read |
| `create_document`, `update_document`, `list_versions`, `restore_version`, `list_gaps`, `resolve_gap` | write |
| `publish_document`, `unpublish_document`, `archive_document`, `delete_document` | publish |

`lookupForAgent(cms, actor, collections, question)` (`./agent`) is the
answer-a-user helper behind `read_for_answer`: matching sections, resolved
`[[link:key|label]]` links and the URL of each section.

### Coding agents (MCP)

Register `https://app.example.com/api/cms/mcp` with the header
`Authorization: Bearer sgk_…`. The key's scopes decide which tools it sees.

### CLI

```
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx agent-cms collections
npx agent-cms search "slack 연결" --collections guide
npx agent-cms get posts hello-world --draft
npx agent-cms put posts ./hello-world.md --publish --note "launch post"
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

`@mainsoft-2024/agent-cms/markdown` is browser-safe: `parseMarkdown` gives a
small block tree (headings with stable anchors, lists, callouts `> [!tip]`,
code, tables, link rows) and `extractToc` a table of contents. Render it with
your own components.

## Develop

```
npm ci
npm run typecheck && npm test && npm run build
```

Release: bump `version` in `package.json`, push a `v<version>` tag; the
Publish workflow pushes it to GitHub Packages.

The roadmap is in [TODO.md](./TODO.md).

## License

MIT
