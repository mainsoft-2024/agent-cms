/**
 * Plugins: a way for another package (or the app) to add to the CMS without changing it. A plugin
 * can listen to what happens, add routes under `/api/cms/<plugin name>/`, add agent tools, define
 * background jobs, put values into `GET /_me` and bring its own tables.
 *
 *   export const stats = definePlugin({
 *     name: "stats",
 *     setup(ctx) {
 *       ctx.on("doc.published", (e) => console.log("published", e.collection, e.slug));
 *       ctx.route("GET", "summary", async ({ actor, cms }) => Response.json({ n: (await cms.collections()).length }));
 *     },
 *   });
 *   createCms({ ..., plugins: [stats] });
 *
 * 0.23.0 (plugin v2) adds a life around `setup`: options checked with zod, the engine versions a
 * plugin works with, plugins it needs (`requires`, started first), `start` before the first request
 * and `stop` on `cms.close()`. A plugin that fails to start is switched off with the plugins that
 * need it, and the CMS goes on (`required: true` stops the CMS instead).
 *
 *   export const slack = definePlugin({
 *     name: "slack-notify",
 *     version: "0.3.0",
 *     engine: ">=0.23",
 *     options: z.object({ channel: z.string().default("#content") }),
 *     setup(ctx, options) { ... },
 *     async start(ctx, options) { ... },
 *     async stop() { ... },
 *   });
 *   createCms({ plugins: [slack({ channel: "#news" })] });   // or `slack` for the defaults
 *
 * Plugins written for 0.12 to 0.22 (`{ name, sql, setup(ctx) }`) work unchanged.
 */
import type { z, ZodTypeAny } from "zod";
import type { AutomationFn } from "./automations";
import type { JobKind } from "./jobs";
import type { OutEvent } from "./outbox";
import type { Sealer } from "./secrets";
import type { TransferFile } from "./transfer";
import type { Actor, CmsDoc, CollectionConfig, FieldAdmin, WebhookEvent } from "./types";

export type CmsEvent = OutEvent;

export interface PluginRouteArgs<Cms = unknown> {
  req: Request;
  /** Who is calling, after the session or key check (may be anonymous: check it). */
  actor: Actor;
  /** Path segments after the plugin's name. */
  path: string[];
  url: URL;
  cms: Cms;
}

export interface PluginTool<Cms = unknown> {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  /** Scope a key needs. People need the matching permission on some collection. Default `read`. */
  scope?: "read" | "write" | "publish" | "admin";
  run(actor: Actor, input: any, cms: Cms): unknown | Promise<unknown>;
}

export interface PluginNav {
  label: string;
  href: string;
  /** Only for admins. Default false. */
  admin?: boolean;
}

/** The collection hooks a plugin can add (the same as a collection's `hooks`). */
export type PluginHooks = NonNullable<CollectionConfig["hooks"]>;
export type PluginHookName = keyof PluginHooks;
export type PluginHookFn<K extends PluginHookName> = NonNullable<PluginHooks[K]>[number];

/** One URL of `sitemap.xml`. */
export interface SitemapEntry {
  loc: string;
  lastmod: string;
  alternates?: { hreflang: string; href: string }[];
}

/** A mail the CMS's own sign-in sends (invites, password resets). */
export interface PluginMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Filters: a value on its way out goes through every plugin's function for that name, lowest
 * `priority` first, and each returns the value (changed or not). A filter that throws is skipped
 * (the value goes on as it was) and the error goes to `onError`.
 */
export interface PluginFilters {
  /** The URLs of `sitemap.xml`, before it is written (add pages the CMS does not hold, drop some). */
  "sitemap.entries": { value: SitemapEntry[]; ctx: { origin: string } };
  /** A document REST sends (`GET /collections/:c/:slug`, lists, singles), after `afterRead`. */
  "rest.doc": { value: CmsDoc; ctx: { actor: Actor; draft: boolean; list: boolean } };
  /** What a tool returns, to MCP and to `callTool` alike. */
  "mcp.result": { value: unknown; ctx: { tool: string; actor: Actor } };
  /** Each file of an export (`GET /export`, `npx @mainsoft/agent-cms export`). */
  "export.file": { value: TransferFile; ctx: { actor: Actor } };
  /** A mail of the CMS's own sign-in, before it goes to `sendMail`. */
  "mail.message": { value: PluginMail; ctx: { kind: "invite" | "reset" } };
}
export type PluginFilterName = keyof PluginFilters;

