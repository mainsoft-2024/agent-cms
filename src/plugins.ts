/**
 * The life of the plugins given to `createCms` (0.23.0, plugin v2): their order (`requires`),
 * `setup` inside `createCms`, `start` before the first request, `stop` on `cms.close()`, a
 * restart, settings, and the list `cms.plugins.list()` / `GET /plugins` shows.
 *
 * A plugin that is not in use (it failed to start, or one it needs is missing or not running)
 * adds nothing: its routes answer 503 `plugin_failed`; its tools, menu entries, `_me` values,
 * hooks, filters, access rules and automation actions are skipped; its jobs wait.
 */
import type { ZodTypeAny } from "zod";
import type { AutomationFn } from "./automations";
import type { JobKind } from "./jobs";
import { type PluginSettingsView,
  pluginOf,
  PLUGIN_NAME,
  versionSatisfies,
  type CmsPlugin,
  type PluginAccessQuery,
  type PluginContext,
  type PluginFilterName,
  type PluginFilters,
  type PluginHookName,
  type PluginInfo,
  type PluginInput,
  type PluginNav,
  type PluginRoute,
  type PluginAdded,
  type PluginState,
  type PluginStore,
  type PluginDb,
  type PluginTool,
} from "./plugin";
import type { CmsRepo } from "./repo";
import { describeSettings, isSecretSchema } from "./plugin-fields";
import type { Sealer } from "./secrets";
import { RANKER_NAME, type SearchRanker, type SearchSectionsOptions, type SearchSectionsPage } from "./rankers";
import type { Actor, CollectionConfig, FieldAdmin } from "./types";
import { VERSION } from "./version";

export const PLUGIN_START_TIMEOUT_MS = 10_000;
export const PLUGIN_STOP_TIMEOUT_MS = 5_000;
/** `ctx.store`: longest key, largest value (JSON). */
export const PLUGIN_STORE_KEY_MAX = 200;
export const PLUGIN_STORE_VALUE_MAX = 64 * 1024;
/** Where a plugin's settings are kept (`cms_records`, one row per plugin, key = its name). */
export const PLUGIN_SETTINGS_KIND = "plugin-settings";
/** Plugins the CMS itself registers (webhooks, automations). Identity comes from here, never from a field a plugin sets. */
export const BUILTIN_PLUGINS = new WeakSet<CmsPlugin>();
const isBuiltin = (p: CmsPlugin) => BUILTIN_PLUGINS.has(p);
/** What the admin sees instead of a stored secret. */
export const SECRET_MASK = "••••••••";

/** A zod problem without the value it was about (validators quote values; settings may be secrets). */
// Only the setting's name: deeper path segments can be keys of a secret record.
const safeIssues = (issues: readonly { path: (string | number)[]; code: string }[]) => issues.map((i) => `${i.path.length ? String(i.path[0]) : "settings"}: ${i.code}`).join("; ");

type Registered = PluginInfo["registered"];

interface Entry {
  plugin: CmsPlugin;
  ctx: PluginContext<any> | null;
  state: PluginState;
  error: string | null;
  startedMs: number | null;
  startedAt: string | null;
  /** Its `start` ran and its `stop` has not yet. */
  live: boolean;
  /** Its settings, checked at its last start. */
  settings: Record<string, unknown>;
  /** Counts start attempts: a late continuation of an older one does nothing. */
  attempt: number;
}

