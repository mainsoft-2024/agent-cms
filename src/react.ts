/**
 * `@mainsoft/agent-cms/react` (0.24.0): admin plugins for React.
 *
 *   // my-plugin/admin.tsx
 *   import { defineAdminPlugin, useCmsAdmin } from "@mainsoft/agent-cms/react";
 *   export const statsAdmin = defineAdminPlugin({
 *     name: "stats",
 *     label: { en: "Read counts", ko: "읽은 수 통계" },
 *     pages: { "": StatsPage },
 *     slots: { editorActions: (ctx) => <ReadsBadge slug={ctx.slug} /> },
 *   });
 *
 *   // the app's admin frame
 *   <CmsProvider plugins={[statsAdmin]}>…</CmsProvider>
 *
 * The admin screens (`npx @mainsoft/agent-cms add`) read the merged slots and plugin
 * pages through this module, so plugin packages and the app must share one React and
 * one copy of this package (`npx @mainsoft/agent-cms doctor` checks the React one).
 * React is an optional peer dependency: only this entry needs it.
 */

import * as React from "react";
import type { AssetDetail, Me, RestClient } from "./client";
import type { DocLike } from "./diff";
import { checkAdminPlugin, createAdminRuntime, type AdminNavItem, type AdminRuntime, type AdminText } from "./admin";

export { MULTI_SLOTS, SINGLE_SLOTS, LIST_SLOTS, pickText, type AdminSidePart, type AdminNavItem, type AdminText, type AdminPageMatch } from "./admin";

// ── what slots get (the admin screens give these) ────────────────────────────

/** 0.21.0: `seo` in collections with search engine details. */
export type DocContent = DocLike & { seo?: { title?: string | null; description?: string | null; image?: string | null; canonical?: string | null; noindex?: boolean } | null };

/** What editor slots get: the document as it is on screen, and ways to change it (the person still saves). */
export interface EditorSlotContext {
  collection: string;
  /** null while the document is new. */
  slug: string | null;
  content: DocContent;
  /** Merge a change into the form (marks the document as changed). */
  setContent: (patch: Partial<DocContent>) => void;
  /** Put markdown at the cursor in the body. */
  insertMarkdown: (markdown: string) => void;
  version: number | null;
  published: boolean;
  readOnly: boolean;
  /**
   * 0.26.0: read the document again after the plugin changed it through the API. Unsaved edits on
   * screen are kept: changes that do not overlap are merged in; overlapping ones open the merge
   * screen when the person saves.
   */
  reload: () => Promise<void>;
}

/** 0.26.0: what an `editorSide` panel gets. */
export interface EditorSideContext extends EditorSlotContext {
  /** Close the panel. */
  close: () => void;
  /** True on a phone: the panel covers the screen. */
  mobile: boolean;
}

/** 0.26.0: a panel beside the document editor, opened with a button in the editor's header. */
export interface EditorSide {
  /** The button's name (and the panel's title for screen readers). */
  label: AdminText;
  /** An icon for the button (about 16px). Without it the button shows the label. */
  icon?: React.ReactNode;
  render: (ctx: EditorSideContext) => React.ReactNode;
}

/** What `slots.localeAction` gets (0.22.0). */
export interface LocaleSlotContext {
  collection: string;
  /** The source document's slug. */
  slug: string;
  /** The language on screen and the source's. */
  locale: string;
  defaultLocale: string;
  /** How this language stands: `missing` before it is started. */
  status: "missing" | "outdated" | "current";
  /** The translation's working copy on screen (null while missing), and a way to change it (the person still saves). */
  content: DocContent | null;
  setContent: ((patch: Partial<DocContent>) => void) | null;
  /** Load the languages and the document again (after the plugin wrote through the API). */
  reload: () => void;
  readOnly: boolean;
}

/** Slots a plugin can fill. Several plugins in one slot show side by side, the app's first. */
export interface AdminPluginSlots {
  /** Next to a file's alt text field in the media library. `setAlt` fills the field (the person still saves it). */
  assetAlt?: (asset: AssetDetail, o: { setAlt: (alt: string) => void }) => React.ReactNode;
  /** Buttons in the document editor's header, before Save. */
  editorActions?: (ctx: EditorSlotContext) => React.ReactNode;
  /** A panel under the fields in the document editor. */
  editorPanel?: (ctx: EditorSlotContext) => React.ReactNode;
  /** Next to a field's input in the editor's form. */
  fieldAddon?: (field: { key: string; label: string; widget: string }, ctx: EditorSlotContext & { value: unknown; setValue: (v: unknown) => void }) => React.ReactNode;
  /**
   * 0.26.0: a panel beside the editor (about 380px wide; the whole screen on a phone), opened and
   * closed with a button in the editor's header. One panel is open at a time.
   */
  editorSide?: EditorSide | readonly EditorSide[];
  /** Next to "Start translation" and in a translation's status bar. */
  localeAction?: (ctx: LocaleSlotContext) => React.ReactNode;
}

// ── plugin pages ─────────────────────────────────────────────────────────────

export interface PluginPageProps {
  /** The plugin's name. */
  plugin: string;
  /** The path after `/admin/p/<plugin>/`, in parts. */
  path: string[];
  /** Values of `:name` parts of the page key. */
  params: Record<string, string>;
}

