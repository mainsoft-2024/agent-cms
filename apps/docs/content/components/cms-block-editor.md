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

- Written for agent-cms, with no editor library and no extra dependency. Each block is its own small editable element; every change goes through plain functions that are tested on their own.
- The body is still stored as markdown, so agents, the CLI, version history and search are unchanged. Opening a document never changes it, and a block you did not touch keeps its exact text (and the blank lines around it).
- What has no block of its own (HTML, columns, tables, toggles, images with a caption) is drawn as it will look; double-click or press Enter to edit its markdown in place.
- **One column**, as wide as the page it becomes. The preview opens in a window of its own (put it on a second screen); it follows every keystroke without saving. The Markdown view can still show the preview beside the text.

| Do this | How |
| --- | --- |
| Blocks menu | `/`, or `+` beside a line |
| Heading, list, to-do, quote, callout | Type `## `, `- `, `1. `, `[] `, `> `, `> [!tip] ` at the start of a line |
| Bold, italic, strike, code | Select text and use the toolbar, `Ctrl/⌘ B`, `I`, `Shift S`, `E`, or type `**text**`, `*text*`, `~~text~~`, `` `text` `` |
| Link | `Ctrl/⌘ K`, or paste a URL over selected text |
| Code block, divider | Three backticks then Enter; `---` |
| Select blocks | `Esc`, then `Shift ↑/↓`; or drag across them; `Ctrl/⌘ A` twice |
| Move blocks | Drag the handle, or `Ctrl/⌘ Shift ↑/↓` |
| Duplicate, delete, copy as markdown | The handle's menu, `Ctrl/⌘ D`, `Delete`, `Ctrl/⌘ C` |
| Images | Paste or drop them (they go to the media library), or `/image` |
| Undo, redo | `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` |
| Full screen | The **Full screen** button in the body bar, or `Ctrl/⌘ Shift F`; `Esc` leaves. The fields fold under the top bar (**Fields** opens them), and the bar fades while you type |

- The editor header has a **Blocks / Markdown** switch; the choice is remembered in the browser. The status line shows words and reading time.
