// agent-cms: markdown ⇄ blocks for the block editor.
// The document is stored as markdown, as always. The block editor shows it as
// blocks and writes markdown back. Nothing is lost:
// - what the editor has no block for (HTML, callouts with several paragraphs,
//   page links, pictures inside a line...) becomes a "source block" holding
//   the markdown as written; the editor draws it and edits its text;
// - a block that was not touched writes its original markdown back, byte for
//   byte (a block with blocks inside it: when none of them was touched either).
//
// Blocks live in one flat list in reading order. A block inside another one
// (a nested list item, the inside of a toggle, a column) names it in `parent`
// and comes after it, before its next sibling. cms-blocks-tree.ts has the
// operations that keep that true.
// Pure functions: no React, no DOM (tested in node).

import { inlineToMarkdown, parseMarkdown, sameBlocks, toMarkdown, type Block, type Inline, type TableAlign } from "@mainsoft/agent-cms/markdown";
import { mdToSpans, spansToMd, type Span } from "./cms-blocks-inline";

export type TextType = "p" | "h2" | "h3" | "quote" | "callout" | "bullet" | "number" | "todo" | "toggle";
export const TEXT_TYPES: readonly TextType[] = ["p", "h2", "h3", "quote", "callout", "bullet", "number", "todo", "toggle"];
export type Tone = "note" | "tip" | "warning";
export const LIST_TYPES: readonly TextType[] = ["bullet", "number", "todo"];
export type { TableAlign };

interface Base {
  id: string;
  /** The block this one sits in (a list item, a toggle, a column). */
  parent?: string;
  /** The markdown this block was loaded from, and what the block (with what is inside it) looked like then. */
  orig?: { md: string; fp: string };
  /** The text between the block before it (by id, same level) and this one, as loaded. */
  gap?: { after: string; text: string };
}
export type TextBlock = Base & {
  type: TextType;
  spans: Span[];
  checked?: boolean;
  /** A callout's kind. */
  tone?: Tone;
  /** First number of a numbered list that does not start at 1. */
  start?: number;
  /** A list item that starts a new list right after another list of the same kind. */
  newList?: true;
};
export type CodeBlock = Base & { type: "code"; text: string; lang: string };
export type RuleBlock = Base & { type: "hr" };
/** An image or file on its own line: `![alt](target "caption")`. */
export type MediaBlock = Base & { type: "media"; target: string; alt: string; caption?: string };
/** A table: the first row is the header. */
export type TableBlock = Base & { type: "table"; align: TableAlign[]; head: Span[][]; rows: Span[][][] };
/** Side-by-side columns: its children are `col` blocks, theirs are the blocks of each column. */
export type ColumnsBlock = Base & { type: "columns" };
export type ColBlock = Base & { type: "col" };
/** Markdown the editor keeps as text (drawn when not being edited). */
export type SourceBlock = Base & { type: "source"; md: string; kind: string };
export type EBlock = TextBlock | CodeBlock | RuleBlock | MediaBlock | TableBlock | ColumnsBlock | ColBlock | SourceBlock;

export const isText = (b: EBlock): b is TextBlock => (TEXT_TYPES as readonly string[]).includes(b.type);
export const isList = (b: EBlock): b is TextBlock => (LIST_TYPES as readonly string[]).includes(b.type);
/** Blocks that hold other blocks. */
export const holdsBlocks = (b: EBlock) => ["bullet", "number", "todo", "toggle", "col", "columns"].includes(b.type);

let seq = 0;
export const newId = () => `k${Date.now().toString(36)}${(++seq).toString(36)}`;

// ── markdown → blocks ─────────────────────────────────────────────────────────

const hasImage = (items: Inline[]): boolean => items.some((i) => i.t === "image" || ("kids" in i && i.kids ? hasImage(i.kids) : false));

/** What a source block holds (for its label). */
export function sourceKind(b: Block): string {
  if (b.t === "html") return b.isolated ? "html-isolated" : "html";
  if (b.t === "quote" && b.callout) return "callout";
  return b.t;
}

