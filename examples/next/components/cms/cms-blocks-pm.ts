// agent-cms: the block editor's document model on ProseMirror (through Tiptap).
//
// The body is stored as markdown. cms-blocks-convert.ts turns markdown into a
// flat list of blocks with `parent` links (and keeps the original text of every
// block); this file turns that list into a ProseMirror document and back.
// Every block node carries its block id (`bid`), so a block that comes back
// unchanged writes its original markdown, byte for byte.
//
// The schema is small and strict, the same blocks the markdown dialect has:
//   paragraph, heading (2, 3, 4), quote, callout, listItem (bullet, number, todo:
//   a line of text and the blocks inside it), toggle (the same, can be closed),
//   codeBlock, rule, media (picture or file with alt text and caption), table,
//   columns (two or more columns of blocks), source (markdown kept as text).
// Marks: bold, italic, strike, code, link.
//
// No React here: the editor screen adds node views to these nodes. Tested in node.

import { getSchema, Mark, mergeAttributes, Node, type Extensions, type JSONContent } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { childrenOf, newId, type EBlock, type TableAlign, type TextBlock, type TextType, type Tone } from "./cms-blocks-convert";
import { normalize, type Span } from "./cms-blocks-inline";

// ── nodes ─────────────────────────────────────────────────────────────────────

/** Every block node remembers which block it is. */
const bid = { bid: { default: null as string | null, keepOnSplit: false, rendered: false } };
const blockAttrs = (b: string | null) => (b ? { "data-block-id": b } : {});

const Doc = Node.create({ name: "doc", topNode: true, content: "block+" });
const Text = Node.create({ name: "text", group: "inline" });

const HardBreak = Node.create({
  name: "hardBreak",
  inline: true,
  group: "inline",
  selectable: false,
  linebreakReplacement: true,
  parseHTML: () => [{ tag: "br" }],
  renderHTML: ({ HTMLAttributes }) => ["br", HTMLAttributes],
  renderText: () => "\n",
});

const Paragraph = Node.create({
  name: "paragraph",
  group: "block",
  content: "inline*",
  priority: 1000,
  addAttributes: () => ({ ...bid }),
  parseHTML: () => [{ tag: "p" }],
  renderHTML: ({ node, HTMLAttributes }) => ["p", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "p", class: "cms-b cms-p" }), 0],
});

/** A heading node's level as the markdown has it: 2, 3 or 4. */
export const headingLevel = (level: unknown): 2 | 3 | 4 => (level === 3 ? 3 : level === 4 ? 4 : 2);

const Heading = Node.create({
  name: "heading",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes: () => ({ ...bid, level: { default: 2, rendered: false }, anchor: { default: null as string | null, keepOnSplit: false, rendered: false } }),
  parseHTML: () => [
    { tag: "h1", attrs: { level: 2 } },
    { tag: "h2", attrs: { level: 2 } },
    { tag: "h3", attrs: { level: 3 } },
    { tag: "h4", attrs: { level: 4 } },
    { tag: "h5", attrs: { level: 4 } },
    { tag: "h6", attrs: { level: 4 } },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [`h${headingLevel(node.attrs.level)}`, mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": `h${headingLevel(node.attrs.level)}`, class: `cms-b cms-h${headingLevel(node.attrs.level)}` }), 0],
});

const Quote = Node.create({
  name: "quote",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes: () => ({ ...bid }),
  parseHTML: () => [{ tag: "blockquote" }],
  renderHTML: ({ node, HTMLAttributes }) => ["blockquote", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "quote", class: "cms-b cms-quote" }), 0],
});

const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes: () => ({ ...bid, tone: { default: "note", rendered: false } }),
  parseHTML: () => [{ tag: "aside[data-tone]", getAttrs: (el) => ({ tone: (el as HTMLElement).dataset.tone || "note" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["aside", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "callout", "data-tone": node.attrs.tone, class: "cms-b cms-callout" }), 0],
});

