---
title: Versions and drafts
summary: Snapshots, publishing, restoring and comparing versions.
category: Guides
order: 2
---
Every save is a full snapshot with its author, note and changed fields.

## Drafts

With `versions: { drafts: true }` (the default), saving a published document changes its working copy only. The public page keeps showing the published version until someone publishes. The list shows these documents as **Modified since publish**.

With `drafts: false`, every save publishes (useful for release notes).

## Publish, unpublish, archive

```ts
await cms.publish(actor, "posts", "hello");
await cms.unpublish(actor, "posts", "hello");   // back to draft
await cms.archive(actor, "posts", "hello");     // hidden, kept
```

`republishedAt` records when a document goes public again.

## Restore and compare

```ts
await cms.restore(actor, "posts", "hello", 3, { publish: true });
const diff = await cms.diff(actor, "posts", "hello", 3, 5);
```

The **Version history** screen shows the same: side by side or unified, with word highlights.

## Limits

`versions.max` (default 100) keeps the newest N versions per document; the published version is always kept.
