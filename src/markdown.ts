/**
 * The markdown subset documents are written in, parsed to a small block tree.
 * Framework-free: the app renders the tree with its own components, so a doc
 * looks native wherever it shows (public page, admin preview, chat).
 *
 * Supported: `## / ###` headings, paragraphs, `-`/`*` and `1.` lists, task
 * lists `- [ ]` / `- [x]`, `>` quotes and `> [!note]` callouts, fenced code,
 * `---`, GFM tables, and inline **bold**, *italic* (or _italic_), ~~strike~~,
 * `code`, [text](url), a hard line break (a line ending in `\`) and the CMS
 * link `[[link:key|label]]`. A backslash before a markup character keeps it
 * as text (`\*`).
 *
 * Blocks between `:::` lines (0.15.0):
 * - `:::toggle Title` … `:::` a part that opens and closes,
 * - `:::columns` / `:::col` … `:::col` … / `:::` side-by-side columns,
 * - `:::html` … `:::` HTML kept exactly as written. It is never sanitized
 *   when saved; renderers make it safe when they draw it (see `./html`).
 *   `:::html isolated` asks for it to run in a sandboxed frame instead.
 * Any other `:::name` block is kept word for word as a `raw` block.
 *
 * Files from the media library are named by id: `![alt](asset:ID/name.jpg
 * "caption")` on a line of its own is a media block (an image, a video
 * player or a download card, by the file's type), and `[label](asset:ID/
 * name.pdf)` links to a file. Only the id matters; the name after the slash
 * is there for people. `![alt](https://…)` shows an image from elsewhere.
 *
 * `toMarkdown(blocks)` writes a tree back. For every tree `parseMarkdown`
 * makes, `parseMarkdown(toMarkdown(tree))` gives the same tree.
 */

export type Inline =
  | { t: "text"; v: string }
  /** `v` is the plain text; `kids` is there when the part has markup inside (`**see [x](/y)**`). */
  | { t: "strong"; v: string; kids?: Inline[] }
  | { t: "em"; v: string; kids?: Inline[] }
  | { t: "del"; v: string; kids?: Inline[] }
  | { t: "code"; v: string }
  /** A hard line break (a line ending in `\`). */
  | { t: "br"; v: "\n" }
  | { t: "link"; href: string; v: string }
  /** `[label](asset:ID/name)`: a link to a file in the media library. */
  | { t: "file"; asset: string; name: string; v: string }
  /** An image inside a line of text. `asset` (a media library id) or `src` (https). */
  | { t: "image"; asset: string | null; name: string; src: string | null; alt: string; v: string }
  /** `[[link:key|label]]` — an app screen, resolved by the collection. */
  | { t: "applink"; key: string; v: string };

/** With `parseMarkdown(src, { lines: true })` every top-level block says which lines of the source it came from (1-based). */
export type Block = BlockBody & { line?: number; endLine?: number };

export type TableAlign = "left" | "center" | "right" | null;

type BlockBody =
  | { t: "heading"; level: 2 | 3; id: string; text: string; inline: Inline[] }
  | { t: "p"; inline: Inline[] }
  /**
   * `start`: the first number of an ordered list when it is not 1.
   * `kids`: blocks nested under an item (lines indented under it), by item; only there when some item has them.
   */
  | { t: "list"; ordered: boolean; items: Inline[][]; start?: number; kids?: (Block[] | null)[] }
  | { t: "todo"; items: { checked: boolean; inline: Inline[]; kids?: Block[] }[] }
  | { t: "quote"; callout: "note" | "tip" | "warning" | null; blocks: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  /** A line that is only `![alt](asset:ID/name "caption")` or `![alt](https://…)`. */
  | { t: "media"; asset: string | null; name: string; src: string | null; alt: string; caption: string }
  /** A paragraph that is only app links: drawn as link cards. */
  | { t: "links"; items: { key: string; v: string }[] }
  | { t: "table"; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] }
  /** `:::toggle Title`: `title` shown, `blocks` hidden until opened. */
  | { t: "toggle"; title: Inline[]; text: string; blocks: Block[] }
  | { t: "columns"; cols: Block[][] }
  /** `:::html`: the HTML exactly as written. Draw it with `./html`'s `sanitizeHtml` or in a sandboxed frame, never as is. */
  | { t: "html"; v: string; isolated?: true }
  /** Text the parser does not know (an unknown `:::name` block), kept word for word. */
  | { t: "raw"; v: string };

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export const APP_LINK_RE = /\[\[link:([a-z0-9][a-z0-9._-]*)\|([^\]]+)\]\]/gi;

