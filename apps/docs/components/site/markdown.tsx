import { parseMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";
import Link from "next/link";
import { CodeBlock } from "./code-block";

/** Turn `/docs/x` links into the current language's path. */
function localHref(href: string, lang: "en" | "ko") {
  if (lang === "ko" && href.startsWith("/docs/")) return `/ko${href}`;
  return href;
}

function Inlines({ items, lang }: { items: Inline[]; lang: "en" | "ko" }) {
  return (
    <>
      {items.map((x, i) => {
        if (x.t === "text") return x.v;
        if (x.t === "strong") return <strong key={i}>{x.v}</strong>;
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
        // [[link:key|label]] app links have no target on the docs site: plain label.
        return <span key={i}>{x.v}</span>;
      })}
    </>
  );
}

function BlockView({ b, lang }: { b: Block; lang: "en" | "ko" }) {
  switch (b.t) {
    case "heading": {
      const H = b.level === 2 ? "h2" : "h3";
      return (
        <H id={b.id} className="group">
          <Inlines items={b.inline} lang={lang} />
          <a href={`#${b.id}`} aria-label={`Link to ${b.text}`} className="ml-2 text-[var(--faint-gray)] opacity-0 group-hover:opacity-100">
            #
          </a>
        </H>
      );
    }
    case "p":
      return (
        <p>
          <Inlines items={b.inline} lang={lang} />
        </p>
      );
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inlines items={it} lang={lang} />
            </li>
          ))}
        </L>
      );
    }
    case "quote":
      return (
        <div className="callout" role={b.callout ? "note" : undefined}>
          <span className="callout-bar" aria-hidden />
          <div className="min-w-0">
            {b.callout ? <p className="label-mono !mb-1">{b.callout}</p> : null}
            {b.blocks.map((x, i) => (
              <BlockView key={i} b={x} lang={lang} />
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
  }
}

/** A document body, rendered from the CMS's own markdown blocks. */
export function Markdown({ source, lang = "en" }: { source: string; lang?: "en" | "ko" }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="prose-site">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} lang={lang} />
      ))}
    </div>
  );
}
