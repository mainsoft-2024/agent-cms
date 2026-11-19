---
title: Introduction
summary: An add-on CMS that runs inside your Next.js app, edited by people and agents alike.
category: Get started
order: 1
---
agent-cms runs **inside your existing web app**: no separate server, no new database. People edit in admin screens you copy into the app; AI agents read and write the same documents through tools. Use it for anything a CMS is for: a blog, release notes, a help center, internal docs, a notice board.

## What you get

- **Collections over one table set.** Every collection lives in the same `cms_*` tables, so adding one needs no migration. Each has typed `fields` (zod), categories, slugs and house-style checks.
- **Versions.** Every save is a full snapshot. Drafts, publish, unpublish, archive, restore. A stale save is a conflict that carries the other person's copy, and the editor merges the two line by line.
- **Agents as editors.** One tool list, three ways in: MCP, a CLI and REST, plus the same tools as functions for the agent in your own app. Agents change one section at a time, check a draft before saving, and people review what they changed block by block.
- **Search built for answering.** Korean-aware, returns sections with citation ids such as `cms://docs/install#tables`.
- **Admin screens you own.** Screens copied into your app with shadcn, built on your own parts.
- **Safe defaults.** Every collection is `public` or `internal`; API keys are hashed, scoped and can expire; publishing, deletes and refusals go to an audit log.

## This site

These pages are agent-cms documents. Organisation members edit them in the admin, agents edit them with an API key, and any agent can read them over MCP without a key. See [Read the docs with an agent](/agents).

## Next

- [Install](/docs/install) the package.
- Follow the [Quick start](/docs/quick-start) to get a collection, a route and the admin running.
