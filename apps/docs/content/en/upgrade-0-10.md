---
title: Upgrade to 0.10
summary: The schema is version 4, deleting means the trash, schedules need a cron call, and four screens have new parts.
category: Upgrade
order: 3
---
0.10.0 is the first npm release after 0.7.0 and contains 0.8.0 and 0.9.0. Coming
from 0.7.0, do [Upgrade to 0.8](/docs/upgrade-0-8) first. 0.9.0 needs nothing.

## 1. Schema version 4

```sh
npx agent-cms migrate check
npx agent-cms migrate apply    # or `migrate print` and run the SQL yourself
```

The step only adds things and is safe to run twice:

- columns on `cms_documents` (`deleted_at`, `deleted_by`, `schedule`, `due_at`, `review`), on `cms_versions` (`label`, `pinned`, `approved_by`, `approved_at`) and on `cms_assets` (`deleted_at`, `deleted_by`)
- the tables `cms_comments`, `cms_releases`, `cms_saved_filters` and `cms_presence`

Re-export `cmsComments`, `cmsReleases`, `cmsSavedFilters` and `cmsPresence` from your Drizzle schema next to the other tables.

## 2. Deleting now means the trash

`cms.remove`, `DELETE /collections/:c/:slug`, the `delete_document` tool and deleting a file used to be final. They now put the document or file in the trash for 30 days.

- A trashed document is not found by `get`, `list`, search or agents. Its address stays taken: creating a document with the same slug fails with `slug_in_trash` until it is restored or purged.
- A trashed file's object stays in the bucket until it is purged, so a public address keeps answering until then.
- `createCms({ trash: { days: 0 } })` keeps the old behaviour. Tests that count rows after a delete want this, or `cms.trash.purge(admin, "all")`.
- Old trash is emptied when `cms.runScheduled()` runs (next section).

## 3. A cron call for schedules and the trash

Scheduled publishing and emptying the trash happen when `cms.runScheduled()` runs. Set `createCms({ cronSecret })` and call the route every few minutes:

```
POST /api/cms/_cron
Authorization: Bearer <cronSecret>
```

`GET` works too. Without `cronSecret` the route answers 404. On Vercel, a cron job with `CRON_SECRET` sends exactly this header. Calling it from two places at once is safe.

> [!note]
> Nothing publishes on its own. If no one calls the route, a scheduled document stays "Scheduled" after its time has passed.

## 4. Admin screens

```sh
npx agent-cms add --update
npx agent-cms add cms-trash cms-releases
```

- `cms-doc-editor` has two more files, `cms-flow.tsx` and `cms-paste.ts`.
- `cms-doc-list` needs the shadcn `label` part; `cms-versions` needs `dialog` and `input`.
- `cms-shell` links to "Releases" and "Trash" for people who can edit. The target that `hrefFor` receives has two new kinds, `releases` and `trash`: add the two routes in your app.
- `cms-preview-comments` is optional: the comment box for guests on your public preview page, for links made with "Allow comments".

## 5. Review is opt-in

Nothing changes until a collection asks for it:

```ts
defineCollection({ slug: "guide", review: { agents: "required" } });
```

From then on an API key, or an agent acting for a person, cannot publish a version nobody approved (`review_required`). `everyone: "required"` also stops people from approving their own request.

## 6. Type changes

`CmsDoc` has `deletedAt`, `deletedBy`, `schedule`, `dueAt`, `review`. `CmsVersion` has `label`, `pinned`, `approvedBy`, `approvedAt`. `DocSummary` has `schedule` and `review`; `DocCounts` has `scheduled` and `review`. `CmsAsset` has `deletedAt`, `deletedBy`.

A custom `CmsRepo` has new methods (`updateVersion`, comments, releases, filters, presence), and `findDoc`, `findDocById` and `findAsset` take `{ trashed }`. `MemoryRepo` and `DrizzleRepo` implement them.
