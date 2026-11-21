---
title: cms-block-editor
summary: A Notion-style block editor for the document body. The body stays markdown.
order: 21
---

```bash
npx @mainsoft/agent-cms add cms-block-editor
```

Pass it to the provider, loaded lazily (it is the largest screen part):

```tsx
const CmsBlockEditor = lazy(() => import("@/components/cms/cms-block-editor"));
<CmsProvider baseUrl="/api/cms" slots={{ blockEditor: CmsBlockEditor }}>
```

- Built on BlockNote's MPL-2.0 core packages (`@blocknote/core`, `@blocknote/react`, `@blocknote/mantine`). No GPL packages.
- The body is still stored as markdown, so agents, the CLI, version history and search are unchanged. A block you did not touch keeps its exact text, and opening a document never saves it.
- What blocks cannot show (HTML, columns, callouts, aligned tables, images with a caption) stays as a **source block**: the markdown as written, edited as text.
- Type `/` for blocks, including an image from the media library, a callout, two columns and HTML. Pasted or dropped images go to the media library.
- The editor header has a **Blocks / Markdown** switch; the choice is remembered in the browser.
