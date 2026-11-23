/**
 * Drawing HTML blocks (`:::html`) and HTML documents safely.
 *
 * The CMS stores HTML exactly as people wrote it. Safety happens when it is
 * drawn, in one of two ways:
 * - `sanitizeHtml(html)` keeps an allow-list of tags and attributes and drops
 *   scripts, event handlers, script URLs, forms and frames from other hosts.
 *   Use it wherever HTML goes into your page's DOM.
 * - `isolatedHtml(html)` returns a whole page to put in
 *   `<iframe sandbox="allow-scripts" srcdoc>` (never with allow-same-origin):
 *   scripts run, but cannot reach your site's cookies, storage or DOM.
 *
 *   import { sanitizeHtml } from "@mainsoft/agent-cms/html";
 *   <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.v) }} />
 */
import sanitize from "sanitize-html";
import { DEFAULT_IFRAME_HOSTS, SAFE_TAGS, type HtmlPolicy } from "./html-inspect";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { DEFAULT_VIDEO_HOSTS, videoEmbed } from "./video";

export { inspectHtml, hasScripts, DEFAULT_IFRAME_HOSTS, SAFE_TAGS, type HtmlPolicy, type HtmlInert, type HtmlInertKind } from "./html-inspect";

export interface DrawOptions {
  /** URL for a media library file named `asset:ID/name` in the HTML. Default `/api/cms/files/ID/name`. */
  assetUrl?: (id: string, name: string) => string;
}

/** Style properties kept with `allowStyle: true`. */
export const DEFAULT_STYLE_PROPS = [
  "color", "background-color", "text-align", "font-weight", "font-style", "text-decoration", "text-transform", "letter-spacing", "line-height",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-radius", "border-color", "border-width", "border-style", "width", "max-width", "min-width", "height", "max-height",
  "display", "gap", "flex", "flex-direction", "flex-wrap", "justify-content", "align-items", "grid-template-columns", "vertical-align",
];

