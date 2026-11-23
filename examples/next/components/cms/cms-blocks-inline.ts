// agent-cms: rich text inside one block of the block editor.
// A line of text is a list of spans (text + marks). Spans come from the
// block's inline markdown, are drawn as HTML in a contentEditable element, are
// read back from that element after each keystroke, and are written back as
// inline markdown. Formatting commands work on spans, never on the DOM, so the
// result is the same in every browser.

import { codeSpan, parseInline, type Inline } from "@mainsoft/agent-cms/markdown";

export type Mark = "b" | "i" | "s" | "code";
export const MARKS: readonly Mark[] = ["b", "i", "s", "code"];

export interface Span {
  text: string;
  b?: true;
  i?: true;
  s?: true;
  code?: true;
  /** A link target: "https://…", "/path", "asset:ID/name", or "cms-link:key" for an app link. */
  href?: string;
}

export const APP_LINK = "cms-link:";

// ── markdown → spans ──────────────────────────────────────────────────────────

function fromInline(items: Inline[], marks: Omit<Span, "text"> = {}): Span[] {
  const out: Span[] = [];
  for (const i of items) {
    switch (i.t) {
      case "text":
        out.push({ ...marks, text: i.v });
        break;
      case "br":
        out.push({ ...marks, text: "\n" });
        break;
      case "code":
        out.push({ ...marks, code: true, text: i.v });
        break;
      case "strong":
      case "em":
      case "del": {
        const m = { ...marks, [i.t === "strong" ? "b" : i.t === "em" ? "i" : "s"]: true };
        out.push(...(i.kids ? fromInline(i.kids, m) : [{ ...m, text: i.v }]));
        break;
      }
      case "link":
        out.push({ ...marks, href: i.href, text: i.v });
        break;
      case "file":
        out.push({ ...marks, href: `asset:${i.asset}/${encodeURIComponent(i.name)}`, text: i.v });
        break;
      case "applink":
        out.push({ ...marks, href: APP_LINK + i.key, text: i.v });
        break;
      case "image":
        // Blocks with inline images are kept as source blocks; this is only a fallback.
        out.push({ ...marks, text: i.alt });
        break;
    }
  }
  return normalize(out);
}

export function mdToSpans(md: string): Span[] {
  return fromInline(parseInline(md));
}

// ── spans → markdown ──────────────────────────────────────────────────────────

const same = (a: Span, b: Span) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.s === !!b.s && !!a.code === !!b.code && a.href === b.href;

/** Adjacent spans with the same marks become one; empty spans go. */
export function normalize(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const whole of spans) {
    if (!whole.text) continue;
    // A line break is always a span of its own.
    if (whole.text !== "\n" && whole.text.includes("\n")) {
      const parts = whole.text.split(/(\n)/).filter(Boolean);
      out.push(...normalize(parts.map((text) => ({ ...whole, text }))));
      continue;
    }
    const s = whole;
    const clean: Span = { text: s.text };
    for (const m of MARKS) if (s[m]) clean[m] = true;
    if (s.href) clean.href = s.href;
    const last = out[out.length - 1];
    if (last && same(last, clean) && clean.text !== "\n" && last.text !== "\n") last.text += clean.text;
    else out.push(clean);
  }
  return out;
}

