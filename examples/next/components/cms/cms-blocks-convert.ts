// agent-cms: markdown ⇄ blocks for the block editor.
// The document is stored as markdown, as always. The block editor shows it as
// blocks and writes markdown back. Nothing is lost:
// - what the editor has no block for (HTML, columns, callouts, tables, toggles,
//   images with a caption apart from the alt text...) becomes a "source block"
//   holding the markdown as written; the editor draws it and edits its text;
// - a block that was not touched writes its original markdown back, byte for byte.
// Pure functions: no React, no DOM (tested in node).

import { parseMarkdown, sameBlocks, toMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";
import { mdToSpans, spansToMd, type Span } from "./cms-blocks-inline";

export type TextType = "p" | "h2" | "h3" | "quote" | "callout" | "bullet" | "number" | "todo";
export const TEXT_TYPES: readonly TextType[] = ["p", "h2", "h3", "quote", "callout", "bullet", "number", "todo"];
export type Tone = "note" | "tip" | "warning";
export const LIST_TYPES: readonly TextType[] = ["bullet", "number", "todo"];

interface Base {
  id: string;
  /** The markdown this block was loaded from, and what the block looked like then. */
  orig?: { md: string; fp: string };
  /** The text between the block before it (by id) and this one, as loaded. */
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
/** An image or file on its own line: `![alt](target)`. */
export type MediaBlock = Base & { type: "media"; target: string; alt: string };
/** Markdown the editor keeps as text (drawn when not being edited). */
export type SourceBlock = Base & { type: "source"; md: string; kind: string };
export type EBlock = TextBlock | CodeBlock | RuleBlock | MediaBlock | SourceBlock;

export const isText = (b: EBlock): b is TextBlock => (TEXT_TYPES as readonly string[]).includes(b.type);
export const isList = (b: EBlock): b is TextBlock => (LIST_TYPES as readonly string[]).includes(b.type);

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

function astToBlocks(b: Block, src: string): EBlock[] {
  const source = (): EBlock[] => [{ id: newId(), type: "source", md: src, kind: sourceKind(b) }];
  const text = (type: TextType, md: string, extra: Partial<TextBlock> = {}): TextBlock => ({ id: newId(), type, spans: mdToSpans(md), ...extra });
  switch (b.t) {
    case "p":
      return hasImage(b.inline) ? source() : [text("p", toInlineMd(b.inline))];
    case "heading":
      return hasImage(b.inline) ? source() : [text(b.level === 3 ? "h3" : "h2", toInlineMd(b.inline))];
    case "list":
      if (b.items.some(hasImage)) return source();
      return b.items.map((it, n) => text(b.ordered ? "number" : "bullet", toInlineMd(it), n === 0 && b.ordered && b.start && b.start !== 1 ? { start: b.start } : {}));
    case "todo":
      if (b.items.some((x) => hasImage(x.inline))) return source();
      return b.items.map((it) => text("todo", toInlineMd(it.inline), { checked: it.checked }));
    case "quote": {
      const only = b.blocks.length === 1 ? b.blocks[0] : null;
      if (!only || only.t !== "p" || hasImage(only.inline)) return source();
      return b.callout ? [text("callout", toInlineMd(only.inline), { tone: b.callout })] : [text("quote", toInlineMd(only.inline))];
    }
    case "code":
      return [{ id: newId(), type: "code", text: b.v, lang: b.lang }];
    case "hr":
      return [{ id: newId(), type: "hr" }];
    case "media": {
      if (b.caption && b.caption !== b.alt) return source();
      const m = /\]\((\S+?)(?:\s+"[^"]*")?\)\s*$/.exec(src);
      return [{ id: newId(), type: "media", target: m ? m[1] : (b.src ?? ""), alt: b.alt }];
    }
    default:
      // tables, toggles, columns, html, page links, raw, and anything newer.
      return source();
  }
}

function toInlineMd(items: Inline[]): string {
  return toMarkdown([{ t: "p", inline: items }]);
}

/** A fingerprint of what the user can change in a block. */
export function fingerprint(b: EBlock): string {
  const { id: _id, orig: _o, gap: _g, ...rest } = b as EBlock & { orig?: unknown; gap?: unknown };
  return JSON.stringify(rest);
}

/** Markdown → blocks for the editor. Each block that is one markdown block remembers its text. */
export function markdownToBlocks(md: string): EBlock[] {
  const lines = md.split("\n");
  const ast = parseMarkdown(md, { lines: true });
  const blocks: EBlock[] = [];
  let last: Block | null = null;
  let prevEnd = 0;
  let prevId: string | null = null;
  for (const b of ast) {
    const src = b.line ? lines.slice(b.line - 1, b.endLine ?? b.line).join("\n") : toMarkdown([b]);
    const made = astToBlocks(b, src);
    // Two lists of the same kind in a row stay two lists.
    const sameKind = last && last.t === b.t && (b.t === "todo" || (b.t === "list" && (last as { ordered: boolean }).ordered === b.ordered));
    if (sameKind && made[0] && isList(made[0])) (made[0] as TextBlock).newList = true;
    last = b;
    if (made.length === 1) made[0].orig = { md: src, fp: fingerprint(made[0]) };
    else if (b.t === "list" || b.t === "todo") {
      // Each item keeps its own lines (wrapped lines and all).
      const chunks = src.split("\n").reduce<string[]>((acc, line) => {
        if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || !acc.length) acc.push(line);
        else acc[acc.length - 1] += "\n" + line;
        return acc;
      }, []);
      if (chunks.length === made.length) made.forEach((m, i) => (m.orig = { md: chunks[i], fp: fingerprint(m) }));
    }
    if (made.length && prevId && b.line && prevEnd) made[0].gap = { after: prevId, text: "\n".repeat(Math.max(1, b.line - prevEnd)) };
    // Inside a list, items follow each other on the next line.
    for (let i = 1; i < made.length; i++) if (made[i].orig) made[i].gap = { after: made[i - 1].id, text: "\n" };
    if (made.length && b.endLine) (prevEnd = b.endLine), (prevId = made[made.length - 1].id);
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

function blockMd(b: EBlock, num: number): string {
  if (b.orig && b.orig.fp === fingerprint(b)) return b.orig.md;
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
    case "code": {
      const f = fence(b.text);
      return `${f}${b.lang}\n${b.text}\n${f}`;
    }
    case "hr":
      return "---";
    case "media":
      return b.target ? `![${b.alt.replace(/[[\]\\]/g, (c) => `\\${c}`)}](${b.target})` : "";
    case "source":
      return b.md;
  }
}

/** Blocks → markdown. Untouched blocks write their original text. */
export function blocksToMarkdown(blocks: readonly EBlock[]): string {
  let out = "";
  let prev: EBlock | null = null;
  let num = 1;
  for (const b of blocks) {
    if (b.type === "number") num = prev?.type === "number" && !b.newList ? num + 1 : b.start || 1;
    const md = blockMd(b, num);
    if (!md.trim() && b.type !== "code") {
      // An empty line in the editor is nothing in markdown, and ends a list.
      prev = null;
      continue;
    }
    const sameList = prev && isList(b) && b.type === prev.type && !(b as TextBlock).newList;
    const untouched = (x: EBlock) => !!x.orig && x.orig.fp === fingerprint(x);
    const sep = prev && b.gap && b.gap.after === prev.id && untouched(b) && untouched(prev) ? b.gap.text : sameList ? "\n" : "\n\n";
    out += out ? sep + md : md;
    prev = b;
  }
  return out;
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
  if (b.type === "media") return b.alt;
  if (b.type === "source") return b.md;
  return "";
}

/** Blocks → markdown for the clipboard (fresh, not the original text). */
export function blocksToClipboard(blocks: readonly EBlock[]): string {
  return blocksToMarkdown(blocks.map((b) => ({ ...b, orig: undefined })));
}
