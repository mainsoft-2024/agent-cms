/**
 * `@mainsoft/agent-cms/admin` (0.24.0): the admin runtime without a UI framework.
 *
 * An admin plugin is the browser half of a plugin: buttons in the admin's slots, pages
 * under `/admin/p/<plugin>/…`, menu entries and its own strings. This file merges what
 * plugins bring (in the order given, after the app's own) and finds a page for a path.
 * It knows nothing about React: the framework binding (`@mainsoft/agent-cms/react`) gives
 * the node and component types and a `combine` that puts several slot outputs together.
 */

/** Slots where every plugin adds its part (the app's first, then plugins in order). */
export const MULTI_SLOTS = ["assetAlt", "editorActions", "editorPanel", "fieldAddon", "localeAction"] as const;
export type MultiSlotName = (typeof MULTI_SLOTS)[number];
/** Slots that hold one thing: the app's wins, else the first plugin's. */
export const SINGLE_SLOTS = ["blockEditor"] as const;
export type SingleSlotName = (typeof SINGLE_SLOTS)[number];

/**
 * 0.26.0: slots where each part stays separate (the screen shows one at a time): the app's first,
 * then plugins in order. Each part is `{ label, icon?, render }`; the runtime gives a list.
 */
export const LIST_SLOTS = ["editorSide"] as const;
export type ListSlotName = (typeof LIST_SLOTS)[number];

/** One part of a list slot, as the runtime gives it. `plugin` is null for the app's own. */
export interface AdminSidePart<N = unknown> {
  plugin: string | null;
  /** A key for the screen (`app` or the plugin's name, with a number when one brings several). */
  key: string;
  label: AdminText;
  icon?: N;
  render: (...args: unknown[]) => N;
}

/** Text in one language, or by language (`{ en: "Stats", ko: "통계" }`). */
export type AdminText = string | Record<string, string>;

export interface AdminNavItem {
  label: AdminText;
  /** Path under the plugin's pages (`""` is `/admin/p/<plugin>`). Default `""`. */
  path?: string;
  /** Only for admins. Default false. */
  admin?: boolean;
}

/** The framework-free shape of an admin plugin. `N` is a rendered node, `P` a page component. */
export interface AdminPluginShape<N = unknown, P = unknown> {
  /** The same name as the server plugin (`definePlugin({ name })`). */
  name: string;
  /** A name people read (the menu and the page header). Default: the name. */
  label?: AdminText;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  slots?: { [K in MultiSlotName]?: (...args: any[]) => N } & { [K in SingleSlotName]?: unknown } & { [K in ListSlotName]?: unknown };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /**
   * Pages by path under `/admin/p/<plugin>`: `""` is the plugin's first page; `"items/:id"`
   * takes a parameter. Where two keys fit a path, the one with a fixed word at the first part
   * where they differ wins (`items/:id` beats `:kind/edit` for `items/edit`).
   */
  pages?: Record<string, P>;
  /** Menu entries. Default: one entry for the `""` page when there is one. */
  nav?: AdminNavItem[];
  /** The plugin's strings by language: `{ en: { title: "Stats" }, ko: { title: "통계" } }`. */
  messages?: Record<string, Record<string, string>>;
}

export interface AdminRuntimeOptions<N, P> {
  plugins?: readonly AdminPluginShape<N, P>[];
  /** The app's own slots (they come first). */
  slots?: Record<string, unknown>;
  /** Put several slot outputs together (React: a fragment with keys). */
  combine: (parts: N[]) => N;
  /** Where the admin lives. Default "/admin". */
  basePath?: string;
  /** Called when a plugin's slot throws (the other parts still show). Default `console.error`. */
  onError?: (err: unknown, where: string) => void;
  /**
   * 0.24.1: wrap each plugin's slot output, so a part that fails later (React: while it renders)
   * is left out too. `report` sends the error to `onError`. The app's own parts are not wrapped.
   */
  wrap?: (node: N, o: { plugin: string; slot: string; report: (err: unknown) => void }) => N;
}

export interface AdminPageMatch<P> {
  plugin: string;
  page: P;
  /** The page key that matched (`"items/:id"`). */
  key: string;
  params: Record<string, string>;
}

