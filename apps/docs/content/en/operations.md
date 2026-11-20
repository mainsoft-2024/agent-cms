---
title: Limits, key rotation, retention and events
summary: Requests per minute for keys and strangers, addresses a key may be used from, a new secret without downtime, how long logs are kept, and a live stream of what happens.
category: Guides
order: 12
---
> [!note]
> From 0.14.0. Everything here is off until you set it. See [Upgrade to 0.14](/docs/upgrade-0-14).

## Request limits

```ts
createCms({
  rateLimit: { perMinute: 600, anonymousPerMinute: 120 },
});
```

| Who | Counted by | Limit |
|---|---|---|
| An API key | The key | Its own `rateLimit`, else `perMinute` |
| No key and no session | The caller's address | `anonymousPerMinute` |
| A signed-in person | Not counted | None |

Over the limit the answer is 429 with `Retry-After` in seconds:

```json
{ "error": "rate_limited", "message": "Too many requests. Try again in 42 seconds", "params": { "retryAfter": 42, "limit": 60 } }
```

A minute is a fixed window: the count starts over when the clock minute ends. Counts live in the server process. With several servers, or on a serverless host, give a store they share; it needs one method:

```ts
rateLimit: {
  perMinute: 600,
  store: {
    hit: async (bucket, ttlMs) => {
      const n = await redis.incr(bucket);
      if (n === 1) await redis.pexpire(bucket, ttlMs);
      return n;
    },
  },
}
```

The address comes from `X-Forwarded-For` (first entry), then `X-Real-IP`. A server that is not behind a proxy setting those should say where it is: `createCmsHandler({ clientIp: (req) => … })`.

## A key's own limit and addresses

On the keys screen, or:

```ts
await cms.createKey(admin, { name: "deploy", scopes: ["read", "write"], rateLimit: 60, allowedIps: ["203.0.113.0/24", "2001:db8::/32"] });
```

From any other address the key answers 403 `forbidden_ip`. Up to 50 addresses or ranges, IPv4 and IPv6.

## Rotating a key

"Rotate" on the keys screen, or `POST /keys/:id/rotate` with `{ "graceMinutes": 60 }`:

- A new secret is made with the same name, scopes, collections, expiry and limits. It is shown once.
- The old secret keeps working for the grace time (60 minutes by default, up to 7 days, `0` to stop it now), so callers can switch without a break.
- The list shows the old key with "Works until …", then as "Replaced".

`DELETE /keys/:id?reason=leaked` keeps a note with a revoked key.

## Retention

```ts
createCms({
  retention: { auditDays: 365, hitsDays: 400, revokedKeysDays: 90, deliveriesDays: 14 },
});
```

| Option | What goes |
|---|---|
| `auditDays` | Audit log entries older than this |
| `hitsDays` | Read counts older than this (the dashboard reads 30 days at most) |
| `revokedKeysDays` | Keys revoked longer ago than this |
| `deliveriesDays` | Webhook deliveries (they are kept 30 days without it) |

The cron call applies the rules at most once a day and writes one audit entry when it deleted something. Documents, their versions (`versions.max` on a collection) and the trash (`trash.days`) are not part of it.

Look before it runs:

```sh
npx @mainsoft/agent-cms retention --dry-run     # needs an admin key
```

```json
{ "dryRun": true, "items": [{ "what": "audit", "days": 365, "before": "2025-11-21T00:00:00.000Z", "rows": 1204 }] }
```

## Events as they happen

```ts
const es = new EventSource("/api/cms/_events?collections=posts");
es.addEventListener("doc.published", (e) => refresh(JSON.parse(e.data).slug));
es.addEventListener("resync", (e) => JSON.parse(e.data).documents.forEach((d) => refresh(d.slug)));
```

`GET /_events` is a Server-Sent Events stream of the same events webhooks carry (`doc.created`, `doc.updated`, `doc.published`, …).

- Someone who may write in a collection hears everything about its documents.
- A reader, such as a stranger on a public collection, hears only what changes the public copy: published, unpublished, archived, deleted, restored.
- Events without a collection (files, releases) go to admins.
- Every message has an id, a time. When the browser reconnects it sends the id back, and the first message is one `resync` listing the documents saved since (up to 200). `?since=<ISO time>` does the same by hand.

> [!warning]
> The stream is fed by the server process that answers it. With several servers, a change made through another one arrives with the next `resync`, not live. Hosts that cut long responses (serverless) end the stream after their time limit; `EventSource` reconnects by itself.

In code: `const stop = cms.subscribe((event) => …)`.

## More hooks

```ts
defineCollection({
  slug: "posts",
  hooks: {
    beforeValidate: [({ input, prev }) => (!prev && !input.slug && input.title ? { slug: slugify(input.title) } : undefined)],
    afterPublish: [(doc) => revalidatePath(`/blog/${doc.slug}`)],
    afterDelete: [(doc) => searchIndex.remove(doc.id)],
    afterRead: [(doc, { actor }) => (actor.kind === "anonymous" ? { ...doc, fields: { ...doc.fields, internalNote: undefined } } : undefined)],
  },
});
```

| Hook | When | Can it stop the action |
|---|---|---|
| `beforeValidate` | Before the input is checked. Return fields to change them | Yes, by throwing |
| `beforeChange`, `beforePublish`, `beforeDelete` | Before the save, publish or delete (0.12) | Yes |
| `afterChange`, `afterPublish`, `afterDelete` | After it happened | No. Errors go to `onError` |
| `afterRead` | Before one document leaves `get` (not lists or search) | Yes, by throwing |

`afterPublish` also runs for a scheduled publish and for a release.
