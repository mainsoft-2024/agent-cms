import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";
import type { AssetInfo } from "@mainsoft/agent-cms";
import { sanitizeHtml } from "@mainsoft/agent-cms/html";

type Files = Record<string, AssetInfo>;

// A small public renderer for the block tree of `parseMarkdown`. Yours will
// have your own components; what matters here is how media is looked up.
function inlines(items: Inline[], files: Files): ReactNode[] {
  return items.map((i, n) => {
    if (i.t === "strong") return <strong key={n}>{i.kids ? inlines(i.kids, files) : i.v}</strong>;
    if (i.t === "em") return <em key={n}>{i.kids ? inlines(i.kids, files) : i.v}</em>;
    if (i.t === "del") return <del key={n}>{i.kids ? inlines(i.kids, files) : i.v}</del>;
    if (i.t === "br") return <br key={n} />;
    if (i.t === "code") return <code key={n}>{i.v}</code>;
    if (i.t === "link") return <a key={n} href={i.href} className="underline">{i.v}</a>;
    if (i.t === "file") return files[i.asset] ? <a key={n} href={files[i.asset].url} className="underline">{i.v}</a> : <span key={n}>{i.v}</span>;
    if (i.t === "image") {
      const f = i.asset ? files[i.asset] : null;
      // eslint-disable-next-line @next/next/no-img-element
      return f || i.src ? <img key={n} src={f?.url ?? i.src ?? ""} alt={i.alt || f?.alt || ""} className="inline max-h-40" /> : null;
    }
    return <span key={n}>{i.v}</span>;
  });
}

/** `imageSrc`: the address to show a picture of the library at (a named size, your CDN). Default: the file itself. */
export function PostBody({ body, files, imageSrc }: { body: string; files: Files; imageSrc?: (file: AssetInfo) => string }) {
  const draw = (blocks: Block[]): ReactNode[] =>
    blocks.map((b, n) => {
      switch (b.t) {
        case "heading":
          return b.level === 2 ? <h2 key={n} id={b.id} className="mt-6 text-xl font-semibold">{inlines(b.inline, files)}</h2> : <h3 key={n} id={b.id} className="mt-4 font-semibold">{inlines(b.inline, files)}</h3>;
        case "p":
          return <p key={n} className="leading-7">{inlines(b.inline, files)}</p>;
        case "list": {
          const L = b.ordered ? "ol" : "ul";
          return <L key={n} className={b.ordered ? "list-decimal pl-6" : "list-disc pl-6"}>{b.items.map((it, k) => <li key={k}>{inlines(it, files)}</li>)}</L>;
        }
        case "quote":
          return <blockquote key={n} className="border-l-2 pl-3 text-muted-foreground">{draw(b.blocks)}</blockquote>;
        case "code":
          return <pre key={n} className="overflow-x-auto rounded bg-muted p-3 text-sm"><code>{b.v}</code></pre>;
        case "hr":
          return <hr key={n} />;
        case "media": {
          const f = b.asset ? files[b.asset] : null;
          if (b.asset && !f) return null;
          const alt = b.alt || f?.alt || "";
          return (
            <figure key={n} className="my-4">
              {f?.kind === "video" ? (
                <video controls preload="metadata" src={f.url} aria-label={alt} className="w-full rounded" />
              ) : f?.kind === "audio" ? (
                <audio controls src={f.url} aria-label={alt} className="w-full" />
              ) : f && f.kind !== "image" ? (
                <a href={f.url} className="block rounded border px-3 py-2 underline">{alt || f.name}</a>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={(f && imageSrc ? imageSrc(f) : f?.url) ?? b.src ?? ""} alt={alt} width={f?.width ?? undefined} height={f?.height ?? undefined} className="h-auto w-full rounded" />
              )}
              {b.caption ? <figcaption className="mt-1 text-center text-sm text-muted-foreground">{b.caption}</figcaption> : null}
            </figure>
          );
        }
        case "todo":
          return <ul key={n} className="space-y-1">{b.items.map((it, k) => <li key={k} className="flex gap-2"><input type="checkbox" checked={it.checked} readOnly disabled /> <span>{inlines(it.inline, files)}</span></li>)}</ul>;
        case "table":
          return (
            <div key={n} className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr>{b.head.map((c, k) => <th key={k} className="border-b p-2 text-left" style={{ textAlign: b.align[k] ?? undefined }}>{inlines(c, files)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k} className="border-b p-2" style={{ textAlign: b.align[k] ?? undefined }}>{inlines(c, files)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        case "toggle":
          return <details key={n}><summary className="cursor-pointer font-medium">{inlines(b.title, files)}</summary>{draw(b.blocks)}</details>;
        case "columns":
          return <div key={n} className="grid gap-4 md:grid-flow-col md:auto-cols-fr">{b.cols.map((c, k) => <div key={k} className="min-w-0 space-y-3">{draw(c)}</div>)}</div>;
        case "html":
          // HTML is kept as written in the CMS; sanitizeHtml draws only what is safe.
          return <div key={n} dangerouslySetInnerHTML={{ __html: sanitizeHtml(b.v, {}, { assetUrl: (id, name) => files[id]?.url ?? `/api/cms/files/${id}/${encodeURIComponent(name)}` }) }} />;
        default:
          return null;
      }
    });
  return <article className="space-y-3">{draw(parseMarkdown(body))}</article>;
}
