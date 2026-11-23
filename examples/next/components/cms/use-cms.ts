// agent-cms registry: cms-lib (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The one place the admin screens get their REST client, strings and a few
// small hooks from. Wrap the admin pages once:
//
//   <CmsProvider baseUrl="/api/cms" messages={ko}>{children}</CmsProvider>
"use client";

import * as React from "react";
import { createRestClient, type AssetDetail, type Me, type RestClient } from "@mainsoft/agent-cms/client";
import type { DocLike } from "@mainsoft/agent-cms/diff";
import { createT, en, type CmsMessages, type T } from "./cms-messages";

/** What create / update / autosave take. */
export type DocInputWire = Parameters<RestClient["update"]>[2];

export interface CmsProviderProps {
  /** Where the CMS route is mounted. Default "/api/cms". */
  baseUrl?: string;
  /** UI strings (any subset); e.g. `ko` from ./cms-messages. Default English. */
  messages?: Partial<CmsMessages>;
  /** The app's public origin, for the MCP URL shown to agents. Default: the page's origin. */
  appUrl?: string;
  /** Custom fetch (tests, server-side rendering). */
  fetch?: typeof fetch;
  /** Places where an extension package adds its own controls. An empty slot shows nothing. */
  slots?: CmsSlots;
  children?: React.ReactNode;
}

export interface CmsSlots {
  /** Next to a file's alt text field in the media library. `setAlt` fills the field (the person still saves it). */
  assetAlt?: (asset: AssetDetail, o: { setAlt: (alt: string) => void }) => React.ReactNode;
  /**
   * The block editor for the body (`npx @mainsoft/agent-cms add cms-block-editor`). Without it
   * the body is edited as markdown text. Pass it lazily (next/dynamic or React.lazy): it is large.
   */
  blockEditor?: React.ComponentType<BlockEditorProps>;
  /** 0.17.0: buttons in the document editor's header, before Save (a "Translate" or "Check links" button). */
  editorActions?: (ctx: EditorSlotContext) => React.ReactNode;
  /** 0.17.0: a panel under the fields in the document editor (an SEO score, a social card preview). */
  editorPanel?: (ctx: EditorSlotContext) => React.ReactNode;
  /** 0.17.0: next to a field's input in the editor's form (a "Generate" button, a counter). */
  fieldAddon?: (field: { key: string; label: string; widget: string }, ctx: EditorSlotContext & { value: unknown; setValue: (v: unknown) => void }) => React.ReactNode;
}

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
}

export interface BlockEditorProps {
  /** The body as markdown. */
  value: string;
  /** Called with new markdown, only when the text really changed. */
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  /** Upload a pasted or dropped file; returns the markdown target ("asset:ID/name"). */
  uploadFile?: (file: File) => Promise<string>;
  /** The address to show for a target ("asset:ID/name" → a real URL). */
  resolveFileUrl?: (target: string) => string;
  /** Open the media picker; resolves to markdown for the picked file, or null. */
  onPickMedia?: () => Promise<string | null>;
  /** The screen puts markdown at the cursor through this. */
  insertRef?: React.MutableRefObject<((markdown: string) => void) | null>;
  /** The screen's toolbar runs editing commands through this (0.21.0). */
  commandsRef?: React.MutableRefObject<BlockEditorCommands | null>;
  /** Called when what the toolbar shows may have changed (selection, marks, history). */
  onStateChange?: () => void;
  /** Collections whose documents can be put in as snippets (`[[snippet:key]]`). */
  snippetCollections?: string[];
  id?: string;
  describedBy?: string;
}

/** Commands of the body editor's toolbar, in either mode. `kind` names a block or a mark. */
export type EditorCommand =
  | "undo"
  | "redo"
  | "p"
  | "h2"
  | "h3"
  | "h4"
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "bullet"
  | "number"
  | "todo"
  | "quote"
  | "callout"
  | "table"
  | "codeblock"
  | "hr"
  | "steps"
  | "card"
  | "video"
  | "snippet"
  /** Two columns side by side (`:::columns`). */
  | "columns"
  /** A toggle: a title that opens to show what is inside (`:::toggle`). */
  | "toggle"
  /** An HTML block (`:::html`). */
  | "html";