export interface AdminRuntime<N, P> {
  plugins: readonly AdminPluginShape<N, P>[];
  /** The app's slots with every plugin's merged in. A slot nobody fills is absent. */
  slots: Record<string, unknown>;
  /** The page for `/admin/p/<plugin>/<...path>`, or null. */
  page(plugin: string, path: readonly string[]): AdminPageMatch<P> | null;
  /** Menu entries of every plugin, with their address. */
  nav(o: { locale: string; isAdmin: boolean }): { plugin: string; label: string; href: string }[];
  /** A plugin's string in `locale` (then English, then the key), with `{name}` filled from `vars`. */
  t(plugin: string, locale: string, key: string, vars?: Record<string, string | number>): string;
  /** A plugin's label in `locale`. */
  label(plugin: string, locale: string): string;
  /** `${basePath}/p/<plugin>/<path>`. */
  href(plugin: string, path?: string): string;
}

const NAME = /^[a-z][a-z0-9-]{0,47}$/;

/** Pick the text for a language: exact, then its base (`ko` for `ko-KR`), then English, then any. */
export function pickText(text: AdminText | undefined, locale: string, fallback = ""): string {
  if (text === undefined) return fallback;
  if (typeof text === "string") return text;
  return text[locale] ?? text[locale.split("-")[0]] ?? text.en ?? Object.values(text)[0] ?? fallback;
}

/** Check an admin plugin's shape (throws a clear error). Returns it unchanged. */
export function checkAdminPlugin<T extends AdminPluginShape>(p: T): T {
  if (!p || typeof p !== "object") throw new Error("[agent-cms] admin plugin: expected an object from defineAdminPlugin({ name, ... })");
  if (!NAME.test(p.name ?? "")) throw new Error(`[agent-cms] admin plugin "${p.name}": the name must be lowercase letters, digits and dashes (the server plugin's name)`);
  const all = [...MULTI_SLOTS, ...SINGLE_SLOTS, ...LIST_SLOTS] as readonly string[];
  for (const k of Object.keys(p.slots ?? {})) {
    if (!all.includes(k)) throw new Error(`[agent-cms] admin plugin "${p.name}": unknown slot "${k}" (slots: ${all.join(", ")})`);
    if ((LIST_SLOTS as readonly string[]).includes(k)) listParts((p.slots as Record<string, unknown>)[k], `admin plugin "${p.name}": slot ${k}`);
  }
  for (const key of Object.keys(p.pages ?? {}))
    if (key !== "" && !/^(?:[a-z0-9_-]+|:[a-zA-Z_][a-zA-Z0-9_]*)(?:\/(?:[a-z0-9_-]+|:[a-zA-Z_][a-zA-Z0-9_]*))*$/.test(key))
      throw new Error(`[agent-cms] admin plugin "${p.name}": page "${key}" is not a path like "", "settings" or "items/:id"`);
  return p;
}

