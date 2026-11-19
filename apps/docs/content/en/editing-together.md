---
title: Editing together
summary: Conflicts, merging, autosave, agent review, preview links and bulk actions.
category: Guides
order: 3
---
People and agents edit the same documents, so agent-cms never lets one save silently overwrite another.

## Conflicts

A document GET sends `ETag: "v<n>"`. Send it back as `If-Match` on PATCH or DELETE, or pass `expectedVersion`. When someone saved in between, the write fails with `conflict_version` (409) and carries the other copy as `current`. `requireIfMatch: true` on the handler refuses writes without a version (428).

## Merge

`mergeDocs(base, mine, theirs)` from `@mainsoft/agent-cms/diff` (browser-safe) merges the body line by line and the other values field by field. Where both sides changed the same lines, you pick theirs, mine or both; "both" puts theirs first, then mine. The editor opens the **Merge** screen for this.

## Autosave

The editor keeps unsaved edits with `PUT …/autosave` without creating versions, and offers to restore them.

## Agent changes

Each body hunk that an API key or your assistant saved is a review item until a person accepts it or reverts it:

```ts
const open = await cms.agentChanges(actor, "docs", "install");
await cms.reviewChanges(actor, "docs", "install", { hunks: "all" });
```

In the editor every agent block has **Accept** and **Revert**, and the toolbar has **Accept all**. Reverts are saved as one version.

## Draft preview links

With `previewSecret` (32+ characters) on `createCms`, sign a link to one exact version:

```ts
const { url } = await cms.createPreviewLink(actor, "posts", "hello", { ttl: "24h" });
```

Your public page reads it:

```ts
const token = searchParams.cms_preview;
const doc = token ? (await cms.readPreview(token)).doc : await cms.get(anon, "posts", slug);
```

Links cannot be revoked one by one; rotating `previewSecret` revokes all.

## Bulk actions

```ts
await cms.bulk(actor, "posts", "publish", [{ slug: "a" }, { slug: "b" }]);
```

Actions: `publish`, `unpublish`, `archive`, `unarchive`, `delete`. Each document runs on its own and you get `{ slug, ok, error? }` for each.
