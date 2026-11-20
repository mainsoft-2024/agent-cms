---
title: Upgrade to 0.8
summary: The ./ai entry is gone, the schema is version 3, agents can act for a person, and the media library is opt-in.
category: Upgrade
order: 2
---
0.8.0 was not published to npm on its own. It is part of 0.10.0, the first
release after 0.7.0: coming from 0.7.0, do this page first, then
[Upgrade to 0.10](/docs/upgrade-0-10).

## 1. `./ai` is gone: the package no longer calls into a model library

agent-cms hands agents tools. It never calls a model, and from 0.8 it does
not depend on any library that does. The `./ai` entry (`cmsTools`,
`remoteCmsTools`, `remoteCmsToolsFor`) and the optional `ai` peer dependency
are removed. MCP, REST, the CLI and `./tools` are unchanged.

If you used `cmsTools`, wrap the same tool list yourself. It is about ten
lines with whatever your agent framework calls a tool:

```ts
import { toolsFor, callTool } from "@mainsoft/agent-cms/tools";

const actor = { kind: "system", label: "assistant" } as const;

const tools = Object.fromEntries(
  toolsFor(cms, actor).map((t) => [
    `cms_${t.name}`, // the old `prefix` option
    {
      description: t.description,
      inputSchema: t.input, // a zod object
      execute: (args: unknown) => callTool(cms, actor, t.name, args),
    },
  ])
);
```

`callTool` does what the old wrapper did: it checks the input, runs the tool
with the actor's permissions, records the call as made by an agent
(`via: "ai"`), and returns a CMS error (`{ error, kind, message, params }`)
as a result instead of throwing. `toolsFor(cms, actor, only)` replaces the
`only` option.

If you used `remoteCmsTools` or `remoteCmsToolsFor`:

```ts
import { createCmsClient } from "@mainsoft/agent-cms/client";
import { toolErrorResult } from "@mainsoft/agent-cms/tools";

const api = createCmsClient({ url, key });
const tools = await api.listTools(); // only what the key may use; each has a JSON Schema
const run = (name: string, args: Record<string, unknown>) =>
  api.call(name, args).catch((e) => toolErrorResult(e) ?? Promise.reject(e));
```

## 2. Schema version 3

```sh
npx @mainsoft/agent-cms migrate check    # what is missing
npx @mainsoft/agent-cms migrate apply    # or `migrate print` and run the SQL yourself
```

The step only adds things, and is safe to run twice:

- `cms_documents.updated_by_agent`, `cms_versions.author_agent`,
  `cms_audit.actor_agent` (text, nullable).
- Tables `cms_assets` and `cms_asset_refs` for the media library that ships
  with 0.8. They stay empty until you configure a file store.

Until it has run, the CMS answers `schema_outdated`, as with every schema
change.

## 3. An agent acting for a person

When an agent in your app works with a signed-in person's permissions, say
so on the actor:

```ts
await callTool(cms, { ...user, agent: { label: "assistant" } }, "patch_document", args);
```

Permissions are exactly the person's. The version, the document and the audit
log also record the agent's name, the edit shows up under "Agent changes" for
review, and the admin shows it as "assistant, Kim". Only code that calls the
CMS in-process can set this; REST and MCP never accept it (the handler drops
it even if `resolveUser` returns it).

Type changes that follow: `CmsDoc.updatedByAgent`, `CmsVersion.authorAgent`,
`AuditEntry.actorAgent` and `DocSummary.updatedByAgent` are new (`string |
null`). `AgentChange.authorKind` can now be `"user"`, and `AgentChange.behalf`
names the person the agent acted for. A custom `CmsRepo` has new methods for
files (`insertAsset` … `listAssetRefs`); `MemoryRepo` and `DrizzleRepo`
implement them.

## 4. The media library is opt-in

Nothing changes until you pass `media` to `createCms` ([Media library](/docs/media-library)). Two things to know even if you never do:

- `parseMarkdown` has a new block (`media`) and two new inlines (`image`,
  `file`). A renderer with an exhaustive `switch` needs cases for them; one
  that ignores unknown blocks shows nothing for a media line.
- A line that is only `![alt](https://…)` used to render as text and is now
  an image block. `![alt](asset:…)` in a body is checked on save: without a
  media library it fails with `asset_missing`.

When you turn it on: re-export `cmsAssets` and `cmsAssetRefs` from your
Drizzle schema next to the other tables, add the same `media` object to
`agent-cms.config.ts`, and run `npx @mainsoft/agent-cms storage check --origin
https://your-site` once per environment.

## 5. Admin screens

Run `npx @mainsoft/agent-cms add --update` (or `--diff` first) to get this version of
the screens you copied. What changed in them:

- `cms-doc-editor` now imports `./cms-media-picker` (and `cms-upload.ts`
  with it), also in apps without a media library; `add` brings both.
- `cms-shell`'s `hrefFor` may be asked for `{ kind: "media" }`. The default
  is `<basePath>/media`; add that page with `cms-media` when you turn the
  library on.
- New strings start with `media_` in `cms-messages.ts` (English and Korean).
