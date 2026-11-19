# Upgrading to agent-cms 0.8

0.8 is not released yet. This file grows as its parts land; what is here is
already on `main`.

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
npx agent-cms migrate check    # what is missing
npx agent-cms migrate apply    # or `migrate print` and run the SQL yourself
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
