import type { Metadata } from "next";
import { Markdown } from "@/components/site/markdown";
import { listPublished } from "@/lib/content";

export const metadata: Metadata = { title: "Changelog", description: "Every agent-cms release, newest first." };

export default async function Changelog() {
  const notes = (await listPublished("changelog")).sort((a, b) => {
    const da = String((a.fields as { date?: string }).date ?? "");
    const db = String((b.fields as { date?: string }).date ?? "");
    return db.localeCompare(da) || b.slug.localeCompare(a.slug, undefined, { numeric: true });
  });
  return (
    <div className="mx-auto max-w-[880px] px-5 pt-6 pb-20 md:px-10">
      <h1 className="display d48 mb-2">Changelog</h1>
      <p className="mb-10 text-[16px] text-[var(--pencil-gray)]">
        Every release of <code className="inline-code">@mainsoft/agent-cms</code>, newest first. Upgrade notes live in the docs.
      </p>
      <ol className="space-y-6">
        {notes.map((n) => (
          <li key={n.slug} id={n.slug} className="site-card scroll-mt-24 p-6 md:grid md:grid-cols-[140px_1fr] md:gap-6">
            <div className="mb-3 md:mb-0">
              <p className="mono text-[15px] font-medium">{n.slug.replace(/^v?/, "v").replace(/-/g, ".")}</p>
              <p className="mono text-[12px] text-[var(--charcoal-trace)]">{String((n.fields as { date?: string }).date ?? "")}</p>
            </div>
            <div className="min-w-0">
              <h2 className="mb-2 text-[18px] font-semibold">{n.title}</h2>
              <Markdown source={n.body} />
            </div>
          </li>
        ))}
      </ol>
      {notes.length === 0 ? <p className="text-[var(--pencil-gray)]">No releases yet.</p> : null}
    </div>
  );
}
