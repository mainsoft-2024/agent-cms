---
title: Webhooks, jobs and plugins
summary: Signed webhooks with retries, the background jobs that send them, collection hooks, plugins and telemetry.
category: Guides
order: 9
---
> [!note]
> From 0.12.0. Coming from an older version? Read [Upgrade to 0.12](/docs/upgrade-0-12) first.

Other services learn what happened through **webhooks**: a signed POST when a document is published, a review is asked for, a file arrives. They are off until you set a key, and they are sent by the same cron call that runs scheduled publishing.

```ts
createCms({
  // ...
  cronSecret: process.env.CMS_CRON_SECRET,   // POST /api/cms/_cron with `Authorization: Bearer <secret>`
  secretsKey: process.env.CMS_SECRETS_KEY,   // 32+ characters: openssl rand -base64 32
});
```

Signing secrets are stored encrypted with `secretsKey` (AES-256-GCM). Changing the key makes the stored secrets unreadable, so keep it with your other long-lived secrets.

An admin makes a webhook in the admin (`cms-webhooks`) or with `POST /webhooks`: a name, an https address, which events, which collections. The signing secret is shown then and can be read again from the same screen.

**Events:** `doc.created`, `doc.updated`, `doc.published`, `doc.unpublished`, `doc.archived`, `doc.deleted`, `doc.restored`, `review.requested`, `review.approved`, `review.rejected`, `asset.uploaded`, `asset.moved`, `asset.deleted`, `release.published`, `comment.created`. No events checked means all of them.

**What is sent.** Never the document's text:

```json
{ "id": "…", "event": "doc.published", "at": "2026-11-21T03:00:00.000Z",
  "actor": { "kind": "user", "id": "u1", "label": "Kim", "agent": null },
  "collection": "posts", "slug": "launch", "version": 3, "url": "https://example.com/posts/launch" }
```

**The receiver** checks the signature (`X-CMS-Signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body">`, five minutes of tolerance). `verifyWebhook` has no Node imports, so it also runs on edge runtimes:

```ts
import { verifyWebhook } from "@mainsoft/agent-cms/webhooks";

export async function POST(req: Request) {
  const event = await verifyWebhook(req, process.env.CMS_WEBHOOK_SECRET!); // throws WebhookVerifyError
  if (event.event === "doc.published") revalidatePath(`/${event.collection}/${event.slug}`);
  return new Response("ok");
}
```

A delivery can arrive twice (the answer got lost, the CMS tried again): `event.id` is the same on every attempt.

**Delivery.** Nothing is sent inside the request that caused it. The event is written to a jobs table and goes out with the next cron call, so the delay is your cron interval. An answer outside 2xx, a redirect, or no answer in 10 seconds counts as a failure and is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours. After 20 failed deliveries in a row the webhook is switched off (the audit log says so, the screen shows why, "Turn on" starts it again). The history keeps 30 days and has "Send again".

**Addresses.** Only https addresses on the public internet: private, loopback and link-local addresses are refused when the webhook is saved and again before every delivery. `webhooks: { allowInsecure: true }` lifts this for local development only.

**Who.** Admins and keys with the `admin` scope. There is no agent tool that makes a webhook: an agent cannot open a way out for data by itself.

## Background jobs

Webhook deliveries are one kind of job. The same table runs your own:

```ts
cms.jobs.define<{ id: string }>("report.build", { retryAfter: [60, 600], run: async ({ id }) => build(id) });
await cms.jobs.enqueue("report.build", { id: "2026-11" }, { runAt: tomorrow });
```

`POST /_cron` runs scheduled publishing, then the jobs that are due (for about 20 seconds; the rest waits for the next call), then housekeeping. Two calls at the same moment never run the same job. Without a cron service, `npx @mainsoft/agent-cms cron --watch` calls it every 30 seconds (`AGENT_CMS_URL`, `AGENT_CMS_CRON_SECRET`). `GET /jobs?state=failed` lists what gave up, `POST /jobs/:id/retry` tries again, and `doctor` warns when there are any.

## Hooks, plugins, telemetry

**Collection hooks** run inside a write:

```ts
defineCollection({
  slug: "posts",
  hooks: {
    beforeChange: [({ content, prev }) => (prev ? undefined : { keywords: [...content.keywords, "new"] })], // return fields to change them
    beforePublish: [({ content }) => { if (!content.summary) throw new Error("Write a summary before publishing"); }],
    beforeDelete: [({ slug }) => { if (slug === "home") throw new Error("The home page cannot be deleted"); }],
    afterChange: [/* as before */],
  },
});
```

A hook that throws refuses the write with `hook_rejected` (422) and your message. `beforePublish` also runs for schedules, releases and approvals.

**Plugins** add to the CMS from another package:

```ts
import { definePlugin } from "@mainsoft/agent-cms";

export const stats = definePlugin({
  name: "stats",                                   // routes live under /api/cms/stats/
  sql: ['CREATE TABLE IF NOT EXISTS "stats_days" (…)'],   // collected in cms.plugins.sql for your migrations
  setup(ctx) {
    ctx.on("doc.published", (e) => ctx.enqueue("rollup", { slug: e.slug }));
    ctx.job("rollup", { run: async (p) => { /* … */ } });
    ctx.route("GET", "summary", ({ actor, cms }) => Response.json({ /* … */ }));   // actor is already checked
    ctx.tool({ name: "stats_summary", description: "…", input: z.object({}), run: () => ({ /* … */ }) });
    ctx.me((actor) => ({ canSee: actor.kind !== "anonymous" }));   // GET /_me → plugins.stats
    ctx.nav({ label: "Stats", href: "/admin/stats" });             // the admin sidebar shows it
  },
});
createCms({ /* … */, plugins: [stats] });
```

`ctx.secrets` seals values the plugin keeps in the database (null without `secretsKey`).

**Telemetry.** `createCms({ onEvent })` gets every request (`method`, `path`, `status`, `ms`, `actor`, `via`), every event, every job run, every cron call and every error the CMS reports. Connect it to your tracing; it is never awaited.
