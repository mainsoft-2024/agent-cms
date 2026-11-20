---
title: REST API
summary: The routes under /api/cms.
category: Reference
order: 1
---
Auth: an `Authorization: Bearer sgk_…` key, else your session user (`resolveUser`), else anonymous (published reads only).

A write that uses the session must come from a page of the app itself. The handler compares the browser's `Origin` with the address of the request (`Host`, or `X-Forwarded-Host` behind a proxy) and answers 403 `cross_site` when they differ. Requests with a key are not checked. If the admin is served from another address, list it: `createCmsHandler({ cms, resolveUser, trustedOrigins: ["https://admin.example.com"] })`.

## Documents

```text
GET    /collections/:c                    list (?fields=summary&state=&q=&category=&by=&limit=&cursor=, ?drafts=1)
POST   /collections/:c                    create {doc, publish?, note?}
GET    /collections/:c/:slug              read (?draft=1 for the working copy)
PATCH  /collections/:c/:slug              update {doc, expectedVersion?, publish?, note?}
DELETE /collections/:c/:slug              to the trash (kept 30 days by default)
POST   /collections/:c/:slug/patch        {ops, expectedVersion?, dryRun?}
POST   /collections/:c/:slug/publish | archive | unarchive | unpublish
```

## Editing helpers

```text
GET    /collections/:c/_counts            numbers per state
GET    /collections/:c/_schema            fields as JSON Schema + admin hints
POST   /collections/:c/_diagnose          {doc, slug?} → every problem, nothing saved
POST   /collections/:c/_bulk              {action, items:[{slug, expectedVersion?}]}
PUT    /collections/:c/:slug/autosave     {doc, baseVersion}   DELETE: discard
GET    /collections/:c/:slug/changes      agent changes waiting for review
POST   /collections/:c/:slug/review       {hunks: [...] | "all", action?}
POST   /collections/:c/:slug/preview      {ttl: "1h" | "24h" | "7d", comments?}
```

## Versions

```text
GET    /collections/:c/:slug/versions[/:n]
GET    /collections/:c/:slug/diff?a=&b=
POST   /collections/:c/:slug/versions/:n/restore  {publish?}
```

## Publishing flow

```text
POST   /collections/:c/:slug/schedule     {publishAt?, unpublishAt?, expectedVersion?}   DELETE: cancel
POST   /collections/:c/:slug/review/request {note?} | review/approve {publish?} | review/reject {note?}
GET    /reviews?collection=               documents waiting for a review
GET    /collections/:c/:slug/comments | POST {body, anchor?, quote?, threadId?}
POST   /collections/:c/:slug/comments/:id/resolve {resolved?}
GET    /preview/comments?token= | POST    comments through a preview link that allows them
POST   /collections/:c/:slug/presence     {cursor?, selection?}   DELETE: leave
GET    /collections/:c/_presence          who has which document open
PATCH  /collections/:c/:slug/versions/:n  {label?, pinned?}
POST   /collections/:c/_preview           {doc, slug?} → blocks, diagnostics, diff; nothing saved
GET    /collections/:c/_filters | POST {name, query, shared?} | DELETE /collections/:c/_filters/:id
GET    /releases | POST {name}
GET    /releases/:id | PATCH {name} | DELETE
POST   /releases/:id/items {items} | DELETE /releases/:id/items/:documentId
POST   /releases/:id/publish | POST /releases/:id/schedule {publishAt | null}
GET    /trash?kind=document|asset | POST /trash/_restore {items} | POST /trash/_purge {items | all: true}
GET    /_cron                             run what is due (Authorization: Bearer <cronSecret>)
```

See [Publishing flow](/docs/publishing-flow).

## Webhooks and jobs

Admins and keys with the `admin` scope.

```text
GET    /webhooks                           {webhooks, events, enabled}
POST   /webhooks                           {name, url, events?, collections?, enabled?} → {webhook, secret}
PATCH  /webhooks/:id                       the same fields | DELETE
GET    /webhooks/:id/secret                the signing secret
POST   /webhooks/:id/test                  send a ping now → {delivery}
GET    /webhooks/:id/deliveries?limit=     the last 30 days, newest first
POST   /webhooks/deliveries/:id/retry      queue the same event again
GET    /jobs?state=waiting|failed|done&kind=   {waiting, failed, jobs}
POST   /jobs/:id/retry                     give a failed job another round
POST   /_cron                              Bearer cronSecret: schedules, due jobs, housekeeping → {published, …, jobs}
ANY    /<plugin name>/…                    routes a plugin added
```

