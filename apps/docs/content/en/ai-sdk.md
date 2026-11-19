---
title: AI SDK tools
summary: Give your own agent the CMS tools, in-process or from another service.
category: Agents
order: 1
---
## In-process

```ts
import { streamText } from "ai";
import { cmsTools } from "@mainsoft/agent-cms/ai";

const result = streamText({
  model,
  tools: {
    ...myTools,
    ...cmsTools(cms, { kind: "system", label: "assistant" }, { prefix: "cms_" }),
  },
  messages,
});
```

You get every tool the actor may use; `only` and `prefix` narrow and rename them. They are plain AI SDK tools, so anything built on the AI SDK can use them.

## From another service

```ts
import { remoteCmsTools } from "@mainsoft/agent-cms/ai";

const tools = remoteCmsTools(
  { url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! },
  { only: ["search_documents", "get_document", "patch_document"] }
);
```

`await remoteCmsToolsFor(client, opts)` first asks the server which tools the key may use, so a read-only key is offered read tools only.

## Tools

- **read:** `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document`
- **write:** `create_document`, `update_document`, `patch_document`, `diagnose_document`, `list_versions`, `restore_version`
- **publish:** `publish_document`, `unpublish_document`, `archive_document`, `delete_document`, `bulk_documents`

Tool errors come back as results, not throws, so the model can re-read and retry: `{ error: "conflict_version", kind: "conflict", message, params }`. See [Errors](/docs/errors).
