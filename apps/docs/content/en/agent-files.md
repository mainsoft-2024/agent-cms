---
title: Agents edit documents like code
summary: Read a document as a numbered file, search many, replace exact text, push files from your editor, keep agents' edits as suggestions, and keep HTML exactly as written.
category: Guides
order: 13
---
> [!note]
> New in 0.15.0. Needs schema 8 (`npx @mainsoft/agent-cms migrate apply`).

## One document, one file

Every document reads as one text file: frontmatter lines (slug, title, summary, category, keywords, then one line per field) and the body. Agents read it with line numbers and change it by replacing exact text, the way coding agents edit code. The same edit works for body text, HTML blocks and fields.

```text
---
slug: new-dashboard
title: The new dashboard
cover: "asset:a8f2c0d1e2f3/banner.jpg"
---

## What changed
```

## Tools

- `read_document`: the file with line numbers; `offset` and `limit` for long documents, `outline: true` for headings and blocks with their lines.
- `grep_documents`: matching lines across documents. Literal text by default, `regex: true` for a regular expression. Narrow with `collections`, `slugs` or `glob` (`guide/2026-*`).
- `edit_document`: `edits: [{ oldString, newString, replaceAll? }]`. The old text must be unique; several edits apply in order as one version, all or none. When the text is not found, the answer lists the closest lines.
- `write_document`: the whole file. Replacing needs `expectedVersion`.
- `document_file_link`: a 10-minute link to download or upload the file.

## From the command line

```bash
npx @mainsoft/agent-cms pull guide new-dashboard
# edit guide/new-dashboard.md with any editor
npx @mainsoft/agent-cms push
```

If someone edited the document in the CMS meanwhile, `push` merges both. When both changed the same lines, the file gets `<<<<<<<` markers and nothing is saved until you fix them.

## Suggestions

With `agentEdits: "suggest"` on a collection, edits by API keys and agents wait as suggestions. A person applies or rejects them (`POST /collections/:c/:slug/suggestions/:id/apply`).

## HTML blocks and HTML documents

````text
:::html
<div class="pricing">…</div>
:::
````

HTML is stored exactly as written. Parts that would do nothing on the page (scripts, `onclick`, frames from other hosts) come back as warnings with their line. Draw HTML with `sanitizeHtml` from `@mainsoft/agent-cms/html`, or in a sandboxed frame with `isolatedHtml`. Adding or changing HTML needs the `html` permission (keys: the `html` scope). Whole-HTML documents are switched on per collection with `body: { formats: ["markdown", "html"] }`.
