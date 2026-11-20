---
title: "Document editor"
summary: "Info form generated from the collection schema, markdown with live preview, autosave and restore, problems on the fields, agent change review (accept, revert), save, publish, preview links."
order: 5
---
## Usage

```tsx
<CmsDocEditor
  collection="posts"
  slug={slug}
  onBack={() => router.push("/admin/posts")}
  onOpenVersions={(c, s) => router.push(`/admin/${c}/${s}/versions`)}
  publicUrlFor={(c, s) => `/blog/${s}`}
/>
```

Leave out `slug` to create a document. The fields form is built from the collection schema (`GET /_schema`). Blocks an agent wrote show Accept and Revert.

## Long documents

- **Section order** (above the text, from two `##` sections up): the text box becomes one card per section. Drag a card or use its arrows; the text before the first heading stays in place. A card's title jumps to that section in the text.
- **The preview follows the text.** Scrolling either side moves the other to the same block.
- **Click the preview**: a click on a block selects its lines in the text.

On wide screens the editor fills the window's height and scrolls inside itself, so the header and the problems line stay in view. If your admin has a bar above it, pass the height that is left:

```tsx
<CmsDocEditor className="md:h-[calc(100dvh-4rem)]" collection="posts" slug={slug} />
```

To render the preview yourself, `MarkdownPreview` takes `components` and `onPickLines(line, endLine)`, and `renderBlocks(blocks, components)` from `cms-parts` renders a block tree with your components.

## Install

```sh
npx @mainsoft/agent-cms add cms-doc-editor
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