const ESCAPE = /[\\`*_~[\]]/g;
/** A snippet token (`[[snippet:key]]`) stays as written: the server puts the snippet there. */
const SNIPPET_TOKEN = /(\[\[snippet:[a-z0-9][a-z0-9._-]*\]\])/i;
export const escapeMd = (s: string) =>
  s
    .split(SNIPPET_TOKEN)
    .map((part, k) => (k % 2 ? part : part.replace(ESCAPE, (c) => `\\${c}`)))
    .join("");

const MD_MARK: Record<"b" | "i" | "s", string> = { b: "**", i: "*", s: "~~" };
type Piece = { md: string; lead: string; trail: string; marks: ("b" | "i" | "s")[]; br?: true };

const codeMd = codeSpan;

function pieces(spans: Span[]): Piece[] {
  const out: Piece[] = [];
  for (let k = 0; k < spans.length; k++) {
    const s = spans[k];
    const marks = (["b", "i", "s"] as const).filter((m) => s[m]);
    if (s.text === "\n") {
      out.push({ md: "", lead: "", trail: "", marks: [], br: true });
      continue;
    }
    if (s.href) {
      // A link is written once for all spans that share its target; its label is plain text.
      let label = s.text;
      while (spans[k + 1]?.href === s.href && spans[k + 1].text !== "\n") label += spans[++k].text;
      const md = s.href.startsWith(APP_LINK) ? `[[link:${s.href.slice(APP_LINK.length)}|${label.replace(/[\]|]/g, "")}]]` : `[${label.replace(/[[\]]/g, (c) => `\\${c}`)}](${s.href})`;
      out.push({ md, lead: "", trail: "", marks });
      continue;
    }
    if (s.code) {
      out.push({ md: codeMd(s.text), lead: "", trail: "", marks });
      continue;
    }
    const lead = /^\s*/.exec(s.text)![0];
    const rest = s.text.slice(lead.length);
    const trail = /\s*$/.exec(rest)![0];
    const core = rest.slice(0, rest.length - trail.length);
    out.push({ md: escapeMd(core), lead, trail, marks: core ? marks : [] });
  }
  return out;
}

/** Spans → inline markdown. Marks stay open across spans that share them; spaces stay outside marks. */
export function spansToMd(input: Span[]): string {
  const ps = pieces(normalize(input));
  let out = "";
  const open: ("b" | "i" | "s")[] = [];
  let space = "";
  const lasts = (i: number, m: "b" | "i" | "s") => {
    let n = 0;
    while (i + n < ps.length && !ps[i + n].br && (ps[i + n].marks.includes(m) || !ps[i + n].md)) n++;
    return n;
  };
  const close = (to: number) => {
    while (open.length > to) out += MD_MARK[open.pop()!];
  };
  ps.forEach((p, i) => {
    if (p.br) {
      close(0);
      out += space + "\\\n";
      space = "";
      return;
    }
    if (!p.md) {
      space += p.lead + p.trail;
      return;
    }
    let keep = 0;
    while (keep < open.length && p.marks.includes(open[keep])) keep++;
    close(keep);
    out += space + p.lead;
    for (const m of p.marks.filter((x) => !open.includes(x)).sort((a, b) => lasts(i, b) - lasts(i, a))) (out += MD_MARK[m]), open.push(m);
    out += p.md;
    space = p.trail;
  });
  close(0);
  return out + space;
}

// ── spans → HTML (what the editable element shows) ────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function spansToHtml(spans: Span[]): string {
  let html = "";
  for (const s of spans) {
    if (s.text === "\n") {
      html += "<br>";
      continue;
    }
    let h = esc(s.text);
    if (s.code) h = `<code>${h}</code>`;
    if (s.s) h = `<s>${h}</s>`;
    if (s.i) h = `<em>${h}</em>`;
    if (s.b) h = `<strong>${h}</strong>`;
    if (s.href) h = `<a data-href="${esc(s.href)}" title="${esc(s.href.startsWith(APP_LINK) ? s.href.slice(APP_LINK.length) : s.href)}">${h}</a>`;
    html += h;
  }
  // A trailing line break needs a second one to be visible in an editable element.
  if (spans.length && spans[spans.length - 1].text === "\n") html += "<br>";
  return html;
}

// ── DOM → spans (after the browser changed the text) ──────────────────────────

const TAG_MARK: Record<string, Mark> = { STRONG: "b", B: "b", EM: "i", I: "i", S: "s", DEL: "s", STRIKE: "s", CODE: "code" };

export function domToSpans(root: Node): Span[] {
  const out: Span[] = [];
  const walk = (n: Node, marks: Omit<Span, "text">) => {
    n.childNodes.forEach((c, idx) => {
      if (c.nodeType === 3) {
        const t = (c.nodeValue ?? "").replace(/\u200b/g, "");
        if (t) out.push({ ...marks, text: t.replace(/\u00a0/g, " ") });
        return;
      }
      if (c.nodeType !== 1) return;
      const el = c as HTMLElement;
      if (el.tagName === "BR") {
        // The browser's placeholder <br> at the very end of the element is not text.
        const lastInRoot = n === root && idx === n.childNodes.length - 1;
        if (!lastInRoot) out.push({ ...marks, text: "\n" });
        return;
      }
      if (el.dataset?.cmsSkip !== undefined) return;
      const m = { ...marks } as Omit<Span, "text">;
      const mark = TAG_MARK[el.tagName];
      if (mark) m[mark] = true;
      if (el.tagName === "A") m.href = el.getAttribute("data-href") ?? el.getAttribute("href") ?? undefined;
      // A block element the browser made (pasting, some IMEs) starts a new line.
      if ((el.tagName === "DIV" || el.tagName === "P") && out.length && out[out.length - 1].text !== "\n") out.push({ ...marks, text: "\n" });
      walk(el, m);
    });
  };
  walk(root, {});
  return normalize(out);
}

// ── text, offsets, slicing ────────────────────────────────────────────────────

export const plain = (spans: Span[]) => spans.map((s) => s.text).join("");
export const spansLength = (spans: Span[]) => spans.reduce((n, s) => n + s.text.length, 0);

/** The spans between two character offsets. */
export function sliceSpans(spans: Span[], from: number, to = Infinity): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const s of spans) {
    const end = at + s.text.length;
    const a = Math.max(from, at);
    const b = Math.min(to, end);
    if (b > a) out.push({ ...s, text: s.text.slice(a - at, b - at) });
    at = end;
  }
  return normalize(out);
}

export function insertText(spans: Span[], at: number, text: string, like: Omit<Span, "text"> = {}): Span[] {
  return normalize([...sliceSpans(spans, 0, at), { ...like, text }, ...sliceSpans(spans, at)]);
}

/** Marks at a caret position (those of the character before it). */
export function marksAt(spans: Span[], at: number): Omit<Span, "text"> {
  let pos = 0;
  for (const s of spans) {
    pos += s.text.length;
    if (pos >= at && at > 0) {
      const { text: _t, href: _h, ...m } = s;
      return m;
    }
  }
  return {};
}

/** True when every character in the range has the mark. */
export function hasMark(spans: Span[], from: number, to: number, mark: Mark): boolean {
  const part = sliceSpans(spans, from, to).filter((s) => s.text !== "\n");
  return part.length > 0 && part.every((s) => s[mark]);
}

/** Add the mark to the range, or take it away when the whole range has it. */
export function toggleMark(spans: Span[], from: number, to: number, mark: Mark): Span[] {
  if (from >= to) return spans;
  const on = !hasMark(spans, from, to, mark);
  const mid = sliceSpans(spans, from, to).map((s) => {
    if (s.text === "\n") return s;
    const n = { ...s };
    if (on) n[mark] = true;
    else delete n[mark];
    return n;
  });
  return normalize([...sliceSpans(spans, 0, from), ...mid, ...sliceSpans(spans, to)]);
}

export function setLink(spans: Span[], from: number, to: number, href: string | null): Span[] {
  if (from >= to) return spans;
  const mid = sliceSpans(spans, from, to).map((s) => {
    const n = { ...s };
    if (href) n.href = href;
    else delete n.href;
    return n;
  });
  return normalize([...sliceSpans(spans, 0, from), ...mid, ...sliceSpans(spans, to)]);
}

/** The link around a position: its target and range. */
export function linkAt(spans: Span[], at: number): { href: string; from: number; to: number } | null {
  let pos = 0;
  for (let k = 0; k < spans.length; k++) {
    const s = spans[k];
    const end = pos + s.text.length;
    if (s.href && at >= pos && at <= end) {
      let from = pos;
      let to = end;
      for (let j = k - 1, p = pos; j >= 0 && spans[j].href === s.href; j--) (p -= spans[j].text.length), (from = p);
      for (let j = k + 1, p = end; j < spans.length && spans[j].href === s.href; j++) (p += spans[j].text.length), (to = p);
      return { href: s.href, from, to };
    }
    pos = end;
  }
  return null;
}

/**
 * Markdown typed by hand becomes formatting as soon as it is closed:
 * `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` right before the caret.
 */
export function autoFormat(spans: Span[], caret: number): { spans: Span[]; caret: number } | null {
  const text = plain(spans).slice(0, caret);
  const rules: [RegExp, Mark, number][] = [
    [/\*\*([^*\n]*[^*\s\n])\*\*$/, "b", 2],
    [/~~([^~\n]*[^~\s\n])~~$/, "s", 2],
    [/(?:^|[^*\w])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*$/, "i", 1],
    [/`([^`\n]+)`$/, "code", 1],
  ];
  for (const [re, mark, d] of rules) {
    const m = re.exec(text);
    if (!m) continue;
    const inner = m[1];
    const end = caret;
    const start = end - inner.length - 2 * d;
    // Only on plain text: never inside code or a link.
    if (sliceSpans(spans, start, end).some((s) => s.code || s.href)) continue;
    const before = sliceSpans(spans, 0, start);
    const middle = sliceSpans(spans, start + d, end - d).map((s) => ({ ...s, [mark]: true }) as Span);
    const after = sliceSpans(spans, end);
    return { spans: normalize([...before, ...middle, ...after]), caret: end - 2 * d };
  }
  return null;
}