const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s/;
const CONTAINER = /^:::([a-z][a-z0-9-]*)(?:[ \t]+(.*?))?\s*$/;
const CLOSE = /^:::\s*$/;
const FENCE = /^```/;

function indentOf(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** A line without its first `cols` columns of indentation; tabs after them are kept as written. */
function stripIndent(line: string, cols: number): string {
  let n = 0;
  let i = 0;
  while (i < line.length && n < cols && (line[i] === " " || line[i] === "\t")) {
    n += line[i] === "\t" ? 4 - (n % 4) : 1;
    i++;
  }
  return (n > cols ? " ".repeat(n - cols) : "") + line.slice(i);
}

function dedent(lines: string[]): string {
  const used = lines.filter((l) => l.trim());
  if (!used.length) return "";
  const cut = Math.min(...used.map(indentOf));
  return lines
    .map((l) => (l.trim() ? stripIndent(l, cut) : ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** The lines of each column inside `:::columns` … `:::` (same rules as the parser). */
function splitColumns(inner: string[]): string[] {
  const cols: string[][] = [];
  let depth = 0;
  for (let k = 0; k < inner.length; k++) {
    const l = inner[k];
    if (depth === 0 && /^:::col\s*$/.test(l)) {
      cols.push([]);
      continue;
    }
    if (!cols.length) cols.push([]);
    if (FENCE.test(l)) {
      cols[cols.length - 1].push(l);
      while (++k < inner.length) {
        cols[cols.length - 1].push(inner[k]);
        if (/^```\s*$/.test(inner[k])) break;
      }
      continue;
    }
    const c = CONTAINER.exec(l);
    if (c && c[1] !== "col") {
      if (c[1] === "html") {
        cols[cols.length - 1].push(l);
        while (++k < inner.length) {
          cols[cols.length - 1].push(inner[k]);
          if (CLOSE.test(inner[k])) break;
        }
        continue;
      }
      depth++;
    } else if (CLOSE.test(l)) depth--;
    cols[cols.length - 1].push(l);
  }
  return cols.map((c) => c.join("\n").replace(/^\n+|\n+$/g, ""));
}

/** The inside of a `:::name` … `:::` container, without its first and closing lines. */
function innerOf(src: string): string {
  const lines = src.split("\n");
  const end = lines.length > 1 && CLOSE.test(lines[lines.length - 1]) ? lines.length - 1 : lines.length;
  return lines.slice(1, end).join("\n").replace(/^\n+|\n+$/g, "");
}

/** Lines of a list, cut into its items; each item: its own lines, and the lines nested under it. */
function listItems(src: string): { own: string; kids: string | null }[] {
  const lines = src.split("\n");
  const base = indentOf(lines[0] ?? "");
  const out: { own: string[]; kids: string[] | null }[] = [];
  let width = 2;
  for (const line of lines) {
    const top = LIST_MARK.test(line) && indentOf(line) < base + width;
    if (top || !out.length) {
      out.push({ own: [line], kids: null });
      width = Math.max(2, (/^\s*(?:[-*+]|\d+[.)])\s/.exec(line)?.[0].length ?? 2) - indentOf(line));
      continue;
    }
    const cur = out[out.length - 1];
    // Blocks inside the item: a nested list right under it, or anything after a blank line.
    if (cur.kids || !line.trim() || (indentOf(line) >= base + width && LIST_MARK.test(line))) (cur.kids ??= []).push(line);
    else cur.own.push(line);
  }
  return out.map((x) => ({ own: x.own.map((l) => stripIndent(l, base)).join("\n"), kids: x.kids ? dedent(x.kids) : null }));
}

const spansOf = (items: Inline[]) => mdToSpans(inlineToMarkdown(items));

