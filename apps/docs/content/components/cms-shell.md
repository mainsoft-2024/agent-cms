---
title: "Admin layout"
summary: "Sidebar with collections, API keys and audit log, plus extraNav for your app's own screens. A sheet menu under 768px."
order: 1
---
## Usage

```tsx
<CmsShell title="Admin" LinkComponent={Link} activeCollection="posts" extraNav={[{ label: "App", items: [{ label: "Reports", href: "/admin/reports" }] }]}>
  {children}
</CmsShell>
```

Pass `LinkComponent={Link}` so links use your router, and `extraNav` for your own screens. Under 768px the sidebar becomes a sheet menu.

## Install

```sh
npx agent-cms add cms-shell
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
