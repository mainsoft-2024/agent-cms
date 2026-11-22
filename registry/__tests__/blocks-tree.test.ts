// The block editor's nesting: toggles, columns, nested lists and tables load from
// markdown, write back untouched byte for byte, and move without losing anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksToMarkdown, markdownToBlocks, sameMarkdown, type EBlock, type TextBlock } from "../cms/cms-blocks-convert";
import type { Span } from "../cms/cms-blocks-inline";
import { indent, makeColumns, moveTo, normalize, outdent, reachable, removeBlocks, subtree } from "../cms/cms-blocks-tree";

const fresh = (bs: EBlock[]) => bs.map((b) => ({ ...b, orig: undefined }));
const shape = (bs: EBlock[]) => {
  const map = new Map(bs.map((b) => [b.id, b]));
  const depth = (b: EBlock): number => (b.parent && map.has(b.parent) ? 1 + depth(map.get(b.parent)!) : 0);
  return bs.map((b) => `${"  ".repeat(depth(b))}${b.type}${"spans" in b ? ":" + (b as TextBlock).spans.map((s) => s.text).join("") : ""}`);
};
const find = (bs: EBlock[], text: string) => bs.find((b) => "spans" in b && (b as TextBlock).spans.map((s) => s.text).join("") === text)!;

const DOC = [
  "## Plan",
  "- one\n  - one a\n    - one a i\n  - one b\n- two",
  "1. first\n   1. inner\n2. second",
  "- [ ] task\n  - [x] sub task",
  ":::toggle More **details**\nInside the toggle.\n\n- with a list\n:::",
  ":::columns\n:::col\nLeft text\n:::col\n![Pic](asset:abcdefabcdef/p.png \"A caption\")\n\nRight text\n:::",
  "| Name | Age |\n| :-- | --: |\n| Ann | 3 |\n| Bo \\| Jo | `a|b` |",
  "Last line.",
].join("\n\n");

test("tree: nested markdown loads as blocks inside blocks", () => {
  const bs = markdownToBlocks(DOC);
  assert.deepEqual(shape(bs), [
    "h2:Plan",
    "bullet:one",
    "  bullet:one a",
    "    bullet:one a i",
    "  bullet:one b",
    "bullet:two",
    "number:first",
    "  number:inner",
    "number:second",
    "todo:task",
    "  todo:sub task",
    "toggle:More details",
    "  p:Inside the toggle.",
    "  bullet:with a list",
    "columns",
    "  col",
    "    p:Left text",
    "  col",
    "    media",
    "    p:Right text",
    "table",
    "p:Last line.",
  ]);
  const media = bs.find((b) => b.type === "media") as Extract<EBlock, { type: "media" }>;
  assert.equal(media.caption, "A caption");
});

test("tree: untouched comes back byte for byte; fresh says the same thing", () => {
  const bs = markdownToBlocks(DOC);
  assert.equal(blocksToMarkdown(bs), DOC);
  const again = blocksToMarkdown(fresh(bs));
  assert.ok(sameMarkdown(DOC, again), again);
});

test("tree: one changed block inside a toggle rewrites the toggle, keeps the rest", () => {
  const bs = markdownToBlocks(DOC);
  const p = find(bs, "Inside the toggle.") as TextBlock;
  const next = bs.map((b) => (b.id === p.id ? { ...p, spans: [{ text: "Changed." }] } : b));
  const md = blocksToMarkdown(next);
  assert.ok(md.includes(":::toggle More **details**\nChanged.\n\n- with a list\n:::"), md);
  assert.ok(md.includes("- one\n  - one a\n    - one a i"), md);
  assert.ok(md.includes("| Bo \\| Jo | `a|b` |"), md);
});

