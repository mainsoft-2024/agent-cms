import { notFound } from "next/navigation";
import { isCmsError } from "@mainsoft/agent-cms";
import { cms, seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

// The public page. A draft preview link adds ?cms_preview=<token>.
export default async function Post({ params, searchParams }: { params: { slug: string }; searchParams: { cms_preview?: string } }) {
  await seed();
  try {
    const token = searchParams.cms_preview;
    const doc = token ? (await cms.readPreview(token)).doc : await cms.get({ kind: "anonymous" }, "posts", params.slug);
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-8">
        {token ? <p role="status" className="rounded bg-amber-100 px-3 py-2 text-sm">Draft preview</p> : null}
        <h1 className="text-3xl font-semibold">{doc.title}</h1>
        {doc.summary ? <p className="text-muted-foreground">{doc.summary}</p> : null}
        <article className="whitespace-pre-wrap">{doc.body}</article>
      </main>
    );
  } catch (e) {
    if (isCmsError(e) && (e.kind === "not_found" || e.kind === "unauthorized")) notFound();
    throw e;
  }
}
