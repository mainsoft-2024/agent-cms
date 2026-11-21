import { parseMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";
import { sanitizeHtml } from "@mainsoft/agent-cms/html";
import Link from "next/link";
import { CodeBlock } from "./code-block";

/** What `cms.assetsFor(doc)` gives for each file a document uses. */
export type Files = Record<string, { url: string; kind: string; mime: string; name: string; alt: string; size: number; width: number | null; height: number | null }>;

/** Without the file's row (a preview of unsaved text), the CMS's file route still finds it by id. */
const fileHref = (asset: string, name: string) => `/api/cms/files/${asset}/${encodeURIComponent(name)}`;

const size = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A media line: a picture, a player or a download card, by the file's type. */
function MediaView({ b, files }: { b: Extract<Block, { t: "media" }>; files: Files }) {
  const f = b.asset ? files[b.asset] : undefined;
  const src = b.asset ? (f?.url ?? fileHref(b.asset, b.name ?? "file")) : (b.src ?? "");
  const kind = f?.kind ?? "image";
  const alt = b.alt || f?.alt || "";
  let body;
  if (kind === "video") body = <video src={src} controls preload="metadata" aria-label={alt || undefined} className="w-full rounded-[8px] bg-black" />;
  else if (kind === "audio") body = <audio src={src} controls preload="metadata" aria-label={alt || undefined} className="w-full" />;
  else if (kind === "image")
    // eslint-disable-next-line @next/next/no-img-element
    body = <img src={src} alt={alt} width={f?.width ?? undefined} height={f?.height ?? undefined} loading="lazy" decoding="async" className="h-auto max-w-full rounded-[8px] border border-[var(--color-rule-gray)]" />;
  else
    body = (
      <a href={`${src}${src.includes("?") ? "&" : "?"}download=1`} className="site-card flex items-center gap-3 px-4 py-3 no-underline">
        <span className="mono min-w-0 flex-1 truncate">{f?.name ?? b.name}</span>
        {f ? <span className="label-mono shrink-0">{size(f.size)}</span> : null}
      </a>
    );
  return (
    <figure className="my-5">
      {body}
      {b.caption ? <figcaption className="mt-2 text-[13px] text-[var(--color-warm-gray)]">{b.caption}</figcaption> : null}
    </figure>
  );
}

/** Turn `/docs/x` links into the current language's path. */
function localHref(href: string, lang: "en" | "ko") {
  if (lang === "ko" && href.startsWith("/docs/")) return `/ko${href}`;
  return href;
}

function Inlines({ items, lang, files = {} }: { items: Inline[]; lang: "en" | "ko"; files?: Files }) {
  return (
    <>
      {items.map((x, i) => {
        if (x.t === "text") return x.v;
        if (x.t === "strong") return <strong key={i}>{x.kids ? <Inlines items={x.kids} lang={lang} files={files} /> : x.v}</strong>;
        if (x.t === "em") return <em key={i}>{x.kids ? <Inlines items={x.kids} lang={lang} files={files} /> : x.v}</em>;
        if (x.t === "del") return <del key={i}>{x.kids ? <Inlines items={x.kids} lang={lang} files={files} /> : x.v}</del>;
        if (x.t === "br") return <br key={i} />;
        if (x.t === "code") return <code key={i} className="inline-code">{x.v}</code>;
        if (x.t === "link") {
          const href = localHref(x.href, lang);
          return href.startsWith("/") || href.startsWith("#") ? (
            <Link key={i} href={href} className="link">
              {x.v}
            </Link>
          ) : (
            <a key={i} href={href} className="link" rel="noreferrer">
              {x.v}
            </a>
          );
        }
        if (x.t === "image") {
          const f = x.asset ? files[x.asset] : undefined;
          // eslint-disable-next-line @next/next/no-img-element
          return <img key={i} src={x.asset ? (f?.url ?? fileHref(x.asset, x.name ?? "file")) : (x.src ?? "")} alt={x.alt || f?.alt || ""} loading="lazy" className="inline-block max-h-[1.4em] align-text-bottom" />;
        }
        if (x.t === "file")
          return (
            <a key={i} href={files[x.asset]?.url ?? fileHref(x.asset, x.name ?? "file")} className="link">
              {x.v}
            </a>
          );
        // [[link:key|label]] app links have no target on the docs site: plain label.
        return <span key={i}>{x.v}</span>;
      })}
    </>
  );
}

function BlockView({ b, lang, files }: { b: Block; lang: "en" | "ko"; files: Files }) {
  switch (b.t) {
    case "media":
      return <MediaView b={b} files={files} />;
    case "heading": {
      const H = b.level === 2 ? "h2" : "h3";
      return (
        <H id={b.id} className="group">
          <Inlines items={b.inline} lang={lang} files={files} />
          <a href={`#${b.id}`} aria-label={`Link to ${b.text}`} className="ml-2 text-[var(--color-steel)] opacity-0 group-hover:opacity-100">
            #
          </a>
        </H>
      );
    }
    case "p":
      return (
        <p>
          <Inlines items={b.inline} lang={lang} files={files} />
        </p>
      );
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inlines items={it} lang={lang} files={files} />
            </li>
          ))}
        </L>
      );
    }
    case "quote":
      return (
        <div className="callout" role={b.callout ? "note" : undefined}>
          <div className="min-w-0">
            {b.callout ? <p className="label-mono !mb-1">{b.callout}</p> : null}
            {b.blocks.map((x, i) => (
              <BlockView key={i} b={x} lang={lang} files={files} />
            ))}
          </div>
        </div>
      );
    case "code":
      return <CodeBlock code={b.v} lang={b.lang} />;
    case "hr":
      return <hr />;
    case "links":
      return (
        <p>
          {b.items.map((x) => (
            <span key={x.key} className="pill pill-white mr-2">
              {x.v}
            </span>
          ))}
        </p>
      );
    case "todo":
      return (
        <ul className="list-none pl-0">
          {b.items.map((it, k) => (
            <li key={k} className="flex items-start gap-2">
              <input type="checkbox" checked={it.checked} readOnly disabled className="mt-[0.45em]" />
              <span>
                <Inlines items={it.inline} lang={lang} files={files} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                {b.head.map((c, k) => (
                  <th key={k} style={{ textAlign: b.align[k] ?? undefined }}>
                    <Inlines items={c} lang={lang} files={files} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, k) => (
                    <td key={k} style={{ textAlign: b.align[k] ?? undefined }}>
                      <Inlines items={c} lang={lang} files={files} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "toggle":
      return (
        <details>
          <summary>
            <Inlines items={b.title} lang={lang} files={files} />
          </summary>
          {b.blocks.map((x, i) => (
            <BlockView key={i} b={x} lang={lang} files={files} />
          ))}
        </details>
      );
    case "columns":
      return (
        <div className="grid gap-6 md:grid-flow-col md:auto-cols-fr">
          {b.cols.map((c, k) => (
            <div key={k} className="min-w-0">
              {c.map((x, i) => (
                <BlockView key={i} b={x} lang={lang} files={files} />
              ))}
            </div>
          ))}
        </div>
      );
    case "html":
      // Kept as written in the CMS; drawn through the allow-list here.
      return <div className="cms-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(b.v, {}, { assetUrl: (id, name) => files[id]?.url ?? fileHref(id, name) }) }} />;
    case "raw":
      return null;
  }
}

/** A document body, rendered from the CMS's own markdown blocks. `files`: `cms.assetsFor(doc)`, for pages that use the media library. */
export function Markdown({ source, lang = "en", files = {} }: { source: string; lang?: "en" | "ko"; files?: Files }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="prose-site">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} lang={lang} files={files} />
      ))}
    </div>
  );
}