/** Heading anchor: lowercase, spaces → '-', keeps Hangul; stable across renders. */
export function anchorOf(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()<>!?.,:;'"“”‘’/\\|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "section";
}

const ASSET_TARGET = /^asset:([a-z0-9]{12})(?:\/([^\s)]*))?$/;
const IMAGE = String.raw`!\[([^\]]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\s*\)`;
const IMAGE_LINE = new RegExp(`^\\s*${IMAGE}\\s*$`);
const IMAGE_ANY = new RegExp(IMAGE, "g");
const ASSET_LINK_ANY = /(^|[^!])\[([^\]]+)\]\(asset:([a-z0-9]{12})(?:\/[^\s)]*)?\)/g;
/** Characters a backslash keeps as text. */
const ESCAPABLE = "\\`*_~[]#>!|:+.)(-";

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** `asset:ID/name` → the file's id and name; an https URL → `src`. Anything else: null. */
function mediaTarget(target: string): { asset: string | null; name: string; src: string | null } | null {
  const a = ASSET_TARGET.exec(target);
  if (a) return { asset: a[1], name: safeDecode(a[2] ?? ""), src: null };
  if (/^https:\/\//i.test(target)) return { asset: null, name: "", src: target };
  return null;
}

const INLINE_RE = new RegExp(
  [
    String.raw`(?<br>\\\n)`,
    String.raw`\\(?<esc>[\\${"`"}*_~\[\]#>!|:+.)(\-])`,
    String.raw`\[\[link:(?<key>[a-z0-9][a-z0-9._-]*)\|(?<keyLabel>[^\]]+)\]\]`,
    "(?<ticks>``+)(?<code2>.+?)\\k<ticks>(?!`)",
    "`(?<code>[^`]+)`",
    String.raw`!\[(?<alt>[^\]]*)\]\(\s*(?<img>(?:[^()\s]|\([^()\s]*\))+)(?:\s+"(?<cap>[^"]*)")?\s*\)`,
    String.raw`\[(?<label>[^\]]+)\]\((?<href>(?:[^()\s]|\([^()\s]*\))+)\)`,
    String.raw`\*\*(?<strong>(?=\S)(?:\\.|[^\\])+?)\*\*(?!\*)`,
    String.raw`~~(?<del>(?=\S)(?:\\.|[^\\])+?)~~`,
    String.raw`\*(?<em>(?![\s*])(?:\\.|[^\\])+?)(?<![\s\\])\*(?!\*)`,
    String.raw`(?<![\p{L}\p{N}_\\])_(?<em2>(?![\s_])(?:\\.|[^\\])+?)(?<![\s\\])_(?![\p{L}\p{N}_])`,
  ].join("|"),
  "giu"
);

function wrap(t: "strong" | "em" | "del", inner: string): Inline {
  const kids = parseInline(inner);
  if (kids.length === 1 && kids[0].t === "text") return { t, v: kids[0].v };
  return { t, v: inlineText(kids), kids };
}

/** A code span with enough backticks around it for the backticks inside. */
export function codeSpan(v: string): string {
  if (!v.includes("`")) return `\`${v}\``;
  const longest = Math.max(...(v.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = "`".repeat(Math.max(2, longest + 1));
  return `${ticks} ${v} ${ticks}`;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const g = m.groups!;
    if (m.index > last) text(src.slice(last, m.index));
    if (g.br !== undefined) out.push({ t: "br", v: "\n" });
    else if (g.esc !== undefined) text(g.esc);
    else if (g.key) out.push({ t: "applink", key: g.key, v: g.keyLabel });
    else if (g.code2 !== undefined) out.push({ t: "code", v: g.code2.replace(/^ (.*) $/, "$1") });
    else if (g.code !== undefined) out.push({ t: "code", v: g.code });
    else if (g.img !== undefined) {
      const target = mediaTarget(g.img);
      if (target) out.push({ t: "image", ...target, alt: g.alt, v: g.alt });
      else text(g.alt);
    } else if (g.label !== undefined) {
      const href = g.href;
      const file = ASSET_TARGET.exec(href);
      if (file) out.push({ t: "file", asset: file[1], name: safeDecode(file[2] ?? ""), v: g.label });
      // Only http(s), mailto and same-site paths: no javascript: or data: URLs, and no `//host`
      // or `/\host` (browsers read both as another site).
      else if (/^(https?:\/\/|mailto:|\/(?![/\\])|#)/i.test(href) && !/[\s<>"`]/.test(href)) out.push({ t: "link", href, v: g.label });
      else text(g.label);
    } else if (g.strong !== undefined) out.push(wrap("strong", g.strong));
    else if (g.del !== undefined) out.push(wrap("del", g.del));
    else if (g.em !== undefined) out.push(wrap("em", g.em));
    else if (g.em2 !== undefined) out.push(wrap("em", g.em2));
    last = m.index + m[0].length;
  }
  if (last < src.length) text(src.slice(last));
  return out;
}

export function inlineText(inline: Inline[]): string {
  return inline.map((i) => i.v).join("");
}

const CONTAINER = /^:::([a-z][a-z0-9-]*)(?:[ \t]+(.*?))?\s*$/;
const CLOSE = /^:::\s*$/;
const FENCE_OPEN = /^```(\S*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of a table row: split at `|` that is not escaped or inside `code`. */
function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  // Inside a code span: the length of the backtick run that opened it (0: not in code).
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && !tick) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const run = "`".repeat(n);
      // Code only when a run of the same length closes it later on the line.
      const closes = (from: number) => {
        for (let j = s.indexOf(run, from); j >= 0; j = s.indexOf(run, j + 1)) if (s[j - 1] !== "`" && s[j + n] !== "`") return true;
        return false;
      };
      if (!tick && closes(i + n)) tick = n;
      else if (tick && n === tick) tick = 0;
      cur += s.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (c === "|" && !tick) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Index of the `:::` line that closes the container opened at `from` (or lines.length). */
function closeOf(lines: string[], from: number, html: boolean): number {
  if (html) {
    for (let j = from + 1; j < lines.length; j++) if (CLOSE.test(lines[j])) return j;
    return lines.length;
  }
  let depth = 1;
  for (let j = from + 1; j < lines.length; j++) {
    const l = lines[j];
    if (FENCE_OPEN.test(l)) {
      j++;
      while (j < lines.length && !FENCE_CLOSE.test(lines[j])) j++;
      continue;
    }
    const c = CONTAINER.exec(l);
    if (c && c[1] !== "col") {
      if (c[1] === "html") {
        j = closeOf(lines, j, true);
        continue;
      }
      depth++;
      continue;
    }
    if (CLOSE.test(l) && --depth === 0) return j;
  }
  return lines.length;
}

/** A list item marker at the start of a line (after any indentation). */
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Leading spaces of a line (a tab counts as four). */
function indentOf(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** A line without its first `cols` columns of indentation; the rest (tabs in code too) is kept as written. */
export function stripIndent(line: string, cols: number): string {
  let n = 0;
  let i = 0;
  while (i < line.length && n < cols && (line[i] === " " || line[i] === "\t")) {
    n += line[i] === "\t" ? 4 - (n % 4) : 1;
    i++;
  }
  return (n > cols ? " ".repeat(n - cols) : "") + line.slice(i);
}

/** Lines without the indentation they all share. */
function dedent(lines: string[]): string {
  const cut = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => (l.trim() ? stripIndent(l, cut) : "")).join("\n");
}

export function parseMarkdown(source: string, o: { lines?: boolean } = {}): Block[] {
  const lines = source.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  /** `from`, `to`: 0-based source lines of the block. */
  const push = (b: Block, from: number, to: number) => out.push(o.lines ? { ...b, line: from + 1, endLine: to + 1 } : b);
  const used = new Map<string, number>();
  let para: string[] = [];
  let paraAt = [0, 0];
  type ListAcc = { kind: "ul" | "ol" | "todo"; items: string[]; checks: boolean[]; start: number; from: number; to: number; indent: number; kids: (string[] | null)[]; width: number };
  let list: ListAcc | null = null;

  const uniqueId = (text: string) => {
    const base = anchorOf(text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const flushPara = () => {
    if (!para.length) return;
    let text = "";
    para.forEach((l, k) => {
      if (k === 0) text = l;
      else text += /(^|[^\\])(\\\\)*\\$/.test(text) ? "\n" + l : " " + l;
    });
    para = [];
    text = text.trim();
    if (!text) return;
    const inline = parseInline(text);
    const onlyLinks = inline.every((i) => i.t === "applink" || (i.t === "text" && !i.v.trim()));
    if (onlyLinks && inline.some((i) => i.t === "applink")) {
      push({ t: "links", items: inline.filter((i): i is Extract<Inline, { t: "applink" }> => i.t === "applink").map((i) => ({ key: i.key, v: i.v })) }, paraAt[0], paraAt[1]);
    } else push({ t: "p", inline }, paraAt[0], paraAt[1]);
  };
  const flushList = () => {
    if (!list) return;
    const l: ListAcc = list;
    const kids = l.kids.map((k) => (k ? parseMarkdown(dedent(k)) : null));
    const any = kids.some((k) => k && k.length);
    if (l.kind === "todo") push({ t: "todo", items: l.items.map((s, k) => (kids[k]?.length ? { checked: l.checks[k], inline: parseInline(s), kids: kids[k]! } : { checked: l.checks[k], inline: parseInline(s) })) }, l.from, l.to);
    else {
      const b: Block = { t: "list", ordered: l.kind === "ol", items: l.items.map(parseInline) };
      if (l.kind === "ol" && l.start !== 1) b.start = l.start;
      if (any) b.kids = kids.map((k) => (k && k.length ? k : null));
      push(b, l.from, l.to);
    }
    list = null;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Lines indented under a list item: a nested list (and what follows it) belongs to that item.
    if (list && line.trim()) {
      const l: ListAcc = list;
      const at = indentOf(line);
      const last = l.kids.length - 1;
      if (at >= l.indent + l.width && (l.kids[last] || LIST_MARK.test(line))) {
        flushPara();
        (l.kids[last] ??= []).push(line);
        l.to = i;
        continue;
      }
    }
    if (list && !line.trim()) {
      // A blank line then lines indented under the item: blocks inside the item (a paragraph, a toggle, a list...).
      const l: ListAcc = list;
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && indentOf(lines[k]) >= l.indent + l.width) {
        flushPara();
        const last = l.kids.length - 1;
        for (; i < k; i++) (l.kids[last] ??= []).push("");
        i--;
        continue;
      }
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      const from = i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) buf.push(lines[i++]);
      push({ t: "code", lang: fence[1] ?? "", v: buf.join("\n") }, from, Math.min(i, lines.length - 1));
      continue;
    }
    const box = CONTAINER.exec(line);
    if (box && box[1] !== "col") {
      flush();
      const name = box[1];
      const end = closeOf(lines, i, name === "html");
      const inner = lines.slice(i + 1, end);
      const to = Math.min(end, lines.length - 1);
      if (name === "html") push((box[2] ?? "").trim() === "isolated" ? { t: "html", v: inner.join("\n"), isolated: true } : { t: "html", v: inner.join("\n") }, i, to);
      else if (name === "toggle") {
        const title = parseInline((box[2] ?? "").trim());
        push({ t: "toggle", title, text: inlineText(title), blocks: parseMarkdown(inner.join("\n")) }, i, to);
      } else if (name === "columns") {
        const cols: string[][] = [];
        let depth = 0;
        for (let k = 0; k < inner.length; k++) {
          const l = inner[k];
          if (depth === 0 && /^:::col\s*$/.test(l)) {
            cols.push([]);
            continue;
          }
          if (!cols.length) cols.push([]);
          if (FENCE_OPEN.test(l)) {
            cols[cols.length - 1].push(l);
            while (++k < inner.length) {
              cols[cols.length - 1].push(inner[k]);
              if (FENCE_CLOSE.test(inner[k])) break;
            }
            continue;
          }
          const c = CONTAINER.exec(l);
          if (c && c[1] !== "col") {
            if (c[1] === "html") {
              const e = closeOf(inner, k, true);
              cols[cols.length - 1].push(...inner.slice(k, e + 1));
              k = e;
              continue;
            }
            depth++;
          } else if (CLOSE.test(l)) depth--;
          cols[cols.length - 1].push(l);
        }
        push({ t: "columns", cols: cols.map((c) => parseMarkdown(c.join("\n"))) }, i, to);
      } else push({ t: "raw", v: lines.slice(i, end + 1).join("\n") }, i, to);
      i = end;
      continue;
    }
    const h = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const text = h[2];
      const inline = parseInline(text);
      push({ t: "heading", level: h[1].length as 2 | 3, id: uniqueId(inlineText(inline)), text: inlineText(inline), inline }, i, i);
      continue;
    }
    if (/^#\s+/.test(line)) {
      // A document's title lives in its own field; a stray H1 renders as H2.
      flush();
      const inline = parseInline(line.replace(/^#\s+/, ""));
      push({ t: "heading", level: 2, id: uniqueId(inlineText(inline)), text: inlineText(inline), inline }, i, i);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      push({ t: "hr" }, i, i);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf: string[] = [];
      const from = i;
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      i--;
      let callout: "note" | "tip" | "warning" | null = null;
      const tag = /^\[!(note|tip|warning)\]\s*$/i.exec(buf[0] ?? "");
      if (tag) {
        callout = tag[1].toLowerCase() as "note" | "tip" | "warning";
        buf.shift();
      }
      const inner = parseMarkdown(buf.join("\n")).map((b) => (b.t === "heading" ? ({ t: "p", inline: b.inline } as Block) : b));
      push({ t: "quote", callout, blocks: inner }, from, i);
      continue;
    }
    if (line.includes("|") && !para.length && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = tableCells(line);
      const delim = tableCells(lines[i + 1]);
      if (head.length === delim.length && (line.trim().startsWith("|") || head.length > 1)) {
        flush();
        const from = i;
        const align: TableAlign[] = delim.map((d) => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null));
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          const cells = tableCells(lines[i]);
          rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
          i++;
        }
        i--;
        push({ t: "table", align, head: head.map(parseInline), rows }, from, i);
        continue;
      }
    }
    const img = IMAGE_LINE.exec(line);
    const target = img ? mediaTarget(img[2]) : null;
    if (img && target) {
      flush();
      push({ t: "media", ...target, alt: img[1].trim(), caption: (img[3] ?? "").trim() }, i, i);
      continue;
    }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    const ul = task ? null : /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (task || ul || ol) {
      flushPara();
      const kind = task ? "todo" : ol ? "ol" : "ul";
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [], checks: [], start: ol ? Number(ol[1]) : 1, from: i, to: i, indent: indentOf(line), kids: [], width: 2 };
      // Blocks inside this item start at its text: past the marker and the space after it.
      list.width = Math.max(2, (/^\s*(?:[-*+]|\d+[.)])\s/.exec(line)?.[0].length ?? 2) - indentOf(line));
      list.items.push(task ? task[2] : ol ? ol[2] : ul![1]);
      list.checks.push(task ? task[1] !== " " : false);
      list.kids.push(null);
      list.to = i;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += " " + line.trim();
      list.to = i;
      continue;
    }
    flushList();
    paraAt = para.length ? [paraAt[0], i] : [i, i];
    para.push(line.trim());
  }
  flush();
  return out;
}

// ── writing a tree back ───────────────────────────────────────────────────────

const ESCAPE_ALL = new RegExp(`[${ESCAPABLE.replace(/[\]\\^-]/g, "\\$&")}]`, "g");

function escapeText(s: string): string {
  return s.replace(ESCAPE_ALL, "\\$&");
}

function inlineMd(items: Inline[], esc: boolean): string {
  const text = (s: string) => (esc ? escapeText(s) : s);
  return items
    .map((i) => {
      switch (i.t) {
        case "text":
          return text(i.v);
        case "strong":
          return `**${i.kids ? inlineMd(i.kids, esc) : text(i.v)}**`;
        case "em":
          return `*${i.kids ? inlineMd(i.kids, esc) : text(i.v)}*`;
        case "del":
          return `~~${i.kids ? inlineMd(i.kids, esc) : text(i.v)}~~`;
        case "code":
          return codeSpan(i.v);
        case "br":
          return "\\\n";
        case "link":
          return `[${i.v}](${i.href})`;
        case "file":
          return `[${i.v}](asset:${i.asset}${i.name ? "/" + encodeName(i.name) : ""})`;
        case "image":
          return `![${i.alt}](${i.asset ? `asset:${i.asset}${i.name ? "/" + encodeName(i.name) : ""}` : (i.src ?? "")})`;
        case "applink":
          return `[[link:${i.key}|${i.v}]]`;
      }
    })
    .join("");
}

const encodeName = (name: string) => encodeURIComponent(name).replace(/%2F/gi, "/").replace(/[()]/g, (c) => encodeURIComponent(c));

/** Inline markup for `items`: as plain as it can be while reading back the same. */
export function inlineToMarkdown(items: Inline[]): string {
  const plain = inlineMd(items, false);
  if (same(parseInline(plain), items)) return plain;
  return inlineMd(items, true);
}

/** Drop what parsing adds (`line`, heading ids) so two trees compare by content. */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "line" && k !== "endLine" && k !== "id" && x !== undefined) o[k] = strip(x);
    return o;
  }
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(strip(a))) === JSON.stringify(sortKeys(strip(b)));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
    );
  }
  return v;
}

