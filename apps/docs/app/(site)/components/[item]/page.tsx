import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/site/code-block";
import { LiveDemo } from "@/components/site/demo";
import { Markdown } from "@/components/site/markdown";
import { publishedDoc } from "@/lib/content";
import { itemByName, LIVE, NOT_LIVE, SCREENS } from "@/lib/registry-items";
import { siteUrl } from "@/lib/site";

export async function generateMetadata({ params }: PageProps<"/components/[item]">): Promise<Metadata> {
  const it = itemByName((await params).item);
  return it ? { title: it.title, description: it.description } : {};
}

export default async function ComponentPage({ params }: PageProps<"/components/[item]">) {
  const { item } = await params;
  const it = itemByName(item);
  if (!it || item === "cms-lib") notFound();
  const doc = await publishedDoc("components", item);
  const url = `${siteUrl()}/r/${item}.json`;
  return (
    <div className="mx-auto max-w-[1200px] px-5 pt-6 pb-20 md:px-10">
      <p className="mono mb-3 text-[12px] text-[var(--charcoal-trace)]">
        <Link href="/components" className="hover:text-black">
          Components
        </Link>{" "}
        / {item}
      </p>
      <h1 className="display d32 mb-2">{it.title}</h1>
      <p className="mb-6 max-w-[720px] text-[16px] text-[var(--pencil-gray)]">{it.description}</p>

      <div className="mb-8 grid gap-3 md:grid-cols-2">
        <div>
          <p className="label-mono mb-2">With the shadcn CLI</p>
          <CodeBlock lang="sh" code={`npx shadcn add ${url}`} />
        </div>
        <div>
          <p className="label-mono mb-2">With the agent-cms CLI</p>
          <CodeBlock lang="sh" code={`npx agent-cms add ${item}`} />
        </div>
      </div>

      {LIVE.has(item) ? (
        <LiveDemo item={item} />
      ) : NOT_LIVE[item] ? (
        <div className="callout">
          <span className="callout-bar" aria-hidden />
          <p className="!mb-0">
            {NOT_LIVE[item]}{" "}
            <Link href="/components/cms-doc-editor" className="link">
              Open the editor demo
            </Link>
          </p>
        </div>
      ) : null}

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 max-w-[760px]">{doc ? <Markdown source={doc.body} /> : null}</div>
        <aside className="text-[13px]">
          <p className="label-mono mb-2">Files</p>
          <ul className="mono mb-5 space-y-1 text-[12px]">
            {it.files.map((f) => (
              <li key={f.path}>components/cms/{f.path.split("/").pop()}</li>
            ))}
          </ul>
          {it.registryDependencies?.length ? (
            <>
              <p className="label-mono mb-2">Brings along</p>
              <ul className="mono mb-5 space-y-1 text-[12px]">
                {it.registryDependencies.map((d) => (
                  <li key={d}>{SCREENS.some((s) => s.name === d) ? <Link href={`/components/${d}`} className="link">{d}</Link> : d}</li>
                ))}
              </ul>
            </>
          ) : null}
          {it.dependencies?.length ? (
            <>
              <p className="label-mono mb-2">Packages</p>
              <ul className="mono space-y-1 text-[12px]">
                {it.dependencies.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
