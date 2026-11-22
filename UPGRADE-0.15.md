# Upgrading to 0.15

From 0.14.x. **Schema 8**: one new column, `cms_documents.body_format` (`text`, default `'markdown'`). Everything else is off until you use it.

## 1. Database

```sh
npx @mainsoft/agent-cms migrate check     # shows the one step
npx @mainsoft/agent-cms migrate apply     # or run the printed SQL yourself
```

The step is `ALTER TABLE cms_documents ADD COLUMN IF NOT EXISTS body_format text NOT NULL DEFAULT 'markdown'`. Existing documents stay markdown.

## 2. Screens

```sh
npx @mainsoft/agent-cms add --update            # every screen you have
npx @mainsoft/agent-cms add cms-block-editor    # optional: the block editor
```

Pass the block editor as a slot, ideally lazily:

```tsx
const CmsBlockEditor = lazy(() => import("@/components/cms/cms-block-editor"));
const slots = { blockEditor: CmsBlockEditor };
<CmsProvider slots={slots} …>
```

Without the slot the editor stays the markdown text box. The body is stored as markdown either way.

## 3. Korean screen text

The `ko` catalogs (screens and server errors) now use 음슴체 ("저장 실패", "대표 이미지 없음"). If you overrode Korean strings, check that yours still match the tone.

## 4. HTML

- `:::html` blocks and HTML documents are stored as written. What would not work on the page comes back as `html_inert` warnings.
- Adding or changing HTML needs the role permission `html` (admins have it). API keys need the new `html` scope. Running HTML (`:::html isolated` with `html: { render: "isolated" }`) needs `html_scripts`.
- To render HTML on your site use `@mainsoft/agent-cms/html` (`sanitizeHtml`, `markdownToHtml`, `bodyToSafeHtml`). Never insert a stored body as HTML without it.
- HTML documents are off: turn them on per collection with `body: { formats: ["markdown", "html"] }`.

## 5. Agents

New tools `read_document`, `grep_documents`, `edit_document`, `write_document`, `document_file_link`; the old tools stay. If an agent should only suggest, set `agentEdits: "suggest"` on the collection.

## 6. Types and behaviour

- `Inline` gains `em`, `del`, `br`, and `strong` may carry `kids`; `Block` gains `todo`, `table`, `toggle`, `columns`, `html`, `raw`, and `list.start`. A renderer with a `switch` over block types should handle (or skip) the new ones.
- `DocContent.format` (`"html"` or absent), `CollectionConfig.body.formats`, `html`, `agentEdits`, `publishChecks`.
- New error codes: `forbidden_html`, `forbidden_html_scripts`, `raw_link_invalid`, `raw_link_expired`, `suggestion_not_found`, `suggestion_stale`, `format_not_allowed`, `edit_not_found`, `edit_not_unique`, `edit_invalid`, `file_invalid`, `pattern_invalid`, `publish_check_failed`, `zip_too_large`; validation errors carry `issues`.
- `update_document`, `patch_document` and `edit_document` refuse unknown fields.
- The Node adapter ignores `X-Forwarded-For` unless `toNodeHandler(handler, { trustProxy: true })`.
- `grep` and `raw` are reserved: a collection cannot use those slugs.