// ── caret in an editable element, counted like the spans ─────────────────────

function lengthOf(n: Node, root: Node): number {
  if (n.nodeType === 3) return (n.nodeValue ?? "").replace(/\u200b/g, "").length;
  if (n.nodeType !== 1) return 0;
  const el = n as HTMLElement;
  if (el.tagName === "BR") return el.parentNode === root && el === root.lastChild ? 0 : 1;
  if (el.dataset?.cmsSkip !== undefined) return 0;
  let len = 0;
  n.childNodes.forEach((c) => (len += lengthOf(c, root)));
  return len;
}

/** Character offset of a DOM position inside `root`. */
export function offsetOf(root: Node, node: Node, offset: number): number {
  let total = 0;
  const visit = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === 3) {
        total += (n.nodeValue ?? "").slice(0, offset).replace(/\u200b/g, "").length;
        return true;
      }
      for (let i = 0; i < offset && i < n.childNodes.length; i++) total += lengthOf(n.childNodes[i], root);
      return true;
    }
    if (n.nodeType === 3 || (n.nodeType === 1 && (n as HTMLElement).tagName === "BR")) {
      total += lengthOf(n, root);
      return false;
    }
    for (const c of Array.from(n.childNodes)) if (visit(c)) return true;
    return false;
  };
  for (const c of Array.from(root.childNodes)) if (visit(c)) break;
  return total;
}

