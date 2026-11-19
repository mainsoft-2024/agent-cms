---
title: Your own agent
summary: Give the agent in your app the CMS tools, in-process or from another service. The package itself never calls a model.
category: Agents
order: 1
---
> [!note]
> This page used to be "AI SDK tools". The `./ai` entry (`cmsTools`, `remoteCmsTools`) was removed in 0.8.0: agent-cms hands agents tools and depends on no model library. What replaces it is below; [Upgrade to 0.8](/docs/upgrade-0-8) has the before and after.

## In-process

`toolsFor(cms, actor)` lists the tools this actor may use: a name, a description and a zod schema for the input. `callTool` runs one. Wrap them in whatever your agent framework calls a tool:

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

`callTool(cms, actor, name, args, { only })` checks the input, runs the tool with the actor's permissions, and records the call as made by an agent. `toolsFor(cms, actor, only)` and the `only` option narrow the list.

## From another service

A script, a scheduled job or another service uses a key:

```ts
import { createCmsClient } from "@mainsoft/agent-cms/client";
import { toolErrorResult } from "@mainsoft/agent-cms/tools";

const api = createCmsClient({ url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! });

const tools = await api.listTools(); // only what this key may use: { name, description, inputSchema }
const run = (name: string, args: Record<string, unknown>) =>
  api.call(name, args).catch((e) => toolErrorResult(e) ?? Promise.reject(e));
```

`listTools()` asks the server which tools the key may use, so a read-only key is offered read tools only.

## For a signed-in person

When the agent works with a signed-in person's permissions, say so on the actor:

```ts
await callTool(cms, { ...user, agent: { label: "assistant" } }, "patch_document", args);
```

Permissions are exactly the person's. The version, the document and the audit log also record the agent's name, the edit shows up under "Agent changes" for review, and the admin shows it as "assistant, Kim". Only code that calls the CMS in-process can set this; REST and MCP never accept it.

## Errors are results

Tool errors come back as results, not throws, so the model can re-read and retry: `{ error: "conflict_version", kind: "conflict", message, params: { expected, current } }`. Every code is on the [errors](/docs/errors) page.

## The tools

- **read:** `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document`
- **write:** `create_document`, `update_document`, `patch_document`, `diagnose_document`, `list_versions`, `restore_version`
- **publish:** `publish_document`, `unpublish_document`, `archive_document`, `delete_document`, `bulk_documents`
- **With a [media library](/docs/media-library):** `list_assets`, `get_asset` (read), `import_asset`, `update_asset` (write), `move_asset`, `delete_asset` (publish)
- **With the [file manager](/docs/file-manager):** `list_store_files` (read), `register_asset` (write), `create_share_link` (publish)

The same list is served over [MCP](/docs/mcp), so a coding agent and the agent in your app see one set of tools. For answering questions from your documents, see [Answering](/docs/answering).
