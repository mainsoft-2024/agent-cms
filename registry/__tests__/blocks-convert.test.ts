// The block editor's model: markdown → blocks → markdown loses nothing, and the
// editing commands (marks, links, typed markdown) work on spans.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { blocksToClipboard, blocksToMarkdown, markdownToBlocks, sameMarkdown, type EBlock, type TextBlock } from "../cms/cms-blocks-convert";
import { autoFormat, hasMark, insertText, linkAt, mdToSpans, setLink, sliceSpans, spansToMd, toggleMark, type Span } from "../cms/cms-blocks-inline";

const root = new URL("../../", import.meta.url).pathname;
const files = ["README.md", "CHANGELOG.md", "TODO.md", ...readdirSync(`${root}docs/roadmap`).map((f) => `docs/roadmap/${f}`)];
const fresh = (bs: EBlock[]) => bs.map((b) => ({ ...b, orig: undefined }));

test("blocks: every markdown file in the repository survives the block editor, untouched and rewritten", () => {
  const bad: string[] = [];
  for (const f of files) {
    const md = readFileSync(root + f, "utf8");
    const blocks = markdownToBlocks(md);
    if (!sameMarkdown(md, blocksToMarkdown(blocks))) bad.push(`${f} (kept)`);
    // Written fresh from the blocks (as after an edit everywhere). Fences of four or more backticks are beyond the parser.
    if (!/````/.test(md) && !sameMarkdown(md, blocksToMarkdown(fresh(blocks)))) bad.push(`${f} (fresh)`);
  }
  assert.deepEqual(bad, []);
});

test("blocks: untouched documents come back byte for byte", () => {
  const bad = files.filter((f) => {
    const md = readFileSync(root + f, "utf8").replace(/^\n+|\n+$/g, "");
    return blocksToMarkdown(markdownToBlocks(md)) !== md;
  });
  assert.deepEqual(bad, []);
});

test("blocks: what the editor has no block for is a source block with the text as written", () => {
  const md = [":::html\n<div onclick=\"x()\">Hi</div>\n:::", "> [!tip]\n> Careful\n>\n> - more", "[[link:pricing|Pricing]]", "A ![inline](https://x.dev/a.png) picture"].join("\n\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.type === "source" ? b.kind : null]),
    [
      ["source", "html"],
      ["source", "callout"],
      ["source", "links"],
      ["source", "p"],
    ]
  );
  assert.equal(blocksToMarkdown(fresh(blocks)), md);
});

test("blocks: tables, columns, toggles and captioned pictures are blocks of their own now", () => {
  const md = ["| a | b |\n| --: | :-- |\n| 1 | 2 |", ":::columns\n:::col\nLeft\n:::col\nRight\n:::", "![Alt](asset:abcdefabcdef/pic.png \"Other caption\")", ":::toggle More\nInside\n:::"].join("\n\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["table", "columns", "col", "p", "col", "p", "media", "toggle", "p"]
  );
  assert.ok(sameMarkdown(md, blocksToMarkdown(fresh(blocks))), blocksToMarkdown(fresh(blocks)));
});

test("blocks: the editor's own blocks map both ways", () => {
  const md = "## Title\n\n### Sub\n\nSome **bold *both*** and `code`, ~~gone~~, a [link](https://x.dev), a [file](asset:f1f1f1f1f1f1/a.pdf) and [[link:pricing|Pricing]].\\\nNext line.\n\n- one\n- two\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] todo\n\n> quoted\n\n> [!warning]\n> Mind the gap\n\n```ts\nconst a = 1;\n```\n\n---\n\n![Alt text](asset:img1img1img1/p.png)";
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["h2", "h3", "p", "bullet", "bullet", "number", "number", "todo", "todo", "quote", "callout", "code", "hr", "media"]
  );
  assert.equal((blocks[5] as TextBlock).start, 3);
  assert.ok(sameMarkdown(md, blocksToMarkdown(fresh(blocks))), blocksToMarkdown(fresh(blocks)));
  assert.ok(blocksToMarkdown(fresh(blocks)).includes("3. third\n4. fourth"));
});