/** What the block editor offers the toolbar (find and replace included). */
export interface BlockEditorCommands {
  run: (cmd: EditorCommand) => boolean;
  /** Is the command possible here, and is it on (a mark, the current block type)? */
  state: (cmd: EditorCommand) => { enabled: boolean; active: boolean };
  /** Find: highlights matches, returns how many and which one is current (0-based, -1 none). */
  find: (query: string, o: { caseSensitive: boolean; wholeWord: boolean }) => { count: number; current: number };
  /** Move to the next or previous match. */
  findStep: (dir: 1 | -1) => { count: number; current: number };
  /** Replace the current match (and go to the next), or all. Returns how many were replaced. */
  replace: (text: string, all: boolean) => number;
  /** Drop the find highlights. */
  findClear: () => void;
  focus: () => void;
}

export interface CmsContextValue {
  client: RestClient;
  t: T;
  locale: string;
  baseUrl: string;
  appUrl: string;
  /** `GET /_me` (null while loading). */
  me: Me | null;
  meError: unknown;
  reloadMe: () => void;
  slots: CmsSlots;
  /** Show a short message at the bottom of the screen (announced to screen readers). Returns its id. */
  toast: (message: string, o?: ToastOptions) => number;
  /** Take a message away before its time. */
  dismissToast: (id: number) => void;
}

export interface ToastOptions {
  /** "error" stays until closed and is announced at once; "ok" and "info" leave after `duration`. */
  tone?: "ok" | "error" | "info";
  /** One button in the message, e.g. Undo. Pressing it closes the message. */
  action?: { label: string; run: () => void | Promise<void> };
  /** Milliseconds before the message leaves. Default 5000 (8000 with an action, never for errors). */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

const CmsContext = React.createContext<CmsContextValue | null>(null);

// ── theme ────────────────────────────────────────────────────────────────────

export type CmsTheme = "light" | "dark" | "system";
const THEME_KEY = "cms-theme";
/** The theme kept in this browser ("system" when none). */
export function storedTheme(): CmsTheme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
/** Light, dark, or the system's: sets the `dark` class on <html> (Tailwind's dark mode) and keeps the choice. */
export function applyTheme(theme: CmsTheme = storedTheme()): void {
  if (typeof document === "undefined") return;
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", !!dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

const NO_SLOTS: CmsSlots = {};

const LAYER = '[role="dialog"], [role="alertdialog"]';

/**
 * Focus goes back where it was when a dialog closes. The admin opens its dialogs from code (no `DialogTrigger`),
 * and Radix then has nothing to return focus to: it would fall to the page, and the next Tab would start from
 * the top. When the focused element leaves the page and nothing else took focus, the most recent element that
 * had focus and is still there (enabled, and inside the dialog still open on top, if any) gets it back.
 * Base UI returns focus itself; this then does nothing.
 */
function useFocusReturn() {
  React.useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    let seen: HTMLElement[] = [];
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLElement)) return;
      seen = [...seen.filter((x) => x !== e.target && x.isConnected).slice(-19), e.target];
    };
    const mo = new MutationObserver(() => {
      const last = seen[seen.length - 1];
      if (!last || last.isConnected) return;
      const at = document.activeElement;
      if (at && at !== document.body) return;
      const layers = document.querySelectorAll<HTMLElement>(LAYER);
      const top = layers.length ? layers[layers.length - 1] : null;
      for (let i = seen.length - 1; i >= 0; i--) {
        const el = seen[i];
        if (!el.isConnected || (el as HTMLButtonElement).disabled || el.closest("[inert]")) continue;
        if (top ? !top.contains(el) : !!el.closest(LAYER)) continue;
        el.focus({ preventScroll: true });
        return;
      }
    });
    document.addEventListener("focusin", onFocus, true);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      mo.disconnect();
    };
  }, []);
}

