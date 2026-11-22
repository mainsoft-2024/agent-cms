---
title: Upgrading to 0.16
summary: No schema change. People are found by name or email; the CMS can sign people in and run on its own.
category: Upgrade
order: 9
---
No schema change: everything new lives in `cms_records`. Nothing changes until you use it.

1. `npm i @mainsoft/agent-cms@0.16` and `npx @mainsoft/agent-cms add --update` (the screens changed a lot: roles, transfer, media, preview link).
2. Roles: people are now found by name or email, so the screens no longer ask for ids. `POST /roles/:id/members` also takes `{ "email": "…" }`; such a member shows `pending: true` until that person first uses the admin. The CMS remembers who has used the admin (records of kind `person`); `GET /roles/_users` returns them with `lastSeenAt`.
3. The shell needs the `dropdown-menu` part (`npx shadcn add dropdown-menu`) for the account menu.

## Optional: the CMS's own sign-in

```ts
import { createAuth } from "@mainsoft/agent-cms/auth";
const auth = createAuth({ cms, sendMail /* optional */, oidc /* optional */ });
export const handler = createCmsHandler({ cms, auth }); // instead of resolveUser
```

Add the pages: `npx @mainsoft/agent-cms add cms-login cms-people cms-account`, then routes
`/admin/login`, `/setup`, `/invite`, `/reset` (outside the admin frame), `/admin/people` and `/admin/account`.
The first admin signs up with the setup code the server prints.

## Optional: run the CMS on its own

```bash
npx @mainsoft/agent-cms dev     # try it
npx @mainsoft/agent-cms serve   # with server: { cms } in agent-cms.config.ts
```

See `examples/server` for Docker and compose.
