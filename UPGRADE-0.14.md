# Upgrading to 0.14

From 0.13.x. There is no schema change and nothing behaves differently until you set one of the new options.

## 1. Screens

```sh
npx @mainsoft/agent-cms add --update     # cms-keys, cms-messages
```

The keys screen gains "Rotate", "Requests per minute" and "Allowed addresses".

## 2. Request limits are off until you set them

```ts
createCms({
  rateLimit: { perMinute: 600, anonymousPerMinute: 120 },
});
```

- `perMinute` is for each API key; a key's own `rateLimit` wins over it.
- `anonymousPerMinute` is for each address that sends no key and has no session. Signed-in people are not counted.
- Over the limit: 429 `rate_limited`, `Retry-After` in seconds.
- Counting is per server process. With several servers, or on serverless, give a shared store:

```ts
rateLimit: {
  perMinute: 600,
  store: { hit: async (bucket, ttlMs) => { const n = await redis.incr(bucket); if (n === 1) await redis.pexpire(bucket, ttlMs); return n; } },
}
```

The caller's address is read from `X-Forwarded-For` (first entry), then `X-Real-IP`. If your server is not behind a proxy that sets those, a client can send the header itself: pass `createCmsHandler({ clientIp: (req) => … })`.

## 3. Rotating a key

`POST /keys/:id/rotate` with `{ "graceMinutes": 60 }` returns a new secret. The old one works until the grace time ends. `0` cuts it off at once. A rotated key shows as "Replaced" in the list once its time is over.

## 4. Retention is off until you set it

```ts
createCms({ retention: { auditDays: 365, hitsDays: 400, revokedKeysDays: 90 } });
```

It runs with the cron call, at most once a day. Try it first: `npx @mainsoft/agent-cms retention --dry-run` (an admin key).

## 5. Types

- `CreateCmsOptions` gained `rateLimit` and `retention`; `CmsHandlerOptions` gained `clientIp`.
- `CmsKey` gained `rateLimit`, `allowedIps`, `revokedReason`, `rotatedTo`. A key with `revokedAt` in the future is a rotated key that still works: compare with the current time before calling it revoked.
- A custom `CmsRepo` needs `prune(what, before, dryRun)`, and `revokeKey` must accept a time in the future. `MemoryRepo` and `DrizzleRepo` do both.
- New hooks on a collection: `beforeValidate`, `afterPublish`, `afterDelete`, `afterRead`.
- New error codes: `rate_limited` (429), `forbidden_ip`, `forbidden_admin`, `invalid_ip_range`, `invalid_rate_limit`.
- `retention`, `_events` and `auth` are reserved names: a collection cannot have those slugs.
