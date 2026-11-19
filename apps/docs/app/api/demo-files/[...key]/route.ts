import { demoFile } from "@/lib/demo";

export const dynamic = "force-dynamic";

/**
 * The pictures of the gallery's demo library. They are made by the site when
 * the demo starts (visitors cannot upload), and are still served as inert
 * content: no script runs from this address.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string[] }> }): Promise<Response> {
  const { key } = await ctx.params;
  const file = await demoFile(key.map(decodeURIComponent).join("/"));
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(file.body as BodyInit, {
    headers: {
      "content-type": file.mime,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