/** What a plugin's access rule is asked. Return false to refuse; it can only narrow what the CMS allows. */
export interface PluginAccessQuery {
  actor: Actor;
  collection: string;
  op: "read" | "write" | "publish" | "delete";
  /** The document, when the check is about one. */
  doc?: CmsDoc | null;
}

/** Small values a plugin keeps (JSON, up to 64 KB each, keys up to 200 characters). */
export interface PluginStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Keys that start with `prefix`, with their values, oldest first (up to 500). */
  list<T = unknown>(prefix?: string): Promise<{ key: string; value: T }[]>;
}

export interface PluginContext<Cms = unknown> {
  /** The CMS the plugin was given to. Use it inside handlers and `start`, not during `setup`. */
  cms: Cms;
  /** This plugin's name. */
  name: string;
  /** Listen to an event (or `"*"` for all). Runs after the write, never blocks it; errors go to `onError`. */
  on(event: WebhookEvent | "*", fn: (e: CmsEvent) => void | Promise<void>): void;
  /** A route at `/api/cms/<plugin name>/<path>`. `path` is matched as a prefix; `""` is the plugin root. */
  route(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, handler: (a: PluginRouteArgs<Cms>) => Response | Promise<Response>): void;
  tool(tool: PluginTool<Cms>): void;
  /** A kind of background job. Its full name is `<plugin name>.<kind>`; `enqueue` takes the short one. */
  job<P = Record<string, unknown>>(kind: string, def: JobKind<P>): void;
  enqueue(kind: string, payload?: Record<string, unknown>, o?: { runAt?: Date | string }): Promise<unknown>;
  /** Values added to `GET /_me` under `plugins.<plugin name>` (what the admin screens read). */
  me(fn: (actor: Actor) => Record<string, unknown> | Promise<Record<string, unknown>>): void;
  /** A menu entry the admin shell shows (`_me.nav`). */
  nav(item: PluginNav): void;
  /** Seal and open values kept in the database. Null without `secretsKey`. */
  secrets: Sealer | null;

  // ── 0.23.0 ──
  /**
   * A collection hook (the names of a collection's `hooks`), for every collection or the ones in
   * `collections`. Runs after the collection's own hooks, in plugin order. Throwing in a `before*`
   * hook refuses the change (`hook_rejected`); errors in `after*` hooks go to `onError`.
   */
  hook<K extends PluginHookName>(name: K, fn: PluginHookFn<K>, o?: { collections?: readonly string[] }): void;
  /** A collection of the plugin's own (form entries, redirects, ...). Its name must be free. */
  collection(c: CollectionConfig<any, string>): void;
  /** A field added to a collection of the app (`fields.<key>`). The key must be free. */
  field(collection: string, key: string, schema: ZodTypeAny, admin?: FieldAdmin): void;
  /** An action automations can run. Its name is `<plugin name>.<name>`. */
  automationAction(name: string, def: { label: string; run: AutomationFn }): void;
  /** A filter: change a value on its way out (see `PluginFilters`). Lower `priority` runs first; default 10. */
  filter<K extends PluginFilterName>(name: K, fn: (value: PluginFilters[K]["value"], ctx: PluginFilters[K]["ctx"]) => PluginFilters[K]["value"] | Promise<PluginFilters[K]["value"]>, o?: { priority?: number }): void;
  /**
   * An access rule on top of the CMS's (roles, `access`, keys): return false to refuse. It can
   * only narrow: what the CMS refuses stays refused. Runs on every check, so keep it fast and
   * synchronous. System actors (jobs, automations) are not asked.
   */
  access(rule: (q: PluginAccessQuery) => boolean, o?: { collections?: readonly string[] }): void;
  /** Small values the plugin keeps in the database (`cms_records`, kind `plugin:<name>`). */
  store: PluginStore;
  /** The plugin's settings (its `settings` schema, saved on the admin screen), checked. Read it in `start` or handlers. */
  settings<T = Record<string, unknown>>(): T;
  /** A line for your logs and metrics: goes to `onEvent` as `{ type: "plugin", plugin, level, message, data }`. */
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
}

