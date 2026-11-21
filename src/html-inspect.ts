/**
 * What a piece of HTML would lose when it is drawn safely. Dependency-free so
 * the admin screens can show it while someone types; it is a report, not the
 * safety boundary (that is `sanitizeHtml` in `./html`, or a sandboxed frame).
 *
 * The CMS keeps HTML exactly as written. These are the parts that stay in the
 * saved text but do nothing on the page.
 */

export interface HtmlPolicy {
  /**
   * How HTML blocks are drawn.
   * - "safe" (default): sanitized and drawn in the page; scripts and event handlers do nothing.
   * - "isolated": drawn as written inside `<iframe sandbox="allow-scripts">` with no access to the site.
   */
  render?: "safe" | "isolated";
  /** Hosts an `<iframe src>` may point at (safe mode). Default: YouTube (no-cookie) and Vimeo players. */
  iframeHosts?: string[];
  /** `style` attributes: false (default) drops them; true keeps a short list of layout and color properties; a list names the properties. */
  allowStyle?: boolean | string[];
  /** Keep only classes that start with this (e.g. "cms-"). Default: every class. */
  classPrefix?: string;
}

export type HtmlInertKind = "script" | "event" | "url" | "iframe" | "style" | "tag";

export interface HtmlInert {
  /** 1-based line inside the HTML. */
  line: number;
  kind: HtmlInertKind;
  /** What it is: the tag, the attribute or the address. */
  detail: string;
}

export const DEFAULT_IFRAME_HOSTS = ["www.youtube-nocookie.com", "youtube-nocookie.com", "player.vimeo.com"];

/** Tags drawn in safe mode. */
export const SAFE_TAGS = [
  "a", "abbr", "address", "article", "aside", "audio", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "iframe", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby",
  "s", "samp", "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "time", "tr", "track", "u", "ul", "var", "video", "wbr",
];

/** Tags that never draw in safe mode, with the reason kind. */
const BLOCKED: Record<string, HtmlInertKind> = {
  script: "script",
  noscript: "script",
  style: "style",
  link: "style",
  meta: "tag",
  base: "tag",
  form: "tag",
  input: "tag",
  button: "tag",
  textarea: "tag",
  select: "tag",
  option: "tag",
  object: "tag",
  embed: "tag",
  applet: "tag",
  frame: "tag",
  frameset: "tag",
  svg: "tag",
  math: "tag",
  template: "tag",
  portal: "tag",
};

const URL_ATTRS = new Set(["href", "src", "srcset", "poster", "action", "formaction", "xlink:href", "background", "data", "cite"]);
const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;|&newline;/gi, "")
    .replace(/&amp;/gi, "&");

/** A URL that runs code or is not a link a page may follow. */
function badUrl(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = decode(raw).replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/.test(v)) return false;
  return !/^(https?|mailto|tel|asset):/.test(v);
}

function hostOf(src: string): string | null {
  try {
    return new URL(decode(src).trim(), "https://invalid.local").hostname;
  } catch {
    return null;
  }
}

/** Every part of `html` that would not work when drawn safely (by line). Empty for HTML that draws as written. */
export function inspectHtml(html: string, policy: HtmlPolicy = {}): HtmlInert[] {
  const out: HtmlInert[] = [];
  const hosts = policy.iframeHosts ?? DEFAULT_IFRAME_HOSTS;
  const lineAt = (i: number) => html.slice(0, i).split("\n").length;
  const re = new RegExp(TAG_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!m[1] || m[0].startsWith("</")) continue;
    const tag = m[1].toLowerCase();
    const line = lineAt(m.index);
    const blocked = BLOCKED[tag];
    if (blocked) out.push({ line, kind: blocked, detail: `<${tag}>` });
    else if (!SAFE_TAGS.includes(tag)) out.push({ line, kind: "tag", detail: `<${tag}>` });
    const attrs = m[2] ?? "";
    const ar = new RegExp(ATTR_RE.source, "g");
    let a: RegExpExecArray | null;
    while ((a = ar.exec(attrs))) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (name.startsWith("on")) out.push({ line, kind: "event", detail: name });
      else if (name === "style" && !policy.allowStyle) out.push({ line, kind: "style", detail: "style" });
      else if (URL_ATTRS.has(name) && badUrl(value.trim().split(/[\s,]/)[0] ?? "")) out.push({ line, kind: "url", detail: `${name}="${value.slice(0, 40)}"` });
      else if (name === "srcdoc") out.push({ line, kind: "url", detail: "srcdoc" });
      else if (tag === "iframe" && name === "src") {
        const host = hostOf(value);
        if (!host || !hosts.includes(host)) out.push({ line, kind: "iframe", detail: host ?? value.slice(0, 40) });
      }
    }
  }
  return out;
}

/** True when the HTML has something only isolated drawing would run (scripts, event handlers, script URLs). */
export function hasScripts(html: string): boolean {
  return inspectHtml(html).some((x) => x.kind === "script" || x.kind === "event" || (x.kind === "url" && /javascript:/i.test(decode(x.detail))));
}