export function CmsProvider({ baseUrl = "/api/cms", messages, appUrl, fetch: f, slots = NO_SLOTS, children }: CmsProviderProps) {
  const client = React.useMemo(() => createRestClient({ url: baseUrl, fetch: f }), [baseUrl, f]);
  const t = React.useMemo(() => createT(messages), [messages]);
  const locale = messages?._locale ?? en._locale;
  const [me, setMe] = React.useState<Me | null>(null);
  const [meError, setMeError] = React.useState<unknown>(null);
  const [tick, setTick] = React.useState(0);
  // The theme this browser keeps, and the system's when it changes (for "system").
  React.useEffect(() => {
    applyTheme();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => storedTheme() === "system" && applyTheme("system");
    mq?.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, []);
  useFocusReturn();
  React.useEffect(() => {
    let live = true;
    client.me().then(
      (m) => live && (setMe(m), setMeError(null)),
      (e) => live && setMeError(e)
    );
    return () => {
      live = false;
    };
  }, [client, tick]);
  const origin = appUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const seq = React.useRef(0);
  const dismissToast = React.useCallback((id: number) => setToasts((l) => l.filter((x) => x.id !== id)), []);
  const toast = React.useCallback((message: string, o: ToastOptions = {}) => {
    const id = ++seq.current;
    // Newest last; never more than three at once (the oldest goes first).
    setToasts((l) => [...l.filter((x) => x.message !== message), { ...o, id, message }].slice(-3));
    return id;
  }, []);
  const value = React.useMemo<CmsContextValue>(
    () => ({ client, t, locale, baseUrl, appUrl: origin.replace(/\/+$/, ""), me, meError, reloadMe: () => setTick((n) => n + 1), slots, toast, dismissToast }),
    [client, t, locale, baseUrl, origin, me, meError, slots, toast, dismissToast]
  );
  return React.createElement(CmsContext.Provider, { value }, children, React.createElement(Toaster, { toasts, dismiss: dismissToast, closeLabel: t("close") }));
}

// ── toasts ────────────────────────────────────────────────────────────────────
// A polite live region that always exists (so screen readers hear the first
// message too) and an assertive one for errors. Hovering or focusing a message
// stops its timer; Escape closes the newest.

function ToastRow({ item, dismiss, closeLabel }: { item: ToastItem; dismiss: (id: number) => void; closeLabel: string }) {
  const [paused, setPaused] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ms = item.duration ?? (item.tone === "error" ? 0 : item.action ? 8000 : 5000);
  React.useEffect(() => {
    if (!ms || paused) return;
    const h = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(h);
  }, [ms, paused, dismiss, item.id]);
  const h = React.createElement;
  return h(
    "div",
    {
      "data-cms-toast": item.tone ?? "info",
      onMouseEnter: () => setPaused(true),
      onMouseLeave: () => setPaused(false),
      onFocus: () => setPaused(true),
      onBlur: () => setPaused(false),
      className:
        "pointer-events-auto flex w-full items-center gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 " +
        (item.tone === "error" ? "border-destructive/40" : ""),
    },
    h("span", { className: "min-w-0 flex-1 break-words " + (item.tone === "error" ? "text-destructive" : "") }, item.message),
    item.action
      ? h(
          "button",
          {
            type: "button",
            disabled: busy,
            className: "shrink-0 rounded-md px-2 py-1 font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            onClick: async () => {
              setBusy(true);
              try {
                await item.action!.run();
              } finally {
                dismiss(item.id);
              }
            },
          },
          item.action.label
        )
      : null,
    h(
      "button",
      { type: "button", "aria-label": closeLabel, className: "shrink-0 rounded-md px-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", onClick: () => dismiss(item.id) },
      "×"
    )
  );
}

function Toaster({ toasts, dismiss, closeLabel }: { toasts: ToastItem[]; dismiss: (id: number) => void; closeLabel: string }) {
  React.useEffect(() => {
    if (!toasts.length) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog that is open takes Escape for itself.
      if (typeof document !== "undefined" && document.querySelector("[role=dialog],[role=alertdialog]")) return;
      dismiss(toasts[toasts.length - 1].id);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [toasts, dismiss]);
  const h = React.createElement;
  const list = (items: ToastItem[]) => items.map((x) => h(ToastRow, { key: x.id, item: x, dismiss, closeLabel }));
  const wrap = "pointer-events-none fixed inset-x-3 bottom-3 z-[100] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96";
  return h(
    React.Fragment,
    null,
    h("div", { role: "status", "aria-live": "polite", "aria-atomic": false, className: wrap, "data-cms-toaster": "" }, list(toasts.filter((x) => x.tone !== "error"))),
    h("div", { role: "alert", "aria-live": "assertive", className: wrap + " sm:bottom-20" }, list(toasts.filter((x) => x.tone === "error")))
  );
}

// ── cross-screen news ─────────────────────────────────────────────────────────

/** Window event a screen sends after it put something in the trash or took it out (the sidebar count listens). */
export const TRASH_CHANGED = "agent-cms:trash-changed";
export const trashChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TRASH_CHANGED));
};

