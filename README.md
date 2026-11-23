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
- **Admin screens you own.** `npx @mainsoft/agent-cms add cms-doc-list` copies the
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
npm i @mainsoft/agent-cms drizzle-orm zod
npx @mainsoft/agent-cms init
```

Peer dependencies: `drizzle-orm` and `zod` (`^3.25` or `^4`). `init` writes
`agent-cms.config.ts`, `lib/cms.ts`, the API route, a schema re-export and
`.env.example` lines, and never overwrites a file.

**Write the full name after `npx`.** The scope is part of the command:
`agent-cms` without `@mainsoft/` is another project's package on npm, so
leaving it out stops with `could not determine executable to run` in any
folder where this package is not installed (a monorepo root, an agent's
shell, a new project). With other package managers:

```
bunx @mainsoft/agent-cms init
pnpm dlx @mainsoft/agent-cms init     # or `pnpm exec agent-cms init` once it is installed
yarn agent-cms init                   # yarn 1 does not install peer dependencies: add drizzle-orm and zod yourself
```

pnpm 11 and later skip versions published in the last day by default
(`minimumReleaseAge`), so on the day of a release `pnpm add` gives you the
one before it.

## Set up

**1. Tables.** Re-export them from your Drizzle schema so drizzle-kit sees
them, or put the SQL in a migration:

```ts
export {
  cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit, cmsAssets, cmsAssetRefs, cmsComments, cmsReleases,
  cmsSavedFilters, cmsPresence, cmsJobs, cmsWebhooks, cmsWebhookDeliveries, cmsRecords, cmsChanges,
  cmsDocRefs, cmsAnchorAliases, cmsRedirects, // 0.21
} from "@mainsoft/agent-cms/tables";
```

```
npx @mainsoft/agent-cms migrate check   # what is missing, as SQL (exit 1 when behind)
npx @mainsoft/agent-cms migrate apply   # or run the idempotent DDL directly
npx @mainsoft/agent-cms doctor          # tables, columns, schema version, broken rows
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

**Content model (0.21).** Documents can point at each other, nest, be the one
document of a collection, start from templates and share snippets:

```ts
import { assetIds, defineSingle, relation } from "@mainsoft/agent-cms";

export const guides = defineCollection({
  slug: "guides", label: "Guides", visibility: "public",
  tree: { maxDepth: 3 },                    // parent and order; cms.move(), cms.tree()
  seo: true,                                // search title, description, share image, noindex
  templates: [{ key: "howto", label: "How-to", body: "## Before you start\n\n## Steps" }],
  fields: z.object({
    author: relation("people").optional(),                       // a document id
    related: relation(["guides", "faq"], { many: true, max: 5 }).optional(),
    photos: assetIds({ max: 12 }).optional(),                    // a gallery
  }),
  url: (d) => `/guides/${d.slug}`,
});
export const snippets = defineCollection({ slug: "snippets", label: "Snippets", visibility: "public", snippets: true });
export const site = defineSingle({ slug: "site", label: "Site", visibility: "public", fields: z.object({ name: z.string().default("Docs") }) });

createCms({ ..., redirects: true });        // published addresses may change; the old one redirects
```

`?expand=author` fills in related documents; deleting or hiding (archiving) a
document others point at answers `409 doc_referenced` until you pass `force`.
`[[snippet:key]]` in a body shows the published snippet to readers, on a line
of its own or, for a one-paragraph snippet, inside a sentence.
`cms.single(actor, "site")` returns the defaults until the first save.
`cms.seoFor(doc)` fills a page's head (and warns about a share image under
1200×630). `GET /sitemap.xml` lists published public documents (`noindex` left
out). New blocks: `:::steps`, `:::card`, `:::video` (YouTube and Vimeo, more
with `video: { hosts }`, only yours with `video: { hosts, defaults: false }`);
`## Title {#id}` pins an anchor. With redirects on, `cms.resolveRedirect(path)` answers your 404 page;
admins add redirects to an address or to a document (it follows the document's
current address) and see visits per day for 30 days. Details in
`UPGRADE-0.21.md`.

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

