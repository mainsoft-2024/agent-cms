---
title: Export and import
summary: Documents as markdown files, between two installations or from WordPress, CSV and JSON. An import shows what it would do before it does it.
category: Guides
order: 11
---
> [!note]
> From 0.13.0.

Documents travel as markdown files with frontmatter, one per document:

```
content/
  guide/getting-started.md
  posts/hello-world.md
  _meta.json               # version, time, counts
  _assets/manifest.json    # the files the documents use
  _assets/<id>/<name>      # the files themselves (--with-files)
```

## From the command line

```sh
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx @mainsoft/agent-cms export ./content                     # published copies
npx @mainsoft/agent-cms export ./content --drafts            # working copies where the key may write
npx @mainsoft/agent-cms export ./content --collection guide,posts --with-files

npx @mainsoft/agent-cms import ./content --dry-run --diff    # one line per file, with the changed lines
npx @mainsoft/agent-cms import ./content
npx @mainsoft/agent-cms import ./content --publish           # publish what was public when exported
npx @mainsoft/agent-cms put guide ./guide                    # one folder into one collection
```

What an import does:

- It never deletes.
- A new address becomes a draft. An address that exists gets a new version; the public copy stays until someone publishes.
- `--on-conflict file-wins` (default) saves the file, `db-wins` skips documents that exist, `newest` follows the later change.
- A file that fails the collection's checks is reported with the reason and the rest goes on.
- With `_assets/` in the folder, files the target does not have are uploaded first and every `asset:ID` in the documents is pointed at the new id. Running it again uploads nothing twice.

## From the admin

The `cms-transfer` screen (admins) takes an export file (`.json`) or markdown files, shows a table of what each would do, lets you untick files, and imports the rest as drafts. The Export tab downloads the bundle.

## From somewhere else

```sh
npx @mainsoft/agent-cms import ./wordpress.xml --from wordpress --collection posts --dry-run
npx @mainsoft/agent-cms import ./wordpress.xml --from wordpress --collection posts --publish
npx @mainsoft/agent-cms import ./rows.csv --from csv --collection guide
npx @mainsoft/agent-cms import ./items.json --from json --collection guide
```

| Source | What is read |
|---|---|
| `wordpress` | A WordPress export file (Tools → Export). Posts and pages (`--types post,page,…` picks others). HTML becomes markdown, categories and tags become keywords, the post's slug is the address, published posts can be published with `--publish`. Attachments, menus and revisions are left out. |
| `csv` | The first row names the columns: `slug`, `title`, `summary`, `body` (or `html`, `content`), `category`, `keywords` (or `tags`), `status`. Other columns become fields. |
| `json` | An array, or `{ "documents": [...] }`, of objects with the same keys. Keys the CMS does not know become fields. |

Addresses are made usable (lowercase letters, digits, hyphens) and unique. A title with no such characters, a Korean one for example, becomes `doc-1`, `doc-2`: rename them after the import.

In code:

```ts
import { filesFromSource, htmlToMarkdown } from "@mainsoft/agent-cms";

const files = filesFromSource("wordpress", xml, { collection: "posts" });
const report = await cms.transfer.import(actor, files, { dryRun: true });
```

Pictures inside WordPress posts keep pointing at the old site (only `https` addresses survive). Bring them into the media library with the `import_asset` tool or the media screen's "Import from URL".

## REST

- `GET /export?collections=a,b&drafts=1&download=1` → `{ files, documents }`
- `POST /import` with `{ files, dryRun, diff, publish, onConflict, collection, only, assetMap }` → `{ items, applied }`

Up to 2000 files per request; the CLI sends them in batches of 100.