## Automations, roles, dashboard, export

From 0.13.0. Admins (or a key with the `admin` scope) unless noted.

| Method and path | What it does |
|---|---|
| `GET /automations` | Automations, with the triggers and actions that can be picked |
| `POST /automations`, `PATCH /automations/:id`, `DELETE /automations/:id` | Make, change, delete |
| `GET /automations/:id/runs` | Run history (30 days) |
| `POST /automations/:id/test` `{collection, slug}` | What would happen to one document; nothing is changed |
| `GET /roles`, `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id` | Roles and what they allow |
| `POST /roles/:id/members` `{id, label?}`, `DELETE /roles/:id/members/:userId` | People in a role |
| `GET /roles/_users?q=` | Find people (from `createCms({ users })`) |
| `GET /_stats?days=7\|14\|30` | The dashboard's numbers. Anyone signed in, for what they may read |
| `GET /export?collections=&drafts=1&download=1` | Documents as markdown files. Anyone who may read |
| `POST /import` `{files, dryRun?, diff?, publish?, onConflict?, collection?, only?, assetMap?}` | Read files into drafts. Needs write |
| `GET /openapi.json` | This API as an OpenAPI 3.1 document. Anyone, for what they may read |
| `POST /keys/:id/rotate` `{graceMinutes?}` | A new secret for the same key; the old one works for the grace time (0.14.0) |
| `GET /retention`, `POST /retention` `{dryRun?}` | The retention rules; delete what they allow, or only count (0.14.0) |
| `GET /_events?collections=&since=` | What happens, as a Server-Sent Events stream. Anyone, for what they may read (0.14.0) |

See [Automations, roles and the dashboard](/docs/automations), [Export and import](/docs/import-export) and [OpenAPI and other servers](/docs/openapi).

## Files

Only with a [media library](/docs/media-library); without one these answer `media_disabled`.

```text
GET    /assets?store=&folder=&kind=image,video&q=&tag=&cursor=&limit=
GET    /assets/_folders | POST {path, store?} | DELETE ?path=&store=
POST   /assets/_import                    {url, folder?, store?, alt?, tags?}   https only, public addresses only
POST   /assets/uploads                    {name, mime, size, folder?, store?, alt?, tags?, replace?} → {asset, upload}
GET    /assets/uploads/:id                which parts arrived   DELETE: give up
POST   /assets/uploads/:id/parts          {parts: [1, 2]} → signed addresses for those parts
POST   /assets/uploads/:id/complete       {width?, height?, duration?} → the file is checked and joins the library
GET    /assets/:id | PATCH {alt?, tags?, focal?: {x, y} | null} | DELETE ?confirm=1
POST   /assets/:id/move                   {folder?, name?}
POST   /assets/:id/share                  {ttl?: "1h" | "24h" | "7d"}
POST   /assets/:id/thumb                  the small picture, as the request body
GET    /files/:id/:name                   302 to the file; ?thumb=1, ?download=1, ?size=<name>
GET    /stores/:store/files?prefix=&q=&cursor=   everything in the bucket (file manager)
POST   /stores/:store/files/_register | _move | _delete
```

`upload` is `{kind: "single", url, headers}` (PUT the file there) or `{kind: "multipart", partSize, partCount}` (ask for part addresses, PUT each part). With `replace: <id>` the upload becomes that file's new content once it passed the checks. `?size=` needs [image sizes](/docs/media-library#image-sizes); an unknown name answers `unknown_image_size`.

## Other

```text
GET    /_me                               who am I, what may I do
GET    /search?q=&collections=a,b&miss=1
GET    /preview?token=
GET    /keys | POST /keys | DELETE /keys/:id
GET    /audit?cursor=&action=&outcome=&actorKind=
POST   /mcp
```

A document GET sends `ETag: "v<n>"`; writes take `If-Match`. See [Editing together](/docs/editing-together).
