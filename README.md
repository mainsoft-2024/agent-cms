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
- **Agents are first-class editors.** One tool list, three ways in:
  - **MCP** at `/api/cms/mcp` for coding agents (Claude Code, Cursor, …),
    served with the official MCP SDK.
  - **CLI** (`agent-cms put notes/launch.md --publish`) for agents with a shell.
  - **REST** for everything else.

  The list itself is in `./tools` (`toolsFor`, `callTool`), so an agent
  running inside your app gets the same tools whatever framework runs it.
  This package never calls a model: the model, its key and the agent loop
  stay with you.
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

Used `./ai`? It is gone: read [UPGRADE-0.8.md](./UPGRADE-0.8.md).
Upgrading from 0.5? Read [UPGRADE-0.6.md](./UPGRADE-0.6.md) first (the
`cms_gaps` table needs moving before anything drops it). Changes are in
[CHANGELOG.md](./CHANGELOG.md).

## Install

```
npm i @mainsoft/agent-cms
npx agent-cms init
```

Peer dependencies: `drizzle-orm` and `zod` (`^3.25` or `^4`). `init` writes
`agent-cms.config.ts`, `lib/cms.ts`, the API route, a schema re-export and
`.env.example` lines, and never overwrites a file.

## Set up

**1. Tables.** Re-export them from your Drizzle schema so drizzle-kit sees
them, or put the SQL in a migration:

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit, cmsAssets, cmsAssetRefs } from "@mainsoft/agent-cms/tables";
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
npx agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command cms-media cms-files cms-trash cms-releases
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
| `cms-media` | The media library: stores and folders, grid or list, a file's alt text, tags and the documents that use it, uploads with progress, delete with a look at where the file is used |
| `cms-media-picker` | The "choose media" dialog behind image and file fields and the editor's "Insert media" (comes with `cms-doc-editor`) |
| `cms-files` | The file manager: a bucket folder by folder, also files nobody uploaded through the CMS; move, download, share links and delete for several at once |
| `cms-trash` | Deleted documents and files: restore, or delete forever (admins) |
| `cms-releases` | Releases: documents that go out together, the version of each, what blocks them, publish now or at a set time |
| `cms-preview-comments` | For your public page: the comments on a draft opened through a preview link, and a box for a guest to add one |
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

### Scheduling, review, comments, releases, trash

The editor, the list and two more screens (`cms-trash`, `cms-releases`) cover
the publishing flow. Nothing here needs set-up except the cron call.

- **Schedule.** The arrow beside "Publish" sets a time to publish and a time
  to unpublish, entered on the clock of `createCms({ timeZone })`. What goes
  out is the version that was current when it was scheduled; an edit after
  that shows a warning with "Schedule the latest version". Schedules run when
  something calls the cron route, so their precision is your cron's interval:

  ```ts
  createCms({ cronSecret: process.env.CMS_CRON_SECRET /* ... */ });
  // every minute or so: POST /api/cms/_cron   Authorization: Bearer <secret>
  ```

  The same call publishes scheduled releases and empties the trash of what is
  older than `trash.days`.
- **Review.** `defineCollection({ review: { agents: "required" } })` keeps what
  an API key or an agent wrote from going public until a person approves it;
  `everyone: "required"` asks the same of people, and the one who asked cannot
  approve. The editor shows the request with "Send back" and "Approve and
  publish"; the list has an "In review" tab.
- **Comments.** On a section or on selected text, with replies and resolve.
  They follow the text while it is edited, and move to "Lost their place" when
  the text is gone. A preview link made with "Allow comments" lets someone
  without an account comment: `readPreview(token)` returns `comments: true`
  for such a link, and `<CmsPreviewComments token={token} />` on your page
  (`add cms-preview-comments`, no provider needed) shows the box.
- **Paste.** Text copied from a web page or a document program is pasted as
  markdown (headings, lists, bold, links, tables, code); invisible characters
  and curly quotes are tidied. Colours and font sizes are left out, and the
  editor says so once.
