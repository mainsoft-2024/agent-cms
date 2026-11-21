# Changelog

## Unreleased (0.15.0, first part of the editing and media polish)

Agents edit documents the way coding agents edit code, HTML is kept exactly as written, and markdown grows tables, task lists, toggles, columns, italic and strike. **Schema 8** (one column: `cms_documents.body_format`); run `npx @mainsoft/agent-cms migrate apply` or the step in `migrate check`.

- **Documents as files for agents.** New tools `read_document` (numbered lines, `offset`/`limit`, `outline`), `grep_documents` (literal or regex, `collections`, `glob`, `context`, `output: lines|files|count`, stops early with `partial: true`), `edit_document` (exact `oldString` → `newString`, unique unless `replaceAll`, several edits as one version, all or none; "not found" answers name the closest lines), `write_document` (whole file; replacing needs `expectedVersion`) and `document_file_link` (10-minute GET/PUT link). Fields are frontmatter lines, so one edit can change body text, HTML and fields together; a bad field fails with its line number. REST: `POST /grep`, `GET …/:slug/read`, `GET|PUT …/:slug/file`, `POST …/:slug/edit`, `POST …/:slug/file-link`, `GET|PUT /raw/:token`.
- **CLI** `read`, `grep`, `edit`, `pull`, `push`, `status`: pull documents into files, edit them with any editor, push them back. An edit someone made in the CMS meanwhile is merged; when both changed the same lines the file gets git-style conflict markers and nothing is saved.
- **Suggestions.** `agentEdits: "suggest"` on a collection keeps edits by API keys and agents as suggestions (`GET …/:slug/suggestions`, `POST …/suggestions/:id/apply|reject`). A suggestion whose text changed since cannot be applied (`suggestion_stale`).
- **HTML blocks** (`:::html` … `:::`) and **HTML documents** (`body: { formats: ["markdown", "html"] }` on a collection, `format: "html"` on a document). HTML is stored as written and never stripped. Parts that would do nothing on the page (scripts, event handlers, script URLs, frames from other hosts, `style`) come back as `html_inert` warnings with their line. Adding or changing HTML needs the role permission `html` (admins have it; keys need the new `html` scope); HTML that runs (`:::html isolated` with `html.render: "isolated"`) needs `html_scripts`.
- **`@mainsoft/agent-cms/html`**: `sanitizeHtml` (allow-list; asset: addresses resolved), `isolatedHtml` (a page for `<iframe sandbox="allow-scripts">` with a height report), `markdownToHtml`, `bodyToSafeHtml`, `inspectHtml`. Tested against 35 XSS filter evasions.
- **Markdown**: `*italic*` / `_italic_`, `~~strike~~`, nesting inside bold, backslash escapes, hard line breaks, GFM tables with alignment, `- [ ]` task lists, ordered lists that start at any number, `:::toggle Title`, `:::columns` / `:::col`, unknown `:::name` blocks kept word for word. New `toMarkdown(blocks)` writes a tree back; every markdown file in this repository reads back the same (tested).
- **Publish checks**: `publishChecks` on a collection; an `error` stops publishing (`publish_check_failed`), and `POST …/:slug/checks` shows problems before publishing.
- The admin preview draws the new blocks; HTML blocks show in a sandboxed frame with what will not work listed under them. The example app and docs site render them too.
- **Korean screen text is 음슴체** across the admin and error messages (a test keeps it that way).

Not in this part yet (see `docs/roadmap/ab-polish-status.md`): the block editor (BlockNote), toasts and undo, editor slash menu and image paste, media multi-select and bulk actions, phone toolbar, the HTML-document conversion dialog.

## 0.14.0

Operations: request limits, key rotation, retention, more hooks, and a live stream of events. **No schema change.** See [UPGRADE-0.14.md](./UPGRADE-0.14.md).

