// agent-cms: markdown ⇄ block editor (BlockNote) blocks.
// The document is stored as markdown, as always. The block editor shows it as
// blocks and writes markdown back. Nothing is lost:
// - what the block editor cannot show (HTML, columns, callouts, aligned tables,
//   captions apart from alt text...) becomes a "source block" holding the
//   markdown as written, edited as text;
// - a block that was not touched keeps its original markdown, byte for byte.
// Pure functions: no React, no editor instance (tested in node).

import { inlineToMarkdown, parseMarkdown, sameBlocks, toMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";

/** The shape of a BlockNote block, as far as this file needs it. */
export interface BnBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BnBlock[];
}

interface BnText {
  type: "text";
  text: string;
  styles: Record<string, boolean | string>;
}
interface BnLink {
  type: "link";
  href: string;
  content: BnText[];
}
type BnInline = BnText | BnLink;

/** Block types the editor offers (anything else the editor may hold is written as text). */
export const BLOCK_TYPES = ["paragraph", "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "codeBlock", "table", "image", "divider", "cmsSource"] as const;

/** Link targets for things markdown writes in its own way. */
const APP_LINK = "cms-link:";

// ── markdown → blocks ─────────────────────────────────────────────────────────

type Styles = Record<string, true>;

function inlineToBn(items: Inline[], styles: Styles = {}): BnInline[] {
  const out: BnInline[] = [];
  const text = (v: string, s: Styles) => v && out.push({ type: "text", text: v, styles: { ...s } });
  for (const i of items) {
    switch (i.t) {
      case "text":
        text(i.v, styles);
        break;
      case "strong":
      case "em":
      case "del": {
        const s = { ...styles, [i.t === "strong" ? "bold" : i.t === "em" ? "italic" : "strike"]: true } as Styles;
        if (i.kids) out.push(...inlineToBn(i.kids, s));
        else text(i.v, s);
        break;
      }
      case "code":
        text(i.v, { ...styles, code: true });
        break;
      case "br":
        text("\n", styles);
        break;
      case "link":
        out.push({ type: "link", href: i.href, content: [{ type: "text", text: i.v, styles: { ...styles } }] });
        break;
      case "file": {
        // The target exactly as markdown writes it ("asset:ID/name").
        const md = inlineToMarkdown([i]);
        const href = md.slice(md.lastIndexOf("](") + 2, -1);
        out.push({ type: "link", href, content: [{ type: "text", text: i.v, styles: { ...styles } }] });
        break;
      }
      case "applink":
        out.push({ type: "link", href: APP_LINK + i.key, content: [{ type: "text", text: i.v, styles: { ...styles } }] });
        break;
      case "image":
        // Only reached through `canShow`, which keeps paragraphs with inline images as source.
        text(i.v, styles);
        break;
    }
  }
  return out;
}

const hasImage = (items: Inline[]): boolean => items.some((i) => i.t === "image" || ("kids" in i && i.kids ? hasImage(i.kids) : false));

/** Source-block kind (for its label). */
export function sourceKind(b: Block): string {
  if (b.t === "html") return b.isolated ? "html-isolated" : "html";
  if (b.t === "quote" && b.callout) return "callout";
  return b.t;
}

function astToBn(b: Block, src: string | null, id: () => string): BnBlock[] {
  const source = (): BnBlock[] => [{ id: id(), type: "cmsSource", props: { md: src ?? "", kind: sourceKind(b) } }];
  switch (b.t) {
    case "p":
      return hasImage(b.inline) ? source() : [{ id: id(), type: "paragraph", content: inlineToBn(b.inline) }];
    case "heading":
      return [{ id: id(), type: "heading", props: { level: b.level }, content: inlineToBn(b.inline) }];
    case "list":
      if (b.items.some(hasImage)) return source();
      return b.items.map((it, n) => ({
        id: id(),
        type: b.ordered ? "numberedListItem" : "bulletListItem",
        props: b.ordered && n === 0 && b.start && b.start !== 1 ? { start: b.start } : {},
        content: inlineToBn(it),
      }));
    case "todo":
      if (b.items.some((x) => hasImage(x.inline))) return source();
      return b.items.map((it) => ({ id: id(), type: "checkListItem", props: { checked: it.checked }, content: inlineToBn(it.inline) }));
    case "quote": {
      const only = b.blocks.length === 1 ? b.blocks[0] : null;
      if (b.callout || !only || only.t !== "p" || hasImage(only.inline)) return source();
      return [{ id: id(), type: "quote", content: inlineToBn(only.inline) }];
    }
    case "code":
      return [{ id: id(), type: "codeBlock", props: { language: b.lang }, content: [{ type: "text", text: b.v, styles: {} }] }];
    case "hr":
      return [{ id: id(), type: "divider" }];
    case "media":
      // The block editor's image has one text (caption); keep it as source when alt and caption differ.
      if (b.caption && b.caption !== b.alt) return source();
      return [{ id: id(), type: "image", props: { url: mediaTarget(b), caption: b.alt, name: b.name } }];
    case "table":
      if (b.align.some((a) => a) || [b.head, ...b.rows].some((r) => r.some(hasImage))) return source();
      return [
        {
          id: id(),
          type: "table",
          content: { type: "tableContent", rows: [b.head, ...b.rows].map((cells) => ({ cells: cells.map((c) => inlineToBn(c)) })) },
        },
      ];
    case "toggle":
      if (hasImage(b.title)) return source();
      return [{ id: id(), type: "toggleListItem", content: inlineToBn(b.title), children: b.blocks.flatMap((x) => astToBn(x, null, id)) }];
    default:
      // html, columns, links, raw, and anything newer.
      return source();
  }
}

function mediaTarget(b: Extract<Block, { t: "media" }>): string {
  const md = toMarkdownOne(b);
  const m = /\]\((\S+)/.exec(md);
  return m ? m[1].replace(/\)$/, "") : (b.src ?? "");
}

