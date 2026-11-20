---
title: Publishing flow
summary: Scheduled publishing, review requests, comments, releases and the trash, and the one cron call they need.
category: Guides
order: 8
---
> [!note]
> On npm from 0.10.0. Coming from an older version? Read [Upgrade to 0.10](/docs/upgrade-0-10) first.

The editor, the document list and two more screens (`cms-trash`, `cms-releases`) cover what happens between "saved" and "public". Nothing here needs set-up except the cron call.

## The cron call

Schedules, scheduled releases and emptying the trash run when something calls one route. Their precision is the interval of that call.

```ts
// lib/cms.ts
createCms({ cronSecret: process.env.CRON_SECRET /* ... */ });
```

```json
// vercel.json
{ "crons": [{ "path": "/api/cms/_cron", "schedule": "*/10 * * * *" }] }
```

Vercel sends `Authorization: Bearer $CRON_SECRET` by itself once the project has that variable. On Vercel's Hobby plan a cron runs once a day at most, and a shorter schedule fails the deployment: keep a daily one there and let another scheduler make the frequent call (this site uses a GitHub Actions schedule every ten minutes). Anywhere else, call `GET` or `POST /api/cms/_cron` with the same header. Without `cronSecret` the route answers 404, and a wrong secret gets 401. The answer says what ran:

```json
{ "published": ["posts/launch"], "unpublished": [], "failed": [], "releases": [], "purged": { "documents": 0, "assets": 0 } }
```

## Schedule

The arrow beside "Publish" sets a time to publish and a time to unpublish, entered on the clock of `createCms({ timeZone })`.

- What goes out is the version that was current when it was scheduled. An edit after that shows a warning with "Schedule the latest version".
- The version is checked again when its time comes. A version with errors is not published; it is reported in `failed` with its error code.
- The list has a "Scheduled" tab, and each row shows its time.

## Review

```ts
defineCollection({ name: "guide", review: { agents: "required" } });
```

- `agents: "required"` keeps what an API key or an agent wrote from going public until a person approves it.
- `everyone: "required"` asks the same of people. Whoever asked cannot approve their own request.
- The editor shows the request with "Send back" and "Approve and publish". The list has an "In review" tab.
- A save while a request is open moves the request to the new version. No tool approves a review: agents can ask (`request_review`) and read the list (`list_review_requests`).

## Comments

Comments go on a section or on selected text, with replies and "Resolve".

- They follow the text while it is edited. When the text is gone they move to "Lost their place" at the bottom.
- A preview link made with "Allow comments" lets someone without an account comment. `readPreview(token)` returns `comments: true` for such a link, and `<CmsPreviewComments token={token} />` on your page shows the box (see [Preview comments](/components/cms-preview-comments)).
- Agents read, answer and resolve comments with `list_comments`, `add_comment` and `resolve_comment`.

## Releases

A release publishes several documents together, now or at a set time.

- Put a document in from the editor's menu ("Add to a release") or from the release screen. Each item is to publish or to unpublish.
- The version is pinned when the document goes in. If it was edited since, the row shows "v5 → v7".
- Publishing is all or nothing: if one document cannot go out, nothing does, and the screen lists what blocked it.
- A document is in one open release at a time. There is no rollback: to undo, unpublish or restore a version.

## Trash

Deleted documents and files stay for 30 days.

```ts
createCms({ trash: { days: 30 } }); // 0 deletes at once, as before 0.10
```

- The address of a deleted document stays taken until it is deleted for good.
- Restoring a document that was published makes it public again.
- A deleted file's public address keeps working until it is deleted for good.
- Only admins delete for good or empty the trash. The cron call removes what is older than `trash.days`.

## Smaller things

- **Editing together.** The editor and the list show who else has a document open, with their cursors in the body. When someone else saves, the editor takes the new version and merges it with unsaved edits when the two do not overlap. It asks every 15 seconds, every 3 while someone else is there; `presenceMs={0}` turns it off.
- **Paste.** Text copied from a web page or a document program is pasted as markdown (headings, lists, bold, links, tables, code). Colours and font sizes are left out, and the editor says so once.
- **Versions** take a name and a pin. Pinned versions are never cleaned up.
- **Saved filters** keep a tab, a search, a category and an author under a name, for yourself or (admins) for everyone.

## Tools for agents

Fifteen tools come with the flow: `label_version`, `preview_document`, `schedule_document`, `unschedule_document`, `request_review`, `list_review_requests`, `list_comments`, `add_comment`, `resolve_comment`, `list_trash`, `restore_from_trash`, `list_releases`, `create_release`, `add_to_release`, `publish_release`. The key's scopes decide which of them an agent sees. The routes are on the [REST API](/docs/rest-api) page.