test("tree: Tab and Shift+Tab nest list items and keep the page order", () => {
  let bs = markdownToBlocks("- a\n- b\n- c\n- d");
  bs = indent(bs, [find(bs, "b").id])!;
  bs = indent(bs, [find(bs, "c").id])!;
  assert.equal(blocksToMarkdown(bs), "- a\n  - b\n  - c\n- d");
  bs = indent(bs, [find(bs, "c").id])!;
  assert.equal(blocksToMarkdown(bs), "- a\n  - b\n    - c\n- d");
  // Outdenting b takes c (after it, inside the same item) along.
  bs = outdent(bs, [find(bs, "b").id])!;
  assert.equal(blocksToMarkdown(bs), "- a\n- b\n  - c\n- d");
  assert.equal(indent(bs, [find(bs, "a").id]), null, "nothing above a");
  const nums = markdownToBlocks("1. x\n2. y\n3. z");
  const n2 = indent(nums, [find(nums, "y").id])!;
  assert.equal(blocksToMarkdown(n2), "1. x\n   1. y\n2. z");
});

test("tree: drag next to, into, and beside", () => {
  let bs = markdownToBlocks("A\n\nB\n\nC\n\n:::toggle T\nInner\n:::");
  // C before A.
  bs = moveTo(bs, [find(bs, "C").id], find(bs, "A").id, "before")!;
  assert.deepEqual(shape(bs), ["p:C", "p:A", "p:B", "toggle:T", "  p:Inner"]);
  // A into the toggle (first child).
  bs = moveTo(bs, [find(bs, "A").id], find(bs, "T").id, "first-child")!;
  assert.deepEqual(shape(bs), ["p:C", "p:B", "toggle:T", "  p:A", "  p:Inner"]);
  // B to the right of C: two columns.
  bs = moveTo(bs, [find(bs, "B").id], find(bs, "C").id, "right")!;
  assert.deepEqual(shape(bs), ["columns", "  col", "    p:C", "  col", "    p:B", "toggle:T", "  p:A", "  p:Inner"]);
  assert.equal(blocksToMarkdown(bs), ":::columns\n:::col\nC\n:::col\nB\n:::\n\n:::toggle T\nA\n\nInner\n:::");
  // A third column, left of the first one.
  bs = moveTo(bs, [find(bs, "Inner").id], find(bs, "C").id, "left")!;
  assert.deepEqual(shape(bs).slice(0, 7), ["columns", "  col", "    p:Inner", "  col", "    p:C", "  col", "    p:B"]);
  // Moving B out leaves its column empty: the column goes; C out too: back to plain blocks.
  bs = moveTo(bs, [find(bs, "B").id], find(bs, "T").id, "after")!;
  bs = moveTo(bs, [find(bs, "C").id], find(bs, "T").id, "after")!;
  assert.deepEqual(shape(bs), ["p:Inner", "toggle:T", "  p:A", "p:C", "p:B"]);
  // Not into itself.
  assert.equal(moveTo(bs, [find(bs, "T").id], find(bs, "A").id, "after"), null);
  // Alt-drag copies: the toggle with what is in it.
  const copied = moveTo(bs, [find(bs, "T").id], find(bs, "B").id, "after", true)!;
  assert.deepEqual(shape(copied).slice(-2), ["toggle:T", "  p:A"]);
  assert.equal(copied.length, bs.length + 2);
});

test("tree: removing a toggle removes what is in it; reachable skips closed toggles", () => {
  const bs = markdownToBlocks(":::toggle T\nInner\n:::\n\nAfter");
  const t = find(bs, "T");
  assert.deepEqual(shape(removeBlocks(bs, [t.id])), ["p:After"]);
  assert.deepEqual(reachable(bs, new Set()).map((b) => b.type), ["toggle", "p"]);
  assert.deepEqual(reachable(bs, new Set([t.id])).map((b) => b.type), ["toggle", "p", "p"]);
  assert.equal(subtree(bs, t.id).length, 2);
});

test("tree: new columns from the / menu write markdown the site reads", () => {
  const cols = makeColumns(3);
  cols.filter((b) => b.type === "p").forEach((b, k) => ((b as TextBlock).spans = [{ text: `c${k}` }]));
  const md = blocksToMarkdown(normalize(cols));
  assert.equal(md, ":::columns\n:::col\nc0\n:::col\nc1\n:::col\nc2\n:::");
  assert.deepEqual(shape(markdownToBlocks(md)), shape(cols));
});

