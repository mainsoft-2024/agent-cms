---
title: Upgrading to 0.13
summary: Schema version 7 adds one table for automations and roles. Four new screens. Nothing changes for an existing app until you use them.
category: Upgrade
order: 6
---
## 1. Schema version 7

One new table: `cms_records`. It holds automations, their run history and roles. Nothing existing changes.

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply     # or `migrate print` and run the SQL yourself
```

If your Drizzle schema file re-exports the tables, add `cmsRecords` (a fresh `init` writes it).

## 2. Roles change nothing until you make one

Who may do what is decided in this order: the system, then a collection's own `access` functions in code, then roles, then the default (admins only). An app that never makes a role behaves exactly as before. See [Automations, roles and the dashboard](/docs/automations).

## 3. Automations run with the cron call

An automation's work is a background job, so it runs on the next `POST /_cron`, the same call that sends webhooks. A new automation made on the screen starts switched off.

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
- New commands: `export <dir> [--with-files]`, `import <dir>`, `import <file> --from json|csv|wordpress`, `openapi`. See [Export and import](/docs/import-export) and [OpenAPI and other servers](/docs/openapi).
- New entry `@mainsoft/agent-cms/adapters/node`.

## 6. Types

- `CreateCmsOptions` gained `users` and `automations`.
- A custom `CmsRepo` needs the record methods (`insertRecord`, `findRecord`, `findRecordByKey`, `listRecords`, `updateRecord`, `deleteRecords`) and `versionsSince`; `MemoryRepo` and `DrizzleRepo` have them.
- New error codes: `name_taken`, `role_not_found`, `role_last_admin`, `forbidden_roles`, `automation_not_found`, `automation_invalid`, `forbidden_automations`.
