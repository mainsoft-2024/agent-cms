/**
 * What the receiver of a webhook needs: the payload type and `verifyWebhook`. No Node imports, so
 * it also runs on edge runtimes and in workers.
 *
 *   import { verifyWebhook } from "@mainsoft/agent-cms/webhooks";
 *   export async function POST(req: Request) {
 *     const event = await verifyWebhook(req, process.env.CMS_WEBHOOK_SECRET!);   // throws when it is not ours
 *     if (event.event === "doc.published") revalidatePath(`/${event.collection}/${event.slug}`);
 *     return new Response("ok");
 *   }
 */
import type { WebhookEvent } from "./types";

export { WEBHOOK_EVENTS, type WebhookEvent } from "./types";

export interface WebhookPayload {
  /** The same on every attempt of one delivery: use it to ignore repeats. */
  id: string;
  event: WebhookEvent | "ping";
  at: string;
  actor: { kind: "user" | "key" | "system"; id: string | null; label: string; agent: string | null } | null;
  collection: string | null;
  slug: string | null;
  version: number | null;
  /** The public address of the document when the collection defines one. The body is never included. */
  url: string | null;
  /** For file and release events: which one (ids and names, never content). */
  detail?: Record<string, unknown>;
  /** 0.22.0: the document's language, in localized collections only (a translation has the same slug as its source). */
  locale?: string;
}

export const SIGNATURE_HEADER = "x-cms-signature";

export class WebhookVerifyError extends Error {
  constructor(public code: "missing" | "malformed" | "expired" | "mismatch", message: string) {
    super(message);
    this.name = "WebhookVerifyError";
  }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

/** The header value for a body: `t=<unix seconds>,v1=<HMAC-SHA256 of "t.body" in hex>`. */
export async function signWebhook(body: string, secret: string, at: Date = new Date()): Promise<string> {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${await hmac(secret, `${t}.${body}`)}`;
}

/**
 * Check the signature and return the payload. Pass the `Request` itself, or the raw body text and
 * the headers when your framework has already read the body. Throws `WebhookVerifyError`.
 */
export async function verifyWebhook(
  input: Request | { body: string; headers: Headers | Record<string, string | string[] | undefined> },
  secret: string,
  o: { toleranceSeconds?: number; now?: Date } = {}
): Promise<WebhookPayload> {
  const headers = input.headers;
  const raw = headers instanceof Headers ? headers.get(SIGNATURE_HEADER) : Object.entries(headers).find(([k]) => k.toLowerCase() === SIGNATURE_HEADER)?.[1];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) throw new WebhookVerifyError("missing", "no X-CMS-Signature header");
  const body = input instanceof Request ? await input.clone().text() : input.body;
  const parts = new Map(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) throw new WebhookVerifyError("malformed", "the signature header is not in the t=…,v1=… form");
  const tolerance = o.toleranceSeconds ?? 300;
  if (Math.abs((o.now ?? new Date()).getTime() / 1000 - t) > tolerance) throw new WebhookVerifyError("expired", "the signature is older than the allowed time");
  const want = await hmac(secret, `${t}.${body}`);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) throw new WebhookVerifyError("mismatch", "the signature does not match");
  try {
    return JSON.parse(body) as WebhookPayload;
  } catch {
    throw new WebhookVerifyError("malformed", "the body is not JSON");
  }
}