/** The text line of a list item or a toggle (what comes before the blocks inside it). */
const Line = Node.create({
  name: "line",
  content: "inline*",
  parseHTML: () => [{ tag: "div[data-line]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-line": "", class: "cms-line" }), 0],
});

const ListItem = Node.create({
  name: "listItem",
  group: "block",
  content: "line block*",
  defining: true,
  addAttributes: () => ({
    ...bid,
    kind: { default: "bullet", rendered: false },
    checked: { default: false, rendered: false },
    start: { default: null, rendered: false },
    newList: { default: false, rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "div[data-list-item]",
      getAttrs: (el) => {
        const d = (el as HTMLElement).dataset;
        return { kind: d.kind || "bullet", checked: d.checked === "true", start: d.start ? Number(d.start) : null, newList: d.newList === "true" };
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    mergeAttributes(
      HTMLAttributes,
      blockAttrs(node.attrs.bid),
      { "data-block-type": node.attrs.kind, "data-list-item": "", "data-kind": node.attrs.kind, "data-checked": String(!!node.attrs.checked), class: "cms-b cms-item" },
      node.attrs.start !== null && node.attrs.start !== undefined ? { "data-start": String(node.attrs.start) } : {},
      node.attrs.newList ? { "data-new-list": "true" } : {}
    ),
    0,
  ],
});

const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "line block*",
  defining: true,
  addAttributes: () => ({ ...bid, open: { default: false, rendered: false, keepOnSplit: false } }),
  parseHTML: () => [{ tag: "div[data-block-type=toggle]", getAttrs: (el) => ({ open: (el as HTMLElement).dataset.open === "true" }) }, { tag: "details" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "toggle", "data-open": String(!!node.attrs.open), class: "cms-b cms-toggle" }), 0],
});

const CodeBlock = Node.create({
  name: "codeBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: () => ({ ...bid, lang: { default: "", rendered: false } }),
  parseHTML: () => [
    {
      tag: "pre",
      preserveWhitespace: "full",
      getAttrs: (el) => ({ lang: (el as HTMLElement).dataset.lang ?? /language-(\S+)/.exec((el as HTMLElement).querySelector("code")?.className ?? "")?.[1] ?? "" }),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    "pre",
    mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "code", "data-lang": node.attrs.lang ?? "", class: "cms-b cms-code" }),
    ["code", node.attrs.lang ? { class: `language-${node.attrs.lang}` } : {}, 0],
  ],
});

const Rule = Node.create({
  name: "rule",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ ...bid }),
  parseHTML: () => [{ tag: "hr" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "hr", class: "cms-b cms-hr" }), ["hr"]],
});

const Media = Node.create({
  name: "media",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({
    ...bid,
    target: { default: "", rendered: false },
    alt: { default: "", rendered: false },
    caption: { default: "", rendered: false },
    pending: { default: null, rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "figure[data-target]",
      getAttrs: (el) => ({ target: (el as HTMLElement).dataset.target ?? "", alt: (el as HTMLElement).dataset.alt ?? "", caption: (el as HTMLElement).dataset.caption ?? "" }),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    "figure",
    mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), {
      "data-block-type": "media",
      "data-target": node.attrs.target,
      "data-alt": node.attrs.alt,
      "data-caption": node.attrs.caption ?? "",
      class: "cms-b cms-media",
    }),
  ],
});

/** Markdown the editor keeps as text: drawn as it will look, edited as markdown. */
const Source = Node.create({
  name: "source",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ ...bid, md: { default: "", rendered: false }, kind: { default: "p", rendered: false } }),
  parseHTML: () => [{ tag: "div[data-source]", getAttrs: (el) => ({ md: (el as HTMLElement).dataset.source ?? "", kind: (el as HTMLElement).dataset.kind ?? "p" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "source", "data-source": node.attrs.md, "data-kind": node.attrs.kind, class: "cms-b cms-source" })],
});