/** A list slot's value: one `{ label, render }` or several. Throws a clear error on another shape. */
function listParts(v: unknown, where: string): { label: AdminText; icon?: unknown; render: (...a: unknown[]) => unknown }[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  for (const x of list) {
    const o = x as { label?: unknown; render?: unknown } | null;
    if (!o || typeof o.render !== "function" || (typeof o.label !== "string" && (typeof o.label !== "object" || o.label === null)))
      throw new Error(`[agent-cms] ${where}: expected { label, render } (or a list of them)`);
  }
  return list as { label: AdminText; icon?: unknown; render: (...a: unknown[]) => unknown }[];
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

export function createAdminRuntime<N, P>(o: AdminRuntimeOptions<N, P>): AdminRuntime<N, P> {
  const plugins = [...(o.plugins ?? [])].map(checkAdminPlugin);
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.name)) throw new Error(`[agent-cms] admin plugin "${p.name}" is given twice`);
    seen.add(p.name);
  }
  const base = (o.basePath ?? "/admin").replace(/\/+$/, "");
  const report = o.onError ?? ((err: unknown, where: string) => console.error(`[agent-cms] ${where}:`, err));
  const app = o.slots ?? {};
  const slots: Record<string, unknown> = { ...app };

  for (const name of MULTI_SLOTS) {
    // `from: null` is the app's own part (a plugin may well be called "app").
    const parts: { from: string | null; fn: (...a: unknown[]) => N }[] = [];
    if (typeof app[name] === "function") parts.push({ from: null, fn: app[name] as (...a: unknown[]) => N });
    for (const p of plugins) {
      const fn = p.slots?.[name];
      if (typeof fn === "function") parts.push({ from: p.name, fn });
    }
    if (parts.length === 0) delete slots[name];
    else if (parts.length === 1 && parts[0].from === null) slots[name] = parts[0].fn;
    else
      slots[name] = (...args: unknown[]) =>
        o.combine(
          parts.flatMap(({ from, fn }) => {
            if (from === null) return [fn(...args)];
            // A plugin's slot that throws is left out; the app's and the others still show.
            try {
              const node = fn(...args);
              return [o.wrap ? o.wrap(node, { plugin: from, slot: name, report: (err) => report(err, `admin plugin ${from}: slot ${name}`) }) : node];
            } catch (err) {
              report(err, `admin plugin ${from}: slot ${name}`);
              return [];
            }
          })
        );
  }
  for (const name of LIST_SLOTS) {
    const out: AdminSidePart<N>[] = [];
    const add = (from: string | null, v: unknown) => {
      const parts = listParts(v, from === null ? `slot ${name}` : `admin plugin "${from}": slot ${name}`);
      parts.forEach((part, i) => {
        // The app's and a plugin's never collide (a plugin may well be called "app").
        const key = `${from === null ? "app" : `p:${from}`}${parts.length > 1 ? `:${i + 1}` : ""}`;
        const where = `admin plugin ${from}: slot ${name}`;
        const render =
          from === null
            ? (part.render as (...a: unknown[]) => N)
            : (...args: unknown[]) => {
                try {
                  const node = part.render(...args) as N;
                  return o.wrap ? o.wrap(node, { plugin: from, slot: name, report: (err) => report(err, where) }) : node;
                } catch (err) {
                  report(err, where);
                  return o.combine([]);
                }
              };
        out.push({ plugin: from, key, label: part.label, icon: part.icon as N | undefined, render });
      });
    };
    add(null, app[name]);
    for (const p of plugins) add(p.name, (p.slots as Record<string, unknown> | undefined)?.[name]);
    if (out.length) slots[name] = out;
    else delete slots[name];
  }
  for (const name of SINGLE_SLOTS) {
    if (app[name] !== undefined) continue;
    const from = plugins.find((p) => p.slots?.[name] !== undefined);
    if (from) slots[name] = from.slots![name];
  }

  // Pages: only keys with as many parts as the path can match. Among those, 0.24.1: the first
  // part that differs decides, a fixed word beating a parameter (`items/:id` before `:kind/edit`
  // for `items/edit`), whatever order the keys were written in.
  const isParam = (x: string) => x.startsWith(":");
  const specific = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (isParam(a[i]) !== isParam(b[i])) return isParam(a[i]) ? 1 : -1;
    return 0;
  };
  const pageTable = plugins.map((p) => ({
    plugin: p.name,
    pages: Object.entries(p.pages ?? {})
      .map(([key, page]) => ({ key, page, parts: key ? key.split("/") : [] }))
      .sort((a, b) => b.parts.length - a.parts.length || specific(a.parts, b.parts)),
  }));
  const byName = new Map(plugins.map((p) => [p.name, p]));

  const href = (plugin: string, path = "") => `${base}/p/${plugin}${path ? `/${path.replace(/^\/+/, "")}` : ""}`;

  return {
    plugins,
    slots,
    page(plugin, path) {
      const row = pageTable.find((r) => r.plugin === plugin);
      if (!row) return null;
      const segs = path.filter((s) => s !== "");
      for (const { key, page, parts } of row.pages) {
        if (parts.length !== segs.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < parts.length && ok; i++) {
          if (parts[i].startsWith(":")) {
            try {
              params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
            } catch {
              params[parts[i].slice(1)] = segs[i];
            }
          } else ok = parts[i] === segs[i];
        }
        if (ok) return { plugin, page, key, params };
      }
      return null;
    },
    nav({ locale, isAdmin }) {
      const out: { plugin: string; label: string; href: string }[] = [];
      for (const p of plugins) {
        const items = p.nav ?? (p.pages && "" in p.pages ? [{ label: p.label ?? p.name }] : []);
        for (const it of items) if (!it.admin || isAdmin) out.push({ plugin: p.name, label: pickText(it.label, locale, p.name), href: href(p.name, "path" in it ? it.path : "") });
      }
      return out;
    },
    t(plugin, locale, key, vars) {
      const m = byName.get(plugin)?.messages ?? {};
      const s = m[locale]?.[key] ?? m[locale.split("-")[0]]?.[key] ?? m.en?.[key] ?? key;
      return fill(s, vars);
    },
    label(plugin, locale) {
      return pickText(byName.get(plugin)?.label, locale, plugin);
    },
    href,
  };
}
