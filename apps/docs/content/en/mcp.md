---
title: MCP
summary: Connect coding agents to your CMS, with a key or read-only without one.
category: Agents
order: 2
---
The route you mounted serves MCP at `/api/cms/mcp` (official MCP SDK, streamable HTTP, stateless).

## With a key

Create a key in the **API keys** screen, then register the server with the header `Authorization: Bearer sgk_…`:

```sh
claude mcp add --transport http my-cms https://app.example.com/api/cms/mcp --header "Authorization: Bearer sgk_…"
```

The key's scopes decide which tools the agent sees. Published documents are also MCP resources (`cms://<collection>/<slug>`), and two prompts (`answer_from_cms`, `edit_document`) show the safe way to work.

## Without a key (read only)

For public docs any agent may read, turn on anonymous read:

```ts
createCmsHandler({ cms, resolveUser, mcp: { anonymous: "read" } });
```

A request without a key then gets the read tools only (`list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document`) and sees published documents of collections anyone may read. Write tools are not listed. The default stays off (401 without a key).

> [!tip]
> This site does exactly that. Try it: [Read the docs with an agent](/agents).