/** True when two block trees say the same thing (source lines and heading ids aside). */
export function sameBlocks(a: Block[], b: Block[]): boolean {
  return same(a, b);
}

/** A table cell: `|` outside code gets a backslash; a line break becomes a space. */
const cell = (items: Inline[]) => {
  const flat = items.map((i) => (i.t === "br" ? ({ t: "text", v: " " } as Inline) : i));
  // A backtick in the text would start code to the cell splitter: always escaped in a cell.
  const md = JSON.stringify(flat).includes("`") && flat.some((i) => "v" in i && i.t !== "code" && i.v.includes("`")) ? inlineMd(flat, true) : inlineToMarkdown(flat);
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
  return out;
};

function blockMd(b: Block): string {
  switch (b.t) {
    case "heading":
      return `${b.level === 2 ? "##" : "###"} ${inlineToMarkdown(b.inline)}`;
    case "p":
      return inlineToMarkdown(b.inline);
    case "list":
      return b.items
        .map((it, k) => {
          const mark = b.ordered ? `${(b.start ?? 1) + k}.` : "-";
          return guard({ t: "list", ordered: b.ordered, items: [it], ...(b.ordered && (b.start ?? 1) + k !== 1 ? { start: (b.start ?? 1) + k } : {}) }, `${mark} ${inlineToMarkdown(it)}`) + nested(b.kids?.[k], mark.length + 1);
        })
        .join("\n");
    case "todo":
      return b.items.map((it) => guard({ t: "todo", items: [{ checked: it.checked, inline: it.inline }] }, `- [${it.checked ? "x" : " "}] ${inlineToMarkdown(it.inline)}`) + nested(it.kids, 2)).join("\n");
    case "quote": {
      const inner = (b.callout ? `[!${b.callout}]\n` : "") + toMarkdown(b.blocks);
      return inner
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    }
    case "code":
      return "```" + b.lang + "\n" + b.v + "\n```";
    case "hr":
      return "---";
    case "media": {
      const target = b.asset ? `asset:${b.asset}${b.name ? "/" + encodeName(b.name) : ""}` : (b.src ?? "");
      return `![${b.alt}](${target}${b.caption ? ` "${b.caption}"` : ""})`;
    }
    case "links":
      return b.items.map((x) => `[[link:${x.key}|${x.v}]]`).join(" ");
    case "table": {
      const row = (cells: Inline[][]) => `| ${cells.map(cell).join(" | ")} |`;
      const delim = `| ${b.align.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---")).join(" | ")} |`;
      return [row(b.head), delim, ...b.rows.map(row)].join("\n");
    }
    case "toggle":
      return `:::toggle ${inlineToMarkdown(b.title)}\n${toMarkdown(b.blocks)}${b.blocks.length ? "\n" : ""}:::`;
    case "columns":
      return `:::columns\n${b.cols.map((c) => `:::col\n${toMarkdown(c)}${c.length ? "\n" : ""}`).join("")}:::`;
    case "html":
      return `:::html${b.isolated ? " isolated" : ""}\n${b.v}\n:::`;
    case "raw":
      return b.v;
  }
}

