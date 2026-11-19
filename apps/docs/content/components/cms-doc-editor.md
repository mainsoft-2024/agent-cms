---
title: "Document editor"
summary: "Info form generated from the collection schema, markdown with live preview, autosave and restore, problems on the fields, agent change review (accept, revert), save, publish, preview links."
order: 5
---
## Usage

```tsx
<CmsDocEditor
  collection="posts"
  slug={slug}
  onBack={() => router.push("/admin/posts")}
  onOpenVersions={(c, s) => router.push(`/admin/${c}/${s}/versions`)}
  publicUrlFor={(c, s) => `/blog/${s}`}
/>
```

Leave out `slug` to create a document. The fields form is built from the collection schema (`GET /_schema`). Blocks an agent wrote show Accept and Revert.

## Install

```sh
npx agent-cms add cms-doc-editor
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
