/**
 * The life of the plugins given to `createCms` (0.23.0, plugin v2): their order (`requires`),
 * `setup` inside `createCms`, `start` before the first request, `stop` on `cms.close()`, a
 * restart, and the list `cms.plugins.list()` / `GET /plugins` shows. A plugin that is not running
 * (it failed to start, or one it needs is missing or not running) adds nothing: its routes answer
 * 503 `plugin_failed`, its tools, menu entries and `_me` values are left out, its event listeners
 * are skipped and its jobs wait.
 */
import type { JobKind } from "./jobs";
import { pluginOf, PLUGIN_NAME, versionSatisfies, type CmsPlugin, type PluginContext, type PluginInfo, type PluginInput, type PluginNav, type PluginRoute, type PluginState, type PluginTool } from "./plugin";
import type { Sealer } from "./secrets";
import type { Actor } from "./types";
import { VERSION } from "./version";

export const PLUGIN_START_TIMEOUT_MS = 10_000;
export const PLUGIN_STOP_TIMEOUT_MS = 5_000;

interface Entry {
  plugin: CmsPlugin;
  ctx: PluginContext<any> | null;
  state: PluginState;
  error: string | null;
  startedMs: number | null;
  startedAt: string | null;
  /** Its `start` ran and its `stop` has not yet. */
  live: boolean;
}