/** Blocks nested under a list item, indented under its text. */
function nested(kids: Block[] | null | undefined, width: number): string {
  if (!kids || !kids.length) return "";
  const pad = " ".repeat(width);
  // A nested list follows the item's line; anything else needs a blank line before it.
  return (
    (kids[0].t === "list" || kids[0].t === "todo" ? "\n" : "\n\n") +
    toMarkdown(kids)
      .split("\n")
      .map((l) => (l ? pad + l : ""))
      .join("\n")
  );
}

/** A paragraph whose first character would start another kind of block gets a backslash. */
function guard(b: Block, md: string): string {
  if (b.t !== "p" && b.t !== "heading" && b.t !== "list" && b.t !== "todo") return md;
  if (same(parseMarkdown(md), [b])) return md;
  const lines = md.split("\n");
  const fixed = lines
    .map((l, k) => {
      const prefix = b.t === "heading" ? /^#+ / : b.t === "p" ? /^/ : b.t === "todo" ? /^- \[[ x]\] / : /^(\d+\. |- )/;
      if (b.t === "p" && k > 0 && !lines[k - 1].endsWith("\\")) return l;
      const m = prefix.exec(l);
      const at = m ? m[0].length : 0;
      const rest = l.slice(at);
      if (rest.startsWith("\\")) return l;
      const num = /^(\d+)([.)])/.exec(rest);
      if (num) return l.slice(0, at) + num[1] + "\\" + rest.slice(num[1].length);
      return /^[#>\-+*|:`![]/.test(rest) ? l.slice(0, at) + "\\" + rest : l;
    })
    .join("\n");
  return fixed;
}