A write that rides on a person's session must come from a page of the app
itself: the handler compares the browser's `Origin` with the address of the
request (`Host`, or `X-Forwarded-Host` behind a proxy) and answers 403
`cross_site` otherwise. Requests with an API key are not checked. If the
admin lives at another address, list it:
`createCmsHandler({ ..., trustedOrigins: ["https://admin.example.com"] })`.

## Admin screens

The screens are source files you copy into your app and then own, like
shadcn/ui. They use your shadcn/ui parts (`components.json` decides where
they go and how imports are written) and talk to the CMS through
`createRestClient` from `./client`.

```
npx @mainsoft/agent-cms add --list
npx @mainsoft/agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command cms-media cms-files cms-trash cms-releases cms-webhooks cms-dashboard cms-automations cms-roles cms-transfer
npx @mainsoft/agent-cms add --diff      # what a new release would change in your copies
npx @mainsoft/agent-cms add --update    # update files you did not edit; yours get a .new copy
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

To serve them from your own site, write the registry from the installed version:
`npx @mainsoft/agent-cms registry build --base-url https://your.site/r` (into `public/r`).

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
| `cms-webhooks` | Webhooks: events and state, a test delivery, the signing secret, the delivery history with "Send again" (admins) |
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

### Long documents: section order, a preview that follows

- **Section order.** Above the text, "Section order" swaps the text box for
  one card per `##` section. Drag a card or use its arrows to move the whole
  section; the text before the first heading stays where it is. A card's
  title jumps back to that section in the text.
- **The preview follows the text.** Scrolling either side moves the other to
  the same block, and the block under the caret is brought into view.
- **Click the preview to find the line.** A click on a block in the preview
  selects its lines in the text (not on links, players or while selecting
  text). `MarkdownPreview` takes `onPickLines(line, endLine)` if you render
  the preview yourself, and `renderBlocks(blocks, components)` from
  `cms-parts` renders a block tree with your own components.
- The editor now fills the window's height and scrolls inside itself, so its
  header and its problems line stay in view. An app with its own top bar
  passes the height that is left: `<CmsDocEditor className="md:h-[calc(100dvh-4rem)]" />`.

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

**Cloudflare R2**, checked against a real bucket on 2026-11-20 (the same
contract test CI runs against an S3-compatible server): single and multipart
uploads from a browser, signed links, copy, list and the CORS rule all work.
Three things to know. Make the R2 key an **Object Read & Write** token limited
to that bucket. A public store needs the bucket's public address as
`publicUrl`: the `pub-….r2.dev` address or a custom domain (the S3 endpoint
itself never serves files without a signature). And set the CORS rule in the
dashboard (R2, the bucket, Settings, CORS policy) or with Cloudflare's API:
your site's origin and the methods `GET`, `HEAD`, `PUT`. `storage check`
tells you if it is missing.

**Vercel Blob** works the same way with its own adapter
(`npm install @vercel/blob`):

```ts
import { vercelBlobStorage } from "@mainsoft/agent-cms/storage-vercel-blob";

stores: {
  // `access` is how the Blob store was created. A private store is read through signed links only.
  public: { visibility: "public", adapter: vercelBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN!, access: "public" }) },
  private: { visibility: "private", adapter: vercelBlobStorage({ token: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN!, access: "private" }) },
}
```

The browser still sends the file straight to the storage, with a signed
address that holds it to the size it declared. What is different on Blob: a
file goes up in **one request** whatever its size, so there are no parts to
retry one by one and nothing to carry on after a reload (a failed upload
starts again; Vercel's own advice is parts above 100MB, and a 150MB file went
up in one request when we measured). Blob decides the stored type from the
file's extension, and there is no CORS rule to set. `storage check` says
"not supported on this store" for the parts step. Checked against real public
and private Blob stores with `@vercel/blob` 2.9.0.