export function selectionIn(root: HTMLElement): { start: number; end: number; collapsed: boolean } | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  const a = offsetOf(root, r.startContainer, r.startOffset);
  const b = offsetOf(root, r.endContainer, r.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b), collapsed: r.collapsed };
}

function pointAt(root: HTMLElement, at: number): [Node, number] {
  let left = at;
  let found: [Node, number] | null = null;
  const visit = (n: Node): boolean => {
    if (n.nodeType === 3) {
      const len = (n.nodeValue ?? "").length;
      if (left <= len) {
        found = [n, left];
        return true;
      }
      left -= len;
      return false;
    }
    if (n.nodeType === 1 && (n as HTMLElement).tagName === "BR") {
      const len = lengthOf(n, root);
      if (left === 0) {
        const parent = n.parentNode!;
        found = [parent, Array.prototype.indexOf.call(parent.childNodes, n)];
        return true;
      }
      left -= len;
      if (left === 0 && len) {
        const parent = n.parentNode!;
        found = [parent, Array.prototype.indexOf.call(parent.childNodes, n) + 1];
        return true;
      }
      return false;
    }
    for (const c of Array.from(n.childNodes)) if (visit(c)) return true;
    return false;
  };
  for (const c of Array.from(root.childNodes)) if (visit(c)) break;
  return found ?? [root, root.childNodes.length];
}

export function setSelectionIn(root: HTMLElement, start: number, end = start) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  const [sn, so] = pointAt(root, start);
  const [en, eo] = pointAt(root, end);
  r.setStart(sn, so);
  r.setEnd(en, eo);
  sel.removeAllRanges();
  sel.addRange(r);
}