/** Markdown for a block tree, in the form `parseMarkdown` reads back to the same tree. */
export function toMarkdown(blocks: Block[]): string {
  return blocks.map((b) => ((b.t === "list" && b.kids) || (b.t === "todo" && b.items.some((x) => x.kids)) ? blockMd(b) : guard(b, blockMd(b)))).join("\n\n");
}

export function extractToc(blocks: Block[]): TocItem[] {
  return blocks.flatMap((b) => (b.t === "heading" ? [{ id: b.id, text: b.text, level: b.level }] : []));
}

/** Every `[[link:key|…]]` key in a body. */
export function appLinkKeys(body: string): string[] {
  const keys = new Set<string>();
  for (const m of body.matchAll(APP_LINK_RE)) keys.add(m[1]);
  return [...keys];
}

export interface AssetUse {
  id: string;
  /** `media`: a block of its own. `image`: inside a line. `file`: a link. `html`: inside an HTML block. */
  as: "media" | "image" | "file" | "html";
  alt: string;
  /** 1-based line in the body. */
  line: number;
}

/** Every use of a media library file in a body, in order (code blocks skipped). */
export function assetUses(body: string): AssetUse[] {
  const out: AssetUse[] = [];
  let inFence = false;
  let inHtml = false;
  body.replace(/\r/g, "").split("\n").forEach((line, i) => {
    if (!inHtml && /^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    if (!inHtml && /^:::html(\s+isolated)?\s*$/.test(line)) {
      inHtml = true;
      return;
    }
    if (inHtml) {
      if (CLOSE.test(line)) inHtml = false;
      else for (const m of line.matchAll(/asset:([a-z0-9]{12})/g)) out.push({ id: m[1], as: "html", alt: "", line: i + 1 });
      return;
    }
    const whole = IMAGE_LINE.exec(line);
    for (const m of line.matchAll(IMAGE_ANY)) {
      const a = ASSET_TARGET.exec(m[2]);
      if (a) out.push({ id: a[1], as: whole ? "media" : "image", alt: m[1].trim(), line: i + 1 });
    }
    for (const m of line.matchAll(ASSET_LINK_ANY)) out.push({ id: m[3], as: "file", alt: "", line: i + 1 });
  });
  return out;
}

/** External images (`![alt](https://…)`) in a body: line and alt. */
export function externalImages(body: string): { src: string; alt: string; line: number }[] {
  const out: { src: string; alt: string; line: number }[] = [];
  let inFence = false;
  body.replace(/\r/g, "").split("\n").forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const m of line.matchAll(IMAGE_ANY)) if (/^https:\/\//i.test(m[2])) out.push({ src: m[2], alt: m[1].trim(), line: i + 1 });
  });
  return out;
}