/** Numbered steps (`:::steps`): blocks inside, numbered by the screen. */
const Steps = Node.create({
  name: "steps",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ ...bid }),
  parseHTML: () => [{ tag: "div[data-steps]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "steps", "data-steps": "", class: "cms-b cms-steps" }), 0],
});

/** A link shown as a card (`:::card`). */
const Card = Node.create({
  name: "card",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({
    ...bid,
    href: { default: "", rendered: false },
    label: { default: "", rendered: false },
    description: { default: "", rendered: false },
    image: { default: "", rendered: false },
    alt: { default: "", rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "div[data-card]",
      getAttrs: (el) => {
        const d = (el as HTMLElement).dataset;
        return { href: d.href ?? "", label: d.label ?? "", description: d.description ?? "", image: d.image ?? "", alt: d.alt ?? "" };
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), {
      "data-block-type": "card",
      "data-card": "",
      "data-href": node.attrs.href,
      "data-label": node.attrs.label,
      "data-description": node.attrs.description,
      "data-image": node.attrs.image,
      "data-alt": node.attrs.alt,
      class: "cms-b cms-card",
    }),
  ],
});

/** A video (`:::video`): an address on an allowed site or a media library file. */
const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ ...bid, src: { default: "", rendered: false }, caption: { default: "", rendered: false } }),
  parseHTML: () => [{ tag: "div[data-video]", getAttrs: (el) => ({ src: (el as HTMLElement).dataset.src ?? "", caption: (el as HTMLElement).dataset.caption ?? "" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "video", "data-video": "", "data-src": node.attrs.src, "data-caption": node.attrs.caption, class: "cms-b cms-video" })],
});

/** A snippet on a line of its own (`[[snippet:key]]`). */
const Snippet = Node.create({
  name: "snippet",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ ...bid, key: { default: "", rendered: false } }),
  parseHTML: () => [{ tag: "div[data-snippet]", getAttrs: (el) => ({ key: (el as HTMLElement).dataset.snippet ?? "" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "snippet", "data-snippet": node.attrs.key, class: "cms-b cms-snippet" })],
});

/** A snippet inside a line of text (`[[snippet:key]]` among other words): one uneditable piece. */
const SnippetRef = Node.create({
  name: "snippetRef",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ key: { default: "", rendered: false } }),
  parseHTML: () => [{ tag: "span[data-snippet-ref]", getAttrs: (el) => ({ key: (el as HTMLElement).dataset.snippetRef ?? "" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-snippet-ref": node.attrs.key, class: "cms-snippet-ref" }), `[[snippet:${node.attrs.key}]]`],
  renderText: ({ node }) => (node.attrs.key ? `[[snippet:${node.attrs.key}]]` : ""),
});

/** A snippet token inside text, as the server reads it. */
export const SNIPPET_IN_TEXT = /\[\[snippet:([a-z0-9][a-z0-9._-]*)\]\]/gi;

const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column column+",
  isolating: true,
  addAttributes: () => ({ ...bid }),
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, blockAttrs(node.attrs.bid), { "data-block-type": "columns", "data-columns": "", class: "cms-b cms-columns" }), 0],
});

const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  addAttributes: () => ({ ...bid }),
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, node.attrs.bid ? { "data-col-id": node.attrs.bid } : {}, { "data-column": "", class: "cms-column" }), 0],
});