test("blocks: two lists in a row stay two lists; empty lines vanish", () => {
  const md = "- a\n- b\n\n<!-- -->\n\n- c";
  const blocks = markdownToBlocks("- a\n- b");
  const two: EBlock[] = [...blocks, { id: "x", type: "p", spans: [] }, { id: "y", type: "bullet", spans: [{ text: "c" }] }];
  assert.equal(blocksToMarkdown(fresh(two)), "- a\n- b\n\n- c");
  void md;
  const back = markdownToBlocks("1. a\n\n---\n\n1. b");
  assert.equal(blocksToMarkdown(fresh(back)), "1. a\n\n---\n\n1. b");
});

test("blocks: an untouched block keeps its exact text; a changed one is written fresh", () => {
  const md = "Some *odd*   spacing  here\n\n* star list";
  const blocks = markdownToBlocks(md);
  assert.equal(blocksToMarkdown(blocks), md);
  const edited = blocks.map((b, i) => (i === 0 ? { ...(b as TextBlock), spans: [{ text: "Changed" }] } : b));
  assert.equal(blocksToMarkdown(edited), "Changed\n\n* star list");
  assert.equal(blocksToClipboard(blocks), "Some *odd*   spacing  here\n\n- star list");
});

test("spans: marks stay open across spans and spaces stay outside them", () => {
  assert.equal(spansToMd([{ text: "a ", b: true }, { text: "b", b: true, code: true }, { text: " c" }]), "**a `b`** c");
  assert.equal(spansToMd([{ text: "2*3 [x]" }]), "2\\*3 \\[x\\]");
  assert.equal(spansToMd([{ text: "one" }, { text: "\n" }, { text: "two" }]), "one\\\ntwo");
  for (const md of ["**bold *both***", "a [link **x**](https://x.dev) b", "`a ` b`` c", "[[link:pricing|Pricing]] and ~~old~~"]) assert.equal(spansToMd(mdToSpans(md)).length > 0, true, md);
  assert.deepEqual(mdToSpans("**a *b***"), [{ text: "a ", b: true }, { text: "b", b: true, i: true }]);
});

test("spans: toggling marks, links and typed markdown", () => {
  const s: Span[] = [{ text: "hello world" }];
  const bold = toggleMark(s, 0, 5, "b");
  assert.equal(spansToMd(bold), "**hello** world");
  assert.ok(hasMark(bold, 0, 5, "b"));
  assert.equal(spansToMd(toggleMark(bold, 0, 5, "b")), "hello world");
  assert.equal(spansToMd(toggleMark(bold, 0, 11, "b")), "**hello world**");
  const linked = setLink(s, 6, 11, "https://x.dev");
  assert.equal(spansToMd(linked), "hello [world](https://x.dev)");
  assert.deepEqual(linkAt(linked, 8), { href: "https://x.dev", from: 6, to: 11 });
  assert.equal(spansToMd(setLink(linked, 6, 11, null)), "hello world");
  assert.deepEqual(sliceSpans(bold, 3, 8), [{ text: "lo", b: true }, { text: " wo" }]);
  assert.equal(spansToMd(insertText(bold, 5, "!", { b: true })), "**hello!** world");
  const typed = autoFormat([{ text: "say **hi**" }], 10)!;
  assert.equal(spansToMd(typed.spans), "say **hi**");
  assert.deepEqual(typed.spans, [{ text: "say " }, { text: "hi", b: true }]);
  assert.equal(typed.caret, 6);
  assert.deepEqual(autoFormat([{ text: "a *b*" }], 5)!.spans, [{ text: "a " }, { text: "b", i: true }]);
  assert.deepEqual(autoFormat([{ text: "run `npm i`" }], 11)!.spans, [{ text: "run " }, { text: "npm i", code: true }]);
  assert.equal(autoFormat([{ text: "2 * 3 * 4" }], 9), null);
  assert.equal(autoFormat([{ text: "**" }], 2), null);
});

