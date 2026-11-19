import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/site/code-block";
import { siteUrl } from "@/lib/site";
import { SCREENS } from "@/lib/registry-items";

export const metadata: Metadata = { title: "Components", description: "Admin screens you copy into your app with shadcn, then change." };

export default function Components() {
  return (
    <div className="mx-auto max-w-[1100px] px-5 pt-6 pb-20 md:px-10">
      <h1 className="display d48 mb-2">Components</h1>
      <p className="mb-6 max-w-[640px] text-[16px] text-[var(--pencil-gray)]">
        The admin is a set of screens. They are copied into your app as source, built on your shadcn/ui parts, so you own them. The admin of this site uses them as they are, with a different theme.
      </p>
      <div className="mb-10 max-w-[720px]">
        <CodeBlock lang="sh" code={`npx shadcn add ${siteUrl()}/r/cms-shell.json ${siteUrl()}/r/cms-doc-list.json ${siteUrl()}/r/cms-doc-editor.json`} />
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SCREENS.map((it) => (
          <li key={it.name}>
            <Link href={`/components/${it.name}`} className="site-card block h-full p-6 hover:shadow-[0_0_0_1px_var(--carbon-black)]">
              <p className="mono mb-2 text-[12px] text-[var(--charcoal-trace)]">{it.name}</p>
              <h2 className="mb-1.5 text-[16px] font-semibold">{it.title}</h2>
              <p className="text-[var(--pencil-gray)]">{it.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
