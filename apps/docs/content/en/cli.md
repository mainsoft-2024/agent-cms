---
title: CLI
summary: Read and write documents from a shell, for agents and scripts.
category: Agents
order: 3
---
## Connect

```sh
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx @mainsoft/agent-cms collections
```

`--env <file>` reads `AGENT_CMS_URL` and `AGENT_CMS_KEY` from a file instead.

These commands talk to the app over HTTP, so they run from any folder: `npx` fetches the package when it is not installed there. Keep the scope in the command (`bunx @mainsoft/agent-cms …` and `pnpm dlx @mainsoft/agent-cms …` work the same way). `agent-cms` without `@mainsoft/` is another project's package on npm and stops with `could not determine executable to run`.

## Commands

```sh
npx @mainsoft/agent-cms search "install tables" --collections docs
npx @mainsoft/agent-cms get posts hello-world --draft
npx @mainsoft/agent-cms put posts ./hello-world.md --publish --note "launch post"
npx @mainsoft/agent-cms patch posts hello-world ./ops.json --expected-version 3 --dry-run
npx @mainsoft/agent-cms call archive_document '{"collection":"posts","slug":"old","archived":true}'
```

`put` creates the document. To update one that exists, pass the version you read as `--expected-version N`; if someone saved since, `put` fails with a conflict instead of overwriting. `--force` skips that check.

## File format

Markdown with frontmatter. Keys other than `slug`, `title`, `summary`, `category` and `keywords` go into `fields`:

```md
---
title: Hello, world
summary: Our first post
category: News
tags: [launch]
---
Body in **markdown**.
```

## Export, import, OpenAPI

From 0.13.0.

```sh
npx @mainsoft/agent-cms export ./content --drafts --with-files
npx @mainsoft/agent-cms import ./content --dry-run --diff
npx @mainsoft/agent-cms import ./wordpress.xml --from wordpress --collection posts
npx @mainsoft/agent-cms put guide ./guide
npx @mainsoft/agent-cms openapi > openapi.json
```

`export` writes one markdown file per document; `import` reads them back as drafts and says what it would do with `--dry-run`. `--from json|csv|wordpress` reads content from somewhere else. See [Export and import](/docs/import-export). `openapi` prints the REST API as an OpenAPI 3.1 document for what the key may read.

## Local commands

`init`, `doctor`, `migrate check | print | apply` and `add` work on your project, without a server. See [Install](/docs/install) and [Admin screens](/docs/admin-screens).

## Serve the screens from your own site

`npx @mainsoft/agent-cms registry build --base-url https://your.site/r` writes the admin screens of the installed version into `public/r` (change it with `--out`). Serve that folder and people add screens with `npx shadcn add https://your.site/r/cms-shell.json`.