const CmsTable = Table.extend({
  group: "block",
  addAttributes() {
    return {
      ...this.parent?.(),
      ...bid,
      align: {
        default: [] as TableAlign[],
        rendered: false,
        parseHTML: (el: HTMLElement) => {
          try {
            const a = JSON.parse(el.closest("[data-align]")?.getAttribute("data-align") ?? "[]") as unknown;
            return Array.isArray(a) ? a.map((x) => (x === "left" || x === "center" || x === "right" ? x : null)) : [];
          } catch {
            return [];
          }
        },
      },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", { ...blockAttrs(node.attrs.bid), "data-block-type": "table", "data-align": JSON.stringify(node.attrs.align ?? []), class: "cms-b cms-table" }, ["table", { ...HTMLAttributes, "data-align": JSON.stringify(node.attrs.align ?? []) }, ["tbody", 0]]];
  },
  // The same element as renderHTML (Tiptap's own view adds column widths we do not store).
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "cms-b cms-table";
      dom.dataset.blockType = "table";
      if (node.attrs.bid) dom.dataset.blockId = node.attrs.bid as string;
      const table = dom.appendChild(document.createElement("table"));
      const contentDOM = table.appendChild(document.createElement("tbody"));
      return {
        dom,
        contentDOM,
        update: (next) => {
          if (next.type !== node.type) return false;
          if (next.attrs.bid) dom.dataset.blockId = next.attrs.bid as string;
          return true;
        },
        ignoreMutation: (m) => m.type === "attributes" && m.target === dom,
      };
    };
  },
}).configure({ resizable: false, allowTableNodeSelection: true });
const CmsCell = TableCell.extend({ content: "inline*" });
const CmsHeader = TableHeader.extend({ content: "inline*" });

// ── marks ─────────────────────────────────────────────────────────────────────

const Bold = Mark.create({ name: "bold", parseHTML: () => [{ tag: "strong" }, { tag: "b" }], renderHTML: () => ["strong", 0] });
const Italic = Mark.create({ name: "italic", parseHTML: () => [{ tag: "em" }, { tag: "i" }], renderHTML: () => ["em", 0] });
const Strike = Mark.create({ name: "strike", parseHTML: () => [{ tag: "s" }, { tag: "del" }], renderHTML: () => ["s", 0] });
const Code = Mark.create({ name: "code", code: true, parseHTML: () => [{ tag: "code" }], renderHTML: () => ["code", 0] });
/** Only web, mail, phone, in-site, anchor, file and app links become links (the text stays either way). */
const safeHref = (href: string | null) => (href && /^(https?:\/\/|mailto:|tel:|\/(?![/\\])|#|asset:|cms-link:)/i.test(href.trim()) ? { href: href.trim() } : false);

const Link = Mark.create({
  name: "link",
  inclusive: false,
  addAttributes: () => ({ href: { default: "" } }),
  parseHTML: () => [
    // Our own copies carry the address in data-href (the editor draws links without a live href).
    { tag: "a[data-href]", getAttrs: (el) => safeHref((el as HTMLElement).getAttribute("data-href")) },
    { tag: "a[href]", getAttrs: (el) => safeHref((el as HTMLElement).getAttribute("href")) },
  ],
  // The link is drawn without a real href: clicking edits, ⌘-click opens (the screen handles it).
  renderHTML: ({ HTMLAttributes }) => ["a", { "data-href": HTMLAttributes.href, class: "cms-link" }, 0],
});

/** Block ids stay unique: a block split in two, pasted or duplicated gets a new id. */
const UniqueIds = Node.create({
  name: "cmsUniqueIds",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("cmsUniqueIds"),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          const tr = state.tr;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!("bid" in node.attrs)) return;
            const id = node.attrs.bid as string | null;
            if (!id || seen.has(id)) {
              tr.setNodeAttribute(pos, "bid", newId());
              changed = true;
            } else seen.add(id);
          });
          if (!changed) return null;
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});

/** The extensions that make up the schema (the screen adds behaviour and node views on top). */
export const schemaExtensions: Extensions = [
  Doc,
  Text,
  HardBreak,
  Paragraph,
  Heading,
  Quote,
  Callout,
  Line,
  ListItem,
  Toggle,
  CodeBlock,
  Rule,
  Media,
  Source,
  Steps,
  Card,
  Video,
  Snippet,
  SnippetRef,
  Columns,
  Column,
  CmsTable,
  TableRow,
  CmsHeader,
  CmsCell,
  Bold,
  Italic,
  Strike,
  Code,
  Link,
  UniqueIds,
];

