# Upgrading to 0.18

**No schema change.** Install the new version and refresh copied screens:

```sh
npm i @mainsoft/agent-cms@0.18.0
npx @mainsoft/agent-cms add --update
```

0.18 makes every way of reading a document follow the same rules. If your collections use `access` (per-document rules) or `fieldAccess` (hidden fields), read the first section.

## What changes without you doing anything

- **One read policy for every copy.** Fields hidden by `fieldAccess` are removed from every copy that leaves the server, each judged on its own content and version: the published and autosave copies, old versions and their change lists, diffs (a field hidden in either version is left out of both), the `current` copy sent with a `conflict_version` error, preview links (read as a visitor), the files a preview lists, diagnostics, search hits, `grep_documents`, and the documents writes return.
- **Readers are judged on the copy they get.** A reader is checked against the published copy, not the draft (`get`, `grep`, `changedSince`, search, dashboard, file usage). The published copy no longer carries the draft's review note, schedule or due date. An editor sees the draft only of documents they may edit; of the others, the published copy.
- **API keys follow per-document rules.** A key's scopes open a collection; `access.read`, `access.write` and `access.publish` now also apply to each document for keys. A rule that only lets in people (`actor.kind === "user"`) now keeps keys out of those documents too.
- **Per-document screens and queues.** The review queue, who-is-editing presence, the tab counts and the dashboard count only documents the person may edit (or, for readers, the published copies they may read), the same way the list does.
- **Events in collections with per-document rules carry no document identity** for people who are not admins (on `/_events` and `/_changes`): the event says something changed in the collection; the slug, version, link and who did it are left out. Reload what you show; reads apply the rules.
- **Event stream resume points are exact.** Change numbers are handed out in commit order (the built-in repositories take a short lock on the change log at the end of each write's transaction), and every server tells numbered events in that order, its own included. The `ready` frame's id is where live delivery stands; a client that reconnects with `Last-Event-ID` gets exactly the numbered events after it, in order. Every numbered frame, replayed or live, carries `seq` in its data. An event the log could not take is sent without an id, so it never moves the client's position. A custom repository that does not set `changesInCommitOrder` keeps the 0.17 behaviour of waiting up to 15 seconds at a missing number.
- **The change log row is written in the same transaction as the change** for create, update, direct publish, unpublish and archive, version restore, and delete. If the log row cannot be written, the change is rolled back.
- **Versions in pages come from the database**, newest first. The cursor is now `v.<version>`. A numeric cursor from 0.17 is still answered as before (an offset, oldest first).
- **Import keeps a save when its publish fails.** Each item has `published`, `publishError` and `documentId`. The admin lists what failed and offers "Publish these again". Publishing takes a `documentId` (REST body, `client.publish`, `cms.publish`): the server publishes only that document at that version, in one step; a different document made at the same address meanwhile is refused with `document_replaced`, and an edit made meanwhile with `conflict_version`. Publish and unpublish now update the row only if it is still the version that was checked.
- **Releases are guarded on the server.** A person sees only the items they may edit; `hiddenItems` counts the rest. Renaming, scheduling, unscheduling, deleting and publishing a whole release is for admins and for people who can see every item in it (else `forbidden_release`); a blocked publish names hidden items only as hidden. Adding to a scheduled release needs permission to publish that document (it goes out later as the scheduler). Publishing a release needs a driver with transactions; without one it is refused with `transactions_required` instead of going out half way.
- **Suggestions** are bound to the document they were made on (older records without that binding are no longer shown), and someone who cannot see a field the author could see does not get the suggestion.
- **Preview links** now carry the document's id: a link never opens another document later given the same address.
- **Search** checks each hit against the very copy it was indexed from (document id and published version); a stale hit is dropped and the index rebuilt. Your `search({ filter })` sees units of collections with per-document rules only after they are authorized and projected.

## New, when you want it

- `GET /audit` filters on the server: `group` (all actions of a kind), `who` (name), `actorId`, `collection`, `slug`, `since`, `until`. The audit screen uses them and shows a timeline on phones.
- `GET /trash?q=` finds items by title, place or who deleted them.
- `migrate apply` records a checksum of each plugin's SQL; `migrate check` says when it changed since.
- `createTenantHandler({ drainMs, onError })`: a dropped tenant is disposed after its requests in progress (streams included) finish, or after `drainMs` (default 30 s). A failing `dispose` is reported to `onError` (default: a console warning).
- Admin: dashboard skeleton and retry; a document picker for trying automations (the picked document is the test target); webhook events grouped with an explicit "Every event / Only these", masked secrets and delivery words; keys start read-only with presets, an address chip input and a summary of what the key can effectively do; trash search, exact times and restore failures that stay; import results with "Publish these again"; an empty collection that puts the person first.

## Known limits

- **Change log coverage.** Scheduled publish and unpublish, release publish, trash restore, review and file events are written to the change log just after their commit, not inside it. If that write fails, or the process stops right after the commit, their notification is lost for good. A row in the log is not a promise that a subscriber or webhook received it.
- **Drivers without transactions.** A request may return an error after the document was saved. Read back its state before retrying. Use a transaction-capable driver for atomic document and log writes.
- **Preview links made before 0.18**, including links that allow comments, have no document id: until they expire they open whatever document has that address. Rotate `previewSecret` to end them all at once if that matters to you.
- **Plugin checksum.** It compares the recorded SQL text, not the live schema. With no recorded checksum there is nothing to compare, even when `migrate check` exits cleanly. Apply explicit DDL (`ALTER TABLE`; `CREATE TABLE IF NOT EXISTS` adds no columns) before recording changed SQL.
- **Tenant `drainMs` is a cutoff**, not a graceful shutdown: after it the old generation is disposed even if its factory, a request or a stream is still running. It does not cancel or wait for that work.
- **Search with per-document rules** examines up to `limit * 4 + 10` candidates before authorization. Results can be short, or empty, even when readable matches exist.
