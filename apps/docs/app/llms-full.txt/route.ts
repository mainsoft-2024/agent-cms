import { llmsFull } from "@/lib/llms";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(await llmsFull(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