- **Editing together.** Who else has the document open is shown in the editor
  and in the list, with their cursors in the body. When someone else saves,
  the editor takes the new version, merging it with unsaved edits when the
  two do not overlap. It asks every 15 seconds (every 3 while someone else is
  there); `presenceMs={0}` turns it off.
- **Releases.** Put documents in a release from the editor's menu or from the
  release screen; publishing is all or nothing and lists what blocked it.
- **Trash.** Deleted documents and files stay for 30 days
  (`createCms({ trash: { days } })`, `0` deletes at once). A restored document
  that was published is public again.
- **Versions** take a name and a pin (pinned versions are never cleaned up).
  **Saved filters** keep a tab, a search, a category and an author under a
  name, for yourself or (admins) for everyone.

## Media library

Documents can hold images, video and files. The files live in your own
storage bucket; the CMS keeps a row per file and hands the browser a signed
address, so uploads go straight to the storage and never through your app
server (which is why a 5GB video works on a serverless host). Without `media`
the feature is off and nothing changes.

```ts
import { s3Storage } from "@mainsoft/agent-cms/storage-s3";

const s3 = (bucket: string, publicUrl?: string) =>
  s3Storage({ bucket, region: "auto", endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET!, publicUrl });

export const cms = createCms({
  // …
  media: {
    stores: {
      // The first store is the default. `public`: anyone with the address can read.
      public: { label: "Public", visibility: "public", adapter: s3("site-media", "https://media.example.com") },
      // `private`: opened through the CMS after a permission check, with a link that works for 5 minutes.
      private: { label: "Private", visibility: "private", adapter: s3("site-private"), accept: ["application/pdf"], maxFileSize: 100 * 1024 ** 2 },
    },
    // accept: ["image/*", "video/*", ".pdf"],   // what every store takes; default below
    // maxFileSize: 5 * 1024 ** 3,               // default 5GB
    imageUrl: ({ url, width }) => `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=75`,
  },
});
```

