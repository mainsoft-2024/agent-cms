/**
 * Automations: "when this happens, and these conditions hold, do that", made on a screen.
 * An event that matches an enabled automation becomes a background job (jobs.ts), so the work
 * runs on the next cron call, outside the request that caused it. What an automation changes is
 * recorded as the system actor "automation: <name>" and never starts another automation.
 */
import type { CmsErrorCode, CmsErrorOptions, ErrorParams } from "./errors";
import type { CmsJobs } from "./jobs";
import type { OutEvent } from "./outbox";
import type { CmsRepo } from "./repo";
import type { Actor, AuditAction, CmsDoc, CmsRecord, DocContent } from "./types";

export const AUTOMATION_TRIGGERS = ["doc.created", "doc.updated", "doc.published", "doc.unpublished", "doc.deleted", "review.requested", "asset.uploaded", "schedule.daily", "schedule.weekly"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_ACTIONS = ["webhook", "add_keyword", "set_field", "add_to_release", "call"] as const;
export const AUTOMATION_KEEP_DAYS = 30;
export const AUTOMATION_JOB = "automation.run";
const ACTOR_PREFIX = "automation: ";

export interface AutomationCondition {
  /** `category`, `actor` (person or agent), `title`, or a field path such as `fields.tags`. */
  field: string;
  op: "is" | "is_not" | "contains" | "empty" | "not_empty";
  value?: string;
}
export interface AutomationAction {
  /** One of AUTOMATION_ACTIONS, or the name of an action a plugin or the app added. */
  type: string;
  /** webhook: the webhook's id. add_to_release: the release's id. call: the function's name. */
  target?: string;
  /** add_keyword: the keyword. set_field: the field path (`fields.reviewed`). */
  name?: string;
  /** set_field: the value (JSON when it parses, else text). */
  value?: string;
}
export interface CmsAutomation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { event: AutomationTrigger; collection: string | null };
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  createdBy: string | null;
  lastRun: { state: AutomationRun["state"]; at: string } | null;
  /** The day a schedule trigger last fired (`YYYY-MM-DD` in the CMS's time zone). */
  lastTick: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AutomationRun {
  id: string;
  automationId: string;
  event: string;
  state: "ok" | "skipped" | "failed";
  collection: string | null;
  slug: string | null;
  title: string | null;
  steps: { type: string; ok: boolean; note: string }[];
  error: string | null;
  at: string;
}
export type AutomationInput = Partial<Pick<CmsAutomation, "name" | "enabled" | "trigger" | "conditions" | "actions">>;
/** What an action written by the app or a plugin gets. */
export interface AutomationActionContext {
  automation: { id: string; name: string };
  event: OutEvent | { event: AutomationTrigger; collection: null; slug: null };
  /** The document the event is about (its working copy), when there is one. */
  doc: CmsDoc | null;
  /** The actor changes should be made as. */
  actor: Actor;
  action: AutomationAction;
}
export type AutomationFn = (ctx: AutomationActionContext) => void | string | Promise<void | string>;
export interface AutomationOptions {
  /** Functions an automation can call by name (the "call" action): `{ notifySales: async (ctx) => {} }`. */
  actions?: Record<string, AutomationFn>;
}

type Data = Omit<CmsAutomation, "id" | "createdAt" | "updatedAt">;
const KIND = "automation";
const RUN = "automation_run";

export interface AutomationsContext {
  repo: CmsRepo;
  now: () => Date;
  today: () => string;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  audit: (actor: Actor, action: AuditAction, o?: { detail?: Record<string, unknown> }) => void;
  isAdmin: (actor: Actor) => boolean;
  ready: () => Promise<void> | void;
  report: (err: unknown, where: string) => void;
  jobs: CmsJobs;
  collections: () => string[];
  findDoc: (collection: string, slug: string) => Promise<CmsDoc | null>;
  update: (actor: Actor, collection: string, slug: string, input: Partial<DocContent>) => Promise<CmsDoc>;
  addToRelease: (actor: Actor, releaseId: string, item: { collection: string; slug: string }) => Promise<unknown>;
  sendWebhook: (webhookId: string, e: OutEvent) => Promise<boolean>;
  options: AutomationOptions;
}

/** A value inside a document by path: `title`, `category`, `fields.tags`, `fields.seo.title`. */
function at(doc: CmsDoc, path: string): unknown {
  let cur: unknown = doc;
  for (const k of path.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}
const text = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));