export interface PluginHostDeps {
  cms: unknown;
  secrets: Sealer | null;
  /** Names a plugin cannot take (routes of the CMS, collections). */
  taken: (name: string) => boolean;
  listen: (event: Parameters<PluginContext["on"]>[0], fn: Parameters<PluginContext["on"]>[1], plugin: string) => void;
  defineJob: (kind: string, def: JobKind<any>) => void;
  enqueue: (kind: string, payload?: Record<string, unknown>, o?: { runAt?: Date | string }) => Promise<unknown>;
  report: (err: unknown, where: string) => void;
  now: () => Date;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

class PluginTimeout extends Error {}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, no) => (timer = setTimeout(() => no(new PluginTimeout(`${what} took longer than ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** The plugins in an order where each comes after the ones it needs; the given order otherwise. Throws on a cycle. */
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

export function createPluginHost(inputs: readonly PluginInput[], deps: PluginHostDeps) {
  const startTimeout = deps.startTimeoutMs ?? PLUGIN_START_TIMEOUT_MS;
  const stopTimeout = deps.stopTimeoutMs ?? PLUGIN_STOP_TIMEOUT_MS;
  const given = inputs.map(pluginOf);

  // Names, engines and dependencies are checked before anything is set up.
  const seen = new Set<string>();
  for (const p of given) {
    if (!PLUGIN_NAME.test(p.name)) throw new Error(`[agent-cms] plugin name "${p.name}" must be lowercase letters, digits and dashes`);
    if (seen.has(p.name)) throw new Error(`[agent-cms] plugin "${p.name}" is given twice`);
    if (deps.taken(p.name)) throw new Error(`[agent-cms] plugin name "${p.name}" is taken by a route of the CMS`);
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
  const counts = new Map<string, PluginInfo["registered"]>();
  const count = (name: string, k: keyof PluginInfo["registered"]) => {
    const c = counts.get(name)!;
    c[k]++;
  };

  const running = (name: string) => entries.get(name)?.state === "running";
  /** Whether what a plugin added is in use: running, or about to start (a call before the first request, from a script). */
  const usable = (name: string) => {
    const st = entries.get(name)?.state;
    return st === "running" || st === "starting";
  };

  for (const p of ordered) {
    const e: Entry = { plugin: p, ctx: null, state: "starting", error: null, startedMs: null, startedAt: null, live: false };
    entries.set(p.name, e);
    counts.set(p.name, { routes: 0, tools: 0, events: 0, jobs: 0, nav: 0, me: 0, sql: 0 });
    const missing = (p.requires ?? []).find((d) => !given.some((g) => g.name === d) || entries.get(d)?.state === "off");
    if (missing) {
      // Not set up at all: it adds nothing, and says why.
      e.state = "off";
      e.error = given.some((g) => g.name === missing) ? `needs the plugin "${missing}", which is off` : `needs the plugin "${missing}", which is not given to createCms`;
      continue;
    }
    sql.push(...(p.sql ?? []));
    counts.get(p.name)!.sql = p.sql?.length ?? 0;
    const ctx: PluginContext<any> = {
      cms: deps.cms,
      name: p.name,
      secrets: deps.secrets,
      on: (event, fn) => {
        count(p.name, "events");
        deps.listen(event, fn, p.name);
      },
      route: (method, path, handler) => {
        count(p.name, "routes");
        routes.push({ plugin: p.name, method, path: path.split("/").filter(Boolean), handler });
      },
      tool: (tool) => {
        if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) throw new Error(`[agent-cms] plugin ${p.name}: tool name "${tool.name}" must be snake_case`);
        const other = tools.find((t) => t.name === tool.name);
        if (other) throw new Error(`[agent-cms] plugin ${p.name}: the tool "${tool.name}" is already added by ${other.plugin}`);
        count(p.name, "tools");
        tools.push({ ...tool, plugin: p.name });
      },
      job: (kind, def) => {
        count(p.name, "jobs");
        // A plugin that is not running does not run its jobs: they wait and are tried again.
        deps.defineJob(`${p.name}.${kind}`, {
          ...def,
          run: (payload, info) => {
            if (!usable(p.name)) throw new Error(`the plugin ${p.name} is not running`);
            return def.run(payload, info);
          },
        });
      },
      enqueue: (kind, payload, o) => deps.enqueue(`${p.name}.${kind}`, payload, o),
      me: (fn) => {
        count(p.name, "me");
        me.push({ plugin: p.name, fn });
      },
      nav: (item) => {
        count(p.name, "nav");
        nav.push({ ...item, plugin: p.name });
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
  async function startOne(e: Entry): Promise<void> {
    if (!e.ctx) return; // off since createCms: never set up
    const blocked = (e.plugin.requires ?? []).find((d) => !running(d));
    if (blocked) {
      e.state = "off";
      e.error = `needs the plugin "${blocked}", which is ${entries.get(blocked)?.state === "failed" ? "failed" : "off"}`;
      return;
    }
    e.state = "starting";
    e.error = null;
    const t0 = Date.now();
    try {
      if (e.plugin.start) {
        e.live = true;
        await within(Promise.resolve().then(() => e.plugin.start!(e.ctx!, undefined)), startTimeout, `plugin ${e.plugin.name}: start`);
      } else e.live = true;
      e.state = "running";
    } catch (err) {
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
  /** Start every plugin once, in order. Rejects (and is tried again on the next call) while a `required` one is not running. */
  function startAll(): Promise<void> {
    started ??= (async () => {
      for (const e of entries.values()) if (e.state !== "off" || e.ctx) await startOne(e);
      const down = requiredDown();
      if (down) {
        // Close what started, so the next try begins clean.
        for (const e of [...entries.values()].reverse()) await stopOne(e);
        throw Object.assign(new Error(`plugin ${down.plugin.name}: ${down.error ?? down.state}`), { pluginFailed: down.plugin.name, reason: down.error ?? down.state });
      }
    })().catch((err) => {
      started = null;
      throw err;
    });
    return started;
  }

  function info(e: Entry): PluginInfo {
    const p = e.plugin;
    return { name: p.name, version: p.version ?? null, engine: p.engine ?? null, requires: [...(p.requires ?? [])], required: !!p.required, state: e.state, error: e.error, startedMs: e.startedMs, startedAt: e.startedAt, registered: { ...counts.get(p.name)! } };
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
    /** Whether a plugin is running. */
    running,
    /** Whether what a plugin added is in use (running or starting; not failed or off). */
    usable,
    /** Every plugin with its state, version, error and what it added. */
    list: (): PluginInfo[] => [...entries.values()].map(info),
    get: (name: string): PluginInfo | null => {
      const e = entries.get(name);
      return e ? info(e) : null;
    },
    /** Runs before the first request (with the schema check). */
    start: startAll,
    /**
     * Stop a plugin and the ones that need it, then start them again in order. For a plugin that
     * failed (after fixing what it needs) or to pick up new settings. Returns its state after.
     */
    async restart(name: string): Promise<PluginInfo | null> {
      const e = entries.get(name);
      if (!e) return null;
      const after = dependants(name);
      for (const d of [...after].reverse()) await stopOne(d);
      await stopOne(e);
      await startOne(e);
      for (const d of after) await startOne(d);
      return info(e);
    },
    /** Stop every plugin, last started first. */
    async stop(): Promise<void> {
      for (const e of [...entries.values()].reverse()) await stopOne(e);
      for (const e of entries.values()) if (e.ctx && e.state === "running") e.state = "starting";
      started = null;
    },
  };
}

export type PluginHost = ReturnType<typeof createPluginHost>;