**The bucket needs a CORS rule** that lets your site `PUT` to it. Add `media`
(the same object) to `agent-cms.config.ts` and run:

```
npx @mainsoft/agent-cms storage check --origin https://your-site.example
```

It uploads, reads, moves and deletes a test file in every store for real
(also in parts, also with a browser-style signed address), tests the CORS
rule, prints the rule to paste into the bucket, and lists what each store
accepts. `npx @mainsoft/agent-cms storage cleanup` removes uploads that were started
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
`asset` up in `files`. By default the CMS stores originals only and resizing
is your framework's or CDN's job, through `media.imageUrl`.

**Image sizes made by the CMS** are an optional module (`npm install sharp`,
Node runtime only; on the Edge runtime it fails when the app starts, with the
reason):

```ts
import { sharpTransforms } from "@mainsoft/agent-cms/image-sharp";

media: {
  stores: { … },
  transforms: sharpTransforms({
    presets: { thumb: { width: 480 }, card: { width: 800, height: 450, fit: "cover" }, full: { width: 1600 } },
    formats: ["webp"],            // webp (default), avif, jpeg, png
  }),
}

<img src={cms.imageUrl(cover, { size: "card" })} style={{ objectPosition: cover.focal ? `${cover.focal.x * 100}% ${cover.focal.y * 100}%` : undefined }} />
```

- Only the sizes you name exist: `/api/cms/files/<id>/<name>?size=card`.
  Another name answers 404 (`unknown_image_size`), so nobody can make your
  server resize to arbitrary numbers.
- A size is made the first time it is asked for and stored in the same store
  under `_cms/derived/`; after that the route redirects to the stored copy.
  Copies are deleted with the original and when it is replaced.
- Limits: 4096px on the long side, four at a time, ten seconds each, 40MB of
  input. Past a limit, or when sharp fails, the original is served instead.
  SVG and GIF are always served as they are. Nothing is enlarged.
- **Focal point.** In a file's panel, "Focal point" lets an editor click the
  part of a picture that must stay in view (arrow keys work too). `fit:
  "cover"` sizes are cropped around it, and `assetsFor` returns it as `focal:
  { x, y }` (0 to 1) for your own `object-position`. There is no crop editor:
  the original is never changed.
- With the module on, pictures an agent imports or the CLI uploads get their
  list thumbnail from the server (a browser makes its own).

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

**In the admin**, add the screen (`npx @mainsoft/agent-cms add cms-media`) and a page
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

- **Replace.** "Replace" in a file's panel puts new content at the same
  address: same id, same path, so documents need no edit. The new file must
  be the same type; it is checked like any upload before it takes the old
  one's place, and the old content cannot be brought back. Addresses the CMS
  hands out get `?v=<n>` so browsers fetch the new content; a CDN in front of
  a public bucket caches by its own rules. Needs the right to delete.
- **Camera data.** `media: { stripMetadata: true }` removes location, time
  and device data (Exif, XMP, IPTC, comments) from JPEG photos in the browser
  before they are sent, and on the server for imports. The picture itself,
  its colour profile and its orientation are kept. Off by default.
- **Carrying on after a reload.** A large upload is remembered in the
  browser's storage. Choosing the same file again within a day sends only the
  parts that are still missing. (Not on Vercel Blob, which has no parts.)

Agents get six more tools when the app has a media library: `list_assets`,
`get_asset` (read), `import_asset` (fetch an https address into the library;
addresses inside your network are refused), `update_asset` (write),
`move_asset` and `delete_asset` (publish). From a terminal:

```
npx @mainsoft/agent-cms upload ./hero.png ./talk.mp4 --folder launch --alt "The launch screen" --tag launch
```

### File manager