export interface PluginHostDeps {
  /** The CMS a plugin gets as `ctx.cms` (made after the plugins are set up). */
  cms: () => unknown;
  secrets: () => Sealer | null;
  /** The database (for `ctx.store` and settings), once the CMS has one. */
  repo: () => CmsRepo;
  /** Names a plugin cannot take (routes of the CMS, collections of the app). */
  taken: (name: string) => boolean;
  listen: (event: Parameters<PluginContext["on"]>[0], fn: Parameters<PluginContext["on"]>[1], plugin: string) => void;
  enqueue: (kind: string, payload?: Record<string, unknown>, o?: { runAt?: Date | string }) => Promise<unknown>;
  report: (err: unknown, where: string) => void;
  log: (e: { plugin: string; level: "debug" | "info" | "warn" | "error"; message: string; data?: Record<string, unknown> }) => void;
  now: () => Date;
  /** 0.25.0: `ctx.search.sections` (what the keyword index holds). */
  searchSections: (o: SearchSectionsOptions) => Promise<SearchSectionsPage>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

class PluginTimeout extends Error {}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, no) => (timer = setTimeout(() => no(new PluginTimeout(`${what} took longer than ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** Whether a settings key is a secret: one rule, shared with the admin form (see `isSecretSchema`). */
export function isSecretSetting(schema: ZodTypeAny | undefined): boolean {
  return isSecretSchema(schema);
}

/** The plugins in an order where each comes after the ones it needs; the given order otherwise. Throws on a circle. */
export function orderPlugins(list: readonly CmsPlugin[]): CmsPlugin[] {
  const byName = new Map(list.map((p) => [p.name, p]));
  const out: CmsPlugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (p: CmsPlugin, path: string[]) => {
    const s = state.get(p.name);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`[agent-cms] plugins need each other in a circle: ${[...path, p.name].join(" → ")}`);
    state.set(p.name, "visiting");
    for (const dep of p.requires ?? []) {
      const d = byName.get(dep);
      if (d) visit(d, [...path, p.name]);
    }
    state.set(p.name, "done");
    out.push(p);
  };
  for (const p of list) visit(p, []);
  return out;
}

export interface PluginHookEntry {
  plugin: string;
  name: PluginHookName;
  fn: (...a: any[]) => any;
  collections: readonly string[] | null;
}
export interface PluginFieldEntry {
  plugin: string;
  collection: string;
  key: string;
  schema: ZodTypeAny;
  admin?: FieldAdmin;
}

export function createPluginHost(inputs: readonly PluginInput[], deps: PluginHostDeps) {
  const startTimeout = deps.startTimeoutMs ?? PLUGIN_START_TIMEOUT_MS;
  const stopTimeout = deps.stopTimeoutMs ?? PLUGIN_STOP_TIMEOUT_MS;
  const given = inputs.map(pluginOf);

  // Names, engines and dependencies are checked before anything is set up.
  const seen = new Set<string>();
  for (const p of given) {
    if (!PLUGIN_NAME.test(p.name)) throw new Error(`[agent-cms] plugin name "${p.name}" must be lowercase letters, digits and dashes`);
    if (!isBuiltin(p) && (deps.taken(p.name) || given.some((g) => isBuiltin(g) && g.name === p.name))) throw new Error(`[agent-cms] plugin name "${p.name}" is taken by a route of the CMS`);
    if (seen.has(p.name)) throw new Error(`[agent-cms] plugin "${p.name}" is given twice`);
    seen.add(p.name);
    if (p.engine && !versionSatisfies(VERSION, p.engine)) throw new Error(`[agent-cms] plugin ${p.name} works with agent-cms ${p.engine}, this is ${VERSION}`);
    for (const dep of p.requires ?? []) {
      if (dep === p.name) throw new Error(`[agent-cms] plugin ${p.name} cannot need itself`);
      if (!given.some((g) => g.name === dep) && p.required) throw new Error(`[agent-cms] plugin ${p.name} needs the plugin "${dep}", which is not given to createCms`);
    }
  }
  const ordered = orderPlugins(given);

  const entries = new Map<string, Entry>();
  const routes: PluginRoute[] = [];
  const tools: (PluginTool<any> & { plugin: string })[] = [];
  const nav: (PluginNav & { plugin: string })[] = [];
  const me: { plugin: string; fn: (actor: Actor) => Record<string, unknown> | Promise<Record<string, unknown>> }[] = [];
  const sql: string[] = [];
  const jobs: { plugin: string; kind: string; def: JobKind<any> }[] = [];
  const hooks: PluginHookEntry[] = [];
  const collections: { plugin: string; config: CollectionConfig<any, string> }[] = [];
  const fields: PluginFieldEntry[] = [];
  const actions: { plugin: string; name: string; label: string; run: AutomationFn }[] = [];
  const filters = new Map<PluginFilterName, { plugin: string; fn: (v: any, c: any) => any; priority: number; seq: number }[]>();
  const access: { plugin: string; rule: (q: PluginAccessQuery) => boolean; collections: readonly string[] | null }[] = [];
  const rankers: { plugin: string; full: string; ranker: SearchRanker }[] = [];
  const counts = new Map<string, Registered>();
  /** 0.24.1: what each plugin added, by name (the plugins screen lists them). */
  const added = new Map<string, PluginAdded[]>();
  const count = (name: string, k: keyof Registered, label?: string) => {
    counts.get(name)![k]++;
    if (label !== undefined) added.get(name)!.push({ kind: k, name: label.slice(0, 200) });
  };
  let filterSeq = 0;

  const running = (name: string) => entries.get(name)?.state === "running";
  /** Whether what a plugin added is in use: running, or about to start (a call before the first request, from a script). */
  const usable = (name: string) => {
    const st = entries.get(name)?.state;
    return st === "running" || st === "starting";
  };
  /** One transition at a time (start, restart, settings, stop, close): a second waits for the first. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  let closed = false;

  function dbOf(repo: CmsRepo): PluginDb | null {
    if (typeof repo.query !== "function") return null;
    return {
      query: (text, params) => repo.query!(text, params),
      tx: (fn) =>
        repo.tx(
          (inner) => {
            const db = dbOf(inner);
            // Never fall back to the outer connection: writes there would escape the rollback.
            if (!db) throw new Error("[agent-cms] db.tx: this store has no query inside a transaction");
            return fn(db);
          },
          { atomic: true }
        ),
    };
  }

  function makeStore(name: string): PluginStore {
    const kind = `plugin:${name}`;
    const checkKey = (key: string) => {
      if (typeof key !== "string" || !key || key.length > PLUGIN_STORE_KEY_MAX) throw new Error(`[agent-cms] plugin ${name}: a store key is 1 to ${PLUGIN_STORE_KEY_MAX} characters`);
    };
    return {
      async get(key) {
        checkKey(key);
        const r = await deps.repo().findRecordByKey(kind, key);
        return r ? ((r.data as { v: any }).v ?? null) : null;
      },
      async set(key, value) {
        checkKey(key);
        const text = JSON.stringify(value ?? null);
        if (text.length > PLUGIN_STORE_VALUE_MAX) throw new Error(`[agent-cms] plugin ${name}: a store value is at most ${PLUGIN_STORE_VALUE_MAX} bytes of JSON`);
        const data = { v: JSON.parse(text) };
        const repo = deps.repo();
        const at = deps.now().toISOString();
        const cur = await repo.findRecordByKey(kind, key);
        if (cur) await repo.updateRecord(kind, cur.id, { data, at });
        else
          await repo.insertRecord({ kind, key, data, at }).catch(async (e) => {
            // Another server wrote the same key first: change that row instead.
            const again = await repo.findRecordByKey(kind, key);
            if (!again) throw e;
            await repo.updateRecord(kind, again.id, { data, at });
          });
      },
      async delete(key) {
        checkKey(key);
        const repo = deps.repo();
        const cur = await repo.findRecordByKey(kind, key);
        return cur ? (await repo.deleteRecords({ kind, id: cur.id })) > 0 : false;
      },
      async list(prefix = "") {
        const rows = await deps.repo().listRecords({ kind, order: "asc", limit: 500 });
        return rows.filter((r) => (r.key ?? "").startsWith(prefix)).map((r) => ({ key: r.key ?? "", value: (r.data as { v: any }).v }));
      },
    };
  }

  for (const p of ordered) {
    const e: Entry = { plugin: p, ctx: null, state: "starting", error: null, startedMs: null, startedAt: null, live: false, settings: {}, attempt: 0 };
    entries.set(p.name, e);
    added.set(p.name, []);
    counts.set(p.name, { routes: 0, tools: 0, events: 0, jobs: 0, nav: 0, me: 0, sql: 0, hooks: 0, collections: 0, fields: 0, actions: 0, filters: 0, access: 0, rankers: 0 });
    const missing = (p.requires ?? []).find((d) => !given.some((g) => g.name === d) || entries.get(d)?.state === "off");
    if (missing) {
      // Not set up at all: it adds nothing, and says why.
      e.state = "off";
      e.error = given.some((g) => g.name === missing) ? `needs the plugin "${missing}", which is off` : `needs the plugin "${missing}", which is not given to createCms`;
      continue;
    }
    sql.push(...(p.sql ?? []));
    counts.get(p.name)!.sql = p.sql?.length ?? 0;
    const where = `[agent-cms] plugin ${p.name}`;
    const ctx: PluginContext<any> = {
      get cms() {
        return deps.cms();
      },
      name: p.name,
      get secrets() {
        return deps.secrets();
      },
      on: (event, fn) => {
        count(p.name, "events", event);
        deps.listen(event, fn, p.name);
      },
      route: (method, path, handler) => {
        const parts = path.split("/").filter(Boolean);
        if (routes.some((r) => r.plugin === p.name && r.method === method && r.path.join("/") === parts.join("/"))) throw new Error(`${where}: the route ${method} /${parts.join("/")} is added twice`);
        count(p.name, "routes", `${method} /${[p.name, ...parts].join("/")}`);
        routes.push({ plugin: p.name, method, path: parts, handler });
      },
      tool: (tool) => {
        if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) throw new Error(`${where}: tool name "${tool.name}" must be snake_case`);
        const other = tools.find((t) => t.name === tool.name);
        if (other) throw new Error(`${where}: the tool "${tool.name}" is already added by ${other.plugin}`);
        count(p.name, "tools", tool.name);
        tools.push({ ...tool, plugin: p.name });
      },
      job: (kind, def) => {
        if (jobs.some((j) => j.plugin === p.name && j.kind === kind)) throw new Error(`${where}: the job kind "${kind}" is defined twice`);
        count(p.name, "jobs", `${p.name}.${kind}`);
        // A plugin that is not in use does not run its jobs: they wait and are tried again.
        jobs.push({
          plugin: p.name,
          kind: `${p.name}.${kind}`,
          def: {
            ...def,
            run: (payload, info) => {
              if (!usable(p.name)) throw new Error(`the plugin ${p.name} is not running`);
              return def.run(payload, info);
            },
          },
        });
      },
      enqueue: (kind, payload, o) => deps.enqueue(`${p.name}.${kind}`, payload, o),
      me: (fn) => {
        count(p.name, "me", "_me");
        me.push({ plugin: p.name, fn });
      },
      nav: (item) => {
        count(p.name, "nav", item.label);
        nav.push({ ...item, plugin: p.name });
      },
      hook: (name, fn, o) => {
        count(p.name, "hooks", o?.collections?.length ? `${name} (${o.collections.join(", ")})` : name);
        hooks.push({ plugin: p.name, name, fn: fn as (...a: any[]) => any, collections: o?.collections ? [...o.collections] : null });
      },
      collection: (config) => {
        if (deps.taken(config.slug)) throw new Error(`${where}: the collection name "${config.slug}" is taken`);
        const other = collections.find((c) => c.config.slug === config.slug);
        if (other) throw new Error(`${where}: the collection "${config.slug}" is already added by ${other.plugin}`);
        count(p.name, "collections", config.slug);
        collections.push({ plugin: p.name, config });
      },
      field: (collection, key, schema, admin) => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key)) throw new Error(`${where}: field key "${key}" must be letters, digits and _`);
        const other = fields.find((f) => f.collection === collection && f.key === key);
        if (other) throw new Error(`${where}: the field "${collection}.${key}" is already added by ${other.plugin}`);
        count(p.name, "fields", `${collection}.${key}`);
        fields.push({ plugin: p.name, collection, key, schema, admin });
      },
      automationAction: (name, def) => {
        if (!/^[a-z][a-z0-9_-]{1,40}$/.test(name)) throw new Error(`${where}: action name "${name}" must be lowercase letters, digits, - and _`);
        const full = `${p.name}.${name}`;
        if (actions.some((a) => a.name === full)) throw new Error(`${where}: the action "${full}" is added twice`);
        count(p.name, "actions", full);
        actions.push({ plugin: p.name, name: full, label: def.label, run: def.run });
      },
      filter: (name, fn, o) => {
        if (!FILTER_NAMES.includes(name)) throw new Error(`${where}: there is no filter "${name}" (${FILTER_NAMES.join(", ")})`);
        count(p.name, "filters", name);
        const list = filters.get(name) ?? [];
        list.push({ plugin: p.name, fn, priority: o?.priority ?? 10, seq: filterSeq++ });
        list.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        filters.set(name, list);
      },
      access: (rule, o) => {
        count(p.name, "access", o?.collections?.length ? o.collections.join(", ") : "*");
        access.push({ plugin: p.name, rule, collections: o?.collections ? [...o.collections] : null });
      },
      store: makeStore(p.name),
      get db() {
        return dbOf(deps.repo());
      },
      settings: <T,>() => e.settings as T,
      log: (level, message, data) => deps.log({ plugin: p.name, level, message, data }),
      search: {
        ranker: (r) => {
          if (!r || typeof r.rank !== "function") throw new Error(`${where}: a search ranker needs a rank function`);
          if (!RANKER_NAME.test(r.name)) throw new Error(`${where}: search ranker name "${r.name}" must be lowercase letters, digits, - and _`);
          const full = `${p.name}.${r.name}`;
          if (rankers.some((x) => x.full === full)) throw new Error(`${where}: the search ranker "${full}" is added twice`);
          count(p.name, "rankers", full);
          rankers.push({ plugin: p.name, full, ranker: r });
        },
        sections: (o) => deps.searchSections(o ?? {}),
      },
    };
    e.ctx = ctx;
    p.setup(ctx, undefined);
  }

  /** The plugins that need `name`, directly or through others, in start order. */
  const dependants = (name: string): Entry[] => {
    const out: Entry[] = [];
    const want = new Set([name]);
    for (const e of entries.values()) {
      if ((e.plugin.requires ?? []).some((d) => want.has(d))) {
        want.add(e.plugin.name);
        out.push(e);
      }
    }
    return out;
  };

  // ── settings ──────────────────────────────────────────────────────────────

  async function storedSettings(name: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
    const r = await deps.repo().findRecordByKey(PLUGIN_SETTINGS_KIND, name);
    return r ? { id: r.id, data: r.data as Record<string, unknown> } : null;
  }

  /** The stored settings with secrets opened. */
  function opened(p: CmsPlugin, data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const shape = p.settings?.shape ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (isSecretSetting(shape[k] as ZodTypeAny) && v && typeof v === "object" && typeof (v as { sealed?: unknown }).sealed === "string") {
        const sealer = deps.secrets();
        if (!sealer) throw new Error(`the setting "${k}" is sealed and the CMS has no secretsKey`);
        const text = sealer.open((v as { sealed: string }).sealed);
        out[k] = (v as { json?: boolean }).json ? JSON.parse(text) : text;
      } else out[k] = v;
    }
    return out;
  }

  /** Read and check a plugin's settings (throws with the reason when they do not fit its schema). */
  async function loadSettings(e: Entry): Promise<Record<string, unknown>> {
    if (!e.plugin.settings) return {};
    const stored = await storedSettings(e.plugin.name);
    const r = e.plugin.settings.safeParse(opened(e.plugin, stored?.data ?? {}));
    if (!r.success) throw new Error(`settings: ${safeIssues(r.error.issues)}`);
    return r.data as Record<string, unknown>;
  }

  // ── start and stop ────────────────────────────────────────────────────────

  async function stopOne(e: Entry) {
    if (!e.live) return;
    e.live = false;
    if (!e.plugin.stop) return;
    try {
      await within(Promise.resolve().then(() => e.plugin.stop!()), stopTimeout, `plugin ${e.plugin.name}: stop`);
    } catch (err) {
      deps.report(err, `plugin ${e.plugin.name}: stop`);
    }
  }

  /** Start one plugin whose dependencies are settled. Never throws: a failure is kept on the entry. */
  async function startOne(e: Entry, during: "starting" | "restarting" = "starting"): Promise<void> {
    if (!e.ctx) return; // off since createCms: never set up
    const blocked = (e.plugin.requires ?? []).find((d) => !running(d));
    if (blocked) {
      e.state = "off";
      e.error = `needs the plugin "${blocked}", which is ${entries.get(blocked)?.state === "failed" ? "failed" : "off"}`;
      return;
    }
    // During a restart what it added stays out of use until its start succeeded.
    e.state = during;
    const attempt = ++e.attempt;
    e.error = null;
    const t0 = Date.now();
    try {
      await within(
        (async () => {
          e.settings = await loadSettings(e);
          // A start that timed out, or a CMS closed meanwhile, opens nothing late.
          if (closed || attempt !== e.attempt) throw new Error("start abandoned");
          e.live = true;
          if (e.plugin.start) await e.plugin.start(e.ctx!, undefined);
        })(),
        startTimeout,
        `plugin ${e.plugin.name}: start`,
      );
      e.state = "running";
    } catch (err) {
      e.attempt++;
      e.state = "failed";
      e.error = messageOf(err);
      deps.report(err, `plugin ${e.plugin.name}: start`);
      // Whatever it opened before failing is closed again.
      await stopOne(e);
    } finally {
      e.startedMs = Date.now() - t0;
      e.startedAt = deps.now().toISOString();
    }
  }

  const requiredDown = () => [...entries.values()].find((e) => e.plugin.required && e.state !== "running");

  let started: Promise<void> | null = null;
  const downError = (down: Entry) => Object.assign(new Error(`plugin ${down.plugin.name}: ${down.state}`), { pluginFailed: down.plugin.name, reason: down.state });
  /**
   * Start every plugin once, in order. Rejects while a `required` plugin is not running: on the
   * first start everything started is stopped again and the next call tries again; later (a
   * restart that failed) the other plugins keep running and requests wait for a fix.
   */
  async function start(): Promise<void> {
    if (closed) return;
    await startAll();
    const down = requiredDown();
    if (down) throw downError(down);
  }
  function startAll(): Promise<void> {
    started ??= serial(async () => {
      if (closed) return;
      for (const e of entries.values()) await startOne(e);
      const down = requiredDown();
      if (down) {
        // Close what started, so the next try begins clean.
        for (const e of [...entries.values()].reverse()) await stopOne(e);
        throw downError(down);
      }
    }).catch((err) => {
      started = null;
      throw err;
    });
    return started;
  }

  function restart(name: string): Promise<PluginInfo | null> {
    const e = entries.get(name);
    if (!e) return Promise.resolve(null);
    return serial(async () => {
      if (closed) return info(e);
      const after = dependants(name);
      // What they added waits while they change (routes 503, rules refuse).
      for (const x of [e, ...after]) if (x.ctx) x.state = "restarting";
      for (const d of [...after].reverse()) await stopOne(d);
      await stopOne(e);
      await startOne(e, "restarting");
      for (const d of after) await startOne(d, "restarting");
      return info(e);
    });
  }

  function info(e: Entry): PluginInfo {
    const p = e.plugin;
    return {
      name: p.name,
      builtin: isBuiltin(p),
      version: p.version ?? null,
      engine: p.engine ?? null,
      requires: [...(p.requires ?? [])],
      required: !!p.required,
      state: e.state,
      error: e.error,
      startedMs: e.startedMs,
      startedAt: e.startedAt,
      registered: { ...counts.get(p.name)! },
      added: [...(added.get(p.name) ?? []), ...(counts.get(p.name)!.sql ? [{ kind: "sql" as const, name: `${counts.get(p.name)!.sql}` }] : [])],
      settings: p.settings ? Object.keys(p.settings.shape) : null,
    };
  }

  // ── what runs where the CMS calls the plugins ────────────────────────────

  /** A hook that runs only while its plugin is in use, and only for its collections. */
  function hooksFor(collection: string): Partial<Record<PluginHookName, ((...a: any[]) => any)[]>> {
    const out: Partial<Record<PluginHookName, ((...a: any[]) => any)[]>> = {};
    for (const h of hooks) {
      if (h.collections && !h.collections.includes(collection)) continue;
      const wrapped = (...a: any[]) => (usable(h.plugin) ? h.fn(...a) : undefined);
      (out[h.name] ??= []).push(wrapped);
    }
    return out;
  }

  return {
    /** Names of the plugins given to `createCms`, in start order. */
    names: [...entries.keys()],
    routes,
    tools,
    nav,
    me,
    /** The SQL the plugins' tables need (run it with your migrations; every statement is safe to repeat). */
    sql,
    /** Job kinds plugins defined (`<plugin>.<kind>`); the CMS registers them. */
    jobs,
    /** Collections plugins added, with the plugin's name. */
    collections,
    fields,
    /** Automation actions plugins added (`<plugin>.<name>`); each runs only while its plugin is in use. */
    actions: actions.map((a) => ({
      ...a,
      run: ((c) => {
        if (!usable(a.plugin)) throw new Error(`the plugin ${a.plugin} is not running`);
        return a.run(c);
      }) as AutomationFn,
    })),
    hooksFor,
    /** Collection names plugins' hooks and access rules point at (checked by the CMS: each must exist). */
    namedCollections: () => [...hooks.map((h) => ({ plugin: h.plugin, names: h.collections ?? [] })), ...access.map((a) => ({ plugin: a.plugin, names: a.collections ?? [] }))],
    /** Whether a plugin is running. */
    running,
    /** Whether what a plugin added is in use (running or starting; not failed or off). */
    usable,
    /** Whether some plugin in use adds an access rule for this collection. */
    hasAccess: (collection: string) => access.some((a) => !a.collections || a.collections.includes(collection)),
    /** The plugins' access rules for one check: false when one refuses. A rule that throws refuses. */
    allows(q: PluginAccessQuery): boolean {
      for (const a of access) {
        if (a.collections && !a.collections.includes(q.collection)) continue;
        // Fails closed: a rule whose plugin is not running refuses.
        if (!usable(a.plugin)) return false;
        try {
          if (a.rule(q) === false) return false;
        } catch (err) {
          deps.report(err, `plugin ${a.plugin}: access`);
          return false;
        }
      }
      return true;
    },
    /** 0.25.0: the search rankers of the plugins in use, with their full names (`<plugin>.<name>`). */
    rankers: () => rankers.filter((r) => usable(r.plugin)),
    /** Whether a filter has functions (so callers can skip the work). */
    filters: (name: PluginFilterName) => (filters.get(name) ?? []).some((f) => usable(f.plugin)),
    /** Run a value through a filter's functions. */
    async filter<K extends PluginFilterName>(name: K, value: PluginFilters[K]["value"], ctx: PluginFilters[K]["ctx"]): Promise<PluginFilters[K]["value"]> {
      let cur = value;
      for (const f of filters.get(name) ?? []) {
        if (!usable(f.plugin)) continue;
        try {
          // Each filter gets a copy: changing the value in place cannot reach what the caller keeps.
          // Values go out as JSON, so a value structuredClone cannot copy is copied as its JSON.
          let copy: typeof cur;
          try {
            copy = structuredClone(cur);
          } catch {
            copy = JSON.parse(JSON.stringify(cur));
          }
          const next = await f.fn(copy, ctx);
          if (next !== undefined) cur = next;
        } catch (err) {
          deps.report(err, `plugin ${f.plugin}: filter ${name}`);
        }
      }
      return cur;
    },
    /** Every plugin with its state, version, error and what it added. */
    list: (): PluginInfo[] => [...entries.values()].map(info),
    get: (name: string): PluginInfo | null => {
      const e = entries.get(name);
      return e ? info(e) : null;
    },
    /** Whether `name` is a built-in plugin (cheap: the event dispatch asks for every listener). */
    isBuiltin: (name: string): boolean => {
      const e = entries.get(name);
      return !!e && isBuiltin(e.plugin);
    },
    /** Runs before the first request; rejects while a `required` plugin is not running. */
    start,
    /** Whether the plugins were closed (`cms.close()`). */
    closed: () => closed,
    /**
     * Stop a plugin and the ones that need it, then start them again in order. For a plugin that
     * failed (after fixing what it needs) or to pick up new settings. Returns its state after.
     */
    restart,
    /** The settings a plugin has, for the admin: secrets show only their last four characters. Null for an unknown plugin or one without settings. */
    async settings(name: string): Promise<PluginSettingsView | null> {
      const e = entries.get(name);
      if (!e?.plugin.settings) return null;
      const shape = e.plugin.settings.shape;
      const secret = Object.keys(shape).filter((k) => isSecretSetting(shape[k] as ZodTypeAny));
      const stored = await storedSettings(name);
      let values: Record<string, unknown> = {};
      try {
        values = opened(e.plugin, stored?.data ?? {});
      } catch {
        values = { ...(stored?.data ?? {}) };
        for (const k of secret) if (k in values) values[k] = "";
      }
      // A secret is never sent back: only whether one is stored.
      for (const k of secret) values[k] = values[k] === undefined || values[k] === null || values[k] === "" ? null : SECRET_MASK;
      return { schema: Object.keys(shape), secret, values, fields: describeSettings(shape) };
    },
    /**
     * Save a plugin's settings (checked with its schema), then restart it. A secret left out (or
     * sent back as the mask) keeps what was stored. Throws `{ invalid: issues }` when they do not fit.
     */
    saveSettings(name: string, input: Record<string, unknown>): Promise<PluginInfo | null> {
      const e = entries.get(name);
      if (!e?.plugin.settings) return Promise.resolve(null);
      return serial(() => save(e, input)).then(() => restart(name));
    },
    /** Refuse new work (nothing starts again). `close()` then stops them; drain running work in between. */
    markClosed() {
      closed = true;
    },
    /** Stop every plugin, last started first. Final: nothing starts again afterwards. */
    close(): Promise<void> {
      closed = true;
      return serial(async () => {
        for (const e of [...entries.values()].reverse()) await stopOne(e);
        for (const e of entries.values()) if (e.ctx && e.state !== "failed") ((e.state = "off"), (e.error = "closed"));
      });
    },
  };

  async function save(e: Entry, input: Record<string, unknown>): Promise<void> {
    const name = e.plugin.name;
    {
      const shape = e.plugin.settings!.shape;
      const stored = await storedSettings(name);
      const prev = (() => {
        try {
          return opened(e.plugin, stored?.data ?? {});
        } catch {
          return {};
        }
      })();
      const merged: Record<string, unknown> = { ...input };
      for (const k of Object.keys(shape)) {
        if (!isSecretSetting(shape[k] as ZodTypeAny)) continue;
        // A secret left out (or sent back as the mask exactly) keeps what was stored.
        if (merged[k] === undefined || merged[k] === SECRET_MASK) merged[k] = prev[k];
      }
      const r = e.plugin.settings!.safeParse(merged);
      if (!r.success) throw Object.assign(new Error("settings do not fit"), { invalid: safeIssues(r.error.issues) });
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.data as Record<string, unknown>)) {
        if (isSecretSetting(shape[k] as ZodTypeAny) && v !== undefined && v !== null && v !== "") {
          const sealer = deps.secrets();
          if (!sealer) throw Object.assign(new Error("no secretsKey"), { invalid: `${k}: needs createCms({ secretsKey })` });
          data[k] = typeof v === "string" ? { sealed: sealer.seal(v) } : { sealed: sealer.seal(JSON.stringify(v)), json: true };
        } else data[k] = v;
      }
      const repo = deps.repo();
      const at = deps.now().toISOString();
      if (stored) await repo.updateRecord(PLUGIN_SETTINGS_KIND, stored.id, { data, at });
      else
        await repo.insertRecord({ kind: PLUGIN_SETTINGS_KIND, key: name, data, at }).catch(async (err) => {
          // Another server saved first: change that row.
          const again = await storedSettings(name);
          if (!again) throw err;
          await repo.updateRecord(PLUGIN_SETTINGS_KIND, again.id, { data, at });
        });
    }
  }
}

export const FILTER_NAMES: readonly PluginFilterName[] = ["sitemap.entries", "rest.doc", "mcp.result", "export.file", "mail.message"];

export type PluginHost = ReturnType<typeof createPluginHost>;