/** A CSS value with no url(), expression() or anything that leaves the declaration. */
const SAFE_CSS_VALUE = /^(?!.*(?:url|expression|image-set|-moz-binding|javascript)\s*[(:])[^;{}<>\\"'`]*$/i;

const defaultAssetUrl = (id: string, name: string) => `/api/cms/files/${id}/${encodeURIComponent(name || "file")}`;
const ASSET_RE = /^asset:([a-z0-9]{12})(?:\/([^\s"'<>]*))?$/;

function assetRewrite(url: string | undefined, o: DrawOptions): string | undefined {
  if (!url) return url;
  const m = ASSET_RE.exec(url.trim());
  if (!m) return url;
  let name = m[2] ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as is */
  }
  return (o.assetUrl ?? defaultAssetUrl)(m[1], name);
}

/** HTML with only what is safe to put in a page (see the module comment). Never throws. */
export function sanitizeHtml(html: string, policy: HtmlPolicy = {}, o: DrawOptions = {}): string {
  const hosts = policy.iframeHosts ?? DEFAULT_IFRAME_HOSTS;
  const styleProps = policy.allowStyle === true ? DEFAULT_STYLE_PROPS : Array.isArray(policy.allowStyle) ? policy.allowStyle : [];
  const urlTags = (tag: string, attr: string) => (_t: string, attribs: sanitize.Attributes) => {
    const out = { ...attribs };
    if (out[attr]) out[attr] = assetRewrite(out[attr], o) ?? "";
    return { tagName: tag, attribs: out };
  };
  return sanitize(html, {
    allowedTags: SAFE_TAGS,
    disallowedTagsMode: "discard",
    allowedAttributes: {
      "*": ["class", "title", "lang", "dir", "aria-*", "role", ...(styleProps.length ? ["style"] : [])],
      a: ["href", "name", "target", "rel"],
      img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"],
      video: ["src", "poster", "controls", "width", "height", "loop", "muted", "playsinline", "preload", "autoplay"],
      audio: ["src", "controls", "loop", "muted", "preload"],
      source: ["src", "srcset", "type", "media", "sizes"],
      track: ["src", "kind", "srclang", "label", "default"],
      iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "loading", "referrerpolicy", "sandbox"],
      td: ["colspan", "rowspan", "headers"],
      th: ["colspan", "rowspan", "headers", "scope"],
      col: ["span"],
      colgroup: ["span"],
      ol: ["start", "reversed", "type"],
      li: ["value"],
      time: ["datetime"],
      data: ["value"],
      details: ["open"],
      abbr: ["title"],
      q: ["cite"],
      blockquote: ["cite"],
    },
    allowedClasses: policy.classPrefix ? { "*": [`${policy.classPrefix}*`] } : undefined,
    allowedStyles: styleProps.length ? { "*": Object.fromEntries(styleProps.map((p) => [p, [SAFE_CSS_VALUE]])) } : undefined,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["href", "src", "cite", "srcset", "poster"],
    allowProtocolRelative: false,
    allowedIframeHostnames: hosts,
    allowIframeRelativeUrls: false,
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "title"],
    transformTags: {
      img: urlTags("img", "src"),
      video: (t, a) => {
        const r = urlTags("video", "src")(t, a);
        if (r.attribs.poster) r.attribs.poster = assetRewrite(r.attribs.poster, o) ?? "";
        return r;
      },
      audio: urlTags("audio", "src"),
      source: urlTags("source", "src"),
      track: urlTags("track", "src"),
      a: (_t, attribs) => {
        const out = { ...attribs };
        if (out.href) out.href = assetRewrite(out.href, o) ?? "";
        if (out.target && out.target !== "_self") {
          out.target = "_blank";
          out.rel = "noopener noreferrer";
        }
        return { tagName: "a", attribs: out };
      },
      iframe: (_t, attribs) => ({
        tagName: "iframe",
        attribs: {
          ...attribs,
          // Players need their own scripts; their origin is the player's, never the site's.
          sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
          referrerpolicy: "strict-origin-when-cross-origin",
          loading: attribs.loading ?? "lazy",
        },
      }),
    },
  });
}

/**
 * A whole page for `<iframe sandbox="allow-scripts" srcdoc={…}>`: the HTML as
 * written, plus a small script that tells the parent its height
 * (`{ type: "agent-cms:height", height }` through postMessage).
 * Never add `allow-same-origin` to that frame.
 */
export function isolatedHtml(html: string, o: DrawOptions & { css?: string } = {}): string {
  const body = html.replace(/(["'(\s=])asset:([a-z0-9]{12})(?:\/([^\s"'<>)]*))?/g, (_m, pre: string, id: string, name?: string) => `${pre}${assetRewrite(`asset:${id}/${name ?? ""}`, o)}`);
  const css = o.css ?? "html,body{margin:0}body{font:16px/1.6 system-ui,sans-serif;color:#111}img,video{max-width:100%;height:auto}";
  const report =
    "<script>(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({type:'agent-cms:height',height:h},'*')}}" +
    "addEventListener('load',send);if(window.ResizeObserver)new ResizeObserver(send).observe(document.documentElement);setTimeout(send,50)})()</script>";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>${css}</style></head><body>${body}${report}</body></html>`;
}

/** The sandbox attribute an isolated frame must use. */
export const ISOLATED_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

// ── markdown → HTML ──────────────────────────────────────────────────────────

export interface ToHtmlOptions extends DrawOptions {
  policy?: HtmlPolicy;
  /** URL for `[[link:key|…]]`; null draws the label only. */
  link?: (key: string) => string | null;
  /** Hosts `:::video` may embed (0.21.0). Default: YouTube and Vimeo. */
  videoHosts?: readonly string[];
  /** Old heading anchors by current anchor (0.21.0): an empty `<span id>` keeps old links working. */
  anchorAliases?: Record<string, readonly string[]>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

function inlineHtml(items: Inline[], o: ToHtmlOptions): string {
  const url = (id: string, name: string) => (o.assetUrl ?? defaultAssetUrl)(id, name);
  return items
    .map((i) => {
      switch (i.t) {
        case "text":
          return esc(i.v);
        case "strong":
          return `<strong>${i.kids ? inlineHtml(i.kids, o) : esc(i.v)}</strong>`;
        case "em":
          return `<em>${i.kids ? inlineHtml(i.kids, o) : esc(i.v)}</em>`;
        case "del":
          return `<del>${i.kids ? inlineHtml(i.kids, o) : esc(i.v)}</del>`;
        case "code":
          return `<code>${esc(i.v)}</code>`;
        case "br":
          return "<br>";
        case "link":
          return `<a href="${esc(i.href)}">${esc(i.v)}</a>`;
        case "file":
          return `<a href="${esc(url(i.asset, i.name))}">${esc(i.v)}</a>`;
        case "image":
          return `<img src="${esc(i.asset ? url(i.asset, i.name) : (i.src ?? ""))}" alt="${esc(i.alt)}">`;
        case "applink": {
          const href = o.link?.(i.key) ?? null;
          return href ? `<a href="${esc(href)}">${esc(i.v)}</a>` : `<span>${esc(i.v)}</span>`;
        }
      }
    })
    .join("");
}

function blockHtml(b: Block, o: ToHtmlOptions): string {
  const url = (id: string, name: string) => (o.assetUrl ?? defaultAssetUrl)(id, name);
  switch (b.t) {
    case "heading":
      return `${(o.anchorAliases?.[b.id] ?? []).map((a) => `<span id="${esc(a)}"></span>`).join("")}<h${b.level} id="${esc(b.id)}">${inlineHtml(b.inline, o)}</h${b.level}>`;
    case "p":
      return `<p>${inlineHtml(b.inline, o)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}${b.ordered && b.start !== undefined && b.start !== 1 ? ` start="${b.start}"` : ""}>${b.items.map((it, k) => `<li>${inlineHtml(it, o)}${b.kids?.[k] ? blocksHtml(b.kids[k]!, o) : ""}</li>`).join("")}</${tag}>`;
    }
    case "todo":
      return `<ul class="todo">${b.items.map((it) => `<li><input type="checkbox" disabled${it.checked ? " checked" : ""}> ${inlineHtml(it.inline, o)}${it.kids ? blocksHtml(it.kids, o) : ""}</li>`).join("")}</ul>`;
    case "quote":
      return b.callout ? `<aside class="callout callout-${b.callout}">${blocksHtml(b.blocks, o)}</aside>` : `<blockquote>${blocksHtml(b.blocks, o)}</blockquote>`;
    case "code":
      return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.v)}</code></pre>`;
    case "hr":
      return "<hr>";
    case "media": {
      const src = b.asset ? url(b.asset, b.name) : (b.src ?? "");
      const name = b.name || src;
      let el: string;
      if (!b.asset || IMAGE_EXT.test(name)) el = `<img src="${esc(src)}" alt="${esc(b.alt)}">`;
      else if (VIDEO_EXT.test(name)) el = `<video src="${esc(src)}" controls preload="metadata"></video>`;
      else if (AUDIO_EXT.test(name)) el = `<audio src="${esc(src)}" controls preload="metadata"></audio>`;
      else el = `<a href="${esc(src)}" download>${esc(b.name || "file")}</a>`;
      return `<figure>${el}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
    }
    case "links":
      return `<p class="links">${b.items.map((x) => inlineHtml([{ t: "applink", key: x.key, v: x.v }], o)).join(" ")}</p>`;
    case "table": {
      const style = (k: number) => (b.align[k] ? ` style="text-align:${b.align[k]}"` : "");
      return `<table><thead><tr>${b.head.map((c, k) => `<th${style(k)}>${inlineHtml(c, o)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c, k) => `<td${style(k)}>${inlineHtml(c, o)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    }
    case "toggle":
      return `<details><summary>${inlineHtml(b.title, o)}</summary>${blocksHtml(b.blocks, o)}</details>`;
    case "columns":
      return `<div class="columns">${b.cols.map((c) => `<div class="column">${blocksHtml(c, o)}</div>`).join("")}</div>`;
    case "html":
      if (b.isolated && o.policy?.render === "isolated")
        return `<iframe class="html-isolated" sandbox="${ISOLATED_SANDBOX}" srcdoc="${esc(isolatedHtml(b.v, o))}" title="HTML" loading="lazy"></iframe>`;
      return sanitizeHtml(b.v, o.policy, o);
    case "steps":
      return `<div class="steps">${blocksHtml(b.blocks, o)}</div>`;
    case "card": {
      const img = b.image ? `<img src="${esc(b.image.asset ? url(b.image.asset, b.image.name) : (b.image.src ?? ""))}" alt="${esc(b.image.alt)}">` : "";
      return `<a class="link-card" href="${esc(/^\s*(javascript|data|vbscript):/i.test(b.href) ? "#" : b.href)}">${img}<span class="link-card-title">${esc(b.label)}</span>${b.description ? `<span class="link-card-text">${esc(b.description)}</span>` : ""}</a>`;
    }
    case "video": {
      const cap = b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : "";
      if (b.asset) return `<figure class="video"><video src="${esc(url(b.asset, b.name))}" controls preload="metadata"></video>${cap}</figure>`;
      const embed = b.src ? videoEmbed(b.src, o.videoHosts ?? DEFAULT_VIDEO_HOSTS) : null;
      if (!embed) return `<p class="video-blocked"><a href="${esc(b.src ?? "")}">${esc(b.caption || b.src || "")}</a></p>`;
      return `<figure class="video"><iframe src="${esc(embed)}" title="${esc(b.caption || "Video")}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>${cap}</figure>`;
    }
    case "raw":
      return `<pre class="raw">${esc(b.v)}</pre>`;
  }
}

function blocksHtml(blocks: Block[], o: ToHtmlOptions): string {
  return blocks.map((b) => blockHtml(b, o)).join("\n");
}

/**
 * A markdown body as HTML that is safe to put in a page: markdown is drawn by
 * the CMS, HTML blocks go through `sanitizeHtml` (or a sandboxed frame for
 * `:::html isolated` when `policy.render` is "isolated").
 */
export function markdownToHtml(body: string, o: ToHtmlOptions = {}): string {
  return blocksHtml(parseMarkdown(body), o);
}

/** A document body (markdown or HTML) as safe HTML. */
export function bodyToSafeHtml(body: string, format: "markdown" | "html", o: ToHtmlOptions = {}): string {
  return format === "html" ? sanitizeHtml(body, o.policy, o) : markdownToHtml(body, o);
}
