---
title: CLI
summary: Read and write documents from a shell, for agents and scripts.
category: Agents
order: 3
---
## Connect

```sh
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx agent-cms collections
```

`--env <file>` reads `AGENT_CMS_URL` and `AGENT_CMS_KEY` from a file instead.

## Commands

```sh
npx agent-cms search "install tables" --collections docs
npx agent-cms get posts hello-world --draft
npx agent-cms put posts ./hello-world.md --publish --note "launch post"
npx agent-cms patch posts hello-world ./ops.json --expected-version 3 --dry-run
npx agent-cms call archive_document '{"collection":"posts","slug":"old","archived":true}'
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

## Local commands

`init`, `doctor`, `migrate check | print | apply` and `add` work on your project, without a server. See [Install](/docs/install) and [Admin screens](/docs/admin-screens).
