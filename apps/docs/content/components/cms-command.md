---
title: "Command menu"
summary: "Cmd+K or Ctrl+K: find documents (drafts included) across collections and open, publish or start a new one."
order: 9
---
## Usage

```tsx
<CmsCommand open={open} onOpenChange={setOpen} onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)} />
```

`CmsShell` opens it from its search box with `onSearch`. It finds drafts too.

## Install

```sh
npx agent-cms add cms-command
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
