# Changelog

## Unreleased (0.8.0)

Read [UPGRADE-0.8.md](./UPGRADE-0.8.md). The media library that completes 0.8.0 is planned in [docs/roadmap](./docs/roadmap/README.md).

- **Breaking: the `./ai` entry and the optional `ai` peer dependency are removed.** This package hands agents tools and never calls a model, and it no longer depends on a library that does. MCP, REST, the CLI and `./tools` are unchanged. A test keeps model libraries out of the sources and the dependencies.
- **`callTool`, `runTool`, `toolErrorResult`** in `./tools`: run a tool by name as an actor, with CMS errors returned as results. Together with `toolsFor` this is the way to give the tools to an agent in your app, whatever framework runs it. MCP runs tools through the same path.
- **An agent acting for a person:** `{ kind: "user", …, agent: { label } }`. Same permissions as the person; versions, the document and the audit log record the agent's name, and its edits are listed under "Agent changes". Requests cannot set it. The admin shows such authors as "agent, person".
- **Schema version 3** (`agent-cms migrate apply`): three nullable columns for the above, and the tables `cms_assets` and `cms_asset_refs` for the media library, with the matching `CmsRepo` methods.
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
- Database: new columns and `cms_audit`; run `npx agent-cms migrate check`.

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
