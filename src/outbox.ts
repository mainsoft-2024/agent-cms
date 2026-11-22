/**
 * Webhooks, the sending side: who is registered, what goes out, retries, switching off an address
 * that keeps failing. Deliveries are jobs (jobs.ts), so they need the cron call to go out.
 */
import { base64url, randomBytes, randomUUID } from "./crypto";
import type { CmsErrorCode, CmsErrorOptions, ErrorParams } from "./errors";
import type { CmsJobs } from "./jobs";
import { assertPublicUrl, FetchGuardError, type ResolveHost } from "./net-guard";
import type { CmsRepo } from "./repo";
import type { Sealer } from "./secrets";
import { WEBHOOK_EVENTS, type Actor, type AuditAction, type CmsWebhook, type WebhookDelivery, type WebhookEvent } from "./types";
import { VERSION } from "./version";
import { signWebhook, type WebhookPayload } from "./webhooks";

export interface WebhookOptions {
  /** Development only: also allow http and addresses that are not on the public internet. */
  allowInsecure?: boolean;
  /** Seconds to wait for an answer. Default 10. */
  timeoutSeconds?: number;
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
}

/** Seconds after each failed attempt: 1 min, 5 min, 30 min, 2 h, 12 h. Then the delivery is given up. */
export const WEBHOOK_RETRY = [60, 300, 1800, 7200, 43_200] as const;
/** Failed deliveries in a row after which the webhook is switched off. */
export const WEBHOOK_MAX_FAILURES = 20;
export const WEBHOOK_KEEP_DAYS = 30;
export const WEBHOOK_JOB = "webhook.deliver";

export type WebhookView = Omit<CmsWebhook, "secretEnc">;
export interface WebhookInput {
  name: string;
  url: string;
  events?: WebhookEvent[];
  collections?: string[];
  enabled?: boolean;
}
export type OutEvent = Omit<WebhookPayload, "id" | "at" | "event"> & { event: WebhookEvent };
export type { WebhookPayload };

export interface OutboxContext {
  repo: CmsRepo;
  now: () => Date;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  audit: (actor: Actor, action: AuditAction, o?: { detail?: Record<string, unknown> }) => void;
  isAdmin: (actor: Actor) => boolean;
  ready: () => Promise<void> | void;
  report: (err: unknown, where: string) => void;
  sealer: Sealer | null;
  jobs: CmsJobs;
  collections: () => string[];
  options: WebhookOptions;
}

