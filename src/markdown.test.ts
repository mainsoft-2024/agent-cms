import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseInline, parseMarkdown, plainText, sameBlocks, toMarkdown, assetUses, type Block } from "./markdown";

const root = join(import.meta.dirname, "..");

function mdFiles(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) mdFiles(p, out);
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}

const bodyOf = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, "");

test("markdown: every markdown file in the repository reads back the same after toMarkdown", () => {
  const files = [
    ...mdFiles(join(root, "docs")),
    ...["README.md", "CHANGELOG.md", "TODO.md", ...readdirSync(root).filter((f) => /^UPGRADE-.*\.md$/.test(f))].map((f) => join(root, f)),
  ];
  assert.ok(files.length > 20, `found ${files.length} files`);
  for (const f of files) {
    const a = parseMarkdown(bodyOf(readFileSync(f, "utf8")));
    const md = toMarkdown(a);
    const b = parseMarkdown(md);
    if (!sameBlocks(a, b)) {
      const i = a.findIndex((x, k) => !sameBlocks([x], b[k] ? [b[k]] : []));
      assert.fail(`${f}: block ${i} changed\n${JSON.stringify(a[i])}\n${JSON.stringify(b[i])}`);
    }
    // Writing twice gives the same text (no drift).
    assert.equal(toMarkdown(b), md, f);
  }
});

test("markdown: italic, strike, nesting, escapes and line breaks", () => {
  assert.deepEqual(parseInline("a *b* _c_ ~~d~~"), [
    { t: "text", v: "a " },
    { t: "em", v: "b" },
    { t: "text", v: " " },
    { t: "em", v: "c" },
    { t: "text", v: " " },
    { t: "del", v: "d" },
  ]);
  assert.deepEqual(parseInline("snake_case_name and 5 * 3 * 2"), [{ t: "text", v: "snake_case_name and 5 * 3 * 2" }]);
  assert.deepEqual(parseInline("***both***"), [{ t: "strong", v: "both", kids: [{ t: "em", v: "both" }] }]);
  assert.deepEqual(parseInline("**see [x](/y)**")[0], { t: "strong", v: "see x", kids: [{ t: "text", v: "see " }, { t: "link", href: "/y", v: "x" }] });
  assert.deepEqual(parseInline("\\*not\\* bold"), [{ t: "text", v: "*not* bold" }]);
  assert.deepEqual(parseInline("``a ` b``"), [{ t: "code", v: "a ` b" }]);
  const [p] = parseMarkdown("one\\\ntwo");
  assert.deepEqual(p, { t: "p", inline: [{ t: "text", v: "one" }, { t: "br", v: "\n" }, { t: "text", v: "two" }] });
  // Old documents: ** with no markup inside stays as before.
  assert.deepEqual(parseInline("**plain**"), [{ t: "strong", v: "plain" }]);
});

test("markdown: tables, task lists, list start, toggle, columns, html and unknown blocks", () => {
  const src = [
    "| Name | Size |",
    "| :--- | ---: |",
    "| a \\| b | `x|y` |",
    "| c | 2 |",
    "",
    "- [ ] write",
    "- [x] review",
    "",
    "3. three",
    "4. four",
    "",
    ":::toggle More **detail**",
    "Hidden text.",
    "",
    "- item",
    ":::",
    "",
    ":::columns",
    ":::col",
    "Left",
    ":::col",
    ":::toggle Inside",
    "deep",
    ":::",
    ":::",
    "",
    ":::html",
    '<div onclick="x()">Hi</div>',
    "",
    "<script>alert(1)</script>",
    ":::",
    "",
    ":::youtube abc",
    "keep me",
    ":::",
  ].join("\n");
  const blocks = parseMarkdown(src, { lines: true });
  const kinds = blocks.map((b) => b.t);
  assert.deepEqual(kinds, ["table", "todo", "list", "toggle", "columns", "html", "raw"]);
  const table = blocks[0] as Extract<Block, { t: "table" }>;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.rows[0][0], [{ t: "text", v: "a | b" }]);
  assert.deepEqual(table.rows[0][1], [{ t: "code", v: "x|y" }]);
  assert.deepEqual((blocks[1] as Extract<Block, { t: "todo" }>).items.map((i) => i.checked), [false, true]);
  assert.equal((blocks[2] as Extract<Block, { t: "list" }>).start, 3);
  const toggle = blocks[3] as Extract<Block, { t: "toggle" }>;
  assert.equal(toggle.text, "More detail");
  assert.deepEqual(toggle.blocks.map((b) => b.t), ["p", "list"]);
  const cols = blocks[4] as Extract<Block, { t: "columns" }>;
  assert.equal(cols.cols.length, 2);
  assert.equal(cols.cols[1][0].t, "toggle");
  const html = blocks[5] as Extract<Block, { t: "html" }>;
  assert.equal(html.v, '<div onclick="x()">Hi</div>\n\n<script>alert(1)</script>');
  assert.equal(blocks[5].line, 27);
  assert.equal(blocks[5].endLine, 31);
  assert.equal((blocks[6] as Extract<Block, { t: "raw" }>).v, ":::youtube abc\nkeep me\n:::");
  assert.ok(sameBlocks(parseMarkdown(toMarkdown(blocks)), blocks));
  // HTML text is kept byte for byte.
  assert.ok(toMarkdown(blocks).includes('<div onclick="x()">Hi</div>\n\n<script>alert(1)</script>'));
});

test("markdown: paragraphs that look like other blocks are written with a backslash", () => {
  const cases: Block[] = [
    { t: "p", inline: [{ t: "text", v: "# not a heading" }] },
    { t: "p", inline: [{ t: "text", v: "2026. A year" }] },
    { t: "p", inline: [{ t: "text", v: "- not a list" }] },
    { t: "p", inline: [{ t: "text", v: "> not a quote" }] },
    { t: "p", inline: [{ t: "text", v: ":::toggle no" }] },
    { t: "p", inline: [{ t: "text", v: "a **b** c" }] },
    { t: "list", ordered: false, items: [[{ t: "text", v: "[ ] not a task" }]] },
  ];
  for (const b of cases) {
    const md = toMarkdown([b]);
    assert.ok(sameBlocks(parseMarkdown(md), [b]), `${JSON.stringify(b)} -> ${md}`);
  }
});

test("markdown: plain text and file uses know the new blocks", () => {
  const body = "## T\n\n:::html\n<p>Hello <b>you</b></p><img src=\"asset:abcdefabcdef/x.png\">\n:::\n\n| a | b |\n| - | - |\n| c | d |\n\n- [x] done ~~gone~~";
  const text = plainText(body);
  assert.ok(text.includes("Hello"));
  assert.ok(!text.includes("<b>"));
  assert.ok(!text.includes("[x]"));
  assert.ok(!text.includes("~~"));
  assert.deepEqual(assetUses(body).map((u) => [u.id, u.as, u.line]), [["abcdefabcdef", "html", 4]]);
});

test("markdown: a numbered list starting at 0 renders from 0", async () => {
  const { markdownToHtml } = await import("./html");
  assert.match(markdownToHtml("0. Setup\n1. Run"), /<ol start="0">/);
});