export interface AdminPlugin {
  /** The same name as the server plugin (`definePlugin({ name })`). */
  name: string;
  /** A name people read (menu and page header): text, or text by language. Default: the name. */
  label?: AdminText;
  slots?: AdminPluginSlots;
  /** Pages under `/admin/p/<name>`: `""` is the first page, `"items/:id"` takes a parameter. */
  pages?: Record<string, React.ComponentType<PluginPageProps>>;
  /** Menu entries. Default: one for the `""` page when there is one. */
  nav?: AdminNavItem[];
  /** Strings by language, read with `usePluginT()`. */
  messages?: Record<string, Record<string, string>>;
}

/** Declare the admin half of a plugin. Checks its shape at once (a clear error, not a blank screen). */
export function defineAdminPlugin<const P extends AdminPlugin>(plugin: P): P {
  return checkAdminPlugin(plugin);
}

// ── the runtime and what plugin components read ──────────────────────────────

export type ReactAdminRuntime = AdminRuntime<React.ReactNode, React.ComponentType<PluginPageProps>>;

export interface CmsAdminValue {
  client: RestClient;
  /** `GET /_me` (null while loading). */
  me: Me | null;
  reloadMe: () => void;
  /** The language of the admin's strings ("en", "ko"). */
  locale: string;
  /** Where the CMS route is mounted ("/api/cms"). */
  baseUrl: string;
  /** Where the admin pages live ("/admin"). */
  basePath: string;
  appUrl: string;
  /** A short message at the bottom of the screen. */
  toast: (message: string, o?: { tone?: "ok" | "error" | "info"; action?: { label: string; run: () => void | Promise<void> }; duration?: number }) => number;
  runtime: ReactAdminRuntime;
}

const CmsAdminContext = React.createContext<CmsAdminValue | null>(null);

/** Given by the admin's `CmsProvider`; plugin components read it with `useCmsAdmin()`. */
export function CmsAdminProvider({ value, children }: { value: CmsAdminValue; children?: React.ReactNode }) {
  return React.createElement(CmsAdminContext.Provider, { value }, children);
}

/** The REST client, `_me`, language, toast and runtime, inside the admin. */
export function useCmsAdmin(): CmsAdminValue {
  const v = React.useContext(CmsAdminContext);
  if (!v)
    throw new Error(
      "agent-cms: useCmsAdmin() needs the admin's <CmsProvider> (0.24.0 or later: `npx @mainsoft/agent-cms add --update`). If it is there, the app and the plugin load two copies of React or of @mainsoft/agent-cms: run `npx @mainsoft/agent-cms doctor`."
    );
  return v;
}

/** The runtime when there is one (null outside the admin): for screens that work with and without plugins. */
export function useAdminRuntime(): ReactAdminRuntime | null {
  return React.useContext(CmsAdminContext)?.runtime ?? null;
}

/** A plugin's strings in the admin's language: `const t = usePluginT("stats"); t("title")`. */
export function usePluginT(plugin: string): (key: string, vars?: Record<string, string | number>) => string {
  const { runtime, locale } = useCmsAdmin();
  return React.useCallback((key: string, vars?: Record<string, string | number>) => runtime.t(plugin, locale, key, vars), [runtime, locale, plugin]);
}

/** 0.24.1: a plugin's slot part that throws while rendering is left out; the rest of the screen stays. */
class SlotBoundary extends React.Component<{ report: (err: unknown) => void; children?: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    this.props.report(err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
// Keyed by plugin and slot: when another plugin's part drops out, a failed boundary is not handed to a neighbour.
const wrap = (node: React.ReactNode, o: { plugin: string; slot: string; report: (err: unknown) => void }): React.ReactNode =>
  React.createElement(SlotBoundary, { key: `plugin:${o.plugin}:${o.slot}`, report: o.report }, node);

const combine = (parts: React.ReactNode[]): React.ReactNode =>
  React.createElement(React.Fragment, null, ...parts.map((p, i) => React.createElement(React.Fragment, { key: React.isValidElement(p) && p.type === SlotBoundary && p.key != null ? p.key : `app:${i}` }, p)));

/** Build the runtime once per set of plugins and slots (what `CmsProvider` calls). */
export function useCreateAdminRuntime(o: { plugins?: readonly AdminPlugin[]; slots?: object; basePath?: string }): ReactAdminRuntime {
  const { plugins, slots, basePath } = o;
  return React.useMemo(
    () => createAdminRuntime<React.ReactNode, React.ComponentType<PluginPageProps>>({ plugins: plugins as AdminPlugin[] | undefined, slots: slots as Record<string, unknown> | undefined, combine, wrap, basePath }),
    [plugins, slots, basePath]
  );
}

/** Without a hook (tests, other frameworks' bridges). */
export function createReactAdminRuntime(o: { plugins?: readonly AdminPlugin[]; slots?: object; basePath?: string }): ReactAdminRuntime {
  return createAdminRuntime<React.ReactNode, React.ComponentType<PluginPageProps>>({ plugins: o.plugins as AdminPlugin[] | undefined, slots: o.slots as Record<string, unknown> | undefined, combine, wrap, basePath: o.basePath });
}
