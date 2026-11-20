---
title: Upgrading to 0.12
summary: Schema version 6 adds three tables for jobs and webhooks. The cron call now also sends webhooks. Webhooks stay off until you set secretsKey.
category: Upgrade
order: 5
---
## 1. Schema version 6

Three new tables: `cms_jobs`, `cms_webhooks`, `cms_webhook_deliveries`. Nothing existing changes.

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply     # or `migrate print` and run the SQL yourself
```

If your Drizzle schema file re-exports the tables, add `cmsJobs`, `cmsWebhooks` and `cmsWebhookDeliveries` (a fresh `init` writes them).

## 2. The cron call does more

`POST /_cron` used to run scheduled publishing and empty the trash. It now also runs background jobs, which is how webhooks go out. Its answer has a new `jobs` field (`{ran, ok, retried, failed, waiting}`); the old fields are unchanged. If you call it once a day, webhooks are delivered once a day: call it every minute or so when you use them. Without a cron service: `npx @mainsoft/agent-cms cron --watch`.

## 3. Webhooks are opt-in

Nothing is sent until you set `secretsKey` (32+ characters) and an admin makes a webhook. Add the screen with `npx @mainsoft/agent-cms add cms-webhooks` and a page at `/admin/webhooks`.

## 4. Screens

`npx @mainsoft/agent-cms add --update` brings `cms-shell` (the Webhooks entry, plugin menu entries) and `cms-messages`. Other screens are unchanged.

## 5. Types

- `CollectionConfig.hooks` gained `beforeChange`, `beforePublish`, `beforeDelete`.
- `CreateCmsOptions` gained `secretsKey`, `webhooks`, `plugins`, `onEvent`.
- A custom `CmsRepo` needs the new job and webhook methods (`insertJob`, `claimJobs`, … `failWebhook`, `pruneDeliveries`); `MemoryRepo` and `DrizzleRepo` have them.
- New error codes: `webhook_not_found`, `delivery_not_found`, `forbidden_webhooks`, `secrets_key_missing`, `webhook_url_blocked`, `webhook_event_unknown`, `hook_rejected`.
