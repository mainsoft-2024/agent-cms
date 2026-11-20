import { verifyWebhook, WebhookVerifyError, type WebhookPayload } from "@mainsoft/agent-cms/webhooks";
import { cms } from "@/lib/cms";

/**
 * A webhook receiver, to show the other side. In a real setup this lives in ANOTHER app (your site,
 * a worker, a chat bot) with the signing secret in its environment:
 *
 *   const event = await verifyWebhook(req, process.env.CMS_WEBHOOK_SECRET!);
 *
 * This example is one app, so without that variable it looks the secret up in the CMS next door.
 * Register it in the admin as http://localhost:3000/api/hook (needs CMS_WEBHOOKS_INSECURE=1: the
 * CMS only sends to https addresses on the public internet otherwise).
 */
const got = ((globalThis as { __hookEvents?: WebhookPayload[] }).__hookEvents ??= []);

async function secretFor(req: Request): Promise<string | null> {
  if (process.env.CMS_WEBHOOK_SECRET) return process.env.CMS_WEBHOOK_SECRET;
  const system = { kind: "system", label: "example receiver" } as const;
  const path = new URL(req.url).pathname;
  const hook = (await cms.webhooks.list(system)).find((w) => new URL(w.url).pathname === path);
  return hook ? (await cms.webhooks.secret(system, hook.id)).secret : null;
}

export async function POST(req: Request) {
  const secret = await secretFor(req);
  if (!secret) return new Response("no webhook points here", { status: 404 });
  try {
    const event = await verifyWebhook(req, secret);
    // Deliveries can repeat (a retry after a lost answer): the id says which ones you have seen.
    if (!got.some((e) => e.id === event.id)) got.unshift(event);
    got.length = Math.min(got.length, 20);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof WebhookVerifyError) return new Response(e.message, { status: 401 });
    throw e;
  }
}

/** What arrived, newest first (so you can see it work). */
export function GET() {
  return Response.json({ events: got });
}