export function createAutomations(ctx: AutomationsContext) {
  const { repo, fail } = ctx;
  const iso = () => ctx.now().toISOString();
  const view = (r: CmsRecord): CmsAutomation => ({ ...(r.data as unknown as Data), id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt });
  const extra = new Map<string, { label: string; run: AutomationFn }>();
  let cache: { at: number; list: CmsAutomation[] } | null = null;

  function admin(actor: Actor) {
    if (!ctx.isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_automations");
  }
  async function all(fresh = false): Promise<CmsAutomation[]> {
    if (!fresh && cache && ctx.now().getTime() - cache.at < 15_000) return cache.list;
    cache = { at: ctx.now().getTime(), list: (await repo.listRecords({ kind: KIND, order: "asc", limit: 500 })).map(view) };
    return cache.list;
  }
  async function found(id: string): Promise<CmsAutomation> {
    const r = await repo.findRecord(KIND, id);
    if (!r) throw fail("automation_not_found");
    return view(r);
  }
  const actionNames = () => [...AUTOMATION_ACTIONS.filter((a) => a !== "call" || Object.keys(ctx.options.actions ?? {}).length > 0), ...extra.keys()];
  function clean(i: AutomationInput, cur?: CmsAutomation): Data {
    const name = (i.name ?? cur?.name ?? "").trim();
    if (!name || name.length > 80) throw fail("name_invalid", { max: 80 });
    const trigger = i.trigger ?? cur?.trigger ?? { event: "doc.published" as const, collection: null };
    if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger.event)) throw fail("automation_invalid", { reason: `unknown trigger "${trigger.event}"` });
    if (trigger.collection && !ctx.collections().includes(trigger.collection)) throw fail("unknown_collection", { collection: trigger.collection });
    const conditions = (i.conditions ?? cur?.conditions ?? []).slice(0, 10).map((c) => ({ field: String(c.field).trim().slice(0, 120), op: c.op, ...(c.value !== undefined ? { value: String(c.value).slice(0, 500) } : {}) }));
    for (const c of conditions) if (!c.field || !["is", "is_not", "contains", "empty", "not_empty"].includes(c.op)) throw fail("automation_invalid", { reason: "a condition needs a field and a comparison" });
    const actions = (i.actions ?? cur?.actions ?? []).slice(0, 10).map((a) => ({ type: String(a.type), ...(a.target ? { target: String(a.target).slice(0, 200) } : {}), ...(a.name ? { name: String(a.name).slice(0, 120) } : {}), ...(a.value !== undefined ? { value: String(a.value).slice(0, 2000) } : {}) }));
    const known = new Set<string>([...AUTOMATION_ACTIONS, ...extra.keys()]);
    for (const a of actions) {
      if (!known.has(a.type)) throw fail("automation_invalid", { reason: `unknown action "${a.type}"` });
      if ((a.type === "webhook" || a.type === "add_to_release" || a.type === "call") && !a.target) throw fail("automation_invalid", { reason: `the action "${a.type}" needs a target` });
      if ((a.type === "add_keyword" || a.type === "set_field") && !a.name) throw fail("automation_invalid", { reason: `the action "${a.type}" needs a name` });
      if (a.type === "call" && !ctx.options.actions?.[a.target!]) throw fail("automation_invalid", { reason: `no function named "${a.target}" (createCms({ automations: { actions } }))` });
    }
    return { name, enabled: i.enabled ?? cur?.enabled ?? true, trigger: { event: trigger.event, collection: trigger.collection || null }, conditions, actions, createdBy: cur?.createdBy ?? null, lastRun: cur?.lastRun ?? null, lastTick: cur?.lastTick ?? null };
  }

  /** Each condition against a document; with no document only an empty list passes. */
  function evaluate(a: CmsAutomation, doc: CmsDoc | null, e: { actor?: OutEvent["actor"] }) {
    return a.conditions.map((c) => {
      const raw = c.field === "actor" ? (e.actor && (e.actor.kind !== "user" || e.actor.agent) ? "agent" : "person") : doc ? at(doc, c.field) : undefined;
      const have = text(raw);
      const want = c.value ?? "";
      const ok =
        c.op === "empty" ? have === "" : c.op === "not_empty" ? have !== "" : c.op === "contains" ? (Array.isArray(raw) ? raw.map(String).includes(want) : have.toLowerCase().includes(want.toLowerCase())) : c.op === "is_not" ? have !== want : have === want;
      return { ...c, ok: c.field === "actor" || !!doc ? ok : false };
    });
  }
  const describe = (a: AutomationAction) => [a.type, a.target, a.name, a.value].filter((x) => x !== undefined && x !== "").join(" ");

  async function act(auto: CmsAutomation, action: AutomationAction, doc: CmsDoc | null, e: AutomationActionContext["event"], actor: Actor): Promise<string> {
    const need = () => {
      if (!doc) throw new Error("this action needs a document");
      return doc;
    };
    if (action.type === "webhook") {
      const ev = "actor" in e ? e : ({ event: "doc.updated", actor: null, collection: null, slug: null, version: null, url: null } as OutEvent);
      if (!(await ctx.sendWebhook(action.target!, ev))) throw new Error("the webhook is gone or switched off");
      return "queued";
    }
    if (action.type === "add_keyword") {
      const d = need();
      if (d.keywords.includes(action.name!)) return "already there";
      await ctx.update(actor, d.collection, d.slug, { keywords: [...d.keywords, action.name!] });
      return "added";
    }
    if (action.type === "set_field") {
      const d = need();
      let value: unknown = action.value ?? "";
      try {
        value = JSON.parse(String(value));
      } catch {
        // plain text
      }
      const path = action.name!.replace(/^fields\./, "").split(".");
      if (["summary", "category", "title"].includes(action.name!)) await ctx.update(actor, d.collection, d.slug, { [action.name!]: value } as Partial<DocContent>);
      else await ctx.update(actor, d.collection, d.slug, { fields: path.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown> });
      return "set";
    }
    if (action.type === "add_to_release") {
      const d = need();
      await ctx.addToRelease(actor, action.target!, { collection: d.collection, slug: d.slug });
      return "added";
    }
    const fn = action.type === "call" ? ctx.options.actions?.[action.target!] : extra.get(action.type)?.run;
    if (!fn) throw new Error(`nothing handles "${action.type}"`);
    return (await fn({ automation: { id: auto.id, name: auto.name }, event: e, doc, actor, action })) || "done";
  }

  async function record(auto: CmsAutomation, run: Omit<AutomationRun, "id" | "automationId" | "at">) {
    const at = iso();
    await repo.insertRecord({ kind: RUN, scope: auto.id, data: { ...run } as Record<string, unknown>, at });
    const cur = await repo.findRecord(KIND, auto.id);
    if (cur) await repo.updateRecord(KIND, auto.id, { data: { ...cur.data, lastRun: { state: run.state, at } }, at: cur.updatedAt });
    cache = null;
  }

  async function execute(auto: CmsAutomation, e: AutomationActionContext["event"]) {
    const doc = e.collection && e.slug ? await ctx.findDoc(e.collection, e.slug) : null;
    const base = { event: e.event, collection: e.collection, slug: e.slug, title: doc?.title ?? null };
    const checks = evaluate(auto, doc, "actor" in e ? e : {});
    if (checks.some((c) => !c.ok)) return record(auto, { ...base, state: "skipped", steps: [], error: null });
    const actor: Actor = { kind: "system", label: `${ACTOR_PREFIX}${auto.name}`, via: "automation" };
    const steps: AutomationRun["steps"] = [];
    let error: string | null = null;
    let cur = doc;
    for (const action of auto.actions) {
      try {
        steps.push({ type: action.type, ok: true, note: await act(auto, action, cur, e, actor) });
        if (cur) cur = (await ctx.findDoc(cur.collection, cur.slug)) ?? cur;
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        steps.push({ type: action.type, ok: false, note: error });
        break; // the steps after a failed one do not run
      }
    }
    await record(auto, { ...base, state: error ? "failed" : "ok", steps, error });
  }

  ctx.jobs.define<{ automationId: string; event: AutomationActionContext["event"] }>(AUTOMATION_JOB, {
    async run(p) {
      const r = await repo.findRecord(KIND, p.automationId);
      if (!r) return;
      const auto = view(r);
      if (auto.enabled) await execute(auto, p.event);
    },
  });

  return {
    /** Add an action people can pick (plugins: `ctx.automationAction()`). */
    addAction(name: string, def: { label: string; run: AutomationFn }) {
      if (!/^[a-z][a-z0-9_.-]{1,60}$/.test(name) || (AUTOMATION_ACTIONS as readonly string[]).includes(name)) throw new Error(`[agent-cms] automation action name "${name}" is not usable`);
      extra.set(name, def);
    },
    async list(actor: Actor) {
      admin(actor);
      await ctx.ready();
      return { automations: await all(true), triggers: AUTOMATION_TRIGGERS, actions: actionNames(), actionLabels: Object.fromEntries([...extra].map(([k, v]) => [k, v.label])), functions: Object.keys(ctx.options.actions ?? {}) };
    },
    async create(actor: Actor, input: AutomationInput): Promise<CmsAutomation> {
      admin(actor);
      await ctx.ready();
      const data = { ...clean(input), createdBy: actor.kind === "anonymous" ? null : actor.label };
      const r = await repo.insertRecord({ kind: KIND, data: data as unknown as Record<string, unknown>, at: iso() });
      cache = null;
      ctx.audit(actor, "automation.create", { detail: { id: r.id, name: data.name } });
      return view(r);
    },
    async update(actor: Actor, id: string, input: AutomationInput): Promise<CmsAutomation> {
      admin(actor);
      await ctx.ready();
      const data = clean(input, await found(id));
      const r = await repo.updateRecord(KIND, id, { data: data as unknown as Record<string, unknown>, at: iso() });
      cache = null;
      ctx.audit(actor, "automation.update", { detail: { id, name: data.name, enabled: data.enabled } });
      return view(r!);
    },
    async remove(actor: Actor, id: string): Promise<void> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      await repo.deleteRecords({ kind: KIND, id });
      await repo.deleteRecords({ kind: RUN, scope: id });
      cache = null;
      ctx.audit(actor, "automation.delete", { detail: { id, name: cur.name } });
    },
    async runs(actor: Actor, id: string, o: { limit?: number } = {}): Promise<AutomationRun[]> {
      admin(actor);
      await ctx.ready();
      await found(id);
      return (await repo.listRecords({ kind: RUN, scope: id, limit: Math.min(Math.max(o.limit ?? 30, 1), 200) })).map((r) => ({ ...(r.data as unknown as Omit<AutomationRun, "id" | "automationId" | "at">), id: r.id, automationId: id, at: r.createdAt }));
    },
    /** Check the conditions against one document and say what would be done. Nothing is changed. */
    async test(actor: Actor, id: string, target: { collection: string; slug: string }) {
      admin(actor);
      await ctx.ready();
      const auto = await found(id);
      const doc = await ctx.findDoc(target.collection, target.slug);
      if (!doc) throw fail("not_found", { collection: target.collection, slug: target.slug });
      const conditions = evaluate(auto, doc, { actor: { kind: "user", id: null, label: "", agent: null } });
      return { matches: conditions.every((c) => c.ok), title: doc.title, conditions, actions: auto.actions.map((a) => ({ type: a.type, would: describe(a) })) };
    },
    /** Called by the core for every event. Never throws. */
    async onEvent(e: OutEvent): Promise<number> {
      try {
        // What an automation did never starts another one.
        if (e.actor?.kind === "system" && e.actor.label.startsWith(ACTOR_PREFIX)) return 0;
        const hit = (await all()).filter((a) => a.enabled && a.trigger.event === e.event && (!a.trigger.collection || a.trigger.collection === e.collection));
        await Promise.all(hit.map((a) => ctx.jobs.enqueue(AUTOMATION_JOB, { automationId: a.id, event: e as unknown as Record<string, unknown> })));
        return hit.length;
      } catch (err) {
        ctx.report(err, "automations");
        return 0;
      }
    },
    /** The cron call: start what is on a schedule (once a day; weekly ones on Mondays) and forget old runs. */
    async tick(): Promise<number> {
      const day = ctx.today();
      const monday = new Date(`${day}T00:00:00Z`).getUTCDay() === 1;
      let n = 0;
      for (const a of await all(true)) {
        if (!a.enabled || a.lastTick === day || !(a.trigger.event === "schedule.daily" || (a.trigger.event === "schedule.weekly" && monday))) continue;
        const cur = await repo.findRecord(KIND, a.id);
        if (!cur) continue;
        await repo.updateRecord(KIND, a.id, { data: { ...cur.data, lastTick: day }, at: cur.updatedAt });
        await ctx.jobs.enqueue(AUTOMATION_JOB, { automationId: a.id, event: { event: a.trigger.event, collection: null, slug: null } });
        n++;
      }
      cache = null;
      await repo.deleteRecords({ kind: RUN, before: new Date(ctx.now().getTime() - AUTOMATION_KEEP_DAYS * 86_400_000).toISOString() });
      return n;
    },
  };
}

export type CmsAutomations = ReturnType<typeof createAutomations>;
