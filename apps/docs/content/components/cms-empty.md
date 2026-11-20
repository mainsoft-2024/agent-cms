---
title: "Empty collection"
summary: "New document, and how to write with an agent instead (CLI one-liner, MCP URL, API key link)."
order: 2
---
## Usage

```tsx
<CmsEmpty collection="posts" onNewDocument={() => router.push("/admin/posts/new")} keysHref="/admin/keys" />
```

`CmsDocList` shows it by itself when a collection is empty; use it directly when you build your own list.

## Install

```sh
npx @mainsoft/agent-cms add cms-empty
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