/** Plain text of a body (for search and summaries): no markup, links as labels, HTML without tags. */
export function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^:::html(?: isolated)?\s*\n([\s\S]*?)\n:::\s*$/gm, (_m, html: string) =>
      " " +
      html
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">") +
      " "
    )
    .replace(/^:::(?:toggle|columns|col)?[ \t]*/gim, "")
    .replace(APP_LINK_RE, "$2")
    .replace(IMAGE_ANY, (_m, alt: string, _t: string, cap?: string) => ` ${alt} ${cap ?? ""} `)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?\[![a-z]+\]\s*$/gim, "")
    .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/gm, "")
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, "")
    .replace(/\\([\\`*_~[\]#>!|:+.)(-])/g, "$1")
    .replace(/~~|[*`>#|]/g, "")
    .replace(/^\s*(\d+[.)]|[-*])\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export interface Section {
  /** Heading anchor, or "" for the text before the first heading. */
  anchor: string;
  heading: string;
  /** Markdown of the section (heading line excluded). */
  markdown: string;
}

/** Split a body at `##` headings (### stays inside its section). */
export function splitSections(body: string): Section[] {
  const lines = body.replace(/\r/g, "").split("\n");
  const out: Section[] = [];
  const used = new Map<string, number>();
  let cur: Section = { anchor: "", heading: "", markdown: "" };
  let inFence = false;
  const push = () => {
    cur.markdown = cur.markdown.trim();
    if (cur.markdown || cur.heading) out.push(cur);
  };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      push();
      const text = inlineText(parseInline(h[1]));
      const base = anchorOf(text);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      cur = { anchor: n ? `${base}-${n}` : base, heading: text, markdown: "" };
      continue;
    }
    // ### headings also take an anchor slot so ids match parseMarkdown().
    const h3 = !inFence ? /^###\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h3) {
      const base = anchorOf(inlineText(parseInline(h3[1])));
      used.set(base, (used.get(base) ?? 0) + 1);
    }
    cur.markdown += line + "\n";
  }
  push();
  return out;
}