let cached: Schema | null = null;
/** The schema without the screen (for tests and for converting outside the editor). */
export function cmsSchema(): Schema {
  return (cached ??= getSchema(schemaExtensions));
}

// ── spans ⇄ inline content ────────────────────────────────────────────────────

export function spansToContent(spans: Span[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const s of spans) {
    const marks: JSONContent["marks"] = [];
    if (s.b) marks.push({ type: "bold" });
    if (s.i) marks.push({ type: "italic" });
    if (s.s) marks.push({ type: "strike" });
    if (s.code) marks.push({ type: "code" });
    if (s.href) marks.push({ type: "link", attrs: { href: s.href } });
    const withMarks = (n: JSONContent): JSONContent => (marks.length ? { ...n, marks } : n);
    s.text.split(/(\n)/).forEach((part) => {
      if (!part) return;
      if (part === "\n") return void out.push({ type: "hardBreak" });
      // A snippet token (a `ref` span: not escaped, not in code or a link) is a chip; the same text
      // written escaped (`\[[snippet:x]]`) stays text.
      if (s.code || s.href || !s.ref) return void out.push(withMarks({ type: "text", text: part }));
      let last = 0;
      for (const m of part.matchAll(SNIPPET_IN_TEXT)) {
        if (m.index! > last) out.push(withMarks({ type: "text", text: part.slice(last, m.index) }));
        out.push(withMarks({ type: "snippetRef", attrs: { key: m[1] } }));
        last = m.index! + m[0].length;
      }
      if (last < part.length) out.push(withMarks({ type: "text", text: part.slice(last) }));
    });
  }
  return out;
}

/** Spans of a text node's inline content. */
export function nodeSpans(node: PMNode): Span[] {
  const out: Span[] = [];
  node.forEach((child) => {
    if (child.type.name === "hardBreak") {
      out.push({ text: "\n" });
      return;
    }
    const ref = child.type.name === "snippetRef";
    if (!child.isText && !ref) return;
    // A chip without a key (being picked) writes nothing.
    if (ref && !child.attrs.key) return;
    const s: Span = ref ? { text: `[[snippet:${child.attrs.key as string}]]`, ref: true } : { text: child.text ?? "" };
    for (const m of child.marks) {
      if (m.type.name === "bold") s.b = true;
      else if (m.type.name === "italic") s.i = true;
      else if (m.type.name === "strike") s.s = true;
      else if (m.type.name === "code") s.code = true;
      else if (m.type.name === "link" && m.attrs.href) s.href = m.attrs.href as string;
    }
    out.push(s);
  });
  return normalize(out);
}

// ── blocks → document ─────────────────────────────────────────────────────────

const emptyCells = (n: number) => Array.from({ length: n }, () => [] as Span[]);

