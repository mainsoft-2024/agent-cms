// The block editor's document on ProseMirror: markdown → blocks → editor document → blocks →
// markdown keeps every byte of what was not edited, and an edit in one block changes only that block.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { blocksToMarkdown, keepEdges, markdownToBlocks, refreshFingerprints, sameMarkdown, type EBlock } from "../cms/cms-blocks-convert";
import { Transform } from "@tiptap/pm/transform";
import { blockAt, cmsSchema, docNode, docToBlocks, textStartOf } from "../cms/cms-blocks-pm";

const root = new URL("../../", import.meta.url).pathname;
const files = ["README.md", "CHANGELOG.md", "TODO.md", ...readdirSync(`${root}docs/roadmap`).map((f) => `docs/roadmap/${f}`), ...readdirSync(root).filter((f) => /^UPGRADE/.test(f))];

/** What the editor does on load and on save. */
function load(md: string) {
  const blocks = markdownToBlocks(md);
  const src = new Map(blocks.map((b) => [b.id, b]));
  const doc = docNode(blocks);
  const keep = new Map(refreshFingerprints(docToBlocks(doc).map((b) => ({ ...b, orig: src.get(b.id)?.orig, gap: src.get(b.id)?.gap }) as EBlock)).map((b) => [b.id, b]));
  const save = (d = doc) => keepEdges(md, blocksToMarkdown(docToBlocks(d).map((b) => ({ ...b, orig: keep.get(b.id)?.orig, gap: keep.get(b.id)?.gap }) as EBlock)));
  return { doc, save };
}

test("editor document: every markdown file in the repository comes back byte for byte when nothing is edited", () => {
  const bad = files.filter((f) => {
    const md = readFileSync(root + f, "utf8");
    return load(md).save() !== md;
  });
  assert.deepEqual(bad, []);
});

test("editor document: written fresh from the editor's blocks, the same markdown", () => {
  const bad = files.filter((f) => {
    const md = readFileSync(root + f, "utf8");
    if (/````/.test(md)) return false;
    return !sameMarkdown(md, blocksToMarkdown(docToBlocks(docNode(markdownToBlocks(md)))));
  });
  assert.deepEqual(bad, []);
});

test("editor document: an edit in one block leaves the rest, blank lines at both ends included", () => {
  const md = "\n\n# Title\n\nFirst   paragraph *kept*  as typed.\n\n- one\n  - nested\n- two\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\nLast line.\n\n\n";
  const { doc, save } = load(md);
  const s = cmsSchema();
  // Type at the end of "Last line."
  let at = -1;
  doc.descendants((n, pos) => {
    if (n.isTextblock && n.textContent === "Last line.") at = pos + n.nodeSize - 1;
  });
  assert.ok(at > 0);
  const edited = new Transform(doc).insert(at, s.text(" More.")).doc;
  assert.equal(save(edited), md.replace("Last line.", "Last line. More."));
  // And a heading turned into a smaller one changes that line only.
  let h = -1;
  doc.descendants((n, pos) => {
    if (n.type.name === "heading") h = pos;
  });
  const smaller = new Transform(doc).setNodeAttribute(h, "level", 3).doc;
  assert.equal(save(smaller), md.replace("# Title", "### Title"));
});

test("editor document: blocks keep their ids, and positions find them", () => {
  const blocks = markdownToBlocks("Hello\n\n- item\n  - inner\n\n:::toggle Open me\nInside\n:::\n");
  const doc = docNode(blocks);
  const back = docToBlocks(doc);
  assert.deepEqual(back.map((b) => [b.type, b.parent ? back.find((x) => x.id === b.parent)?.type : null]), blocks.map((b) => [b.type, b.parent ? blocks.find((x) => x.id === b.parent)?.type : null]));
  const inner = back.find((b) => b.type === "bullet" && b.parent)!;
  const at = textStartOf(doc, inner.id);
  assert.ok(at > 0);
  assert.equal(blockAt(doc, at + 2)?.id, inner.id);
  assert.equal(blockAt(doc, at + 2)?.offset, 2);
});

test("editor document: marks, links and line breaks map both ways", () => {
  const md = "**bold** *italic* ~~gone~~ `code` [link](https://example.com) and a\\\nbreak";
  const { save, doc } = load(md);
  assert.equal(save(), md);
  const p = doc.firstChild!;
  const names = new Set<string>();
  p.forEach((c) => c.marks.forEach((m) => names.add(m.type.name)));
  assert.deepEqual([...names].sort(), ["bold", "code", "italic", "link", "strike"]);
  let breaks = 0;
  p.forEach((c) => (breaks += c.type.name === "hardBreak" ? 1 : 0));
  assert.equal(breaks, 1);
});