/** One markdown block → editor blocks (the first ones at this level, with what is inside them). */
function astToBlocks(b: Block, src: string, parent: string | undefined): EBlock[] {
  const source = (): EBlock[] => [{ id: newId(), parent, type: "source", md: src, kind: sourceKind(b) }];
  const text = (type: TextType, spans: Span[], extra: Partial<TextBlock> = {}): TextBlock => ({ id: newId(), parent, type, spans, ...extra });
  switch (b.t) {
    case "p":
      return hasImage(b.inline) ? source() : [text("p", spansOf(b.inline))];
    case "heading":
      return hasImage(b.inline) ? source() : [text(b.level === 3 ? "h3" : "h2", spansOf(b.inline))];
    case "list":
    case "todo": {
      const inlines = b.t === "list" ? b.items : b.items.map((x) => x.inline);
      if (inlines.some(hasImage)) return source();
      const chunks = listItems(src);
      if (chunks.length !== inlines.length) return source();
      const out: EBlock[] = [];
      let prev: EBlock | null = null;
      chunks.forEach((c, n) => {
        const item =
          b.t === "list"
            ? text(b.ordered ? "number" : "bullet", spansOf(inlines[n]), n === 0 && b.ordered && b.start !== undefined && b.start !== 1 ? { start: b.start } : {})
            : text("todo", spansOf(inlines[n]), { checked: b.items[n].checked });
        const kids = c.kids ? markdownToBlocks(c.kids, item.id) : [];
        // An item's text is all its lines, nested ones included, without the list's own indentation
        // (so it is right wherever the item goes). The fingerprint is set by the caller.
        item.orig = { md: c.kids !== null ? chunkText(src, n) : c.own, fp: "" };
        if (prev) item.gap = { after: prev.id, text: "\n" };
        out.push(item, ...kids);
        prev = item;
      });
      return out;
    }
    case "quote": {
      const only = b.blocks.length === 1 ? b.blocks[0] : null;
      if (!only || only.t !== "p" || hasImage(only.inline)) return source();
      return b.callout ? [text("callout", spansOf(only.inline), { tone: b.callout })] : [text("quote", spansOf(only.inline))];
    }
    case "code":
      return [{ id: newId(), parent, type: "code", text: b.v, lang: b.lang }];
    case "hr":
      return [{ id: newId(), parent, type: "hr" }];
    case "media": {
      const m = /\]\((\S+?)(?:\s+"[^"]*")?\)\s*$/.exec(src);
      return [{ id: newId(), parent, type: "media", target: m ? m[1] : (b.src ?? ""), alt: b.alt, ...(b.caption ? { caption: b.caption } : {}) }];
    }
    case "toggle": {
      if (hasImage(b.title)) return source();
      const t = text("toggle", spansOf(b.title));
      return [t, ...markdownToBlocks(innerOf(src), t.id)];
    }
    case "columns": {
      const cols = splitColumns(innerOf(src).split("\n"));
      if (cols.length < 2) return source();
      const box: EBlock = { id: newId(), parent, type: "columns" };
      const out: EBlock[] = [box];
      for (const c of cols) {
        const col: EBlock = { id: newId(), parent: box.id, type: "col" };
        const inside = markdownToBlocks(c, col.id);
        // An empty column keeps a line, so it stays a column.
        out.push(col, ...(inside.length ? inside : [{ id: newId(), parent: col.id, type: "p", spans: [] } as TextBlock]));
      }
      return out;
    }
    case "table":
      if ([...b.head, ...b.rows.flat()].some(hasImage)) return source();
      return [{ id: newId(), parent, type: "table", align: [...b.align], head: b.head.map(spansOf), rows: b.rows.map((r) => r.map(spansOf)) }];
    default:
      // html, page links, raw, and anything newer.
      return source();
  }
}

