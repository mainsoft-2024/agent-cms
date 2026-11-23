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

## Left (known)

- Archive: a relation saved by another server *after* the archive transaction commits is not stopped (it points at a hidden document). The save path warns about hidden targets on publish; no lock across the two writes.
- Delete (`remove`) still checks references before its transaction, as before 0.21.0.