test("blocks: steps, link cards, videos, snippets and pinned anchors are blocks and come back as written", () => {
  const md = [
    ":::steps\n**Install** the package.\n\n- run it\n:::",
    ":::card\n[Pricing](/pricing)\n![Plans](asset:abcdefghijkl/plan%20a.png)\nWhat each plan costs\n:::",
    ":::card\n[Docs](https://example.com/docs)\n:::",
    ":::video\nhttps://www.youtube.com/watch?v=abc123\nThe tour\n:::",
    ":::video\nasset:abcdefghijkl/tour.mp4\n:::",
    "## Setup {#setup-guide}",
    "[[snippet:support-contact]]",
    "Call [[snippet:support_line]] today.",
  ].join("\n\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.filter((b) => !b.parent).map((b) => b.type),
    ["steps", "card", "card", "video", "video", "h2", "snippet", "p"]
  );
  const steps = blocks.find((b) => b.type === "steps")!;
  assert.deepEqual(blocks.filter((b) => b.parent === steps.id).map((b) => b.type), ["p", "bullet"]);
  const card = blocks.find((b) => b.type === "card") as Extract<EBlock, { type: "card" }>;
  assert.equal(card.href, "/pricing");
  assert.equal(card.image, "asset:abcdefghijkl/plan%20a.png");
  assert.equal(card.alt, "Plans");
  assert.equal((blocks.find((b) => b.type === "h2") as TextBlock).anchor, "setup-guide");
  assert.equal((blocks.find((b) => b.type === "snippet") as Extract<EBlock, { type: "snippet" }>).key, "support-contact");
  assert.equal(blocksToMarkdown(blocks), md);
  assert.equal(blocksToMarkdown(fresh(blocks)), md);
});

test("blocks: new blocks not in the exact form stay source blocks, and edited ones write the exact form", () => {
  for (const odd of [":::card\nno link here\n:::", ":::video\nhttp://insecure.example/v\n:::", ":::card\n[A](/a)\none\ntwo\n:::"]) {
    const blocks = markdownToBlocks(odd);
    assert.deepEqual(blocks.map((b) => b.type), ["source"], odd);
    assert.equal(blocksToMarkdown(fresh(blocks)), odd);
  }
  const blocks = fresh(markdownToBlocks(":::card\n[A](/a)\n:::\n\n:::video\nhttps://vimeo.com/1\n:::\n\n## Title {#keep}"));
  const card = blocks[0] as Extract<EBlock, { type: "card" }>;
  card.label = "Two\nlines";
  card.description = "![not a picture](x)";
  card.image = "asset:abcdefghijkl/my file (1).png";
  card.alt = "Alt";
  (blocks[1] as Extract<EBlock, { type: "video" }>).caption = ":::sneaky";
  delete (blocks[2] as TextBlock).anchor;
  const out = blocksToMarkdown(blocks);
  assert.equal(out, ":::card\n[Two lines](/a)\n![Alt](asset:abcdefghijkl/my%20file%201.png)\n[not a picture](x)\n:::\n\n:::video\nhttps://vimeo.com/1\nsneaky\n:::\n\n## Title");
  assert.deepEqual(markdownToBlocks(out).map((b) => b.type), ["card", "video", "h2"]);
  // An empty steps block writes nothing inside; a video without an address writes nothing.
  assert.equal(blocksToMarkdown([{ id: "s", type: "steps" }]), ":::steps\n:::");
  assert.equal(blocksToMarkdown([{ id: "v", type: "video", src: "", caption: "x" }]), "");
});

test("blocks: #### headings and snippets inside a line convert both ways", () => {
  const md = "#### Rotate {#rotate}\n\n#### Plain\n\nCall [[snippet:support-phone]] now.";
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["h4", "h4", "p"],
  );
  assert.equal(blocksToMarkdown(blocks), md);
  assert.equal(blocksToMarkdown(fresh(blocks)), md);
  // The token stays as written in the text (not escaped).
  assert.equal(spansToMd((blocks[2] as TextBlock).spans), "Call [[snippet:support-phone]] now.");
});