export interface CmsPlugin<Cms = any, O = any> {
  name: string;
  /** The plugin's own version, shown in `cms.plugins.list()`. */
  version?: string;
  /** Versions of `@mainsoft/agent-cms` it works with, as a semver range (`">=0.23"`, `"^0.23.0"`). Checked by `createCms`. */
  engine?: string;
  /** Part of the CMS itself (`webhooks`, `automations`); turned off with `createCms({ builtins })`. Not for your plugins. */
  builtin?: boolean;
  /** Plugins this one needs, by name. They are set up and started first; when one is missing or off, this one is off too. */
  requires?: readonly string[];
  /** When it cannot start, stop the CMS (every request answers 503 `plugin_failed`) instead of going on without it. */
  required?: boolean;
  /**
   * Settings people change on the admin screen (`PUT /plugins/:name/settings`), checked with this
   * schema when the plugin starts: a missing required setting makes the start fail. Values whose
   * schema has `.describe("secret")` are sealed with `secretsKey` and never sent back whole.
   */
  settings?: z.ZodObject<z.ZodRawShape>;
  /** SQL the plugin's tables need, in order. Every statement must be safe to run again (`IF NOT EXISTS`). The CMS does not run it: `cms.plugins.sql` collects it for your migrations. */
  sql?: readonly string[];
  /** Registers what the plugin adds. Runs inside `createCms`, synchronously. */
  setup(ctx: PluginContext<Cms>, options: O): void;
  /** Runs once before the first request is answered (and again on a restart). Keep it short on serverless hosts: it runs on every cold start. */
  start?(ctx: PluginContext<Cms>, options: O): void | Promise<void>;
  /** Runs on `cms.close()` and before a restart. */
  stop?(): void | Promise<void>;
}

/** A plugin defined with `options`: call it with the options, or give it as is for the defaults. */
export interface CmsPluginFactory<Cms = any, I = any> {
  (options?: I): CmsPlugin<Cms>;
  readonly pluginName: string;
}

/** What `createCms({ plugins })` takes. */
export type PluginInput<Cms = any> = CmsPlugin<Cms> | CmsPluginFactory<Cms>;

export interface PluginDefinition<Cms, S extends z.ZodTypeAny> extends Omit<CmsPlugin<Cms, z.output<S>>, "setup" | "start"> {
  /** The options' schema. Checked (and defaults filled in) when the plugin is called with them. */
  options: S;
  setup(ctx: PluginContext<Cms>, options: z.output<S>): void;
  start?(ctx: PluginContext<Cms>, options: z.output<S>): void | Promise<void>;
}

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,30}$/;

function checkName(name: string) {
  if (!PLUGIN_NAME.test(name)) throw new Error(`[agent-cms] plugin name "${name}" must be lowercase letters, digits and dashes (2 to 31 characters)`);
}