test("tree: a numbered item that moved gets its new number", () => {
  let bs = markdownToBlocks("1. a\n2. b\n3. c");
  bs = moveTo(bs, [find(bs, "c").id], find(bs, "a").id, "before")!;
  assert.equal(blocksToMarkdown(bs), "1. c\n2. a\n3. b");
});

test("tree: tables edit as cells and write a table", () => {
  const bs = markdownToBlocks("| a | b |\n| --- | :-: |\n| 1 | 2 |");
  const t = bs[0] as Extract<EBlock, { type: "table" }>;
  const row: Span[][] = [[{ text: "x|y" }], [{ text: "z", b: true }]];
  const next: EBlock[] = [{ ...t, rows: [...t.rows, row], align: [t.align[0], "center"] }];
  assert.equal(blocksToMarkdown(next), "| a | b |\n| --- | :---: |\n| 1 | 2 |\n| x\\|y | **z** |");
});

test("review: a paragraph Tabbed under a list item stays under it after reload", () => {
  let bs = markdownToBlocks("- Parent\n\nNotes");
  bs = indent(bs, [find(bs, "Notes").id])!;
  const md = blocksToMarkdown(bs);
  assert.equal(md, "- Parent\n\n  Notes");
  assert.deepEqual(shape(markdownToBlocks(md)), ["bullet:Parent", "  p:Notes"]);
});

test("review: moving a sibling does not nest it through its old indentation", () => {
  let bs = markdownToBlocks("- A\n  - A1\n- B");
  bs = moveTo(bs, [find(bs, "A1").id], find(bs, "A").id, "before")!;
  const md = blocksToMarkdown(bs);
  assert.equal(md, "- A1\n- A\n- B");
  bs = moveTo(bs, [find(bs, "A").id], find(bs, "A1").id, "before")!;
  assert.deepEqual(shape(markdownToBlocks(blocksToMarkdown(bs))), ["bullet:A", "bullet:A1", "bullet:B"]);
});

test("review: an empty column survives an unrelated edit; a list starting at 0 keeps its numbers", () => {
  let bs = markdownToBlocks(":::columns\n:::col\nLeft\n:::col\n:::\n\n0. Zero\n1. One\n\nNotes");
  bs = moveTo(bs, [find(bs, "Notes").id], find(bs, "Zero").id, "before")!;
  const md = blocksToMarkdown(bs);
  assert.ok(md.startsWith(":::columns\n:::col\nLeft\n:::col\n:::"), md);
  assert.ok(md.includes("0. Zero\n1. One"), md);
});

test("review: tabs inside code nested in a list survive an edit of the item; backticks in a cell stay in the cell", () => {
  const src = "- Parent\n  - Child\n\n  ```make\n  all:\n  \techo hi\n  ```";
  let bs = markdownToBlocks(src);
  const p = find(bs, "Parent") as TextBlock;
  bs = bs.map((b) => (b.id === p.id ? { ...p, spans: [{ text: "Parent!" }] } : b));
  assert.ok(blocksToMarkdown(bs).includes("  \techo hi"), blocksToMarkdown(bs));
  const t = markdownToBlocks("| A | B |\n| --- | --- |\n| a | `b|c|d` |")[0] as Extract<EBlock, { type: "table" }>;
  const edited: EBlock[] = [{ ...t, rows: [[[{ text: "a`" }], t.rows[0][1]]] }];
  const again = markdownToBlocks(blocksToMarkdown(edited))[0] as Extract<EBlock, { type: "table" }>;
  assert.equal(again.rows[0].length, 2);
  assert.equal(again.rows[0][0].map((x) => x.text).join(""), "a`");
  assert.equal(again.rows[0][1].map((x) => x.text).join(""), "b|c|d");
});