export { inspectHtml, hasScripts, DEFAULT_IFRAME_HOSTS, type HtmlPolicy, type HtmlInert, type HtmlInertKind } from "./html-inspect";

/** Every HTML block in a tree, nested ones included, in order. */
export function htmlBlocks(blocks: Block[]): Extract<Block, { t: "html" }>[] {
  const out: Extract<Block, { t: "html" }>[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === "html") out.push(b);
      else if (b.t === "quote" || b.t === "toggle") walk(b.blocks);
      else if (b.t === "columns") b.cols.forEach(walk);
      else if (b.t === "list") b.kids?.forEach((k) => k && walk(k));
      else if (b.t === "todo") b.items.forEach((x) => x.kids && walk(x.kids));
    }
  };
  walk(blocks);
  return out;
}

/** HTML blocks with where their text starts in the body (1-based line of the first HTML line). Skips code fences. */
export function htmlRegions(body: string): { line: number; v: string; isolated: boolean }[] {
  const lines = body.replace(/\r/g, "").split("\n");
  const out: { line: number; v: string; isolated: boolean }[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^:::html(\s+isolated)?\s*$/.exec(lines[i]);
    if (!m) continue;
    const end = closeOf(lines, i, true);
    out.push({ line: i + 2, v: lines.slice(i + 1, end).join("\n"), isolated: !!m[1] });
    i = end;
  }
  return out;
}