`s3Storage` works with AWS S3 (leave `endpoint` out, set `region`),
Cloudflare R2 (`region: "auto"`, the account's S3 endpoint) and MinIO or any
other S3-compatible server. It signs requests itself (`aws4fetch`), so there
is no AWS SDK to install. Another kind of storage is a `StorageAdapter`
(`./storage`).

**The bucket needs a CORS rule** that lets your site `PUT` to it. Add `media`
(the same object) to `agent-cms.config.ts` and run:

```
npx agent-cms storage check --origin https://your-site.example
```

It uploads, reads, moves and deletes a test file in every store for real
(also in parts, also with a browser-style signed address), tests the CORS
rule, prints the rule to paste into the bucket, and lists what each store
accepts. `npx agent-cms storage cleanup` removes uploads that were started
and never finished (`doctor` tells you when there are any).

**What may be uploaded** is yours to decide, at three levels: `media.accept`
for the app, `stores.<name>.accept` for one store (replaces the app-wide
list), and `admin.fields.<field>.accept` for one field (narrows its store's
list). Entries are MIME types (`image/png`), groups (`image/*`) or
extensions (`.pdf`); `["*/*"]` takes anything. Unset, the default
(`DEFAULT_ACCEPT`) takes images, video, sound, PDF, office documents, plain
text and ZIP; web pages and programs only when you list them. `maxFileSize`
has the same three levels. The server checks the name and declared type when
an upload starts, and the first bytes of what actually arrived when it ends:
a web page named `photo.png` is deleted again (`asset_type_mismatch`).

**Your own check.** `media.scan` is called once for every file that arrives:
when a browser upload completes, when a file is imported or stored by the
server, and when a file that was already in the bucket gets registered. It
is where a virus scanner or a content policy goes:

```ts
media: {
  stores: { /* … */ },
  scan: async ({ url, bytes, name, mime, size }) => {
    // `url`: a signed address that works for 10 minutes. `bytes` instead when the CMS holds the file in memory.
    const verdict = await myScanner.check(url ?? bytes);
    return verdict.clean ? true : { ok: false, reason: verdict.name };
  },
},
```

A refused file is deleted from the storage and never becomes usable (a
registered one is left where it was); the caller gets `asset_rejected` and
the audit log has the reason. A check that throws refuses the file too.

**In a document** a file is named by its id, so moving or renaming it never
breaks a page:

```md
![The new dashboard](asset:8k2m4x9pq1zt/dashboard.png "Caption under the picture")

Read [the full report](asset:r7w2k9m4x1pa/report-2026.pdf).
```

An image line of its own is a media block (a picture, a video player or a
download card, by the file's type). `![alt](https://…)` shows an image from
elsewhere. For a field, use the `image` or `file` widget; the value is the
file's id:

```ts
import { assetId } from "@mainsoft/agent-cms";

fields: z.object({ cover: assetId().optional(), brochure: assetId().optional() }),
admin: { fields: { cover: { widget: "image" }, brochure: { widget: "file", accept: [".pdf"], maxFileSize: 20 * 1024 ** 2 } } },
media: { requireAlt: true },   // an image without alt text stops a save (default: a warning)
```

Saving checks the files a document names: one that does not exist or is the
wrong kind for its field is an error; a missing alt text or a private file
in a public document is a warning.

**On your page**, ask for the files a document uses and render the block
tree as before:

```ts
const doc = await cms.get(anon, "posts", slug);
const files = await cms.assetsFor(doc);        // { [id]: { url, width, height, alt, kind, mime, … } }
const cover = files[doc.fields.cover];
<img src={cms.imageUrl(cover, { width: 1200 })} width={cover.width} height={cover.height} alt={cover.alt} />
```

`parseMarkdown` gives `{ t: "media", asset, alt, caption }` blocks; look the
`asset` up in `files`. The CMS stores originals only. Resizing is your
framework's or CDN's job, through `media.imageUrl`.

**Who may do what.** Listing files and opening private ones: signed-in
people and keys. Uploading, importing, alt text, tags, new folders: admins
and keys with `write`. Moving, renaming and deleting: admins and keys with
`publish`. A store's `access: { read, write, delete }` replaces any of the
three. Deleting a file that documents use fails with `asset_in_use` and the
list of documents until the caller confirms. Uploads, moves and deletes are
in the audit log.

The file route is `GET /api/cms/files/<id>/<name>`: it checks permission and
redirects to the public address or to a short-lived signed one
(`media.linkTtlSeconds`, default 300). Set `media.filesUrl` when your handler
is not mounted at `/api/cms`.

**In the admin**, add the screen (`npx agent-cms add cms-media`) and a page
for it; the sidebar shows "Media" by itself when the app has a library:

```tsx
// app/admin/media/page.tsx
"use client";
import { CmsMedia } from "@/components/cms/cms-media";
export default function MediaPage() {
  return <CmsMedia />;
}
```

The browser sends files straight to the storage, four parts at a time for
large ones, tries a failed part again three times, and "Try again" sends only
what is still missing. It also makes a small picture of each image and video
(480px, WebP) for the library, and reads width, height and length.
"Import from URL" fetches a public https address into the open folder
(addresses inside your network are refused, as for agents), and the pencil
in a file's panel renames it; the extension stays, so the type cannot change.
`<CmsProvider slots={{ assetAlt }}>` lets an extension package put its own
control next to a file's alt text field.

Agents get six more tools when the app has a media library: `list_assets`,
`get_asset` (read), `import_asset` (fetch an https address into the library;
addresses inside your network are refused), `update_asset` (write),
`move_asset` and `delete_asset` (publish). From a terminal:

```
npx agent-cms upload ./hero.png ./talk.mp4 --folder launch --alt "The launch screen" --tag launch
```

### File manager

The media library shows the files the CMS knows. The file manager
(`npx agent-cms add cms-files`, a page with `<CmsFiles />`) shows a bucket as
it is, folder by folder: files another program put there appear too. The
sidebar shows "Files" to whoever may look around a store (by default whoever
may read it; a store's `access.browse` narrows that).

- A file the CMS did not know gets a row when someone opens it, tags it,
  shares it or an agent registers it. From then on it works in documents like
  any other file. `npx agent-cms storage sync [--store name] [--folder path]`
  registers everything at once and lists files the CMS knows that are gone
  from the bucket (it deletes nothing).
- Several files and whole folders can be moved or deleted at once (up to
  1000 objects per request). A move copies and deletes, one file after the
  other: files that fail are reported, and moving again takes the rest. A name
  that is taken at the destination gets a number; nothing is overwritten.
  Deleting shows the documents that use any of the files first.
- "Make a link" gives an address for someone outside. For a private store it
  works for 1 hour, 24 hours or 7 days and **cannot be taken back** (it is a
  signed address); for a public store it is the file's public address. Making
  one needs the permission to delete in that store, and is in the audit log.
- The CMS's own folder (`_cms/`, thumbnails) is hidden and cannot be touched.

Agents get three more tools: `list_store_files` (read), `register_asset`
(write) and `create_share_link` (publish).

## Agents

This package never calls a model. It has no model or key settings. It hands
your agent a list of tools; the model and the loop that drives it are yours.

### Your own agent

`toolsFor(cms, actor)` lists the tools this actor may use (name, description,
a zod schema for the input). `callTool` runs one. Wrap them in whatever your
agent framework calls a tool:

```ts
import { toolsFor, callTool } from "@mainsoft/agent-cms/tools";

const actor = { kind: "system", label: "assistant" } as const;

const tools = toolsFor(cms, actor).map((t) => ({
  name: t.name,
  description: t.description,
  input: t.input, // a zod object; toJsonSchema(t.input) from ./mcp gives JSON Schema
  run: (args: unknown) => callTool(cms, actor, t.name, args),
}));
```

`callTool(cms, actor, name, args, { only })` checks the input, runs the tool
with the actor's permissions, and records the call as made by an agent.
`toolsFor(cms, actor, only)` and the `only` option narrow the list.

From another process (a script, a scheduled job, another service), use a key:

```ts
import { createCmsClient } from "@mainsoft/agent-cms/client";
import { toolErrorResult } from "@mainsoft/agent-cms/tools";

const api = createCmsClient({ url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! });

const tools = await api.listTools(); // only what this key may use: { name, description, inputSchema }
const run = (name: string, args: Record<string, unknown>) =>
  api.call(name, args).catch((e) => toolErrorResult(e) ?? Promise.reject(e));
```

Tool errors come back as results, not throws, so the model can re-read and
retry: `{ error: "conflict_version", kind: "conflict", message, params: {
expected, current } }`. Every code is in `./errors` (`ERROR_CODES`).

| Tool | Needs |
|---|---|
| `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document` | read |
| `create_document`, `update_document`, `patch_document`, `diagnose_document`, `list_versions`, `restore_version` | write |
| `publish_document`, `unpublish_document`, `archive_document`, `delete_document`, `bulk_documents` | publish |
| `list_assets`, `get_asset` (with a media library) | read |
| `import_asset`, `update_asset` | write |
| `move_asset`, `delete_asset` | publish |
| `list_store_files` (the bucket as it is) | read |
| `register_asset` | write |
| `create_share_link` | publish |

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

For public docs that any agent may read without a key, turn on anonymous read:

```ts
createCmsHandler({ cms, resolveUser, mcp: { anonymous: "read" } });
```

A request without a key then gets the read tools only (`list_collections`,
`search_documents`, `read_for_answer`, `list_documents`, `get_document`) and
sees published documents of collections anyone may read. Write tools are not
listed and calling one fails with `unknown_tool`. Requests with a key work as
before. The default stays off (401 without a key).

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
code, link rows, media) and `extractToc` a table of contents. Render it with your
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