function toMarkdownOne(b: Block): string {
  return toMarkdown([b]);
}

export interface Loaded {
  blocks: BnBlock[];
  /** Original markdown of each top-level block that maps to one block (by id). */
  sources: Record<string, string>;
}

/** Markdown → blocks for the editor, with each block's original text. */
export function markdownToBlocks(md: string): Loaded {
  const lines = md.split("\n");
  const ast = parseMarkdown(md, { lines: true });
  let n = 0;
  const id = () => `b${++n}`;
  const blocks: BnBlock[] = [];
  const sources: Record<string, string> = {};
  let last: Block | null = null;
  for (const b of ast) {
    // Two lists in a row are two lists: an empty line between them keeps them apart.
    if (last && (last.t === "list" || last.t === "todo") && last.t === b.t && (b.t !== "list" || (last as { ordered: boolean }).ordered === b.ordered)) blocks.push({ id: id(), type: "paragraph", content: [] });
    last = b;
    const src = b.line ? lines.slice(b.line - 1, b.endLine ?? b.line).join("\n") : null;
    const made = astToBn(b, src ?? toMarkdown([b]), id);
    // One block for one markdown block: an untouched one writes its original text back.
    if (made.length === 1 && src !== null && made[0].id) sources[made[0].id] = src;
    blocks.push(...made);
  }
  return { blocks, sources };
}

// ── blocks → markdown ─────────────────────────────────────────────────────────

const ESCAPE = /[\\`*_~[\]]/g;

function escapeText(s: string): string {
  return s.replace(ESCAPE, (c) => `\\${c}`);
}

const MARKS: Record<string, string> = { bold: "**", italic: "*", strike: "~~" };
const MARK_KEYS = Object.keys(MARKS);

interface Run {
  /** Already markdown (escaped text, code span or link). Empty for a pure line break. */
  md: string;
  lead: string;
  trail: string;
  marks: string[];
  br?: true;
}

function toRuns(content: BnInline[]): Run[] {
  const runs: Run[] = [];
  for (const x of content) {
    if (x.type === "text") {
      if (x.text === "\n") {
        runs.push({ md: "", lead: "", trail: "", marks: [], br: true });
        continue;
      }
      const lead = x.styles?.code ? "" : /^\s*/.exec(x.text)![0];
      const rest = x.text.slice(lead.length);
      const trail = x.styles?.code ? "" : /\s*$/.exec(rest)![0];
      const core = rest.slice(0, rest.length - trail.length);
      const marks = MARK_KEYS.filter((k) => x.styles?.[k]);
      const md = !core ? "" : x.styles?.code ? (core.includes("`") ? `\`\` ${core} \`\`` : `\`${core}\``) : escapeText(core).replace(/\n/g, "\\\n");
      runs.push({ md, lead, trail, marks });
    } else if (x.type === "link") {
      const label = x.content.map((c) => c.text).join("");
      const md = x.href.startsWith(APP_LINK) ? `[[link:${x.href.slice(APP_LINK.length)}|${label}]]` : `[${label}](${x.href})`;
      runs.push({ md, lead: "", trail: "", marks: MARK_KEYS.filter((k) => x.content[0]?.styles?.[k]) });
    }
  }
  return runs;
}

