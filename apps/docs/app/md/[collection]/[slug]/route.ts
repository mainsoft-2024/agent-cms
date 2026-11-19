import { publishedDoc } from "@/lib/content";

export const dynamic = "force-dynamic";

/** `/docs/<slug>.md` and `/ko/docs/<slug>.md` (rewritten here): one page as markdown. */
export async function GET(_req: Request, ctx: RouteContext<"/md/[collection]/[slug]">) {
  const { collection, slug } = await ctx.params;
  if (collection !== "docs" && collection !== "docs-ko") return new Response("Not found", { status: 404 });
  const doc = await publishedDoc(collection, slug);
  if (!doc) return new Response("Not found", { status: 404 });
  const md = `# ${doc.title}\n\n${doc.summary ? `${doc.summary}\n\n` : ""}${doc.body.trim()}\n`;
  return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=60" } });
}
