/**
 * The markdown subset documents are written in, parsed to a small block tree.
 * Framework-free: the app renders the tree with its own components, so a doc
 * looks native wherever it shows (public page, admin preview, chat).
 *
 * Supported: `## / ###` headings, paragraphs, `-`/`*` and `1.` lists, `>`
 * quotes and `> [!note]` callouts, fenced code, `---`, and inline **bold**,
 * `code`, [text](url) and the CMS link `[[link:key|label]]`.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; href: string; v: string }
  /** `[[link:key|label]]` — an app screen, resolved by the collection. */
  | { t: "applink"; key: string; v: string };

export type Block =
  | { t: "heading"; level: 2 | 3; id: string; text: string; inline: Inline[] }
  | { t: "p"; inline: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; callout: "note" | "tip" | "warning" | null; blocks: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  /** A paragraph that is only app links: drawn as link cards. */
  | { t: "links"; items: { key: string; v: string }[] };

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
    .replace(/[`*_[\]()<>!?.,:;'"“”‘’/\\|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "section";
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\[\[link:([a-z0-9][a-z0-9._-]*)\|([^\]]+)\]\]|\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\))/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    if (m[2]) out.push({ t: "applink", key: m[2], v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "strong", v: m[4] });
    else if (m[5] !== undefined) out.push({ t: "code", v: m[5] });
    else if (m[6] !== undefined) {
      const href = m[7];
      // Only http(s), mailto and same-site paths: no javascript: or data: URLs.
      if (/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href)) out.push({ t: "link", href, v: m[6] });
      else out.push({ t: "text", v: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

export function inlineText(inline: Inline[]): string {
  return inline.map((i) => i.v).join("");
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  const used = new Map<string, number>();
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const uniqueId = (text: string) => {
    const base = anchorOf(text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    para = [];
    if (!text) return;
    const inline = parseInline(text);
    const onlyLinks = inline.every((i) => i.t === "applink" || (i.t === "text" && !i.v.trim()));
    if (onlyLinks && inline.some((i) => i.t === "applink")) {
      blocks.push({
        t: "links",
        items: inline.filter((i): i is Extract<Inline, { t: "applink" }> => i.t === "applink").map((i) => ({ key: i.key, v: i.v })),
      });
    } else blocks.push({ t: "p", inline });
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ t: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      blocks.push({ t: "code", lang: fence[1] ?? "", v: buf.join("\n") });
      continue;
    }
    const h = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const text = h[2];
      const inline = parseInline(text);
      blocks.push({ t: "heading", level: h[1].length as 2 | 3, id: uniqueId(inlineText(inline)), text: inlineText(inline), inline });
      continue;
    }
    if (/^#\s+/.test(line)) {
      // A document's title lives in its own field; a stray H1 renders as H2.
      flush();
      const inline = parseInline(line.replace(/^#\s+/, ""));
      blocks.push({ t: "heading", level: 2, id: uniqueId(inlineText(inline)), text: inlineText(inline), inline });
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      i--;
      let callout: "note" | "tip" | "warning" | null = null;
      const tag = /^\[!(note|tip|warning)\]\s*$/i.exec(buf[0] ?? "");
      if (tag) {
        callout = tag[1].toLowerCase() as "note" | "tip" | "warning";
        buf.shift();
      }
      const inner = parseMarkdown(buf.join("\n")).map((b) => (b.t === "heading" ? ({ t: "p", inline: b.inline } as Block) : b));
      blocks.push({ t: "quote", callout, blocks: inner });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flush();
  return blocks;
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

/** Plain text of a body (for search and summaries): no markup, links as labels. */
export function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(APP_LINK_RE, "$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?\[![a-z]+\]\s*$/gim, "")
    .replace(/[*`>#]/g, "")
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