/** Runs → markdown with marks kept open across runs that share them. */
function runsMd(runs: Run[]): string {
  let out = "";
  const open: string[] = [];
  let space = "";
  // How many runs from i on still carry a mark (opened first = lasts longest).
  const lasts = (i: number, k: string) => {
    let n = 0;
    while (i + n < runs.length && (runs[i + n].marks.includes(k) || (!runs[i + n].md && !runs[i + n].br))) n++;
    return n;
  };
  const close = (to: number) => {
    while (open.length > to) out += MARKS[open.pop()!];
  };
  runs.forEach((r, i) => {
    if (r.br) {
      close(0);
      out += space + "\\\n";
      space = "";
      return;
    }
    if (!r.md) {
      space += r.lead + r.trail;
      return;
    }
    // Close down to the first open mark this run does not have.
    let keep = 0;
    while (keep < open.length && r.marks.includes(open[keep])) keep++;
    close(keep);
    out += space + r.lead;
    const add = r.marks.filter((k) => !open.includes(k)).sort((a, b) => lasts(i, b) - lasts(i, a));
    for (const k of add) (out += MARKS[k]), open.push(k);
    out += r.md;
    space = r.trail;
  });
  close(0);
  return out + space;
}

export function inlineMd(content: unknown): string {
  return Array.isArray(content) ? runsMd(toRuns(content as BnInline[])) : "";
}

function cellsOf(row: { cells: unknown[] }): string[] {
  return row.cells.map((c) => {
    const content = c && typeof c === "object" && !Array.isArray(c) && (c as { type?: string }).type === "tableCell" ? (c as { content: unknown }).content : c;
    return inlineMd(content).replace(/(^|[^\\])\|/g, "$1\\|").replace(/\\\n/g, " ");
  });
}

function fence(code: string): string {
  let f = "```";
  while (code.includes(f)) f += "`";
  return f;
}

const LIST = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);

function blockMd(b: BnBlock, keep: (b: BnBlock) => string | undefined, num: number): string {
  const kept = keep(b);
  if (kept !== undefined) return kept;
  const p = b.props ?? {};
  switch (b.type) {
    case "paragraph":
      return inlineMd(b.content);
    case "heading":
      return `${Number(p.level) >= 3 ? "###" : "##"} ${inlineMd(b.content)}`;
    case "bulletListItem":
      return `- ${inlineMd(b.content)}`;
    case "numberedListItem":
      return `${num}. ${inlineMd(b.content)}`;
    case "checkListItem":
      return `- [${p.checked ? "x" : " "}] ${inlineMd(b.content)}`;
    case "quote":
      return inlineMd(b.content)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "codeBlock": {
      const code = Array.isArray(b.content) ? (b.content as BnText[]).map((t) => t.text).join("") : "";
      const f = fence(code);
      const lang = typeof p.language === "string" ? p.language : "";
      return `${f}${lang}\n${code}\n${f}`;
    }
    case "table": {
      const rows = ((b.content as { rows?: { cells: unknown[] }[] } | undefined)?.rows ?? []).map(cellsOf);
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
    }
    case "toggleListItem": {
      const inner = blocksToMarkdown(b.children ?? [], keep);
      return `:::toggle ${inlineMd(b.content)}\n${inner}${inner ? "\n" : ""}:::`;
    }
    case "image": {
      const url = String(p.url ?? "");
      return url ? `![${escapeText(String(p.caption ?? ""))}](${url})` : "";
    }
    case "divider":
      return "---";
    case "cmsSource":
      return String(p.md ?? "");
    default:
      // A block type this file does not know (from a paste): keep its text.
      return inlineMd(b.content);
  }
}

/** Blocks → markdown. `keep` returns a block's original text when it was not changed. */
export function blocksToMarkdown(blocks: readonly BnBlock[], keep: (b: BnBlock) => string | undefined = () => undefined): string {
  const parts: string[] = [];
  let prev: BnBlock | null = null;
  let num = 1;
  const flat: BnBlock[] = [];
  // Children of list items and paragraphs come right after them (markdown lists here are one level).
  for (const b of blocks) {
    flat.push(b.type === "toggleListItem" ? b : { ...b, children: [] });
    if (b.type !== "toggleListItem" && b.children?.length) flat.push(...b.children);
  }
  for (const b of flat) {
    if (b.type === "numberedListItem") num = prev?.type === "numberedListItem" ? num + 1 : Number(b.props?.start ?? 1) || 1;
    const md = blockMd(b, keep, num);
    const sameList = prev && LIST.has(b.type) && b.type === prev.type;
    if (md.trim() || b.type === "codeBlock") {
      parts.push(parts.length ? (sameList ? "\n" : "\n\n") + md : md);
      prev = b;
    } else prev = null;
  }
  return parts.join("");
}

/** True when two markdown texts say the same thing (so opening a document never saves it). */
export function sameMarkdown(a: string, b: string): boolean {
  if (a === b) return true;
  return sameBlocks(parseMarkdown(a), parseMarkdown(b));
}

/** A stable fingerprint of a block as the editor holds it (to tell untouched blocks). */
export function fingerprint(b: BnBlock): string {
  return JSON.stringify([b.type, b.props ?? {}, b.content ?? null, b.children ?? []]);
}