export function createOutbox(ctx: OutboxContext) {
  const { repo, fail } = ctx;
  const iso = () => ctx.now().toISOString();
  const view = ({ secretEnc: _s, ...w }: CmsWebhook): WebhookView => w;

  function admin(actor: Actor) {
    if (!ctx.isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_webhooks");
  }
  function sealer(): Sealer {
    if (!ctx.sealer) throw fail("secrets_key_missing");
    return ctx.sealer;
  }
  async function found(id: string): Promise<CmsWebhook> {
    const w = await repo.findWebhook(id);
    if (!w) throw fail("webhook_not_found");
    return w;
  }
  async function checked(i: Partial<WebhookInput>) {
    const out: Partial<Pick<CmsWebhook, "name" | "url" | "events" | "collections" | "enabled">> = {};
    if (i.name !== undefined) {
      const name = i.name.trim();
      if (!name || name.length > 80) throw fail("name_invalid", { max: 80 });
      out.name = name;
    }
    if (i.url !== undefined) {
      try {
        if (ctx.options.allowInsecure) {
          if (!/^https?:$/.test(new URL(i.url).protocol)) throw new FetchGuardError("blocked", "only http and https addresses");
        } else await assertPublicUrl(i.url, { resolveHost: ctx.options.resolveHost });
      } catch (e) {
        throw fail("webhook_url_blocked", { reason: e instanceof FetchGuardError ? e.message : "not a URL" });
      }
      out.url = new URL(i.url).toString();
    }
    if (i.events !== undefined) {
      const bad = i.events.find((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
      if (bad) throw fail("webhook_event_unknown", { event: bad });
      out.events = [...new Set(i.events)];
    }
    if (i.collections !== undefined) {
      const known = ctx.collections();
      const bad = i.collections.find((c) => !known.includes(c));
      if (bad) throw fail("unknown_collection", { collection: bad });
      out.collections = [...new Set(i.collections)];
    }
    if (i.enabled !== undefined) out.enabled = i.enabled;
    return out;
  }
  const matches = (w: CmsWebhook, e: { event: string; collection: string | null }) =>
    w.enabled && (!w.events.length || w.events.includes(e.event as WebhookEvent)) && (!w.collections.length || !e.collection || w.collections.includes(e.collection));
  const queue = (w: CmsWebhook, body: WebhookPayload) => ctx.jobs.enqueue(WEBHOOK_JOB, { webhookId: w.id, body: body as unknown as Record<string, unknown> });

  /** One attempt. Records it, keeps the failure count, and throws so the job is tried again later. */
  async function deliver(w: CmsWebhook, body: WebhookPayload, attempt: number): Promise<WebhookDelivery> {
    const text = JSON.stringify(body);
    const t0 = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      if (!ctx.options.allowInsecure) await assertPublicUrl(w.url, { resolveHost: ctx.options.resolveHost });
      const res = await (ctx.options.fetch ?? fetch)(w.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout((ctx.options.timeoutSeconds ?? 10) * 1000),
        headers: {
          "content-type": "application/json",
          "user-agent": `agent-cms/${VERSION}`,
          "x-cms-event": body.event,
          "x-cms-delivery": body.id,
          "x-cms-signature": await signWebhook(text, sealer().open(w.secretEnc), ctx.now()),
        },
        body: text,
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (status < 200 || status >= 300) error = status >= 300 && status < 400 ? "answered with a redirect (not followed)" : `answered ${status}`;
    } catch (e) {
      error = e instanceof FetchGuardError ? e.message : e instanceof Error && e.name === "TimeoutError" ? "timed out" : e instanceof Error ? e.message.slice(0, 300) : "the request failed";
    }
    const d = await repo.insertDelivery({ webhookId: w.id, event: body.event, payload: body as unknown as Record<string, unknown>, status, ok: error === null, responseMs: Date.now() - t0, attempt, error, at: iso() });
    if (error === null) {
      await repo.updateWebhook(w.id, { failures: 0 });
    } else {
      const failures = await repo.failWebhook(w.id);
      const off = w.enabled && failures >= WEBHOOK_MAX_FAILURES;
      if (off) await repo.updateWebhook(w.id, { enabled: false, disabledReason: `${failures} failed deliveries in a row. The last one: ${error}`, updatedAt: iso() });
      if (off) ctx.audit({ kind: "system", label: "webhooks" }, "webhook.disable", { detail: { id: w.id, name: w.name, failures, error } });
    }
    return d;
  }

  ctx.jobs.define<{ webhookId: string; body: WebhookPayload }>(WEBHOOK_JOB, {
    retryAfter: WEBHOOK_RETRY,
    async run(p, job) {
      const w = await repo.findWebhook(p.webhookId);
      if (!w || !w.enabled) return; // removed or switched off since: nothing to send
      const d = await deliver(w, p.body, job.attempts);
      if (!d.ok) throw new Error(d.error ?? "failed");
    },
  });

  return {
    enabled: () => !!ctx.sealer,
    async list(actor: Actor): Promise<WebhookView[]> {
      admin(actor);
      await ctx.ready();
      return (await repo.listWebhooks()).map(view);
    },
    /** The signing secret is returned here and by `secret()` only. */
    async create(actor: Actor, input: WebhookInput): Promise<{ webhook: WebhookView; secret: string }> {
      admin(actor);
      await ctx.ready();
      const seal = sealer();
      const c = await checked({ ...input, events: input.events ?? [], collections: input.collections ?? [] });
      const secret = `whsec_${base64url(randomBytes(24))}`;
      const at = iso();
      const w = await repo.insertWebhook({ name: c.name!, url: c.url!, events: c.events!, collections: c.collections!, secretEnc: seal.seal(secret), enabled: input.enabled ?? true, createdBy: actor.kind === "anonymous" ? null : actor.label, createdAt: at, updatedAt: at });
      ctx.audit(actor, "webhook.create", { detail: { id: w.id, name: w.name, url: w.url } });
      return { webhook: view(w), secret };
    },
    async update(actor: Actor, id: string, input: Partial<WebhookInput>): Promise<WebhookView> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      const c = await checked(input);
      // Switching it back on is a fresh start.
      const w = await repo.updateWebhook(id, { ...c, ...(c.enabled && !cur.enabled ? { failures: 0, disabledReason: null } : {}), updatedAt: iso() });
      ctx.audit(actor, "webhook.update", { detail: { id, name: w!.name, changed: Object.keys(c) } });
      return view(w!);
    },
    async remove(actor: Actor, id: string): Promise<void> {
      admin(actor);
      await ctx.ready();
      const w = await found(id);
      await repo.deleteWebhook(id);
      ctx.audit(actor, "webhook.delete", { detail: { id, name: w.name, url: w.url } });
    },
    async secret(actor: Actor, id: string): Promise<{ secret: string }> {
      admin(actor);
      await ctx.ready();
      const w = await found(id);
      // Who looked at a signing secret, and when (never the secret itself).
      ctx.audit(actor, "webhook.secret_view", { detail: { id: w.id, name: w.name } });
      return { secret: sealer().open(w.secretEnc) };
    },
    /** Send a `ping` now (not through the queue, no retries) and return what happened. */
    async test(actor: Actor, id: string): Promise<WebhookDelivery> {
      admin(actor);
      await ctx.ready();
      const w = await found(id);
      const who = actor.kind === "user" ? { kind: "user" as const, id: actor.id, label: actor.label, agent: null } : null;
      return deliver(w, { id: randomUUID(), event: "ping", at: iso(), actor: who, collection: null, slug: null, version: null, url: null }, 1);
    },
    async deliveries(actor: Actor, id: string, o: { limit?: number } = {}): Promise<WebhookDelivery[]> {
      admin(actor);
      await ctx.ready();
      await found(id);
      return repo.listDeliveries(id, Math.min(Math.max(o.limit ?? 50, 1), 200));
    },
    /** Queue the same payload again (a new attempt series). */
    async retry(actor: Actor, deliveryId: string): Promise<{ queued: true }> {
      admin(actor);
      await ctx.ready();
      const d = await repo.findDelivery(deliveryId);
      if (!d) throw fail("delivery_not_found");
      await queue(await found(d.webhookId), d.payload as unknown as WebhookPayload);
      return { queued: true };
    },
    /** Called by the core for everything that happens. Never throws and is not awaited by the write. */
    async emit(e: OutEvent): Promise<number> {
      if (!ctx.sealer) return 0;
      try {
        const hooks = (await repo.listWebhooks()).filter((w) => matches(w, e));
        if (!hooks.length) return 0;
        const body: WebhookPayload = { id: randomUUID(), at: iso(), ...e };
        await Promise.all(hooks.map((w) => queue(w, { ...body, id: randomUUID() })));
        return hooks.length;
      } catch (err) {
        ctx.report(err, "webhooks");
        return 0;
      }
    },
    /** Queue one event for one webhook, whatever its own event filter says (automations). False when it is gone or off. */
    async send(webhookId: string, e: OutEvent): Promise<boolean> {
      const w = ctx.sealer ? await repo.findWebhook(webhookId) : null;
      if (!w || !w.enabled) return false;
      await queue(w, { id: randomUUID(), at: iso(), ...e });
      return true;
    },
    prune: () => repo.pruneDeliveries(new Date(ctx.now().getTime() - WEBHOOK_KEEP_DAYS * 86_400_000).toISOString()),
  };
}

export type CmsOutbox = ReturnType<typeof createOutbox>;
