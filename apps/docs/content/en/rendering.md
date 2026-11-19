---
title: Rendering
summary: Turn a document body into your own components.
category: Guides
order: 5
---
`@mainsoft/agent-cms/markdown` runs in the browser and on the server. `parseMarkdown` gives a small block tree; you render it with your own components.

```ts
import { extractToc, parseMarkdown } from "@mainsoft/agent-cms/markdown";

const blocks = parseMarkdown(doc.body);
const toc = extractToc(blocks);
```

## Blocks

- `heading` (levels 2 and 3) with a stable `id` for anchors
- `p`, `list` (ordered or not), `hr`
- `quote`, with an optional callout kind: `> [!tip]`, `> [!note]`, `> [!warning]`
- `code` with its language
- `links`: a row of `[[link:key|label]]` app links

Inline parts are `text`, `strong`, `code`, `link` and app links.

## Example

This site renders every page this way: headings get anchor links, callouts become the amber notes, and shell code blocks get npm, pnpm, yarn and bun tabs.
