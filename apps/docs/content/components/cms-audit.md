---
title: "Audit log"
summary: "Who did what through which channel, filtered by action, who and result."
order: 8
---
## Usage

```tsx
<CmsAudit />
```

Needs an admin. Filter by action, by who (people, keys, the system) and by result.

## Install

```sh
npx @mainsoft/agent-cms add cms-audit
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