- **Request limits.** `createCms({ rateLimit: { perMinute, anonymousPerMinute } })` counts requests per API key and, for callers with no key and no session, per address. A key can carry its own number (`createKey({ rateLimit: 60 })`). Over the limit the answer is 429 `rate_limited` with `Retry-After`. Counts live in the process; pass `rateLimit.store` (one `hit(bucket, ttlMs)` method) to share them between servers. Signed-in people are not counted.
- **Allowed addresses.** `createKey({ allowedIps: ["203.0.113.0/24", "2001:db8::/32"] })`: the key answers 403 `forbidden_ip` from anywhere else. `createCmsHandler({ clientIp })` says where the caller's address comes from (default: `X-Forwarded-For`, then `X-Real-IP`).
- **Key rotation.** `POST /keys/:id/rotate` (`cms.rotateKey`) makes a new secret with the same name, scopes, collections, expiry and limits. The old secret keeps working for `graceMinutes` (default 60), then stops. `DELETE /keys/:id?reason=` keeps a note with a revoked key.
- **Retention.** `createCms({ retention: { auditDays, hitsDays, revokedKeysDays, deliveriesDays } })`. The cron call applies it once a day. `POST /retention { dryRun: true }` and `npx @mainsoft/agent-cms retention --dry-run` count what would go and delete nothing. Documents, versions and the trash are not touched.
- **Hooks.** `beforeValidate` (change the input before it is checked: fill a slug, trim), `afterPublish`, `afterDelete`, and `afterRead` (shape or refuse what `get` returns for a reader).
- **Events stream.** `GET /_events` is a Server-Sent Events stream: `new EventSource("/api/cms/_events?collections=posts")`. A writer hears every save; a reader hears only what changes the public copy. A client that reconnects (`Last-Event-ID` or `?since=`) first gets one `resync` message listing what was saved while it was away. `cms.subscribe(fn)` is the same feed in code.
- **Screens.** `cms-keys`: "Rotate" on each key, "Requests per minute" and "Allowed addresses" in the form, and a rotated key says until when its old secret works. Update with `npx @mainsoft/agent-cms add --update`.
- **REST and CLI.** `/keys/:id/rotate`, `/retention`, `/_events`; `rateLimit` and `allowedIps` on `POST /keys`; CLI `retention [--dry-run]`. All of it is in `/openapi.json`.
- **Not in this release** (bundle 3 continues): the standalone server and its own login (101, 115, 122), multi-site, read cache, Notion import. See `docs/roadmap/3-integrations-and-ops.md`.

## 0.13.0

Integrations and operations, second part: automations, roles, a dashboard, import and export, an OpenAPI document. **Schema version 7** (one new table, `cms_records`; `npx @mainsoft/agent-cms migrate apply`). See [UPGRADE-0.13.md](./UPGRADE-0.13.md).

- **Automations.** "When this happens, and these conditions hold, do that", made on a screen. Nine triggers (a document is created, updated, published, unpublished or deleted; a review is asked for; a file is uploaded; every day; every Monday), conditions on the category, the author, the title or a field, and five actions: send a webhook, add a keyword, set a field, put the document into a release, call a function the app named in `createCms({ automations: { actions } })`. The work runs on the next cron call, is recorded as "automation: <name>", and never starts another automation. "Try it" says what would happen to one document without changing anything. 30 days of run history.
- **Roles.** Per collection: write, publish, delete, set on a screen; an admin role may do everything. People are found through `createCms({ users })` or added by id. A collection's `access` functions in code still win and show as "Set in code". An app without roles behaves as before. A role name can be used once (`name_taken`).
- **Dashboard.** `GET /_stats?days=7|14|30`: documents by state, changes per day split into people and agents, the most read documents, recent activity. A caller sees only the collections they may read.
- **Export and import.** Documents travel as markdown files with frontmatter (`guide/getting-started.md`), plus `_meta.json` and `_assets/manifest.json`. `GET /export`, `POST /import` (dry run, changed lines, three conflict policies, always drafts unless `publish`), CLI `export <dir>` and `import <dir>`, and `put <collection> <dir>`. `export --with-files` downloads the files the documents use; `import` uploads the ones the target lacks and points the documents at the new ids.
- **Import from somewhere else.** `import <file> --from json|csv|wordpress --collection <name>`: a JSON list, a CSV sheet, or a WordPress export file (posts and pages; HTML becomes markdown, categories and tags become keywords). `htmlToMarkdown`, `filesFromSource` and friends are exported.
- **OpenAPI.** `GET /openapi.json` and `npx @mainsoft/agent-cms openapi`: the REST API as an OpenAPI 3.1 document, with one typed schema per collection the caller may read. A test sends every documented route to the real handler, and checks that the handler knows no route the document lacks.
- **`@mainsoft/agent-cms/adapters/node`**: `toNodeHandler(handler)` for Express, Fastify, Koa and plain `node:http`.
- **Screens.** New `cms-dashboard`, `cms-automations`, `cms-roles`, `cms-transfer`. `cms-shell` shows Dashboard to everyone signed in, and Automations, Roles, Import and export to admins. Update with `npx @mainsoft/agent-cms add --update`, then `npx @mainsoft/agent-cms add cms-dashboard cms-automations cms-roles cms-transfer`.
- **REST.** `/automations…`, `/roles…`, `/_stats`, `/export`, `/import`, `/openapi.json`; `GET /_me` returns `dashboard`, `automations`, `roles`.
- **Not in this release** (bundle 3 continues): the standalone server with its own login, rate limits, retention rules, an events stream, Notion import, zip files in the import screen. They are listed in `docs/roadmap/3-integrations-and-ops.md`.

