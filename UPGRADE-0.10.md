# Upgrading to 0.10

0.10.0 is the first npm release after 0.7.0 and contains 0.8.0 and 0.9.0. Coming from 0.7.0, do [UPGRADE-0.8.md](./UPGRADE-0.8.md) first. 0.9.0 needs nothing.

## 1. Schema version 4

```sh
npx agent-cms migrate check
npx agent-cms migrate apply    # or `migrate print` and run the SQL yourself
```

The step only adds things and is safe to run twice: columns on `cms_documents` (`deleted_at`, `deleted_by`, `schedule`, `due_at`, `review`), `cms_versions` (`label`, `pinned`, `approved_by`, `approved_at`) and `cms_assets` (`deleted_at`, `deleted_by`), and the tables `cms_comments`, `cms_releases`, `cms_saved_filters` and `cms_presence`. Re-export `cmsComments`, `cmsReleases`, `cmsSavedFilters` and `cmsPresence` from your Drizzle schema next to the other tables.

## 2. Deleting now means the trash

`cms.remove`, `DELETE /collections/:c/:slug`, the `delete_document` tool and deleting a file used to be final. They now put the document or file in the trash for 30 days.

- A trashed document is not found by `get`, `list`, search or agents. Its address stays taken: creating a document with the same slug fails with `slug_in_trash` until it is restored or purged.
- A trashed file's object stays in the bucket until it is purged, so a public address keeps answering until then.
- `createCms({ trash: { days: 0 } })` keeps the old behaviour. Tests that count rows after a delete want this, or `cms.trash.purge(admin, "all")`.
- Something has to call `cms.runScheduled()` for old trash to be emptied (next section).

## 3. A cron for schedules and the trash

Scheduled publishing and emptying the trash happen when `cms.runScheduled()` runs. Set `createCms({ cronSecret })` and call the route every few minutes:

```
POST /api/cms/_cron
Authorization: Bearer <cronSecret>
```

`GET` works too. Without `cronSecret` the route answers 404. On Vercel, a cron job with `CRON_SECRET` sends exactly this header. Calling it from two places at once is safe.

## 4. Type changes

`CmsDoc` has `deletedAt`, `deletedBy`, `schedule`, `dueAt`, `review`; `CmsVersion` has `label`, `pinned`, `approvedBy`, `approvedAt`; `DocSummary` has `schedule` and `review`; `DocCounts` has `scheduled` and `review`; `CmsAsset` has `deletedAt`, `deletedBy`. A custom `CmsRepo` has new methods (`updateVersion`, comments, releases, filters, presence) and `findDoc`, `findDocById`, `findAsset` take `{ trashed }`. `MemoryRepo` and `DrizzleRepo` implement them.
