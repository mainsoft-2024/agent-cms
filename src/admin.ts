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
  slots?: { [K in MultiSlotName]?: (...args: any[]) => N } & { [K in SingleSlotName]?: unknown };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /**
   * Pages by path under `/admin/p/<plugin>`: `""` is the plugin's first page; `"items/:id"`
   * takes a parameter. The first matching key wins, longer paths first.
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
  for (const k of Object.keys(p.slots ?? {}))
    if (!(MULTI_SLOTS as readonly string[]).includes(k) && !(SINGLE_SLOTS as readonly string[]).includes(k))
      throw new Error(`[agent-cms] admin plugin "${p.name}": unknown slot "${k}" (slots: ${[...MULTI_SLOTS, ...SINGLE_SLOTS].join(", ")})`);
  for (const key of Object.keys(p.pages ?? {}))
    if (key !== "" && !/^(?:[a-z0-9_-]+|:[a-zA-Z_][a-zA-Z0-9_]*)(?:\/(?:[a-z0-9_-]+|:[a-zA-Z_][a-zA-Z0-9_]*))*$/.test(key))
      throw new Error(`[agent-cms] admin plugin "${p.name}": page "${key}" is not a path like "", "settings" or "items/:id"`);
  return p;
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
    const parts: { from: string; fn: (...a: unknown[]) => N }[] = [];
    if (typeof app[name] === "function") parts.push({ from: "app", fn: app[name] as (...a: unknown[]) => N });
    for (const p of plugins) {
      const fn = p.slots?.[name];
      if (typeof fn === "function") parts.push({ from: p.name, fn });
    }
    if (parts.length === 0) delete slots[name];
    else if (parts.length === 1 && parts[0].from === "app") slots[name] = parts[0].fn;
    else
      slots[name] = (...args: unknown[]) =>
        o.combine(
          parts.flatMap(({ from, fn }) => {
            if (from === "app") return [fn(...args)];
            // A plugin's slot that throws is left out; the app's and the others still show.
            try {
              return [fn(...args)];
            } catch (err) {
              report(err, `admin plugin ${from}: slot ${name}`);
              return [];
            }
          })
        );
  }
  for (const name of SINGLE_SLOTS) {
    if (app[name] !== undefined) continue;
    const from = plugins.find((p) => p.slots?.[name] !== undefined);
    if (from) slots[name] = from.slots![name];
  }

  // Pages: literal segments beat parameters; longer keys first.
  const pageTable = plugins.map((p) => ({
    plugin: p.name,
    pages: Object.entries(p.pages ?? {})
      .map(([key, page]) => ({ key, page, parts: key ? key.split("/") : [] }))
      .sort((a, b) => b.parts.length - a.parts.length || a.parts.filter((x) => x.startsWith(":")).length - b.parts.filter((x) => x.startsWith(":")).length),
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