// ── keyboard shortcuts ────────────────────────────────────────────────────────

/** True while the person types in a field (single-letter shortcuts stay quiet then). */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=textbox]");
}

/** "mod" is ⌘ on Apple machines and Ctrl elsewhere. */
export const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modLabel = () => (isApple() ? "⌘" : "Ctrl");

/**
 * Listen for a key on the page. `combo` is like "mod+s", "shift+?", "/", "n".
 * Single keys without mod do nothing while the person types in a field;
 * `inFields` overrides that (true: always fire, false: never while typing).
 */
export function useShortcut(combo: string | null | false, handler: (e: KeyboardEvent) => void, o: { inFields?: boolean } = {}) {
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => {
    if (!combo) return;
    const parts = combo.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const mod = parts.includes("mod");
    const shift = parts.includes("shift");
    const alt = parts.includes("alt");
    const on = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      if (mod !== (e.metaKey || e.ctrlKey) || alt !== e.altKey) return;
      if (shift && !e.shiftKey) return;
      if (!shift && e.shiftKey && key.length === 1 && /[a-z]/.test(key)) return;
      if ((e.key || "").toLowerCase() !== key) return;
      if (!(o.inFields ?? mod) && isTyping(e)) return;
      e.preventDefault();
      ref.current(e);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [combo, o.inFields]);
}

export function useCms(): CmsContextValue {
  const v = React.useContext(CmsContext);
  if (!v) throw new Error("agent-cms: wrap the admin screens in <CmsProvider>.");
  return v;
}

const assetCache = new WeakMap<RestClient, Map<string, Promise<AssetDetail | null>>>();

/** Forget what `useAsset` remembers (after a file changed or was deleted). */
export function forgetAsset(client: RestClient, id?: string): void {
  if (id) assetCache.get(client)?.delete(id);
  else assetCache.delete(client);
}

/** A media library file by id: undefined while loading, null when it is gone or may not be seen. */
export function useAsset(id: string | null | undefined): AssetDetail | null | undefined {
  const { client } = useCms();
  const [state, setState] = React.useState<{ id: string; asset: AssetDetail | null } | null>(null);
  React.useEffect(() => {
    if (!id) return;
    let live = true;
    let known = assetCache.get(client);
    if (!known) assetCache.set(client, (known = new Map()));
    let p = known.get(id);
    if (!p) known.set(id, (p = client.asset(id).catch(() => null)));
    void p.then((asset) => live && setState({ id, asset }));
    return () => {
      live = false;
    };
  }, [client, id]);
  return !id ? null : state?.id === id ? state.asset : undefined;
}

/** Full URL of the CMS endpoint (e.g. https://app.example.com/api/cms). */
export function cmsUrl(appUrl: string, baseUrl: string): string {
  return /^https?:\/\//.test(baseUrl) ? baseUrl.replace(/\/+$/, "") : `${appUrl}${baseUrl.startsWith("/") ? "" : "/"}${baseUrl.replace(/\/+$/, "")}`;
}

// ── data hooks ────────────────────────────────────────────────────────────────

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/** Run `fn` when `deps` change; `reload()` runs it again. Stale results are dropped. */
export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList): AsyncState<T> {
  const [data, setData] = React.useState<T | undefined>(undefined);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  React.useEffect(() => {
    let live = true;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = React.useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

/** `window.matchMedia` as state (false where it does not exist). */
export function useMediaQuery(query: string): boolean {
  // Start false on the server and on the first client render (same HTML for
  // hydration), then follow the real value.
  const [match, setMatch] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return match;
}

/** Narrower than 768px: sidebar in a sheet, cards instead of tables, tabs in the editor. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** State remembered in localStorage (JSON). */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = React.useState<T>(initial);
  // Read after mount so server and first client render agree (hydration).
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* private mode or bad JSON */
    }
  }, [key]);
  const set = React.useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* private mode */
      }
    },
    [key]
  );
  return [value, set];
}

