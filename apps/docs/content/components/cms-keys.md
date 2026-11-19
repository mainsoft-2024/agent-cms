---
title: "API keys"
summary: "Keys with scopes, collections, last use and expiry; revoke; create with the secret shown once and MCP and CLI setup to copy."
order: 7
---
## Usage

```tsx
<CmsKeys mcpServerName="my-app" />
```

The secret is shown once, with ready-to-copy MCP and `.env` setup. Keys can expire.

## Install

```sh
npx agent-cms add cms-keys
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
