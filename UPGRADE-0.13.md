# Upgrading to 0.13

From 0.12.x. One new table, four new screens, and nothing that changes how an existing app behaves until you use them.

## 1. Schema version 7

One new table: `cms_records`. It holds automations, their run history and roles. Nothing existing changes.

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply     # or `migrate print` and run the SQL yourself
```

If your Drizzle schema file re-exports the tables, add `cmsRecords` (a fresh `init` writes it).

## 2. Roles change nothing until you make one

Who may do what is decided in this order: the system, then a collection's own `access` functions in code, then roles, then the default (admins only). An app that never makes a role behaves exactly as before. A collection whose `access` decides an operation in code shows "Set in code" on the roles screen and the screen cannot change it.

A role name can be used once (letter case is ignored). The second one answers 409 `name_taken`.

To let the roles screen find people by name, tell the CMS where they are:

```ts
createCms({
  users: {
    search: (q) => db.user.findMany({ where: { name: { contains: q } }, take: 10 }).then((rows) => rows.map((u) => ({ id: u.id, label: u.name }))),
    get: (id) => db.user.findUnique({ where: { id } }).then((u) => (u ? { id: u.id, label: u.name } : null)),
  },
});
```

Without `users` a person is added by the id your `resolveUser` returns.

## 3. Automations run with the cron call

An automation's work is a background job, so it runs on the next `POST /_cron`, the same call that sends webhooks. If nothing calls it, nothing runs: `npx @mainsoft/agent-cms cron --watch` works without a cron service. A new automation made on the screen starts switched off.

Functions an automation may call are named in code:

```ts
createCms({
  automations: {
    actions: {
      notifySales: async ({ automation, doc }) => { /* … */ },
    },
  },
});
```

## 4. Screens

`npx @mainsoft/agent-cms add --update` brings `cms-shell` (Dashboard, Automations, Roles, Import and export) and `cms-messages`. Then add the new ones and a page for each:

```sh
npx @mainsoft/agent-cms add cms-dashboard cms-automations cms-roles cms-transfer
```

| Screen | Page | Who sees the menu entry |
|---|---|---|
| `CmsDashboard` | `/admin/dashboard` | Everyone who is signed in |
| `CmsAutomations` | `/admin/automations` | Admins |
| `CmsRoles` | `/admin/roles` | Admins |
| `CmsTransfer` | `/admin/transfer` | Admins |

## 5. REST and CLI

- New routes: `GET /openapi.json`, `GET /_stats`, `GET /export`, `POST /import`, `/automations…`, `/roles…`. `GET /_me` returns `dashboard`, `automations`, `roles`.
- `openapi.json` is now a reserved name: a collection cannot have that slug.
- New commands: `export <dir> [--with-files]`, `import <dir>`, `import <file> --from json|csv|wordpress`, `openapi`. `put <collection> <dir>` reads a folder.
- New entry `@mainsoft/agent-cms/adapters/node` for servers that speak Node's `(req, res)`.

## 6. Types

- `CreateCmsOptions` gained `users` and `automations`.
- A custom `CmsRepo` needs the record methods (`insertRecord`, `findRecord`, `findRecordByKey`, `listRecords`, `updateRecord`, `deleteRecords`) and `versionsSince`; `MemoryRepo` and `DrizzleRepo` have them.
- New error codes: `name_taken`, `role_not_found`, `role_last_admin`, `forbidden_roles`, `automation_not_found`, `automation_invalid`, `forbidden_automations`.