/** Call `fn` once `delay` ms after the last call. */
export function useDebounced<A extends unknown[]>(fn: (...a: A) => void, delay: number) {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return React.useMemo(() => {
    const run = (...a: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        fnRef.current(...a);
      }, delay);
    };
    run.cancel = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    return run;
  }, [delay]);
}

// ── shell navigation (the mobile menu button inside each screen's header) ────

export const ShellNavContext = React.createContext<{ openNav: () => void } | null>(null);
export const useShellNav = () => React.useContext(ShellNavContext);

// ── formatting ────────────────────────────────────────────────────────────────

/** "8 min ago", "2 h ago", "yesterday", else a short date. */
export function relativeTime(iso: string | null | undefined, t: T, locale: string, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ms = now.getTime() - d.getTime();
  if (ms < 60_000) return t("just_now");
  if (ms < 3_600_000) return t("minutes_ago", { n: Math.floor(ms / 60_000) });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return t("hours_ago", { n: Math.floor(ms / 3_600_000) });
  if (d.getTime() >= startOfToday - 86_400_000) return t("yesterday");
  return formatDate(iso, locale, d.getFullYear() !== now.getFullYear());
}

export function formatDate(iso: string, locale: string, withYear = false): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(iso));
}

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Nov 20, 1:46 AM": the moment a link or key stops working. */
export function formatUntil(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

// ── documents ─────────────────────────────────────────────────────────────────

/** 0.21.0: `seo` in collections with search engine details. */
export type DocContent = DocLike & { seo?: { title?: string | null; description?: string | null; image?: string | null; canonical?: string | null; noindex?: boolean } | null };

export function contentOf(d: DocContent): DocContent {
  return { slug: d.slug, title: d.title, summary: d.summary, body: d.body, category: d.category, keywords: [...(d.keywords ?? [])], fields: structuredClone(d.fields ?? {}), ...(d.seo ? { seo: { ...d.seo } } : {}) };
}

/**
 * The REST body for saving `next` over a document whose fields were `prev`.
 * `fields` is a JSON Merge Patch on update, so keys that went away are sent
 * as null.
 */
export function toInput(next: DocContent, prevFields?: Record<string, unknown>): DocInputWire {
  const fields: Record<string, unknown> = { ...next.fields };
  for (const k of Object.keys(prevFields ?? {})) if (!(k in fields) || fields[k] === undefined) fields[k] = null;
  return { slug: next.slug, title: next.title, summary: next.summary, body: next.body, category: next.category, keywords: next.keywords, fields, ...(next.seo !== undefined ? { seo: next.seo ?? null } : {}) } as DocInputWire;
}

export const sameContent = (a: DocContent, b: DocContent) => JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));

// ── time zones (schedules are entered in the CMS's zone, stored in UTC) ───────

function wallMs(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
}

/** "2026-11-24" and "09:00" on the clock of `timeZone`, as an ISO instant. Null when either is not filled in. */
export function zonedToIso(date: string, time: string, timeZone: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const h = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !h) return null;
  const want = Date.UTC(+d[1], +d[2] - 1, +d[3], +h[1], +h[2]);
  let guess = want;
  // Twice: the first step can land on the other side of a clock change.
  for (let i = 0; i < 2; i++) guess -= wallMs(guess, timeZone) - want;
  // A time the clock skips (spring forward, e.g. 02:30 in New York on 8 March 2026) does not exist: refuse it.
  if (wallMs(guess, timeZone) !== want) return null;
  // A time that happens twice (fall back) takes the earlier one.
  const hour = 3_600_000;
  if (wallMs(guess - hour, timeZone) === want) guess -= hour;
  return new Date(guess).toISOString();
}

/** The date and time inputs' values for an instant, on the clock of `timeZone`. */
export function zonedParts(iso: string, timeZone: string): { date: string; time: string } {
  const s = new Date(wallMs(new Date(iso).getTime(), timeZone)).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

/** "Nov 24, 9:00 AM" on the clock of `timeZone` (with the year when it is not this year). */
export function formatZoned(iso: string, locale: string, timeZone?: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }).format(d);
}

// ── people ────────────────────────────────────────────────────────────────────

const HUES = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f"];

/** A person's colour (one of eight, picked by id so it stays the same everywhere). Agents are grey. */
export function personColor(id: string, agent?: boolean): string {
  if (agent) return "#525252";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}