export function definePlugin<Cms = any, S extends z.ZodTypeAny = z.ZodTypeAny>(plugin: PluginDefinition<Cms, S>): CmsPluginFactory<Cms, z.input<S>>;
export function definePlugin<Cms = any>(plugin: CmsPlugin<Cms, undefined>): CmsPlugin<Cms>;
export function definePlugin(plugin: CmsPlugin | PluginDefinition<unknown, z.ZodTypeAny>): CmsPlugin | CmsPluginFactory {
  checkName(plugin.name);
  if (plugin.engine !== undefined && !parseRange(plugin.engine)) throw new Error(`[agent-cms] plugin ${plugin.name}: engine "${plugin.engine}" is not a version range`);
  if (!("options" in plugin) || !plugin.options) return plugin as CmsPlugin;
  const def = plugin as PluginDefinition<unknown, z.ZodTypeAny>;
  const factory = (input?: unknown): CmsPlugin => {
    const r = def.options.safeParse(input ?? {});
    if (!r.success) {
      const issues = r.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "options"}: ${i.message}`).join("; ");
      throw new Error(`[agent-cms] plugin ${def.name}: options are not valid (${issues})`);
    }
    const options = r.data;
    const { options: _schema, setup, start, ...rest } = def;
    void _schema;
    return { ...rest, setup: (ctx) => setup(ctx, options), start: start ? (ctx) => start(ctx, options) : undefined };
  };
  return Object.assign(factory, { pluginName: def.name });
}

/** The plugin itself, with the defaults filled in when it was given without its options. */
export function pluginOf(p: PluginInput): CmsPlugin {
  return typeof p === "function" ? p() : p;
}

export interface PluginRoute {
  plugin: string;
  method: string;
  path: string[];
  handler: (a: PluginRouteArgs<any>) => Response | Promise<Response>;
}

export type PluginState = "starting" | "running" | "failed" | "off";

/** One plugin as `cms.plugins.list()` and `GET /plugins` show it. */
export interface PluginInfo {
  name: string;
  /** Part of the CMS (`webhooks`, `automations`). */
  builtin: boolean;
  version: string | null;
  engine: string | null;
  requires: string[];
  required: boolean;
  /**
   * `running`: started (or nothing to start). `starting`: before the first request, or during a
   * restart. `failed`: its `start` threw or took too long. `off`: a plugin it needs is missing or
   * not running.
   */
  state: PluginState;
  error: string | null;
  /** How long its last `start` took. */
  startedMs: number | null;
  startedAt: string | null;
  registered: { routes: number; tools: number; events: number; jobs: number; nav: number; me: number; sql: number; hooks: number; collections: number; fields: number; actions: number; filters: number; access: number };
  /** Its settings schema's keys, when it has one (`GET /plugins/:name/settings` has the values). */
  settings: string[] | null;
}

// ── engine versions (a small semver range check, enough for `engine`) ─────

type Ver = [number, number, number];
type Cmp = { op: "<" | "<=" | ">" | ">=" | "="; v: Ver };

function parseVer(s: string): { v: Ver; parts: number } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim());
  if (!m) return null;
  const raw = [m[1], m[2], m[3]];
  let parts = 0;
  for (const p of raw) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts++;
  }
  const v = raw.map((p, i) => (i < parts ? Number(p) : 0)) as Ver;
  return { v, parts };
}

const cmp = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function upper(v: Ver, parts: number, caret: boolean): Ver {
  if (caret) {
    if (v[0] > 0 || parts <= 1) return [v[0] + 1, 0, 0];
    if (v[1] > 0 || parts <= 2) return [0, v[1] + 1, 0];
    return [0, 0, v[2] + 1];
  }
  // tilde, or a partial version ("0.23", "1.x")
  return parts <= 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0];
}

function parseSet(set: string): Cmp[] | null {
  const out: Cmp[] = [];
  for (const tok of set.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(tok)!;
    const op = m[1] ?? "";
    if (m[2] === "*" || m[2] === "x" || m[2] === "") {
      if (op && op !== "=" && m[2] === "") return null;
      continue;
    }
    const p = parseVer(m[2]);
    if (!p) return null;
    if (op === "^" || op === "~") out.push({ op: ">=", v: p.v }, { op: "<", v: upper(p.v, p.parts, op === "^") });
    else if (op === "" || op === "=") {
      if (p.parts === 3) out.push({ op: "=", v: p.v });
      else if (p.parts > 0) out.push({ op: ">=", v: p.v }, { op: "<", v: upper(p.v, p.parts, false) });
    } else if (op === ">" && p.parts < 3) out.push({ op: ">=", v: upper(p.v, Math.max(p.parts, 1), false) });
    else if (op === "<=" && p.parts < 3) out.push({ op: "<", v: upper(p.v, Math.max(p.parts, 1), false) });
    else out.push({ op: op as Cmp["op"], v: p.v });
  }
  return out;
}

function parseRange(range: string): Cmp[][] | null {
  const sets = range.split("||").map(parseSet);
  return sets.some((s) => s === null) ? null : (sets as Cmp[][]);
}

/** Whether a version is in a semver range (`>=`, `<`, `^`, `~`, `x`, partial versions, `||`). Prerelease tags are ignored. */
export function versionSatisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  const sets = parseRange(range);
  if (!v || !sets) return false;
  return sets.some((set) =>
    set.every(({ op, v: w }) => {
      const c = cmp(v.v, w);
      return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === ">=" ? c >= 0 : c === 0;
    }),
  );
}
