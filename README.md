# agent-cms

An add-on CMS that runs **inside your existing web app**: no separate server,
no new database. People edit in an admin UI; AI agents read and edit the same
documents over REST and MCP; CI tells you when code changed under a doc.

First used for the 서비서 user guide (`/guide`), where the assistant answers
"how do I…" questions from these docs instead of guessing.

- **Collections over one table set.** Every collection lives in the same
  `cms_*` tables, so adding one needs no migration.
- **Versions.** Every save is a full snapshot. Drafts, publish, restore, and
  optimistic concurrency (`expectedVersion` → 409 instead of a silent overwrite).
- **Search built for agents.** In-memory, Korean-aware (particles and verb
  endings, 2-grams), returns *sections* rather than whole docs. Questions with
  no answer are logged as gaps.
- **API keys.** Stored as sha256 only, scopes `read` / `write` / `publish` /
  `admin`, optionally limited to collections. One key works for REST and MCP.
- **Docs that follow the code.** A document lists the files it `covers`. The
  CLI fails a PR that touches those files without updating the doc, and after
  deploy publishes the doc drafts written for that PR.

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

Peer dependencies: `drizzle-orm`, `zod`.

## Set up

**1. Tables.** Re-export them from your Drizzle schema, or run `cmsDdl`
(idempotent `CREATE TABLE IF NOT EXISTS …`) in your migration.

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsGaps, cmsHits, cmsMeta } from "@mainsoft-2024/agent-cms/tables";
```

**2. An instance.**

```ts
import { createCms, defineCollection, DrizzleRepo } from "@mainsoft-2024/agent-cms";
import { z } from "zod";

export const guide = defineCollection({
  slug: "guide",
  label: "Guide",
  coverage: true,                         // CI coverage + deploy-sync
  versions: { max: 100, drafts: true },   // edits wait for publish
  search: { enabled: true, gapLogging: true },
  fields: z.object({ order: z.number().default(100) }),
  access: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin },
});

export const cms = createCms({ repo: new DrizzleRepo(db), collections: [guide] });
```

**3. The route** (`app/api/cms/[...path]/route.ts`):

```ts
import { createCmsHandler } from "@mainsoft-2024/agent-cms/http";

const handler = createCmsHandler({ cms, basePath: "/api/cms", resolveUser });
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
```

That gives you REST under `/api/cms/...` and MCP at `/api/cms/mcp`.

## For agents

- **In your own agent:** `lookupForAgent(cms, actor, question)` from
  `@mainsoft-2024/agent-cms/agent` returns matching sections, resolved app
  links (`[[link:key|label]]` in Markdown) and the doc URL. Wrap it as a tool.
- **External coding agents:** give them a `write` key and the MCP URL
  (`https://<host>/api/cms/mcp`, header `Authorization: Bearer sgk_…`).

## CI

```
AGENT_CMS_URL=https://<host>/api/cms AGENT_CMS_KEY=sgk_… \
  npx agent-cms check-coverage --base origin/main --pr 123 --skip-token GUIDE-OK

AGENT_CMS_URL=… AGENT_CMS_KEY=sgk_… \
  npx agent-cms deploy-sync --from <before-sha> --to <sha>
```

Without the URL or key both commands print why and exit 0.

## Rendering

`@mainsoft-2024/agent-cms/markdown` is browser-safe: `parseMarkdown` gives a
small block tree (headings with stable anchors, lists, callouts `> [!tip]`,
code, tables, app-link rows) and `extractToc` a table of contents. Render it
with your own components.

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
