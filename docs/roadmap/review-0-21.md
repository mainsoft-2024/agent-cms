# 0.21.0 logic review: what was fixed, what is left

Review of the content-model commits before the 0.21.0 release. Tests: `src/review-0-21.test.ts`, plus the cases named below.

## Fixed

| Finding | Fix | Test |
| --- | --- | --- |
| P0 read-only callers read draft content through templates | `templates()` in `src/cms.ts`: without write access only name, description, icon, id, source, maker and date; writers get the content minus fields a `fieldAccess` rule hides | `templates: a read-only caller gets names only…` (core and REST) |
| P1 uploaded videos not "in use" | `assetUses()` in `src/markdown.ts` reads the address line of `:::video`, nested too | `src/media.test.ts` "an uploaded video in a :::video block…" |
| P1 plain redirect into a document-following one froze the address | `saveRedirect()` in `src/model.ts` copies `toDocumentId` when it flattens (both orders) | `redirects: a plain redirect into one that follows a document…` |
| P1 `####` moved existing anchors | Heading 4 ids are given in a second pass (`parseMarkdown`); `splitSections` and `sectionRanges` no longer count `####` | `heading 4 never moves a ## or ### anchor…` |
| P2 visits across midnight | Pending visits per day of the visit; batches being written stay visible to the series | `redirects: each visit counts on its own day…` |
| P2 tree moves without transactions | `move()` asks for an atomic transaction; drivers without one answer `transactions_required` | `src/db/drizzle.test.ts` "…without transactions" |
| P2 snippet tokens read three ways | One reader, `mapSnippetTokens()` in `src/markdown.ts`, for filling in, warnings, uses; `parseInline()` returns `{ t: "snippet" }`, which the editor turns into chips | `snippets: escaped tokens…`, `registry/__tests__/blocks-pm.test.ts` "an escaped \[[snippet:x]]…" |
| P2 gallery picker ignored `accept` | `AssetGrid` and `CmsMediaPicker` check `acceptsFile()`; refused uploads are not sent | `registry/__tests__/media.test.tsx` "gallery: files of a type the field does not take…" |
| P2 archive check, then write | The references are checked again inside the archive transaction, through the transaction's own repo (`referencedBy(id, r)`). The earlier try deadlocked pglite because it read through the outer repo, a second connection waiting on the transaction's. | `archive: a reference saved between the check and the write…` |
| P2 redirect cache kept the `access.read` answer | The cache holds the document; `publicCopy` (the rule) runs on every visit | `redirects to documents: the document is cached…` |

## Delta review

| Finding | Fix | Test |
| --- | --- | --- |
| P1 `fieldAccess` rules got a partial document from templates | `prospectiveDoc()` in `src/cms.ts` builds a complete draft (version 0, status `draft`, dates, every `CmsDoc` key). Listing templates: slug `""`; creating from one: the rule sees the document being made (its slug, title, fields). Every other place that passed `{ collection }`-only objects (new-document diagnostics, field guard on create, checks, hook errors) uses it too | `templates: fieldAccess rules see a complete draft…` |
| P1 a pinned `#### {#id}` could take a `##` / `###` id | Second pass in `parseMarkdown`: a pin that is taken gets the next free generated id (`setup-1`), the block keeps what was written (`pin`), and the body gets the warning `anchor_pin_taken` (`anchorDiagnostics` in `src/model.ts`). `##` / `###` ids never change; `sectionRanges` only looks at `##`, so it needs nothing | `heading 4 pinned to a ## / ### id…` |
| P2 video uses read line by line | `assetUses()` takes `:::video` files from the parsed tree (`videoUses()`, now also inside lists and to-dos); the line is the address line. `checkDoc` (missing files on save) uses `assetUses()`, so both agree | `video files in use come from the parsed tree…` |
| P2 redirect visits double-counted while a batch was written | Each redirect's count is written on its own and leaves `writing` in the same turn; reads of the series and those writes take turns (`hitTurn` in `src/model.ts`) | `redirects: visits being written are counted once…` |
| P2 snippet scanner and editor read backticks differently; CRLF rewritten | `scanInline()` in `src/markdown.ts` walks `INLINE_RE` exactly like `parseInline` (escaped backtick is text, bold/struck/emphasised text read inside); `mapSnippetTokens` returns untouched lines as written and keeps `\r` | `snippets: the scanner reads backticks like the inline parser…` |
| P2 CSP fell back to `https:` | No fallback: `connect-src` lists the origins stores name (Vercel Blob now names `https://vercel.com` and its store host), plus `server.connectSrc`; `media.stores.<name>.browserOrigins` for custom adapters; `serve` warns, `storage check` says so | `src/serve.test.ts` "Vercel Blob names its origins…" |
| P2 no strict video host list | `video: { hosts, defaults: false }` | `video hosts: defaults: false…` |
| P2 gallery focus lost to the generic focus return | `claimFocusReturn()` in `use-cms.ts`: the picker's target holds a claim until it has focused the new last picture; the fallback stands aside meanwhile | `registry/__tests__/media.test.tsx` "gallery: the new last picture wins…" |

## Left (known)

- Archive: the references are asked again inside the archive transaction (`referencedBy(id, r)`), but the transaction runs at the database's default isolation (read committed on Postgres) and takes no lock on the reference rows. The remaining window is between that second check and the commit: a relation saved and committed by another server in that window is not seen by the check, so the archive goes through and the new relation points at a hidden document. Closing it needs a lock both writers take (for example a row lock on the target document in the relation save path) or serializable isolation; neither is done. The save path warns about hidden targets on publish.
- Delete (`remove`) still checks references before its transaction, as before 0.21.0.