/** The editor's document for a list of blocks. */
export function blocksToDoc(blocks: readonly EBlock[], o: { open?: ReadonlySet<string> } = {}): JSONContent {
  const kids = childrenOf(blocks);
  const nodeOf = (b: EBlock): JSONContent | null => {
    const inside = (kids.get(b.id) ?? []).map(nodeOf).filter((x): x is JSONContent => !!x);
    const id = { bid: b.id };
    switch (b.type) {
      case "p":
        return { type: "paragraph", attrs: id, content: spansToContent(b.spans) };
      case "h2":
      case "h3":
      case "h4":
        return { type: "heading", attrs: { ...id, level: Number(b.type[1]), anchor: b.anchor ?? null }, content: spansToContent(b.spans) };
      case "quote":
        return { type: "quote", attrs: id, content: spansToContent(b.spans) };
      case "callout":
        return { type: "callout", attrs: { ...id, tone: b.tone ?? "note" }, content: spansToContent(b.spans) };
      case "bullet":
      case "number":
      case "todo":
        return {
          type: "listItem",
          attrs: { ...id, kind: b.type, checked: !!b.checked, start: b.start ?? null, newList: !!b.newList },
          content: [{ type: "line", content: spansToContent(b.spans) }, ...inside],
        };
      case "toggle":
        return { type: "toggle", attrs: { ...id, open: !!o.open?.has(b.id) }, content: [{ type: "line", content: spansToContent(b.spans) }, ...inside] };
      case "code":
        return { type: "codeBlock", attrs: { ...id, lang: b.lang }, content: b.text ? [{ type: "text", text: b.text }] : [] };
      case "hr":
        return { type: "rule", attrs: id };
      case "media":
        return { type: "media", attrs: { ...id, target: b.target, alt: b.alt, caption: b.caption ?? "" } };
      case "source":
        return { type: "source", attrs: { ...id, md: b.md, kind: b.kind } };
      case "steps":
        return { type: "steps", attrs: id, content: inside.length ? inside : [{ type: "paragraph", attrs: { bid: newId() } }] };
      case "card":
        return { type: "card", attrs: { ...id, href: b.href, label: b.label, description: b.description, image: b.image, alt: b.alt } };
      case "video":
        return { type: "video", attrs: { ...id, src: b.src, caption: b.caption } };
      case "snippet":
        return { type: "snippet", attrs: { ...id, key: b.key } };
      case "table": {
        const width = Math.max(1, b.head.length, ...b.rows.map((r) => r.length));
        const fill = (r: Span[][]) => [...r, ...emptyCells(width - r.length)].slice(0, width);
        const row = (cells: Span[][], head: boolean): JSONContent => ({
          type: "tableRow",
          content: fill(cells).map((c) => ({ type: head ? "tableHeader" : "tableCell", content: spansToContent(c) })),
        });
        return { type: "table", attrs: { ...id, align: Array.from({ length: width }, (_, k) => b.align[k] ?? null) }, content: [row(b.head, true), ...b.rows.map((r) => row(r, false))] };
      }
      case "columns": {
        const cols = inside.filter((c) => c.type === "column");
        if (cols.length < 2) return inside.length ? { type: "columns", attrs: id, content: [...cols, ...Array.from({ length: 2 - cols.length }, () => ({ type: "column", content: [{ type: "paragraph" }] }))] } : null;
        return { type: "columns", attrs: id, content: cols };
      }
      case "col":
        return { type: "column", attrs: id, content: inside.length ? inside : [{ type: "paragraph", attrs: { bid: newId() } }] };
    }
  };
  const top = (kids.get("") ?? []).map(nodeOf).filter((x): x is JSONContent => !!x);
  return { type: "doc", content: top.length ? top : [{ type: "paragraph", attrs: { bid: newId() } }] };
}

// ── document → blocks ─────────────────────────────────────────────────────────