## 0.12.0

Integrations and operations, first part: background jobs, webhooks, hooks, plugins and telemetry. Schema version 6.

- **Background jobs.** A jobs table and `cms.jobs` (`define`, `enqueue`, `run`, `stats`, `list`, `retry`). `POST /_cron` now also runs the jobs that are due, for about 20 seconds per call; two calls at the same moment never run the same job. `npx @mainsoft/agent-cms cron [--watch]` calls it without a cron service. `doctor` warns about jobs that failed for good; `GET /jobs` and `POST /jobs/:id/retry` are for admins.
- **Webhooks.** A signed POST (`X-CMS-Signature`, HMAC-SHA256) for 15 events, filtered by event and collection, without the document's text. Retries after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours; switched off after 20 failures in a row; 30 days of history with "Send again"; a test delivery. Only https addresses on the public internet. Admins only, and no agent tool can make one. Needs `secretsKey`.
- **`@mainsoft/agent-cms/webhooks`**: `verifyWebhook(req, secret)` for the receiver. No Node imports.
- **`secretsKey`.** Values the CMS keeps and gives back (webhook signing secrets, what plugins seal) are stored with AES-256-GCM. `createSealer` is exported.
- **Collection hooks.** `beforeChange` (may change fields or refuse), `beforePublish` and `beforeDelete` (may refuse) next to `afterChange`. A hook that throws answers `hook_rejected` with its message.
- **Plugins.** `definePlugin({ name, sql, setup(ctx) })`: `ctx.on` (events), `ctx.route` (under `/api/cms/<name>/`, with the checked actor), `ctx.tool` (agent tools), `ctx.job` / `ctx.enqueue`, `ctx.me` (values in `GET /_me`), `ctx.nav` (admin menu), `ctx.secrets`.
- **Telemetry.** `createCms({ onEvent })` gets requests, events, job runs, cron calls and reported errors.
- **Screens.** New `cms-webhooks`. `cms-shell` shows "Webhooks" to admins when `secretsKey` is set, and the menu entries plugins add. `cms-messages` has the new strings (en, ko). Update with `npx @mainsoft/agent-cms add --update`, then `npx @mainsoft/agent-cms add cms-webhooks`.
- **REST.** `/webhooks…`, `/jobs…`, plugin routes; `GET /_me` returns `webhooks`, `nav`, `plugins`. The cron answer has a `jobs` field.
- **Not in this release** (bundle 3 continues): automation, the dashboard, OpenAPI, import and export, the roles screen, the standalone server. Hooks `beforeValidate` / `beforeRead` / `afterRead`, plugin tables run by `migrate`, and extension slots inside the editor are not built yet.

## 0.11.1

Commands and messages. The library, the schema and the REST API are the same as 0.11.0.

