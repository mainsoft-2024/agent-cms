// The block editor's document on ProseMirror: markdown → blocks → editor document → blocks →
// markdown keeps every byte of what was not edited, and an edit in one block changes only that block.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { blocksToMarkdown, keepEdges, markdownToBlocks, refreshFingerprints, sameMarkdown, type EBlock } from "../cms/cms-blocks-convert";
import { Transform } from "@tiptap/pm/transform";
import { blockAt, cmsSchema, docNode, docToBlocks, textStartOf } from "../cms/cms-blocks-pm";

const root = new URL("../../", import.meta.url).pathname;
const files = ["README.md", "CHANGELOG.md", "TODO.md", ...readdirSync(`${root}docs/roadmap`).map((f) => `docs/roadmap/${f}`)];

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

test("editor document: steps, cards, videos, snippets and pinned anchors map both ways", () => {
  const md = [
    ":::steps\n**One** first.\n\n**Two** next.\n:::",
    ":::card\n[Docs](https://example.com)\n![](https://example.com/a.png)\nRead them\n:::",
    ":::video\nhttps://youtu.be/xyz\nCaption\n:::",
    "## Pinned {#pin-me}",
    "[[snippet:footer]]",
  ].join("\n\n");
  const { doc, save } = load(md);
  assert.deepEqual(
    (() => {
      const names: string[] = [];
      doc.forEach((n) => names.push(n.type.name));
      return names;
    })(),
    ["steps", "card", "video", "heading", "snippet"]
  );
  assert.equal(doc.child(0).childCount, 2);
  assert.equal(doc.child(3).attrs.anchor, "pin-me");
  assert.equal(save(), md);
  const fresh = blocksToMarkdown(docToBlocks(doc));
  assert.equal(fresh, md);
  // Unpinning the heading and changing the card's description rewrite only those blocks.
  const tr = new Transform(doc);
  let headingPos = -1;
  let cardPos = -1;
  doc.forEach((n, pos) => {
    if (n.type.name === "heading") headingPos = pos;
    if (n.type.name === "card") cardPos = pos;
  });
  tr.setNodeAttribute(headingPos, "anchor", null);
  tr.setNodeAttribute(cardPos, "description", "Changed");
  assert.equal(save(tr.doc), md.replace(" {#pin-me}", "").replace("Read them", "Changed"));
});

test("editor document: a #### pinned to a ## id keeps what was written (the page gives it setup-1)", () => {
  const md = "## Setup\n\n#### Details {#setup}";
  const blocks = markdownToBlocks(md);
  assert.equal((blocks[1] as EBlock & { anchor?: string }).anchor, "setup");
  const { doc, save } = load(md);
  assert.equal(save(), md);
  assert.equal(blocksToMarkdown(docToBlocks(doc)), md, "written fresh, the pin is not rewritten to setup-1");
});

test("editor document: #### is a level 4 heading block, with its pinned anchor, both ways", () => {
  const md = "## Two\n\n### Three\n\n#### Four {#four-pin}\n\n#### Plain four";
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["h2", "h3", "h4", "h4"],
  );
  assert.equal((blocks[2] as EBlock & { anchor?: string }).anchor, "four-pin");
  const { doc, save } = load(md);
  const levels: number[] = [];
  doc.forEach((n) => levels.push(n.attrs.level as number));
  assert.deepEqual(levels, [2, 3, 4, 4]);
  assert.equal(save(), md);
  assert.equal(blocksToMarkdown(docToBlocks(doc)), md, "written fresh, the same");
  // Turning a heading into level 4 writes ####.
  const tr = new Transform(doc);
  tr.setNodeAttribute(0, "level", 4);
  assert.equal(save(tr.doc).split("\n")[0], "#### Two");
});

test("editor document: a snippet inside a line is an inline chip and writes back exactly [[snippet:key]]", () => {
  const md = "Call [[snippet:support-phone]] or write to **[[snippet:support-mail]]** today.\n\n[[snippet:footer]]\n\n`[[snippet:in-code]]` stays code.";
  const { doc, save } = load(md);
  const chips: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "snippetRef") chips.push(n.attrs.key as string);
  });
  assert.deepEqual(chips, ["support-phone", "support-mail"], "two chips; the one in code stays text");
  assert.equal(doc.child(1).type.name, "snippet", "a token alone on its line is still the snippet block");
  assert.equal(save(), md);
  assert.equal(blocksToMarkdown(docToBlocks(doc)), md, "written fresh, the same");
  // Changing a chip's key changes only that token; a chip without a key writes nothing.
  let first = -1;
  doc.descendants((n, pos) => {
    if (n.type.name === "snippetRef" && first < 0) first = pos;
  });
  const tr = new Transform(doc);
  tr.setNodeAttribute(first, "key", "sales-phone");
  assert.equal(save(tr.doc).split("\n")[0], "Call [[snippet:sales-phone]] or write to **[[snippet:support-mail]]** today.");
  const tr2 = new Transform(doc);
  tr2.setNodeAttribute(first, "key", "");
  assert.equal(save(tr2.doc).split("\n")[0], "Call  or write to **[[snippet:support-mail]]** today.");
  // Typed in: a chip put into a line.
  const s = cmsSchema();
  const p = s.nodes.paragraph.create({ bid: "x" }, [s.text("See "), s.nodes.snippetRef.create({ key: "terms" }), s.text(".")]);
  const made = s.nodes.doc.create(null, [p]);
  assert.equal(blocksToMarkdown(docToBlocks(made)), "See [[snippet:terms]].");
});

test("editor document: an escaped \\[[snippet:x]] is text, not a chip, and stays escaped; the server reads the same tokens", async () => {
  const { snippetKeys } = await import("@mainsoft/agent-cms/markdown");
  const md = "Write \\[[snippet:vat]] for the note, or use [[snippet:vat]] and `[[snippet:code]]` here.\n\n\\[[snippet:footer]]";
  const { doc, save } = load(md);
  const chips: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "snippetRef") chips.push(n.attrs.key as string);
  });
  assert.deepEqual(chips, snippetKeys(md), "chips are exactly the tokens the server fills in");
  assert.deepEqual(chips, ["vat"]);
  assert.equal(doc.child(1).type.name, "paragraph", "an escaped token alone on its line is text, not the snippet block");
  assert.ok(doc.textContent.includes("Write [[snippet:vat]] for the note"), doc.textContent);
  assert.equal(save(), md, "nothing edited: byte for byte");
  // Written fresh (the clipboard, a changed block): the literal stays escaped, the chip stays a token.
  const fresh = blocksToMarkdown(docToBlocks(doc));
  assert.deepEqual(snippetKeys(fresh), ["vat"], fresh);
  assert.ok(sameMarkdown(fresh, md), fresh);
  // Typed text that looks like a token is text too (only the menu makes chips).
  const s = cmsSchema();
  const typed = s.nodes.doc.create(null, [s.nodes.paragraph.create({ bid: "t" }, [s.text("See [[snippet:terms]].")])]);
  const out = blocksToMarkdown(docToBlocks(typed));
  assert.deepEqual(snippetKeys(out), [], out);
});
