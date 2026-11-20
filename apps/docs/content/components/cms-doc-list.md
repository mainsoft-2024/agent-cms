---
title: "Document list"
summary: "State tabs with counts, category and author filters, search, 7-day views, selection with bulk publish, unpublish, hide, unhide and delete. Cards with long-press selection on phones."
order: 3
---
## Usage

```tsx
<CmsDocList
  collection="posts"
  hrefFor={(c, s) => `/admin/${c}/${s}`}
  onNewDocument={(c) => router.push(`/admin/${c}/new`)}
  keysHref="/admin/keys"
/>
```

Tabs come from the CMS counts. Select rows to publish, unpublish, hide, unhide or delete them together; each document reports its own result.

## Install

```sh
npx @mainsoft/agent-cms add cms-doc-list
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
