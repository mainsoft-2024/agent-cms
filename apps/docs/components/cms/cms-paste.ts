// agent-cms registry: cms-doc-editor (0.10.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// What a paste becomes in the body: text copied from a web page or a
// document program arrives as HTML and is rewritten as the markdown the CMS
// renders (headings, lists, bold, links, tables, code). Things markdown has
// no place for (colours, font sizes) are left out, and the caller is told.

/** Remove invisible characters, straighten curly quotes, and use plain line breaks and spaces. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"');
}

/** True when the HTML says something markdown can keep. Editors that copy coloured `<div>`s and `<span>`s (code editors) are pasted as their plain text instead. */
export function hasStructure(html: string): boolean {
  return /<(h[1-6]|p|ul|ol|table|strong|b|em|i|a|pre|blockquote|img)\b/i.test(html);
}

const BLOCKS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "FIGURE", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE", "HR"]);
const SKIP = new Set(["SCRIPT", "STYLE", "META", "LINK", "HEAD", "TITLE", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME"]);
const LOST = new Set(["FONT", "U", "MARK", "SUB", "SUP", "SMALL", "BIG"]);

/**
 * HTML from the clipboard as markdown. `dropped` is true when something was
 * left out that the person could see in what they copied (a colour, a font
 * size, underline).
 */
export function htmlToMarkdown(html: string): { markdown: string; dropped: boolean } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let dropped = false;

  const wrap = (mark: string, s: string) => {
    // Markers go inside the spaces: "** bold**" is not bold.
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
  };

  const inline = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (SKIP.has(tag)) return "";
    if (tag === "BR") return "\n";
    if (LOST.has(tag)) dropped = true;
    const style = el.getAttribute("style") ?? "";
    if (/(^|;)\s*(color|background(-color)?|font-size|text-decoration)\s*:/i.test(style) && !/color\s*:\s*(#000|#000000|rgb\(0,\s*0,\s*0\)|black|inherit)/i.test(style)) dropped = true;
    if (tag === "IMG") {
      const src = el.getAttribute("src") ?? "";
      return /^https:\/\//i.test(src) ? `![${(el.getAttribute("alt") ?? "").replace(/[\[\]]/g, "")}](${src})` : "";
    }
    if (tag === "CODE") return el.textContent ? `\`${el.textContent}\`` : "";
    const inner = Array.from(el.childNodes).map(inline).join("");
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      return /^(https?:|mailto:|\/)/i.test(href) && inner.trim() ? `[${inner.trim()}](${href})` : inner;
    }
    // Google Docs wraps everything in <b style="font-weight:normal">; Word and Docs mark bold with spans.
    const weight = /font-weight\s*:\s*(\w+)/i.exec(style)?.[1]?.toLowerCase();
    const bold = weight ? weight === "bold" || Number(weight) >= 600 : tag === "B" || tag === "STRONG";
    const italic = /font-style\s*:\s*italic/i.test(style) || tag === "I" || tag === "EM";
    let out = inner;
    if (italic) out = wrap("*", out);
    if (bold) out = wrap("**", out);
    return out;
  };

  /** A node's children as paragraphs: runs of inline nodes are joined, block children are rendered on their own. */
  const blocks = (parent: Node, depth: number): string[] => {
    const out: string[] = [];
    let run = "";
    const flush = () => {
      const s = run
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .trim();
      if (s) out.push(s);
      run = "";
    };
    for (const child of Array.from(parent.childNodes)) {
      const el = child.nodeType === 1 ? (child as HTMLElement) : null;
      // An inline wrapper around paragraphs (Google Docs puts everything in one <b>) is only a container.
      if (el && !BLOCKS.has(el.tagName) && !SKIP.has(el.tagName) && el.querySelector("p,div,h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre")) {
        flush();
        out.push(...blocks(el, depth));
        continue;
      }
      if (!el || !BLOCKS.has(el.tagName)) {
        run += inline(child);
        continue;
      }
      flush();
      out.push(...block(el, depth));
    }
    flush();
    return out;
  };

  const list = (el: HTMLElement, depth: number): string => {
    const ordered = el.tagName === "OL";
    let n = Number(el.getAttribute("start")) || 1;
    const lines: string[] = [];
    for (const li of Array.from(el.children)) {
      if (li.tagName !== "LI") continue;
      const parts = blocks(li, depth + 1);
      const mark = ordered ? `${n++}. ` : "- ";
      const pad = " ".repeat(mark.length);
      const text = parts.join("\n").split("\n");
      lines.push(`${mark}${text[0] ?? ""}`, ...text.slice(1).map((l) => `${pad}${l}`));
    }
    return lines.join("\n");
  };

  const table = (el: HTMLElement): string => {
    const rows = Array.from(el.querySelectorAll("tr")).map((tr) => Array.from(tr.children).map((c) => inline(c).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()));
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!width) return "";
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    return [line(rows[0]), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
  };

  const block = (el: HTMLElement, depth: number): string[] => {
    const tag = el.tagName;
    const h = /^H([1-6])$/.exec(tag);
    if (h) {
      const text = inline(el).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
      return text ? [`${"#".repeat(Number(h[1]))} ${text}`] : [];
    }
    if (tag === "UL" || tag === "OL") return [list(el, depth)].filter(Boolean);
    if (tag === "TABLE") return [table(el)].filter(Boolean);
    if (tag === "HR") return ["---"];
    if (tag === "PRE") {
      const lang = /language-([\w-]+)/.exec(el.querySelector("code")?.className ?? "")?.[1] ?? "";
      return [`\`\`\`${lang}\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\``];
    }
    if (tag === "BLOCKQUOTE")
      return [
        blocks(el, depth)
          .join("\n\n")
          .split("\n")
          .map((l) => (l ? `> ${l}` : ">"))
          .join("\n"),
      ].filter((s) => s.trim() !== "");
    return blocks(el, depth);
  };

  const markdown = cleanText(blocks(doc.body, 0).join("\n\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, dropped };
}

/** What to put in the body for a paste, or null to let the browser paste as it would. */
export function pasteAsMarkdown(data: { html: string; plain: string }): { text: string; dropped: boolean } | null {
  if (data.html && hasStructure(data.html)) {
    const r = htmlToMarkdown(data.html);
    if (r.markdown) return { text: r.markdown, dropped: r.dropped };
  }
  const text = cleanText(data.plain);
  return text === data.plain ? null : { text, dropped: false };
}