- **Fix (docs, CLI messages, screens):** every command is now written with the full package name: `npx @mainsoft/agent-cms init`. The name `agent-cms` without the scope belongs to another project on npm, so the short form only worked inside a folder where this package was installed. Anywhere else (a monorepo root, an agent's shell that has only `AGENT_CMS_URL` and a key, a new project) `npx`, `bunx` and `pnpm dlx` downloaded that other package and stopped with `could not determine executable to run`. Changed: the README, the upgrade notes, the docs site, the hints the CLI prints (`init`, `doctor`, `migrate`), the `command` of the `schema_outdated` error, and the commands shown by `cms-keys` (after making a key) and `cms-empty`.
- **Fix (CLI):** without `drizzle-orm` or `zod` installed (yarn 1 does not install peer dependencies; npm and pnpm can be set not to) every command ended in a Node stack trace, `--version` included. The CLI now names the missing package and how to add it, and `--version` answers by itself.
- **Screens:** `cms-keys` and `cms-empty` changed, one command each (`npx @mainsoft/agent-cms add --update`). The other screens are untouched: the comment on their first line still names the short form, which works inside your app, and changing it would have left a `.new` copy beside every screen you edited.
- **Docs:** the install page gives the command for bun, pnpm and yarn, and notes that pnpm 11 skips versions published in the last day by default, so on the day of a release `pnpm add` installs the one before it.

## 0.11.0

What was left of the media library and the editor. **Schema version 5** (three columns on `cms_assets`; `npx @mainsoft/agent-cms migrate apply`). See [UPGRADE-0.11.md](./UPGRADE-0.11.md).

- **New: Vercel Blob.** `vercelBlobStorage({ token, access })` from `@mainsoft/agent-cms/storage-vercel-blob` (`@vercel/blob` is an optional peer dependency). Browsers upload straight to Blob with a signed address that holds the file to its declared size; private stores are read through signed links. On this kind of store a file goes up in one request whatever its size, so there is no per-part retry and no carrying on after a reload; `storage check` and `_me.media.stores[].parts` say so. Checked against real public and private stores with `@vercel/blob` 2.9.0.
- **New: image sizes.** `media.transforms: sharpTransforms({ presets })` from `@mainsoft/agent-cms/image-sharp` (`sharp` is an optional peer dependency, Node only). Named sizes only, at `/files/<id>/<name>?size=card`, made on first request and kept under `_cms/derived/`; limits on side, input size, time and how many at once, with the original as the fallback. `cms.imageUrl(asset, { size })`. Pictures the server stores itself get a list thumbnail.
- **New: focal point.** Set on a picture in the file panel (mouse or arrow keys), through `PATCH /assets/:id { focal }` or the `update_asset` tool. `fit: "cover"` sizes are cropped around it and `assetsFor` returns `focal`.
- **New: replace a file at its address.** "Replace" in the file panel, `cms.assets.replace()`, or an upload request with `replace: <id>`. Same id and path, same type, checked before it takes the old content's place; `rev` counts replacements and the addresses the CMS hands out carry `?v=<rev>`. Audit action `asset.replace`.
- **New: `media.stripMetadata`.** JPEG photos lose their location, time and device data in the browser before they are sent (and on the server for imports). The picture, colour profile and orientation are kept.
- **New: uploads carry on after a reload.** Choosing the same file again within a day sends only the missing parts.
- **New (cms-doc-editor): section order.** Cards for the `##` sections, moved by dragging or with arrow buttons. New file `cms-body-tools.tsx` in the `cms-doc-editor` item.
- **New (cms-doc-editor): the preview follows the text** in both directions, and a click on a block in the preview selects its lines in the text. `MarkdownPreview` gained `components` and `onPickLines`; `cms-parts` exports `renderBlocks(blocks, components)`.
- **Changed (cms-doc-editor):** on wide screens the editor fills the window's height and scrolls inside itself (header and problems line stay in view). Pass `className` with the height that is left if your app has its own top bar.
- **Changed (`StorageAdapter`):** optional members `multipart` (set `false` when the storage has no parts), `settle(key, options)` (called once after a browser upload passed its checks) and `size` in the `presignPut` options. Existing adapters need no change.
- New errors: `asset_replace_type` (422), `unknown_image_size` (404).

## 0.10.2

- **Fix (REST):** a signed-in person's writes were refused with `cross_site` ("Cross-site request refused") whenever the app was reached through an address other than the one the server listens on: behind a reverse proxy or a preview tunnel, in a container, or simply by opening a `next start` server as `127.0.0.1` instead of `localhost`. The check compared the page's `Origin` only with `req.url`, which under `next start` holds the listening address. It now also reads the address from `Host` and `X-Forwarded-Host`, the way Next.js does for Server Actions. A page on another site still cannot change any of the three, so the protection is the same. Apps on Vercel were not affected.
- **New:** `createCmsHandler({ trustedOrigins: ["https://admin.example.com"] })` lets pages at other addresses write with a person's session, for an admin served from its own domain. The app's own address needs no entry.

## 0.10.1

- **Fix (cms-doc-editor):** saving or publishing a new document lost its confirmation line ("Saved v1", "Published v1") when the app answered `onCreated` by moving to the document's own address, which is what the examples do. The line now waits for the editor that opens next and shows there once. Update the copy with `npx @mainsoft/agent-cms add cms-doc-editor --update`.

## 0.10.0

The first npm release since 0.7.0. It contains 0.8.0 and 0.9.0 below, which were not published on their own: coming from 0.7.0, read [UPGRADE-0.8.md](./UPGRADE-0.8.md) first, then [UPGRADE-0.10.md](./UPGRADE-0.10.md).

The editing and publishing flow: its rules, REST routes, admin client, agent tools and screens. Read [UPGRADE-0.10.md](./UPGRADE-0.10.md): deletes now go to a trash, and the schema is version 4.

- **Scheduled publishing:** `cms.schedule(actor, col, slug, { publishAt, unpublishAt })`. What goes public is the version that was current when it was scheduled, not what the draft holds later. `cms.runScheduled()` does what is due; the `/_cron` route calls it and has its own secret (`createCms({ cronSecret })`, `Authorization: Bearer`). A version that no longer passes its checks is not published and the failure is in the audit log.
- **Trash:** a deleted document or file goes to the trash for 30 days (`createCms({ trash: { days } })`, `0` deletes at once). It is gone for readers, search and agents, keeps its address, and comes back as it was. `cms.trash.list / restore / purge`; purging is for admins; `runScheduled` empties what is older.
- **Review:** `defineCollection({ review: { agents: "required" } })` stops API keys and agents acting for a person from publishing a version nobody approved (`review_required`); `everyone: "required"` also stops people from approving their own request. `requestReview`, `approveReview` (publishes exactly the requested version), `rejectReview` (with a note), `reviewRequests`.
- **Comments:** threads on a section and a quoted piece of text, answers one level deep, resolve and reopen. Each thread says whether its text is still there. A preview link made with `comments: true` lets its holder read and write them without an account.
- **Releases:** documents that go out together, each pinned at a version. `cms.releases.publish` is one transaction: any blocked document stops all of it and the error lists what blocked. A release can be scheduled.
- **Versions:** a name and a pin (`labelVersion`); pinned versions are never pruned.
- **Saved filters**, **presence** (who has a document open, also agents while they save) and **`cms.preview`** (blocks with source lines, table of contents, problems and diff of unsaved text; `parseMarkdown(src, { lines: true })`).
- List states `scheduled` and `review`; `counts` has both.
- Agent tools (16 → 31, plus the file tools): `schedule_document`, `unschedule_document`, `request_review`, `list_review_requests`, `list_comments`, `add_comment`, `resolve_comment`, `list_trash`, `restore_from_trash`, `list_releases`, `create_release`, `add_to_release`, `publish_release`, `label_version`, `preview_document`. Approving a review is a person's job and has no tool.
- Schema version 4 (run `npx @mainsoft/agent-cms migrate apply`).

Screens (`npx @mainsoft/agent-cms add --update`, then `add cms-trash cms-releases`):

- **`cms-doc-editor`:** the publish button has a schedule panel (times on the clock of `createCms({ timeZone })`, which `GET /_me` now returns); strips under the header show a schedule, a review request ("Send back", "Approve and publish") and the release the document is in; a comments panel (a tab on phones) with marks on the commented text; who else has the document open, their cursors, and their saves merged into unsaved edits that do not overlap (`presenceMs`); "Add to a release"; "Allow comments" on preview links. The item has a second file, `cms-flow.tsx`.
- **`cms-doc-list`:** "Scheduled" and "In review" tabs and badges, who has a document open, saved filters. It needs the shadcn `label` part now.
- **`cms-trash`** (new) and **`cms-releases`** (new: `<CmsReleases>` and `<CmsRelease id>`); `cms-shell` links to both for people who can edit (`CmsShellTarget` has `releases` and `trash`).
- **`cms-versions`:** name a version, pin it, see who approved it. It needs the shadcn `dialog` and `input` parts now.
- Fix: on a phone the state tabs of `cms-doc-list` pushed the page sideways once there were seven of them. They now scroll inside their own row, and a tab you press comes fully into view.
- Korean copy picks the particle that fits a name ("김지수가", "docs-bot이"): `format()` reads `{who|이|가}`.
- **Paste clean-up** in the body: HTML from a web page, Google Docs or Word becomes markdown (headings, lists, bold, italic, links, tables, code, quotes, https images); zero-width characters, non-breaking spaces and curly quotes are tidied; a paste from a code editor stays plain text. No new dependency. Third file of the item: `cms-paste.ts`.
- **`cms-preview-comments`** (new): the comment box for guests on your public preview page.
- Not in this release: a CodeMirror editor (the body stays a text box, with a layer behind it for marks and cursors), section reordering, preview scroll sync, and a click in the preview that finds the line in the body.

## 0.9.0 (released as part of 0.10.0)

- **File manager:** `cms-files` shows a storage bucket as it is, folder by folder, also files nobody uploaded through the CMS. Move, download, share links and delete for several files and whole folders at once; opening a file shows the media library's panel. `cms-shell` shows "Files" to whoever may look around a store (`access.browse`, default: whoever may read it).
- A file the CMS did not know gets a row when it is opened, shared or registered (`cms.assets.register`), and then works in documents. `agent-cms storage sync` registers a whole bucket and lists rows whose file is gone.
- Share links: `cms.assets.share(actor, id, { ttl: "1h" | "24h" | "7d" })`. A private file's link is a signed address that cannot be taken back; a public file gives its public address. Needs the permission to delete in the store; audited as `asset.share`.
- REST: `GET /stores/:store/files`, `…/_open`, `POST …/_register`, `…/_move`, `…/_delete` (`check: true` only counts), `POST /assets/:id/share`. Agent tools (22 → 25 with a media library): `list_store_files`, `register_asset`, `create_share_link`.
- **Media library:** "Import from URL" in the header fetches a public https address into the open folder (the same guarded path as `import_asset`), and a file can be renamed in its panel (the extension is kept; documents keep working).
- `media.scan`: the app's own check of every file that arrives (a virus scanner, a content policy). A refused file is deleted and the caller gets `asset_rejected`; a check that throws refuses too.
- Fix: `cms-media` no longer uses `asChild` on a button, which exists only in the Radix flavour of shadcn/ui. Apps on the Base UI flavour failed to typecheck after `add cms-media`. Found by moving this project's own docs site to 0.8.
- The docs site (`apps/docs`) runs on this version: its copied screens are updated, it documents the media library, the file manager and the tools without `./ai`, and its gallery has a read-only media demo.
- No schema change.

## 0.8.0 (released as part of 0.10.0)

Read [UPGRADE-0.8.md](./UPGRADE-0.8.md). What comes next is in [docs/roadmap](./docs/roadmap/README.md).

- **Breaking: the `./ai` entry and the optional `ai` peer dependency are removed.** This package hands agents tools and never calls a model, and it no longer depends on a library that does. MCP, REST, the CLI and `./tools` are unchanged. A test keeps model libraries out of the sources and the dependencies.
- **`callTool`, `runTool`, `toolErrorResult`** in `./tools`: run a tool by name as an actor, with CMS errors returned as results. Together with `toolsFor` this is the way to give the tools to an agent in your app, whatever framework runs it. MCP runs tools through the same path.
- **An agent acting for a person:** `{ kind: "user", …, agent: { label } }`. Same permissions as the person; versions, the document and the audit log record the agent's name, and its edits are listed under "Agent changes". Requests cannot set it. The admin shows such authors as "agent, person".
- **Schema version 3** (`agent-cms migrate apply`): three nullable columns for the above, and the tables `cms_assets` and `cms_asset_refs` for the media library, with the matching `CmsRepo` methods.
- **Media library screens:** `cms-media` (stores and folders, grid and list, search, type tabs, a panel with a file's alt text, tags and the documents that use it, delete with a look at its uses, a phone layout) and `cms-media-picker` (the "choose media" dialog). The editor gets "Insert media", image and file fields, and media in the preview. `cms-shell` shows "Media" when the app has a library. Uploads go from the browser straight to the storage with progress, parts for large files, automatic retry of a failed part and "Try again" for what is missing; the browser makes the thumbnail.
- `<CmsProvider slots={{ assetAlt }}>`: a place for an extension package next to a file's alt text.
- The example app has a media library when it is given a storage (`npm run s3:dev`), and its public page renders media blocks.
- **Media library (server side):** `createCms({ media: { stores } })` with `s3Storage` from `./storage-s3` (AWS S3, Cloudflare R2, MinIO; signed with `aws4fetch`, no AWS SDK). Files go from the browser straight to the storage with signed addresses; files over 16MB go up in parts and a broken upload resumes with the missing parts. Public and private stores; private files open through `GET /files/:id/:name` after a permission check, with a link that works for 5 minutes.
- **What may be uploaded is the developer's choice** at three levels (`media.accept`, `stores.<name>.accept`, `admin.fields.<field>.accept`; the same for `maxFileSize`, default 5GB). The default list has no web pages or programs. The server checks the first bytes of what arrived and deletes a file that is not what its name says.
- **Files in documents:** `![alt](asset:ID/name "caption")`, `[label](asset:ID/name)` and `![alt](https://…)` in markdown (`media` blocks, `image` and `file` inlines in `parseMarkdown`); field widgets `image` and `file` with `assetId()`; `cms.assetsFor(doc)` and `cms.imageUrl(asset, { width })` for rendering. Saving checks the files a document names (`asset_missing`, `asset_wrong_kind`, `asset_alt_missing`, `asset_private_in_public`), and the CMS records which documents use which file, so deleting a file in use asks first (`asset_in_use`).
- **REST:** `/assets` (list, folders, uploads, import, edit, move, delete) and `/files`; `_me.media`; `createRestClient` methods. **Agent tools (16 → 22):** `list_assets`, `get_asset`, `import_asset` (https only; addresses inside the network are refused, also after redirects), `update_asset`, `move_asset`, `delete_asset`. **CLI:** `agent-cms upload`, `agent-cms storage check | cleanup`; `doctor` reports unfinished uploads.
- New entries `./storage` (`StorageAdapter`, `MemoryStorage`, `DEFAULT_ACCEPT`) and `./storage-s3`. New dependency: `aws4fetch` (no dependencies of its own). `scripts/s3-dev.sh` starts a local S3-compatible server for tests and the example.
- The audit log's route label "AI SDK" is now "Agent".
- Roadmap: `docs/roadmap/` holds one document per bundle of planned work (design, defaults, done criteria) and the approved screen mockups; `TODO.md` gained items 107 to 135.

## 0.7.0

- **Anonymous MCP read:** `createCmsHandler({ mcp: { anonymous: "read" } })` lets agents use `/mcp` without a key. They get the read tools only (`ANONYMOUS_READ_TOOLS`) and see published documents of collections anyone may read. Off by default.
- Releases are published with npm trusted publishing (OIDC) and provenance only; no npm token is stored in the repository.

## 0.6.1

- **Renamed to `@mainsoft/agent-cms`** and published to npmjs.com (with provenance) instead of GitHub Packages: `npm i @mainsoft/agent-cms` needs no `.npmrc` or token. Import paths change scope only (`@mainsoft-2024/agent-cms/http` → `@mainsoft/agent-cms/http`). `@mainsoft-2024/agent-cms` on GitHub Packages stays at 0.6.0. See "New name on npmjs" in [UPGRADE-0.6.md](./UPGRADE-0.6.md).
- The admin screens install with the shadcn CLI: `npx shadcn add <registry-url>/cms-shell.json`. `npm run build:registry -- --base-url <url> --out <dir>` writes the registry (files go to `<components>/cms/`, screens that need other screens point at their URLs, this package is pinned to `^0.6.1`).
- `scripts/shadcn-smoke.sh` and a CI job install a screen into a fresh Next.js app with the shadcn CLI and build it.

## 0.6.0

Breaking changes are listed with what to do in [UPGRADE-0.6.md](./UPGRADE-0.6.md).

### Breaking

- Collections require `visibility: "public" | "internal"`; `internal` requires `access.read`.
- Fine error codes (`invalid_slug`, `conflict_version`, `forbidden_write`, …) with the old coarse value in `kind`; wire shape `{ error, kind, message, params, diagnostics?, current? }`. Messages are English by default (`messages/ko` ships).
- `update` treats `fields` as a JSON Merge Patch.
- Gaps removed from the library (`cmsGaps`, `CmsGap`, `reportGap`, `gaps`, `setGapState`, `/_gaps`, `list_gaps`, `resolve_gap`, `search.gapLogging`). Searches that found nothing call `onSearchMiss` when the caller asks (`reportMiss`, `?miss=1`); the app stores them. The library never touches an existing `cms_gaps` table.
- Peer `zod` is `^3.25 || ^4`. MCP is served by the official SDK (`@modelcontextprotocol/sdk` 1.32).
- `CmsRepo` changed (gap methods out; reviews, audit, meta in; hits by source; key expiry).
- Database: new columns and `cms_audit`; run `npx @mainsoft/agent-cms migrate check`.

### Added

- `diagnose()` and `POST /_diagnose` / `diagnose_document`: every problem at once.
- ETag / `If-Match` on REST, `requireIfMatch`; 409 carries the current copy.
- Autosave without versions; versions record changed fields and hunks; `cms.diff(a, b)`.
- `./diff` (browser-safe): Myers line and word diff, hunks, `merge3`, `mergeDocs`.
- Agent change review: `agentChanges`, `reviewChanges` (accept; revert saved as one version).
- `patch()` / `patch_document`: section replace, insert, delete, append, dry run.
- `lookupForAgent` returns citation ids, trust (human or agent), a `<cms-document>` envelope, token-budget packing; `verifyCitations`.
- Draft preview links (`previewSecret`, `createPreviewLink`, `readPreview`), pinned to a version, 1h / 24h / 7d.
- `bulk()` and `bulk_documents`: publish, unpublish, archive, unarchive, delete with per-document results.
- List summaries with paging (`?fields=summary`), `counts()`, `docState()` with "modified since publish", `republishedAt`.
- API key expiry; audit log (`cms.audit`, `GET /audit`).
- `cmsTables({ prefix, schema })`, `SCHEMA_VERSION` handshake (`schema_outdated`).
- `Cms<C>`: collection names and `fields` typed from the collection list.
- CLI: `init`, `doctor`, `migrate check | print | apply`, `add` (`--diff`, `--update`), `patch`.
- Admin screens as a copy-in registry (`cms-shell`, `cms-doc-list`, `cms-doc-editor`, `cms-merge`, `cms-versions`, `cms-keys`, `cms-audit`, `cms-command`, `cms-empty`) on the app's shadcn/ui parts, English and Korean.
- `normalizeQuery` exported; it ignores word order.
- Usage hits record their source (`rest`, `mcp`, `ai`, `cli`, `app`).

## 0.5.3

- Draft-only saves no longer rebuild the search index; `afterChange` / `onChange` get `{ contentChanged }`.
- `createCms({ timeZone })` for usage-hit days; `hitCounts` filters by collection.
- `toJsonSchema` keeps lengths, ranges, defaults and enums.
- Unbiased API key generation.
- `remoteCmsToolsFor()` offers only the tools a key may use.