The media library shows the files the CMS knows. The file manager
(`npx @mainsoft/agent-cms add cms-files`, a page with `<CmsFiles />`) shows a bucket as
it is, folder by folder: files another program put there appear too. The
sidebar shows "Files" to whoever may look around a store (by default whoever
may read it; a store's `access.browse` narrows that).

- A file the CMS did not know gets a row when someone opens it, tags it,
  shares it or an agent registers it. From then on it works in documents like
  any other file. `npx @mainsoft/agent-cms storage sync [--store name] [--folder path]`
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

## Webhooks, background jobs, plugins

Other services learn what happened through **webhooks**: a signed POST when a document is published, a review is asked for, a file arrives. They are off until you set a key, and they are sent by the same cron call that runs scheduled publishing.

```ts
createCms({
  // ...
  cronSecret: process.env.CMS_CRON_SECRET,   // POST /api/cms/_cron with `Authorization: Bearer <secret>`
  secretsKey: process.env.CMS_SECRETS_KEY,   // 32+ characters: openssl rand -base64 32
});
```

Signing secrets are stored encrypted with `secretsKey` (AES-256-GCM). Changing the key makes the stored secrets unreadable, so keep it with your other long-lived secrets.

An admin makes a webhook in the admin (`cms-webhooks`) or with `POST /webhooks`: a name, an https address, which events, which collections. The signing secret is shown then and can be read again from the same screen.

**Events:** `doc.created`, `doc.updated`, `doc.published`, `doc.unpublished`, `doc.archived`, `doc.deleted`, `doc.restored`, `review.requested`, `review.approved`, `review.rejected`, `asset.uploaded`, `asset.moved`, `asset.deleted`, `release.published`, `comment.created`. No events checked means all of them.

**What is sent.** Never the document's text:

```json
{ "id": "…", "event": "doc.published", "at": "2026-11-21T03:00:00.000Z",
  "actor": { "kind": "user", "id": "u1", "label": "Kim", "agent": null },
  "collection": "posts", "slug": "launch", "version": 3, "url": "https://example.com/posts/launch" }
```

**The receiver** checks the signature (`X-CMS-Signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body">`, five minutes of tolerance). `verifyWebhook` has no Node imports, so it also runs on edge runtimes:

```ts
import { verifyWebhook } from "@mainsoft/agent-cms/webhooks";

export async function POST(req: Request) {
  const event = await verifyWebhook(req, process.env.CMS_WEBHOOK_SECRET!); // throws WebhookVerifyError
  if (event.event === "doc.published") revalidatePath(`/${event.collection}/${event.slug}`);
  return new Response("ok");
}
```

A delivery can arrive twice (the answer got lost, the CMS tried again): `event.id` is the same on every attempt.

**Delivery.** Nothing is sent inside the request that caused it. The event is written to a jobs table and goes out with the next cron call, so the delay is your cron interval. An answer outside 2xx, a redirect, or no answer in 10 seconds counts as a failure and is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours. After 20 failed deliveries in a row the webhook is switched off (the audit log says so, the screen shows why, "Turn on" starts it again). The history keeps 30 days and has "Send again".

**Addresses.** Only https addresses on the public internet: private, loopback and link-local addresses are refused when the webhook is saved and again before every delivery. `webhooks: { allowInsecure: true }` lifts this for local development only.

**Who.** Admins and keys with the `admin` scope. There is no agent tool that makes a webhook: an agent cannot open a way out for data by itself.

### Background jobs

Webhook deliveries are one kind of job. The same table runs your own:

```ts
cms.jobs.define<{ id: string }>("report.build", { retryAfter: [60, 600], run: async ({ id }) => build(id) });
await cms.jobs.enqueue("report.build", { id: "2026-11" }, { runAt: tomorrow });
```

`POST /_cron` runs scheduled publishing, then the jobs that are due (for about 20 seconds; the rest waits for the next call), then housekeeping. Two calls at the same moment never run the same job. Without a cron service, `npx @mainsoft/agent-cms cron --watch` calls it every 30 seconds (`AGENT_CMS_URL`, `AGENT_CMS_CRON_SECRET`). `GET /jobs?state=failed` lists what gave up, `POST /jobs/:id/retry` tries again, and `doctor` warns when there are any.

### Hooks, plugins, telemetry

**Collection hooks** run inside a write:

```ts
defineCollection({
  slug: "posts",
  hooks: {
    beforeChange: [({ content, prev }) => (prev ? undefined : { keywords: [...content.keywords, "new"] })], // return fields to change them
    beforePublish: [({ content }) => { if (!content.summary) throw new Error("Write a summary before publishing"); }],
    beforeDelete: [({ slug }) => { if (slug === "home") throw new Error("The home page cannot be deleted"); }],
    afterChange: [/* as before */],
  },
});
```

A hook that throws refuses the write with `hook_rejected` (422) and your message. `beforePublish` also runs for schedules, releases and approvals.

**Plugins** add to the CMS from another package:

```ts
import { definePlugin } from "@mainsoft/agent-cms";

export const stats = definePlugin({
  name: "stats",                                   // routes live under /api/cms/stats/
  sql: ['CREATE TABLE IF NOT EXISTS "stats_days" (…)'],   // collected in cms.plugins.sql for your migrations
  setup(ctx) {
    ctx.on("doc.published", (e) => ctx.enqueue("rollup", { slug: e.slug }));
    ctx.job("rollup", { run: async (p) => { /* … */ } });
    ctx.route("GET", "summary", ({ actor, cms }) => Response.json({ /* … */ }));   // actor is already checked
    ctx.tool({ name: "stats_summary", description: "…", input: z.object({}), run: () => ({ /* … */ }) });
    ctx.me((actor) => ({ canSee: actor.kind !== "anonymous" }));   // GET /_me → plugins.stats
    ctx.nav({ label: "Stats", href: "/admin/stats" });             // the admin sidebar shows it
  },
});
createCms({ /* … */, plugins: [stats] });
```

`ctx.secrets` seals values the plugin keeps in the database (null without `secretsKey`).

**Telemetry.** `createCms({ onEvent })` gets every request (`method`, `path`, `status`, `ms`, `actor`, `via`), every event, every job run, every cron call and every error the CMS reports. Connect it to your tracing; it is never awaited.

## Automations, roles, dashboard

From 0.13.0 (schema version 7). Coming from 0.12: [UPGRADE-0.13.md](./UPGRADE-0.13.md).

**Automations** are rules made on a screen (`cms-automations`): when a document is created, updated, published, unpublished or deleted, a review is asked for, a file is uploaded, or on a daily or weekly schedule; if the category, the author (person or agent), the title or a field matches; then send a webhook, add a keyword, set a field, put the document into a release, or call a function you named:

```ts
createCms({
  cronSecret: process.env.CRON_SECRET,
  automations: {
    actions: {
      notifySales: async ({ automation, doc }) => { /* … */ },
    },
  },
});
```

The work is a background job: it runs on the next `POST /_cron`, is written into history as "automation: <name>", and what it changes never starts another automation. `POST /automations/:id/test` (the "Try it" box) says what would happen to one document and changes nothing.

**Roles** (`cms-roles`) say who may write, publish and delete in each collection. People are put into a role by the id your `resolveUser` returns; `createCms({ users: { search, get } })` lets the screen find them by name. A collection's own `access` functions are asked first and show as "Set in code". Without any role the CMS behaves as before.

**The dashboard** (`cms-dashboard`, `GET /_stats?days=7|14|30`) shows documents by state, changes per day by people and by agents, the most read documents and recent activity, for the collections the caller may read.

## Limits, key rotation, retention, events

From 0.14.0. Coming from 0.13: [UPGRADE-0.14.md](./UPGRADE-0.14.md).

```ts
createCms({
  rateLimit: { perMinute: 600, anonymousPerMinute: 120 },          // 429 rate_limited + Retry-After
  retention: { auditDays: 365, hitsDays: 400, revokedKeysDays: 90 }, // applied by the cron call, once a day
});
```

- A key can have its own limit and the addresses it may be used from: `createKey({ rateLimit: 60, allowedIps: ["203.0.113.0/24"] })`.
- `POST /keys/:id/rotate` gives a key a new secret; the old one keeps working for an hour (`graceMinutes`).
- `npx @mainsoft/agent-cms retention --dry-run` counts what retention would delete.
- `GET /api/cms/_events` is a Server-Sent Events stream of what happens: `new EventSource("/api/cms/_events?collections=posts")`. Readers hear what goes public, writers hear every save, and a reconnect gets a `resync` of what it missed. The stream is fed by the server process that answers it.
- Collection hooks: `beforeValidate`, `beforeChange`, `beforePublish`, `beforeDelete`, `afterChange`, `afterPublish`, `afterDelete`, `afterRead`.

## Several servers, caching, sites (0.17)

Every change goes to a numbered change log (`cms_changes`); each server follows it, so the events stream, a read cache (`cache: memoryCache()`) and search hear what any server did. Lists are paged in the database. `@mainsoft/agent-cms/db` connects pg, postgres.js, Neon or PGlite; `@mainsoft/agent-cms/tenants` gives each site its own Postgres schema; the core runs on Edge runtimes; `/metrics` speaks Prometheus. Single fields can be hidden or locked per reader (`fieldAccess`). See the [guide](https://agent-cms-docs.vercel.app/docs/scaling) and [UPGRADE-0.17.md](UPGRADE-0.17.md).

## Languages (0.22)

```ts
const cms = createCms({
  locales: ["ko", "en", "ja"],          // off when left out
  defaultLocale: "ko",                  // translations are made from this one (default: the first)
  collections: [
    defineCollection({
      slug: "guide",
      localized: true,
      url: (d) => `/${d.locale}/guide/${d.slug}`,
      fields: z.object({ subtitle: z.string(), sku: z.string(), order: z.number() }),  // text is translated, order is shared
      admin: { fields: { sku: { localized: false } } },                               // override either way
    }),
  ],
});

await cms.create(user, "guide", { slug: "start", title: "Getting started" }, { locale: "en" });  // starts from the Korean text
await cms.get(anon, "guide", "start", { locale: "en", fallback: true });  // Korean, with requestedLocale "en", until English is published
await cms.translations(user, "guide", "start");   // ko: source, en: current | outdated, ja: missing
await cms.sourceDiff(user, "guide", "start", "en"); // what changed in Korean since the English was aligned
await cms.markAligned(user, "guide", "start", "en"); // "matches the current Korean version"
```

A translation is a document of its own, with the source's address: its own versions, drafts, publishing, schedule and review. Title, summary, body, keywords, SEO and text fields are translated; everything else follows the source and is filled in when read (a different value sent to a translation answers `locale_field_shared`). Publishing the source again makes its translations `outdated` until they are updated and aligned.

REST: `?locale=` on every document route (and `&fallback=1` on reads), `GET|POST /collections/<c>/<slug>/_translations`, `POST …/_align`, `GET …/_source-diff?locale=`, `GET /search?locale=`. Agents: `locale` on the document tools and `list_translations`. The sitemap names every language with `hreflang`. Search takes one language at a time; Korean 2-grams only for Korean. Upgrading a big table: [UPGRADE-0.22.md](UPGRADE-0.22.md).

## Forms (0.22)

Contact forms, sign-ups, bug reports: built by admins on the Forms screen, shown on your page with one component, kept in your database.

```ts
createCms({ forms: true, media: { stores: { private: { visibility: "private", adapter } } } });
```

```tsx
// npx @mainsoft/agent-cms add cms-form
import { CmsForm } from "@/components/cms/cms-form";
<CmsForm slug="contact" />
```

- **Fields**: short and long text, e-mail, number, choice, several choices, checkbox, date and file; required, help, limits, a pattern; steps with a progress bar; `showIf` on an earlier field (is, is not, one of, has, empty, filled). The browser and the server run the same checks (`checkSubmission` from `@mainsoft/agent-cms/client`), and the server drops the values of fields a condition hides.
- **Files** go through a one-time upload grant into a private store; admins open them with a five-minute link.
- **Spam**: a hidden field sends bots to Spam without telling them; 5 submissions a minute per address, then 429; `forms.verify(req)` for a captcha.
- **Submissions**: received, spam and archived, search, bulk actions and CSV export (formulas made harmless) on the admin screen and over REST (`/forms/:slug/submissions`, `/forms/:slug/export.csv`).
- **After a submission**: the `form.submitted` event (webhooks, automations) carries ids and field names, not values; `forms.notify` is where your app sends an e-mail.
- **Privacy**: addresses are kept as a hash, `retention.submissionsDays` (365 by default) deletes old submissions with their files, and agents get no tools for submissions. See [UPGRADE-0.22.md](UPGRADE-0.22.md).

## Export, import, OpenAPI

```
npx @mainsoft/agent-cms export ./content --drafts --with-files   # collection/slug.md, _meta.json, _assets/
npx @mainsoft/agent-cms import ./content --dry-run --diff        # says what would change
npx @mainsoft/agent-cms import ./content --on-conflict newest    # file-wins (default) | db-wins | newest
npx @mainsoft/agent-cms import ./wordpress.xml --from wordpress --collection posts --publish
npx @mainsoft/agent-cms import ./rows.csv --from csv --collection guide
npx @mainsoft/agent-cms openapi > openapi.json
```

An import never deletes and makes drafts (a document at the same address gets a new version); `--publish` publishes what was public where it came from. With `_assets/` in the folder the files are uploaded first and `asset:` references follow them. The admin screen `cms-transfer` moves the same files as one bundle. WordPress posts and pages come over with their HTML turned into markdown and their categories and tags as keywords.

`GET /api/cms/openapi.json` is the REST API as an OpenAPI 3.1 document, with a typed schema per collection the caller may read. Use it with a client generator, an API explorer, or as the action list of an agent that speaks OpenAPI.

For servers that speak Node's `(req, res)`:

```ts
import { toNodeHandler } from "@mainsoft/agent-cms/adapters/node";
app.use("/api/cms", toNodeHandler(createCmsHandler({ cms, resolveUser })));   // Express
```

## Block editor

`npx @mainsoft/agent-cms add cms-block-editor --yes` adds a Notion-style block editor and installs what it needs (Tiptap 3 / ProseMirror, MIT; nothing else in the admin or the package depends on it). Pass it as `slots.blockEditor`. Text can be selected, copied and undone across blocks, and input methods go through ProseMirror; the blocks, menus, drag and drop, and the markdown converter are agent-cms's own. The body is still stored as markdown: opening a document never changes it, untouched blocks keep their text, and what has no block of its own (HTML, page links) is drawn as it looks and edited as markdown in place. Type `/` for blocks or markdown shortcuts (`## `, `- `, `**bold**`); pasted images go to the media library. Blocks are moved the way Notion does it: drag the handle (Alt copies, Esc cancels, the page scrolls along), drop beside a block to make columns, into a toggle, or under a list item; draw a box from the margin to select; Tab nests list items; tables are edited cell by cell; the handle menu (⌘/) searches and turns several blocks at once. The editor is one column; the preview opens in its own window and follows every keystroke. The admin also has toasts with Undo, `?` for keyboard shortcuts, a local copy of unsaved edits, and bulk actions in media (move, tag, zip, delete).

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
npx @mainsoft/agent-cms collections
npx @mainsoft/agent-cms search "slack 연결" --collections guide
npx @mainsoft/agent-cms get posts hello-world --draft
npx @mainsoft/agent-cms put posts ./hello-world.md --publish --note "launch post"
npx @mainsoft/agent-cms patch posts hello-world ./ops.json --expected-version 3 --dry-run
npx @mainsoft/agent-cms call archive_document '{"collection":"posts","slug":"old","archived":true}'
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