/** The blocks of the editor's document (ids from the nodes; nodes without one get a new one). */
export function docToBlocks(doc: PMNode): EBlock[] {
  const out: EBlock[] = [];
  const idOf = (n: PMNode) => (n.attrs.bid as string | null) || newId();
  const walk = (n: PMNode, parent: string | undefined) => {
    const id = idOf(n);
    const base = parent ? { id, parent } : { id };
    switch (n.type.name) {
      case "paragraph":
        out.push({ ...base, type: "p", spans: nodeSpans(n) } as TextBlock);
        return;
      case "heading": {
        const h = { ...base, type: `h${headingLevel(n.attrs.level)}`, spans: nodeSpans(n) } as TextBlock;
        if (n.attrs.anchor) h.anchor = n.attrs.anchor as string;
        out.push(h);
        return;
      }
      case "steps":
        out.push({ ...base, type: "steps" });
        n.forEach((c) => walk(c, id));
        return;
      case "card":
        out.push({
          ...base,
          type: "card",
          href: (n.attrs.href as string) ?? "",
          label: (n.attrs.label as string) ?? "",
          description: (n.attrs.description as string) ?? "",
          image: (n.attrs.image as string) ?? "",
          alt: (n.attrs.alt as string) ?? "",
        });
        return;
      case "video":
        out.push({ ...base, type: "video", src: (n.attrs.src as string) ?? "", caption: (n.attrs.caption as string) ?? "" });
        return;
      case "snippet":
        out.push({ ...base, type: "snippet", key: (n.attrs.key as string) ?? "" });
        return;
      case "quote":
        out.push({ ...base, type: "quote", spans: nodeSpans(n) } as TextBlock);
        return;
      case "callout":
        out.push({ ...base, type: "callout", tone: (n.attrs.tone as Tone) ?? "note", spans: nodeSpans(n) } as TextBlock);
        return;
      case "listItem":
      case "toggle": {
        const line = n.firstChild && n.firstChild.type.name === "line" ? n.firstChild : null;
        const kind = (n.type.name === "toggle" ? "toggle" : n.attrs.kind) as TextType;
        const b: TextBlock = { ...base, type: kind, spans: line ? nodeSpans(line) : [] };
        if (kind === "todo") b.checked = !!n.attrs.checked;
        if (kind === "number" && n.attrs.start !== null && n.attrs.start !== undefined) b.start = n.attrs.start as number;
        if (kind !== "toggle" && n.attrs.newList) b.newList = true;
        out.push(b);
        n.forEach((c, _o, i) => {
          if (i === 0 && line) return;
          walk(c, id);
        });
        return;
      }
      case "codeBlock":
        out.push({ ...base, type: "code", text: n.textContent, lang: (n.attrs.lang as string) ?? "" });
        return;
      case "rule":
        out.push({ ...base, type: "hr" });
        return;
      case "media": {
        const m: EBlock = { ...base, type: "media", target: (n.attrs.target as string) ?? "", alt: (n.attrs.alt as string) ?? "" };
        if (n.attrs.caption) m.caption = n.attrs.caption as string;
        out.push(m);
        return;
      }
      case "source":
        out.push({ ...base, type: "source", md: (n.attrs.md as string) ?? "", kind: (n.attrs.kind as string) ?? "p" });
        return;
      case "table": {
        const rows: Span[][][] = [];
        n.forEach((r) => {
          const cells: Span[][] = [];
          r.forEach((c) => cells.push(nodeSpans(c)));
          rows.push(cells);
        });
        const width = Math.max(1, ...rows.map((r) => r.length));
        const align = Array.from({ length: width }, (_, k) => ((n.attrs.align as TableAlign[] | undefined)?.[k] ?? null) as TableAlign);
        out.push({ ...base, type: "table", align, head: rows[0] ?? emptyCells(width), rows: rows.slice(1) });
        return;
      }
      case "columns":
        out.push({ ...base, type: "columns" });
        n.forEach((c) => walk(c, id));
        return;
      case "column":
        out.push({ ...base, type: "col" });
        n.forEach((c) => walk(c, id));
        return;
    }
  };
  doc.forEach((n) => walk(n, undefined));
  return out;
}

/** The document node for a list of blocks, in a schema (tests and conversions). */
export function docNode(blocks: readonly EBlock[], schema: Schema = cmsSchema()): PMNode {
  return schema.nodeFromJSON(blocksToDoc(blocks));
}

/** Where a block's text starts in the document (inside its line for items and toggles); -1 when not found. */
export function textStartOf(doc: PMNode, id: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at >= 0) return false;
    if (n.attrs.bid !== id) return;
    if (n.type.name === "listItem" || n.type.name === "toggle") at = pos + 2;
    else if (n.isTextblock) at = pos + 1;
    else at = pos;
    return false;
  });
  return at;
}

/** The innermost block (node with an id) at a document position, and where its text starts. */
export function blockAt(doc: PMNode, pos: number): { id: string; node: PMNode; pos: number; offset: number } | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === "line") continue;
    if (typeof n.attrs.bid === "string") {
      const start = $p.before(d);
      const textStart = n.type.name === "listItem" || n.type.name === "toggle" ? start + 2 : start + 1;
      return { id: n.attrs.bid, node: n, pos: start, offset: Math.max(0, pos - textStart) };
    }
  }
  return null;
}
