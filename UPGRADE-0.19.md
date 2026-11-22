# Upgrading to 0.19

No schema change, no API change. One change in how markdown is read, and new files for the block editor.

## Nested lists

Lines indented under a list item by two spaces or more (three under `1. `) that start with a list marker are now a list **inside** that item:

```md
- Plans
  - Free
  - Pro
- Billing
```

`parseMarkdown` puts them in `kids`: for `{ t: "list" }` a `kids` array next to `items` (one entry per item, `null` when it has none), for `{ t: "todo" }` an optional `kids` on each item. Both are left out when no item has blocks inside it, so documents without indented items parse exactly as before.

Before 0.19 such lines were read as more items of the same list. Documents that have them now show the indentation they were written with. `toMarkdown`, `markdownToHtml` (`./html`) and the admin preview draw the nesting.

If you draw `parseMarkdown` blocks yourself (a site renderer), draw the kids inside the item, for example:

```tsx
case "list":
  return <L>{b.items.map((it, k) => <li key={k}>{inlines(it)}{b.kids?.[k] ? draw(b.kids[k]!) : null}</li>)}</L>;
case "todo":
  return <ul>{b.items.map((it, k) => <li key={k}>…{inlines(it.inline)}{it.kids ? draw(it.kids) : null}</li>)}</ul>;
```

## Block editor

Update the copied screens: `npx @mainsoft/agent-cms add cms-block-editor --update`. It adds `components/cms/cms-blocks-tree.ts` and updates the editor, `cms-blocks-convert.ts` and `cms-messages.ts`. Nothing else changes in how you mount it (`slots.blockEditor`).
