// The block editor's converter: markdown → blocks → markdown loses nothing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { blocksToMarkdown, fingerprint, inlineMd, markdownToBlocks, sameMarkdown } from "../cms/cms-blocks-convert";

const root = new URL("../../", import.meta.url).pathname;
const files = ["README.md", "CHANGELOG.md", "TODO.md", ...["en", "ko"].flatMap((l) => readdirSync(`${root}apps/docs/content/${l}`).map((f) => `apps/docs/content/${l}/${f}`))];

test("blocks: every markdown file in the repository survives the block editor, untouched and rewritten", () => {
  const bad: string[] = [];
  for (const f of files) {
    const md = readFileSync(root + f, "utf8");
    const { blocks, sources } = markdownToBlocks(md);
    const kept = blocksToMarkdown(blocks, (b) => (b.id ? sources[b.id] : undefined));
    if (!sameMarkdown(md, kept)) bad.push(`${f} (kept)`);
    // Written fresh from the blocks (as after an edit everywhere). Fences of four or more backticks are beyond the parser.
    if (!/````/.test(md) && !sameMarkdown(md, blocksToMarkdown(blocks))) bad.push(`${f} (fresh)`);
  }
  assert.deepEqual(bad, []);
});

test("blocks: what the editor cannot show is a source block with the text as written", () => {
  const md = [":::html\n<div onclick=\"x()\">Hi</div>\n:::", "> [!tip]\n> Careful", "| a | b |\n| --: | :-- |\n| 1 | 2 |", ":::columns\n:::col\nLeft\n:::col\nRight\n:::", "![Alt](asset:abcdefabcdef/pic.png \"Other caption\")"].join("\n\n");
  const { blocks } = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.props?.kind]),
    [
      ["cmsSource", "html"],
      ["cmsSource", "callout"],
      ["cmsSource", "table"],
      ["cmsSource", "columns"],
      ["cmsSource", "media"],
    ]
  );
  assert.equal(blocksToMarkdown(blocks), md);
});

test("blocks: the editor's own blocks map both ways", () => {
  const md = "## Title\n\nSome **bold *both*** and `code`, ~~gone~~, a [link](https://x.dev), a [file](asset:f1f1f1f1f1f1/a.pdf) and [[link:pricing|Pricing]].\\\nNext line.\n\n- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n> quoted\n\n```ts\nconst a = 1;\n```\n\n---\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n\n![Alt text](asset:img1img1img1/p.png)\n\n:::toggle More\nInside\n:::";
  const { blocks } = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "bulletListItem", "bulletListItem", "numberedListItem", "numberedListItem", "checkListItem", "checkListItem", "quote", "codeBlock", "divider", "table", "image", "toggleListItem"]
  );
  assert.ok(sameMarkdown(md, blocksToMarkdown(blocks)), blocksToMarkdown(blocks));
});

test("blocks: an untouched block keeps its exact text; a changed one is written fresh", () => {
  const md = "Some *odd*   spacing  here\n\n* star list";
  const { blocks, sources } = markdownToBlocks(md);
  const before = Object.fromEntries(blocks.map((b) => [b.id!, fingerprint(b)]));
  const keep = (b: (typeof blocks)[number]) => (b.id && before[b.id] === fingerprint(b) ? sources[b.id] : undefined);
  assert.equal(blocksToMarkdown(blocks, keep).split("\n\n")[0], "Some *odd*   spacing  here");
  const edited = blocks.map((b, i) => (i === 0 ? { ...b, content: [{ type: "text", text: "Changed", styles: {} }] } : b));
  assert.equal(blocksToMarkdown(edited, keep).split("\n\n")[0], "Changed");
});

test("blocks: marks stay open across runs and spaces stay outside them", () => {
  assert.equal(inlineMd([{ type: "text", text: "a ", styles: { bold: true } }, { type: "text", text: "b", styles: { bold: true, code: true } }, { type: "text", text: " c", styles: {} }]), "**a `b`** c");
  assert.equal(inlineMd([{ type: "text", text: "2*3 [x]", styles: {} }]), "2\\*3 \\[x\\]");
});
