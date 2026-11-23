# Upgrading to 0.20

No schema change, no API change. The block editor screen changed engine.

## Block editor

Update the copied screens:

```sh
npx @mainsoft/agent-cms add cms-block-editor --update --yes
```

`--yes` installs the npm packages the editor imports (`@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/extensions`, `@tiptap/extension-table`, all MIT, version 3.35) with your package manager. Without it, `add` prints the command. The new file `components/cms/cms-blocks-pm.ts` holds the editor's document model; `cms-blocks-convert.ts`, `cms-blocks-tree.ts`, `cms-blocks-inline.ts` and `cms-messages.ts` are updated.

Mounting does not change: `slots={{ blockEditor: CmsBlockEditor }}`, loaded lazily. The editor needs React 18 or 19.

What stays the same:
- The body is markdown. Opening a document never saves it; untouched blocks keep their exact text (also the blank lines at both ends of the document, and numbered lists written `1. 1. 1.`).
- The markdown view, the preview window and full screen.

## Markdown

`./markdown` exports `closesFence(line, open)`. A code fence now closes only on a line of the same number of backticks or more, as in CommonMark. Code that contains a line of three backticks inside a four-backtick fence reads correctly; before, the inner line closed the block. `toMarkdown` writes a longer fence when the code needs one.
