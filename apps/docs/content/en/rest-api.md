---
title: REST API
summary: The routes under /api/cms.
category: Reference
order: 1
---
Auth: an `Authorization: Bearer sgk_…` key, else your session user (`resolveUser`), else anonymous (published reads only).

## Documents

```text
GET    /collections/:c                    list (?fields=summary&state=&q=&category=&by=&limit=&cursor=, ?drafts=1)
POST   /collections/:c                    create {doc, publish?, note?}
GET    /collections/:c/:slug              read (?draft=1 for the working copy)
PATCH  /collections/:c/:slug              update {doc, expectedVersion?, publish?, note?}
DELETE /collections/:c/:slug
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
POST   /collections/:c/:slug/preview      {ttl: "1h" | "24h" | "7d"}
```

## Versions

```text
GET    /collections/:c/:slug/versions[/:n]
GET    /collections/:c/:slug/diff?a=&b=
POST   /collections/:c/:slug/versions/:n/restore  {publish?}
```

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