/** The lines of item `n` of a list, its nested lines included. */
function chunkText(src: string, n: number): string {
  const lines = src.split("\n");
  const base = indentOf(lines[0] ?? "");
  let item = -1;
  const out: string[] = [];
  for (const line of lines) {
    if ((LIST_MARK.test(line) && indentOf(line) < base + 2) || item < 0) item++;
    if (item === n) out.push(line.trim() ? stripIndent(line, base) : line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

/** A fingerprint of what the user can change in one block (not what is inside it). */
export function fingerprint(b: EBlock): string {
  const { id: _id, orig: _o, gap: _g, parent: _p, ...rest } = b as EBlock & { orig?: unknown; gap?: unknown };
  return JSON.stringify(rest);
}

/** Children of each block, in order ("" for the top level). Blocks whose parent is gone count as top level. */
export function childrenOf(blocks: readonly EBlock[]): Map<string, EBlock[]> {
  const ids = new Set(blocks.map((b) => b.id));
  const m = new Map<string, EBlock[]>();
  for (const b of blocks) {
    const p = b.parent && ids.has(b.parent) ? b.parent : "";
    const list = m.get(p);
    if (list) list.push(b);
    else m.set(p, [b]);
  }
  return m;
}

/** A fingerprint of a block with everything inside it. */
function treeFp(b: EBlock, kids: Map<string, EBlock[]>): string {
  return `${fingerprint(b)}{${(kids.get(b.id) ?? []).map((k) => treeFp(k, kids)).join(",")}}`;
}

/** Markdown → blocks for the editor. Each block remembers its text, and the blank lines before it. */
export function markdownToBlocks(md: string, parent?: string): EBlock[] {
  const lines = md.split("\n");
  const ast = parseMarkdown(md, { lines: true });
  const blocks: EBlock[] = [];
  let last: Block | null = null;
  let prevEnd = 0;
  let prevId: string | null = null;
  for (const b of ast) {
    const src = b.line ? lines.slice(b.line - 1, b.endLine ?? b.line).join("\n") : toMarkdown([b]);
    const made = astToBlocks(b, src, parent);
    const top = made.filter((x) => x.parent === parent);
    // Two lists of the same kind in a row stay two lists.
    const sameKind = last && last.t === b.t && (b.t === "todo" || (b.t === "list" && (last as { ordered: boolean }).ordered === b.ordered));
    if (sameKind && top[0] && isList(top[0])) (top[0] as TextBlock).newList = true;
    last = b;
    const kids = childrenOf(made);
    // A one-block piece keeps its text as written (a list item keeps the text without the list's indentation).
    if (top.length === 1 && !isList(top[0])) top[0].orig = { md: src, fp: "" };
    for (const x of top) if (x.orig) x.orig.fp = treeFp(x, kids);
    if (top.length && prevId && b.line && prevEnd) top[0].gap = { after: prevId, text: "\n".repeat(Math.max(1, b.line - prevEnd)) };
    if (top.length && b.endLine) (prevEnd = b.endLine), (prevId = top[top.length - 1].id);
    else prevId = null;
    blocks.push(...made);
  }
  return blocks;
}

// ── blocks → markdown ─────────────────────────────────────────────────────────

function fence(code: string): string {
  let f = "```";
  while (code.includes(f)) f += "`";
  return f;
}

const cellMd = (spans: Span[]) => {
  const md = spansToMd(spans).replace(/\\\n/g, " ").replace(/\n/g, " ");
  let out = "";
  let tick = 0;
  for (let k = 0; k < md.length; k++) {
    const c = md[k];
    if (c === "\\" && k + 1 < md.length) {
      out += c + md[++k];
      continue;
    }
    if (c === "`") {
      // Code spans open and close with backtick runs of the same length.
      let n = 1;
      while (md[k + n] === "`") n++;
      if (!tick) tick = n;
      else if (n === tick) tick = 0;
      out += md.slice(k, k + n);
      k += n - 1;
      continue;
    }
    out += c === "|" && !tick ? "\\|" : c;
  }
  return out.trim();
};

/** Markdown of one block's own text (not what is inside it). */
function ownMd(b: EBlock, num: number): string {
  switch (b.type) {
    case "p":
      return spansToMd(b.spans);
    case "h2":
      return `## ${spansToMd(b.spans).replace(/\\\n/g, " ")}`;
    case "h3":
      return `### ${spansToMd(b.spans).replace(/\\\n/g, " ")}`;
    case "quote":
      return spansToMd(b.spans)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "callout":
      return [`> [!${b.tone ?? "note"}]`, ...spansToMd(b.spans).split("\n").map((l) => (l ? `> ${l}` : ">"))].join("\n");
    case "bullet":
      return `- ${spansToMd(b.spans).replace(/\n/g, "\n  ")}`;
    case "number":
      return `${num}. ${spansToMd(b.spans).replace(/\n/g, "\n   ")}`;
    case "todo":
      return `- [${b.checked ? "x" : " "}] ${spansToMd(b.spans).replace(/\n/g, "\n  ")}`;
    case "toggle":
      return `:::toggle ${spansToMd(b.spans).replace(/\\?\n/g, " ")}`;
    case "code": {
      const f = fence(b.text);
      return `${f}${b.lang}\n${b.text}\n${f}`;
    }
    case "hr":
      return "---";
    case "media": {
      if (!b.target) return "";
      const cap = (b.caption ?? "").replace(/"/g, "”").replace(/\n/g, " ").trim();
      return `![${b.alt.replace(/[[\]\\]/g, (c) => `\\${c}`)}](${b.target}${cap ? ` "${cap}"` : ""})`;
    }
    case "table": {
      const width = Math.max(1, b.head.length, ...b.rows.map((r) => r.length));
      const row = (cells: Span[][]) => `| ${Array.from({ length: width }, (_, k) => cellMd(cells[k] ?? [])).join(" | ")} |`;
      const delim = `| ${Array.from({ length: width }, (_, k) => b.align[k]).map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---")).join(" | ")} |`;
      return [row(b.head), delim, ...b.rows.map(row)].join("\n");
    }
    case "source":
      return b.md;
    case "columns":
    case "col":
      return "";
  }
}

/** Blocks → markdown. Untouched blocks write their original text. */
export function blocksToMarkdown(blocks: readonly EBlock[]): string {
  const kids = childrenOf(blocks);
  const fps = new Map<string, string>();
  const fpOf = (b: EBlock): string => {
    let f = fps.get(b.id);
    if (f === undefined) fps.set(b.id, (f = `${fingerprint(b)}{${(kids.get(b.id) ?? []).map(fpOf).join(",")}}`));
    return f;
  };
  const untouched = (b: EBlock, num?: number) => {
    if (!b.orig || b.orig.fp !== fpOf(b)) return false;
    // A numbered item that moved writes its new number.
    if (b.type === "number" && num !== undefined) return Number(/^\s*(\d+)/.exec(b.orig.md)?.[1]) === num;
    return true;
  };

  const level = (sibs: readonly EBlock[]): string => {
    let out = "";
    let prev: EBlock | null = null;
    let prevNum = 0;
    let num = 1;
    for (const b of sibs) {
      if (b.type === "number") num = prev?.type === "number" && !b.newList ? num + 1 : (b.start ?? 1);
      const md = blockMd(b, num);
      if (!md.trim() && b.type !== "code") {
        // An empty line in the editor is nothing in markdown, and ends a list.
        prev = null;
        continue;
      }
      const sameList = prev && isList(b) && b.type === prev.type && !(b as TextBlock).newList;
      const sep = prev && b.gap && b.gap.after === prev.id && untouched(b, b.type === "number" ? num : undefined) && untouched(prev, prev.type === "number" ? prevNum : undefined) ? b.gap.text : sameList ? "\n" : "\n\n";
      out += out ? sep + md : md;
      prev = b;
      prevNum = num;
    }
    return out;
  };

  const inside = (b: EBlock) => level(kids.get(b.id) ?? []);

  function blockMd(b: EBlock, num: number): string {
    if (untouched(b, b.type === "number" ? num : undefined)) return b.orig!.md;
    if (b.type === "columns") {
      const cols = (kids.get(b.id) ?? []).map((c) => (c.type === "col" ? inside(c) : blockMd(c, 1)));
      if (!cols.some((c) => c.trim())) return "";
      return `:::columns\n${cols.map((c) => `:::col\n${c}${c ? "\n" : ""}`).join("")}:::`;
    }
    if (b.type === "col") return inside(b);
    const own = ownMd(b, num);
    if (b.type === "toggle") {
      const body = inside(b);
      return `${own}\n${body}${body ? "\n" : ""}:::`;
    }
    if (isList(b)) {
      const body = inside(b);
      if (!body) return own;
      const pad = " ".repeat(b.type === "number" ? `${num}. `.length : 2);
      const first = (kids.get(b.id) ?? [])[0];
      // A nested list follows the item's line; anything else needs a blank line before it.
      return `${own}${first && isList(first) ? "\n" : "\n\n"}${body
        .split("\n")
        .map((l) => (l ? pad + l : ""))
        .join("\n")}`;
    }
    return own;
  }

  return level(kids.get("") ?? []);
}

/** True when two markdown texts say the same thing (so opening a document never saves it). */
export function sameMarkdown(a: string, b: string): boolean {
  if (a === b) return true;
  return sameBlocks(parseMarkdown(a), parseMarkdown(b));
}

/** Plain text of a block, for search in the slash menu and for the outline. */
export function blockPlain(b: EBlock): string {
  if (isText(b)) return b.spans.map((s) => s.text).join("");
  if (b.type === "code") return b.text;
  if (b.type === "media") return b.caption || b.alt;
  if (b.type === "source") return b.md;
  if (b.type === "table") return [...b.head, ...b.rows.flat()].map((c) => c.map((s) => s.text).join("")).join(" ");
  return "";
}

/** Blocks → markdown for the clipboard (fresh, not the original text). Blocks inside the given ones come along. */
export function blocksToClipboard(blocks: readonly EBlock[]): string {
  const ids = new Set(blocks.map((b) => b.id));
  return blocksToMarkdown(blocks.map((b) => ({ ...b, orig: undefined, parent: b.parent && ids.has(b.parent) ? b.parent : undefined })));
}
