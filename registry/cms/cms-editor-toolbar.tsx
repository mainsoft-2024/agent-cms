"use client";

// The body editor's top bar: icon buttons with a tooltip (name and shortcut),
// in a left group (history, text style, lists and blocks, media, new blocks)
// and a right group (find, section order, previews, full screen, word count).
// One roving tab stop (role="toolbar", arrow keys move); buttons that do not
// fit go into a More menu. The same buttons work in the block editor (through
// its commands) and in the markdown text box (they edit the text around the
// selection). Also the find and replace bar (Ctrl/Cmd+F, Ctrl+H).

import * as React from "react";
import {
  AppWindow,
  Bold,
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Code,
  Ellipsis,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  Maximize2,
  MessageSquareWarning,
  Minus,
  PanelRight,
  Pilcrow,
  Plus,
  Puzzle,
  Redo2,
  Search,
  SquareArrowOutUpRight,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
  Undo2,
  WholeWord,
  X,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { MessageKey } from "./cms-messages";
import { isApple, useCms, type BlockEditorCommands, type EditorCommand } from "./use-cms";

type Icon = React.ComponentType<{ className?: string }>;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

// ── commands for the markdown text box ────────────────────────────────────────

export interface MarkdownTarget {
  /** The text box. */
  box: () => HTMLTextAreaElement | null;
  /** The body now. */
  body: () => string;
  /** Set the body (used where the browser cannot insert text with undo). */
  setBody: (body: string) => void;
  /** Find results to draw behind the text (start, end offsets). */
  onMarks?: (marks: { start: number; end: number }[]) => void;
  readOnly?: () => boolean;
}

const LINE_PREFIX = /^(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s?\[!\w+\]\s*|>\s?)/;

/** Find matches in a text (same rules as the block editor). */
export function findInText(text: string, query: string, o: { caseSensitive: boolean; wholeWord: boolean }): { start: number; end: number }[] {
  if (!query) return [];
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, o.caseSensitive ? "gu" : "giu");
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) if (m[0]) out.push({ start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** Toolbar commands that edit the markdown around the text box's selection. */
export function markdownCommands(m: MarkdownTarget): BlockEditorCommands {
  let find: { query: string; o: { caseSensitive: boolean; wholeWord: boolean }; matches: { start: number; end: number }[]; current: number } = { query: "", o: { caseSensitive: false, wholeWord: false }, matches: [], current: -1 };
  const sel = () => {
    const el = m.box();
    const body = m.body();
    return { el, body, a: el ? Math.min(el.selectionStart, body.length) : body.length, b: el ? Math.min(el.selectionEnd, body.length) : body.length };
  };
  /** Replace a range, keeping the browser's undo where it can; then select [selA, selB]. */
  const edit = (a: number, b: number, text: string, selA: number, selB: number) => {
    const el = m.box();
    const body = m.body();
    if (!el) return m.setBody(body.slice(0, a) + text + body.slice(b));
    el.focus();
    el.setSelectionRange(a, b);
    const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
    if (!ok) m.setBody(body.slice(0, a) + text + body.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selA, selB);
    });
  };
  const wrap = (mark: string) => {
    const { body, a, b } = sel();
    const inner = body.slice(a, b);
    // Already wrapped (inside or just outside the selection): take the marks off.
    if (inner.length >= mark.length * 2 && inner.startsWith(mark) && inner.endsWith(mark)) return edit(a, b, inner.slice(mark.length, -mark.length), a, b - mark.length * 2);
    if (body.slice(a - mark.length, a) === mark && body.slice(b, b + mark.length) === mark) return edit(a - mark.length, b + mark.length, inner, a - mark.length, b - mark.length);
    edit(a, b, `${mark}${inner}${mark}`, a + mark.length, b + mark.length);
  };
  const lines = () => {
    const { body, a, b } = sel();
    const start = body.lastIndexOf("\n", a - 1) + 1;
    const nl = body.indexOf("\n", b > a && body[b - 1] === "\n" ? b - 1 : b);
    const end = nl < 0 ? body.length : nl;
    return { body, start, end, text: body.slice(start, end) };
  };
  const setLines = (prefix: (n: number) => string, first?: string) => {
    const { start, end, text } = lines();
    const ls = text.split("\n").map((l) => l.replace(LINE_PREFIX, ""));
    let out = ls.map((l, n) => prefix(n) + l).join("\n");
    if (first) out = `${first}\n${out}`;
    edit(start, end, out, start + out.length, start + out.length);
  };
  /** Put a block of markdown on lines of its own at the caret; select `pick` inside it. */
  const block = (md: string, pick?: string) => {
    const { body, a, b } = sel();
    const before = body.slice(0, a);
    const after = body.slice(b);
    const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const tail = after.startsWith("\n\n") ? "" : after.startsWith("\n") || !after ? "\n" : "\n\n";
    const at = a + lead.length;
    const k = pick ? md.indexOf(pick) : -1;
    edit(a, b, `${lead}${md}${tail}`, k >= 0 ? at + k : at + md.length, k >= 0 ? at + k + pick!.length : at + md.length);
  };
  const lineType = (): EditorCommand => {
    const l = lines().text.split("\n")[0];
    if (/^###\s/.test(l)) return "h3";
    if (/^#{1,2}\s/.test(l)) return "h2";
    if (/^[-*+]\s+\[[ xX]\]\s/.test(l)) return "todo";
    if (/^[-*+]\s/.test(l)) return "bullet";
    if (/^\d{1,9}[.)]\s/.test(l)) return "number";
    if (/^>\s?\[!\w+\]/.test(l)) return "callout";
    if (/^>/.test(l)) return "quote";
    return "p";
  };
  const refind = () => {
    find = { ...find, matches: findInText(m.body(), find.query, find.o) };
    find.current = find.matches.length ? Math.min(Math.max(0, find.current), find.matches.length - 1) : -1;
    m.onMarks?.(find.matches);
  };
  const reveal = () => {
    const el = m.box();
    const r = find.matches[find.current];
    if (!el || !r) return;
    el.setSelectionRange(r.start, r.end);
    const line = m.body().slice(0, r.start).split("\n").length - 1;
    el.scrollTop = Math.max(0, line * (parseFloat(getComputedStyle(el).lineHeight) || 24) - el.clientHeight / 3);
  };
  const report = () => ({ count: find.matches.length, current: find.current });
  return {
    run: (cmd) => {
      if (m.readOnly?.()) return false;
      switch (cmd) {
        case "undo":
        case "redo":
          m.box()?.focus();
          return typeof document.execCommand === "function" && document.execCommand(cmd);
        case "bold":
          return (wrap("**"), true);
        case "italic":
          return (wrap("*"), true);
        case "strike":
          return (wrap("~~"), true);
        case "code":
          return (wrap("`"), true);
        case "link": {
          const { body, a, b } = sel();
          const label = body.slice(a, b) || "";
          const md = `[${label}](https://)`;
          edit(a, b, md, a + label.length + 3, a + label.length + 11);
          return true;
        }
        case "p":
          return (setLines(() => ""), true);
        case "h2":
          return (setLines(() => "## "), true);
        case "h3":
          return (setLines(() => "### "), true);
        case "bullet":
          return (setLines(() => "- "), true);
        case "number":
          return (setLines((n) => `${n + 1}. `), true);
        case "todo":
          return (setLines(() => "- [ ] "), true);
        case "quote":
          return (setLines(() => "> "), true);
        case "callout":
          return (setLines(() => "> ", "> [!note]"), true);
        case "codeblock": {
          const { body, a, b } = sel();
          const inner = body.slice(a, b);
          block(`\`\`\`\n${inner}\n\`\`\``, inner ? undefined : undefined);
          return true;
        }
        case "table":
          return (block("| Column | Column |\n| --- | --- |\n|  |  |", "Column"), true);
        case "hr":
          return (block("---"), true);
        case "steps":
          return (block(":::steps\n1. \n:::"), true);
        case "card":
          return (block(":::card\n[Title](https://)\n:::", "Title"), true);
        case "video":
          return (block(":::video\nhttps://\n:::", "https://"), true);
        case "snippet":
          return (block("[[snippet:key]]", "key"), true);
      }
      return false;
    },
    state: (cmd) => {
      if (m.readOnly?.()) return { enabled: false, active: false };
      if (cmd === "undo" || cmd === "redo") return { enabled: typeof document.execCommand === "function", active: false };
      if (["p", "h2", "h3", "bullet", "number", "todo", "quote", "callout"].includes(cmd)) return { enabled: true, active: lineType() === cmd };
      if (cmd === "link") return { enabled: true, active: false };
      return { enabled: true, active: false };
    },
    find: (query, o) => {
      const from = m.box()?.selectionStart ?? 0;
      find = { query, o, matches: findInText(m.body(), query, o), current: 0 };
      find.current = find.matches.length ? Math.max(0, find.matches.findIndex((r) => r.end >= from)) : -1;
      m.onMarks?.(find.matches);
      return report();
    },
    findStep: (dir) => {
      refind();
      if (!find.matches.length) return report();
      find.current = (find.current + dir + find.matches.length) % find.matches.length;
      reveal();
      return report();
    },
    replace: (text, all) => {
      if (m.readOnly?.()) return 0;
      refind();
      if (!find.matches.length) return 0;
      const body = m.body();
      if (all) {
        let out = "";
        let last = 0;
        for (const r of find.matches) {
          out += body.slice(last, r.start) + text;
          last = r.end;
        }
        out += body.slice(last);
        const n = find.matches.length;
        edit(0, body.length, out, 0, 0);
        find = { ...find, matches: findInText(out, find.query, find.o), current: 0 };
        m.onMarks?.(find.matches);
        return n;
      }
      const r = find.matches[find.current];
      edit(r.start, r.end, text, r.start, r.start + text.length);
      const next = body.slice(0, r.start) + text + body.slice(r.end);
      find = { ...find, matches: findInText(next, find.query, find.o) };
      find.current = find.matches.length ? Math.max(0, find.matches.findIndex((x) => x.start >= r.start + text.length)) : -1;
      m.onMarks?.(find.matches);
      return 1;
    },
    findClear: () => {
      find = { ...find, query: "", matches: [], current: -1 };
      m.onMarks?.([]);
    },
    focus: () => m.box()?.focus(),
  };
}

// ── word count ────────────────────────────────────────────────────────────────

/** Words, characters and reading time of the body (markup left out). */
export function bodyStats(body: string): { words: number; chars: number; minutes: number } {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/:::html[\s\S]*?\n:::/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[link:[^|\]]+\|([^\]]+)\]\]/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)]|\|)\s?/gm, "")
    .replace(/[*_~`|]/g, "");
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  const chars = text.replace(/\s/g, "").length;
  // Hangul and other scripts without spaces read by characters, the rest by words.
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  const minutes = Math.max(1, Math.round(cjk > chars / 2 ? chars / 500 : words / 230));
  return { words, chars, minutes };
}

// ── the bar ───────────────────────────────────────────────────────────────────

export interface EditorToolbarProps {
  /** Commands of the editor shown now (block editor or text box); null while it loads. */
  commands: BlockEditorCommands | null;
  /** Bump to redraw the buttons' state (selection or marks changed). */
  tick?: number;
  /** "blocks" or "markdown" when the app has a block editor; undefined for the text box only. */
  view?: "blocks" | "markdown";
  onView?: (v: "blocks" | "markdown") => void;
  canWrite: boolean;
  body: string;
  /** Section order (shown when the body has more than one section and the text box is shown). */
  outline?: { on: boolean; toggle: () => void } | null;
  /** Insert a file from the media library. */
  onMedia?: (() => void) | null;
  sidePreview?: { on: boolean; toggle: () => void } | null;
  previewWindow?: { on: boolean; toggle: () => void } | null;
  fullscreen?: { onEnter: () => void; buttonRef?: React.Ref<HTMLButtonElement> } | null;
  /** Show the find bar (with replace when true). */
  onFind: (replace: boolean) => void;
  findOpen?: boolean;
  /** The box's label (for screen readers; the switch says what the box is). */
  label?: React.ReactNode;
}

interface Btn {
  key: string;
  label: MessageKey;
  icon: Icon;
  keys?: string;
  cmd?: EditorCommand;
  run?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

/** A shortcut as this computer writes it ("⌘B" / "Ctrl+B"). */
function shortcut(keys: string): string {
  if (isApple()) return keys.replace(/Mod\+/g, "⌘").replace(/Shift\+/g, "⇧").replace(/Alt\+/g, "⌥");
  return keys.replace(/Mod\+/g, "Ctrl+");
}
const ariaKeys = (keys: string) => [keys.replace(/Mod/g, "Control"), keys.replace(/Mod/g, "Meta")].filter((k, i, a) => a.indexOf(k) === i).join(" ");

/** A small bubble under a button: its name and shortcut. */
function Tip({ text, keys, show }: { text: string; keys?: string; show: boolean }) {
  if (!show) return null;
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 inline-flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-xs font-normal text-primary-foreground shadow-md"
      style={{ animation: `cms-tip-in 120ms ${EASE} both` }}
    >
      {text}
      {keys ? <kbd className="font-mono text-[11px] opacity-70">{shortcut(keys)}</kbd> : null}
    </span>
  );
}

/** Shows the tooltip after a short hover, or at once on keyboard focus. */
function useTip() {
  const [show, setShow] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => clear, []);
  return {
    show,
    hide: () => (clear(), setShow(false)),
    props: {
      onPointerEnter: (e: React.PointerEvent) => {
        if (e.pointerType === "touch") return;
        clear();
        timer.current = window.setTimeout(() => setShow(true), 450);
      },
      onPointerLeave: () => (clear(), setShow(false)),
      onFocus: (e: React.FocusEvent) => {
        if ((e.target as HTMLElement).matches?.(":focus-visible")) setShow(true);
      },
      onBlur: () => (clear(), setShow(false)),
    },
  };
}

const BTN = "relative inline-grid size-7 shrink-0 place-items-center rounded-md text-foreground/80 outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-muted-foreground/45 aria-pressed:bg-muted aria-pressed:text-foreground";

const ToolButton = React.forwardRef<HTMLButtonElement, { b: Btn; t: (k: MessageKey) => string; onRun: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>>(function ToolButton({ b, t, onRun, className, ...rest }, ref) {
  const tip = useTip();
  const I = b.icon;
  return (
    <button
      ref={ref}
      type="button"
      data-tb-item=""
      aria-label={t(b.label)}
      aria-keyshortcuts={b.keys ? ariaKeys(b.keys) : undefined}
      aria-pressed={b.pressed === undefined ? undefined : b.pressed}
      disabled={b.disabled}
      tabIndex={-1}
      className={cn(BTN, className)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        tip.hide();
        onRun();
      }}
      {...tip.props}
      {...rest}
    >
      <I className="size-4" />
      <Tip text={t(b.label)} keys={b.keys} show={tip.show} />
    </button>
  );
});

/** A button that opens a menu (text style, insert, More). */
const MenuButton = React.forwardRef<HTMLButtonElement, { label: string; keys?: string; children?: React.ReactNode; wide?: boolean; disabled?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>>(function MenuButton({ label, keys, children, wide, disabled, className, ...rest }, ref) {
  const tip = useTip();
  return (
    <button
      ref={ref}
      type="button"
      data-tb-item=""
      aria-label={label}
      disabled={disabled}
      tabIndex={-1}
      className={cn(BTN, wide && "w-auto gap-1 px-1.5 text-[13px]", className)}
      onMouseDown={(e) => e.preventDefault()}
      {...tip.props}
      {...rest}
      onPointerDown={(e) => {
        tip.hide();
        rest.onPointerDown?.(e);
      }}
      onFocus={(e) => {
        tip.props.onFocus(e);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        tip.props.onBlur();
        rest.onBlur?.(e);
      }}
    >
      {children}
      <Tip text={label} keys={keys} show={tip.show} />
    </button>
  );
});

const Sep = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;

type GroupKey = "history" | "style" | "marks" | "blocks" | "media" | "insert" | "find" | "right";

export function EditorToolbar({ commands, tick, view, onView, canWrite, body, outline, onMedia, sidePreview, previewWindow, fullscreen, onFind, findOpen, label }: EditorToolbarProps) {
  const { t, locale } = useCms();
  void tick;
  const st = (cmd: EditorCommand) => (commands && canWrite ? commands.state(cmd) : { enabled: false, active: false });
  const run = (cmd: EditorCommand) => {
    commands?.run(cmd);
  };
  const b = (key: string, labelKey: MessageKey, icon: Icon, cmd: EditorCommand, keys?: string, toggle = false): Btn => {
    const s = st(cmd);
    return { key, label: labelKey, icon, cmd, keys, disabled: !s.enabled, pressed: toggle ? s.active : undefined };
  };

  const history = [b("undo", "tb_undo", Undo2, "undo", "Mod+Z"), b("redo", "tb_redo", Redo2, "redo", isApple() ? "Mod+Shift+Z" : "Mod+Y")];
  const marks = [b("bold", "tb_bold", Bold, "bold", "Mod+B", true), b("italic", "tb_italic", Italic, "italic", "Mod+I", true), b("strike", "tb_strike", Strikethrough, "strike", "Mod+Shift+X", true), b("code", "tb_code", Code, "code", "Mod+E", true), b("link", "tb_link", LinkIcon, "link", "Mod+K", true)];
  const blocks = [
    b("bullet", "tb_bullet", List, "bullet", undefined, true),
    b("number", "tb_number", ListOrdered, "number", undefined, true),
    b("todo", "tb_todo", ListChecks, "todo", undefined, true),
    b("quote", "tb_quote", TextQuote, "quote", undefined, true),
    b("callout", "tb_callout", MessageSquareWarning, "callout", undefined, true),
    b("table", "tb_table", Table, "table"),
    b("codeblock", "tb_codeblock", SquareCode, "codeblock"),
    b("hr", "tb_hr", Minus, "hr"),
  ];
  const styles: { cmd: EditorCommand; label: MessageKey; icon: Icon; keys: string }[] = [
    { cmd: "p", label: "tb_style_p", icon: Pilcrow, keys: "Mod+Alt+0" },
    { cmd: "h2", label: "tb_style_h2", icon: Heading2, keys: "Mod+Alt+2" },
    { cmd: "h3", label: "tb_style_h3", icon: Heading3, keys: "Mod+Alt+3" },
  ];
  const styleNow = styles.find((s) => st(s.cmd).active) ?? styles[0];
  const styleEnabled = styles.some((s) => st(s.cmd).enabled);
  const inserts: { cmd: EditorCommand; label: MessageKey; icon: Icon; hint: string }[] = [
    { cmd: "steps", label: "blk_steps", icon: ListOrdered, hint: ":::steps" },
    { cmd: "card", label: "blk_card", icon: SquareArrowOutUpRight, hint: ":::card" },
    { cmd: "video", label: "blk_video", icon: Clapperboard, hint: ":::video" },
    { cmd: "snippet", label: "blk_snippet", icon: Puzzle, hint: "[[snippet:…]]" },
  ];
  const insertEnabled = !!commands && canWrite && st("steps").enabled;

  const right: Btn[] = [
    { key: "find", label: "tb_find", icon: Search, keys: "Mod+F", run: () => onFind(false), pressed: !!findOpen },
    ...(outline ? [{ key: "outline", label: "sections_order" as MessageKey, icon: ListTree, run: outline.toggle, pressed: outline.on }] : []),
    ...(sidePreview ? [{ key: "side", label: "blk_preview_side" as MessageKey, icon: PanelRight, run: sidePreview.toggle, pressed: sidePreview.on }] : []),
    ...(previewWindow ? [{ key: "window", label: "blk_preview_window" as MessageKey, icon: AppWindow, run: previewWindow.toggle, pressed: previewWindow.on }] : []),
    ...(fullscreen ? [{ key: "full", label: "focus_enter" as MessageKey, icon: Maximize2, keys: "Mod+Shift+F", run: fullscreen.onEnter, pressed: false, ref: fullscreen.buttonRef }] : []),
  ];

  // ── which groups fit; the rest go into More ──
  const barRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = React.useState<Set<GroupKey>>(new Set());
  // The order groups leave in when the bar gets narrow.
  const DROP: GroupKey[] = ["blocks", "insert", "style", "find", "marks", "media", "history"];
  React.useLayoutEffect(() => {
    const bar = barRef.current;
    const m = measureRef.current;
    if (!bar || !m || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const avail = bar.clientWidth;
      if (!avail) return;
      const width = (k: string) => (m.querySelector<HTMLElement>(`[data-tb-group="${k}"]`)?.offsetWidth ?? 0) + 9;
      const fixed = width("lead") + width("right") + width("stat") + 40;
      let total = fixed + DROP.reduce((s, k) => s + width(k), 0);
      const out = new Set<GroupKey>();
      for (const k of DROP) {
        if (total <= avail) break;
        out.add(k);
        total -= width(k);
      }
      setHidden((old) => (old.size === out.size && [...out].every((k) => old.has(k)) ? old : out));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── roving tab stop ──
  const [focusKey, setFocusKey] = React.useState(0);
  const items = () => Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>("[data-tb-item]:not([disabled])") ?? []);
  React.useLayoutEffect(() => {
    const list = items();
    if (!list.length) return;
    const k = Math.min(focusKey, list.length - 1);
    list.forEach((el, i) => (el.tabIndex = i === k ? 0 : -1));
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).closest("[role=menu]")) return;
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    setFocusKey(n);
    list[n].focus();
  };
  const onFocusIn = (e: React.FocusEvent) => {
    const at = items().indexOf(e.target as HTMLButtonElement);
    if (at >= 0 && at !== focusKey) setFocusKey(at);
  };

  const s = React.useMemo(() => bodyStats(body), [body]);
  const n = (x: number) => x.toLocaleString(locale);
  const stat = (
    <span title={`${t("blk_words", { n: n(s.words) })} · ${t("blk_chars", { n: n(s.chars) })}`} className="shrink-0 whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground">
      {t("blk_words", { n: n(s.words) })}
      {s.words ? <span className="hidden sm:inline"> · {t("blk_read_min", { n: n(s.minutes) })}</span> : null}
    </span>
  );

  const lead = (
    <>
      {label}
      {view && onView ? (
        <div role="group" aria-label={t("blk_view")} className="flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5">
          {(["blocks", "markdown"] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-tb-item=""
              tabIndex={-1}
              aria-pressed={view === v}
              onClick={() => onView(v)}
              className={cn("h-6 whitespace-nowrap rounded px-2 text-xs outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring", view === v ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {t(v === "blocks" ? "blk_view_blocks" : "blk_view_markdown")}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );

  // Closing a menu: after an action that moved focus on purpose (into the text, a dialog, the find bar) focus
  // stays where the action put it; closed with Esc or a click outside, Radix puts it back on the menu button.
  // Radix calls `onCloseAutoFocus` (cancelled below). Base UI has no such event and puts focus back on the
  // button itself, so the button's focus handler sends it on: back where the action left it, or to `after`.
  const acted = React.useRef(false);
  const back = React.useRef<{ until: number; after?: () => void } | null>(null);
  const act = (fn: () => void, after?: () => void) => () => {
    acted.current = true;
    back.current = { until: Date.now() + 800, after };
    fn();
  };
  const closeFocus = (after?: () => void) => ({
    onCloseAutoFocus: (e: Event) => {
      if (acted.current) {
        e.preventDefault();
        after?.();
      }
      acted.current = false;
      back.current = null;
    },
  }) as object;
  const onTriggerFocus = (e: React.FocusEvent) => {
    const b = back.current;
    back.current = null;
    acted.current = false;
    if (!b || Date.now() > b.until) return;
    const from = e.relatedTarget as HTMLElement | null;
    if (from && from.isConnected && !from.closest("[role=menu]")) from.focus();
    else b.after?.();
  };

  const styleMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <MenuButton onFocus={onTriggerFocus} label={t("tb_style")} wide disabled={!styleEnabled} className="min-w-[4.5rem] justify-between">
          <span className="truncate">{t(styleNow.label)}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52" {...closeFocus(() => commands?.focus())}>
        {styles.map((x) => (
          <DropdownMenuItem key={x.cmd} onClick={act(() => run(x.cmd), () => commands?.focus())} className="gap-2">
            <x.icon className="size-4" />
            <span className="grow">{t(x.label)}</span>
            <kbd className="font-mono text-[11px] text-muted-foreground">{shortcut(x.keys)}</kbd>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const insertMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <MenuButton onFocus={onTriggerFocus} label={t("tb_insert")} wide disabled={!insertEnabled}>
          <Plus className="size-4" />
          <span>{t("tb_insert_short")}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60" {...closeFocus()}>
        {inserts.map((x) => (
          <DropdownMenuItem key={x.cmd} onClick={act(() => run(x.cmd))} className="gap-2">
            <x.icon className="size-4" />
            <span className="grow">{t(x.label)}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{x.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const group = (k: GroupKey, node: React.ReactNode, sep = true) =>
    hidden.has(k) ? null : (
      <React.Fragment key={k}>
        {sep ? <Sep /> : null}
        <div data-tb-group={k} className="flex shrink-0 items-center gap-px">
          {node}
        </div>
      </React.Fragment>
    );
  const buttons = (list: Btn[]) => list.map((x) => <ToolButton key={x.key} ref={x.ref} b={x} t={t} onRun={() => (x.cmd ? run(x.cmd) : x.run?.())} />);
  const media = onMedia ? [{ key: "media", label: "media_insert_button" as MessageKey, icon: ImagePlus, run: onMedia, disabled: !canWrite }] : [];

  const leftGroups = () => (
    <>
      {group("history", buttons(history), !!view)}
      {group("style", styleMenu)}
      {group("marks", buttons(marks))}
      {group("blocks", buttons(blocks))}
      {media.length ? group("media", buttons(media)) : null}
      {group("insert", insertMenu)}
    </>
  );

  const more = hidden.size ? (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <MenuButton onFocus={onTriggerFocus} label={t("tb_more")}>
          <Ellipsis className="size-4" />
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" {...closeFocus()}>
        {hidden.has("style") ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Heading2 className="size-4" />
              {t("tb_style")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {styles.map((x) => (
                <DropdownMenuItem key={x.cmd} disabled={!st(x.cmd).enabled} onClick={act(() => run(x.cmd))} className="gap-2">
                  <x.icon className="size-4" />
                  {t(x.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {hidden.has("marks") ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Bold className="size-4" />
              {t("tb_marks")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {marks.map((x) => (
                <DropdownMenuItem key={x.key} disabled={x.disabled} onClick={act(() => run(x.cmd!))} className="gap-2">
                  <x.icon className="size-4" />
                  <span className="grow">{t(x.label)}</span>
                  {x.keys ? <kbd className="font-mono text-[11px] text-muted-foreground">{shortcut(x.keys)}</kbd> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {hidden.has("blocks") ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <List className="size-4" />
              {t("tb_blocks")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {blocks.map((x) => (
                <DropdownMenuItem key={x.key} disabled={x.disabled} onClick={act(() => run(x.cmd!))} className="gap-2">
                  <x.icon className="size-4" />
                  {t(x.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {hidden.has("insert") ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2" disabled={!insertEnabled}>
              <Plus className="size-4" />
              {t("tb_insert")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {inserts.map((x) => (
                <DropdownMenuItem key={x.cmd} onClick={act(() => run(x.cmd))} className="gap-2">
                  <x.icon className="size-4" />
                  {t(x.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {hidden.has("media") && onMedia ? (
          <DropdownMenuItem onClick={act(onMedia)} disabled={!canWrite} className="gap-2">
            <ImagePlus className="size-4" />
            {t("media_insert_button")}
          </DropdownMenuItem>
        ) : null}
        {hidden.has("history") ? (
          <>
            <DropdownMenuSeparator />
            {history.map((x) => (
              <DropdownMenuItem key={x.key} disabled={x.disabled} onClick={act(() => run(x.cmd!))} className="gap-2">
                <x.icon className="size-4" />
                <span className="grow">{t(x.label)}</span>
                {x.keys ? <kbd className="font-mono text-[11px] text-muted-foreground">{shortcut(x.keys)}</kbd> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {hidden.has("find") ? (
          <>
            <DropdownMenuSeparator />
            {right
              .filter((x) => x.key === "find" || x.key === "outline")
              .map((x) => (
                <DropdownMenuItem key={x.key} onClick={act(() => x.run?.())} className="gap-2">
                  <x.icon className="size-4" />
                  <span className="grow">{t(x.label)}</span>
                  {x.keys ? <kbd className="font-mono text-[11px] text-muted-foreground">{shortcut(x.keys)}</kbd> : null}
                </DropdownMenuItem>
              ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const rightShown = hidden.has("find") ? right.filter((x) => x.key !== "find" && x.key !== "outline") : right;

  return (
    <div className="relative min-w-0 border-b">
      <style>{`@keyframes cms-tip-in { from { opacity: 0; transform: translate(-50%, -2px) } to { opacity: 1; transform: translate(-50%, 0) } }`}</style>
      <div ref={barRef} role="toolbar" aria-label={t("tb_label")} aria-orientation="horizontal" className="flex h-11 min-w-0 items-center gap-px overflow-visible px-2 sm:px-3" onKeyDown={onKeyDown} onFocus={onFocusIn}>
        <div data-tb-group="lead" className="flex shrink-0 items-center gap-1.5">
          {lead}
        </div>
        {leftGroups()}
        <span className="min-w-1 flex-1" />
        <div data-tb-group="right" className="flex shrink-0 items-center gap-px">
          {buttons(rightShown)}
          {more}
        </div>
        <Sep />
        {stat}
      </div>
      {/* The same groups, never shown: their widths decide what fits. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex h-0 items-center gap-px overflow-hidden whitespace-nowrap">
        <div data-tb-group="lead" className="flex items-center gap-1.5">
          {view ? <span className="inline-block w-[130px]" /> : null}
        </div>
        {(["history", "style", "marks", "blocks", "media", "insert"] as GroupKey[]).map((k) => (
          <div key={k} data-tb-group={k} className="flex items-center gap-px">
            {k === "style" ? <span className="inline-block w-[84px]" /> : k === "insert" ? <span className="inline-block w-[74px]" /> : (k === "history" ? history : k === "marks" ? marks : k === "blocks" ? blocks : media).map((x) => <span key={x.key} className="inline-block size-7" />)}
          </div>
        ))}
        <div data-tb-group="right" className="flex items-center gap-px">
          {right.map((x) => (
            <span key={x.key} className="inline-block size-7" />
          ))}
          <span className="inline-block size-7" />
        </div>
        <div data-tb-group="stat">
          <span className="text-xs">{t("blk_words", { n: n(s.words) })} · {t("blk_read_min", { n: n(s.minutes) })}</span>
        </div>
      </div>
    </div>
  );
}

// ── find and replace ──────────────────────────────────────────────────────────

export interface FindBarProps {
  commands: BlockEditorCommands | null;
  /** Open with the replace row. */
  replace: boolean;
  canWrite: boolean;
  onClose: () => void;
  /** Text to start with (the selection when it was opened). */
  initial?: string;
}

export function FindBar({ commands, replace: withReplace, canWrite, onClose, initial }: FindBarProps) {
  const { t } = useCms();
  const [q, setQ] = React.useState(initial ?? "");
  const [rep, setRep] = React.useState("");
  const [caseSensitive, setCase] = React.useState(false);
  const [wholeWord, setWhole] = React.useState(false);
  const [showReplace, setShowReplace] = React.useState(withReplace && canWrite);
  const [res, setRes] = React.useState({ count: 0, current: -1 });
  const findRef = React.useRef<HTMLInputElement>(null);
  const repRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => setShowReplace((v) => v || (withReplace && canWrite)), [withReplace, canWrite]);
  React.useEffect(() => {
    (withReplace && canWrite && q ? repRef : findRef).current?.focus();
    findRef.current?.select();
  }, [withReplace]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (commands) setRes(commands.find(q, { caseSensitive, wholeWord }));
  }, [commands, q, caseSensitive, wholeWord]);
  React.useEffect(() => () => commands?.findClear(), [commands]);
  const step = (dir: 1 | -1) => commands && setRes(commands.findStep(dir));
  const close = () => {
    commands?.findClear();
    onClose();
    commands?.focus();
  };
  const doReplace = (all: boolean) => {
    if (!commands || !res.count) return;
    commands.replace(rep, all);
    // The document changes after this: count again on the next frame.
    requestAnimationFrame(() => setRes(commands.find(q, { caseSensitive, wholeWord })));
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if ((e.key === "f" || e.key === "F") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      findRef.current?.select();
    } else if ((e.key === "h" || e.key === "H") && (e.ctrlKey || e.metaKey) && canWrite) {
      e.preventDefault();
      setShowReplace(true);
      requestAnimationFrame(() => repRef.current?.focus());
    }
  };
  const count = !q ? "" : res.count ? t("find_count", { n: res.current + 1, total: res.count }) : t("find_none");
  const small = "inline-grid size-7 shrink-0 place-items-center rounded-md text-foreground/80 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground/45";
  const field = "h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-sky-500/40";
  return (
    <div
      role="search"
      aria-label={t("find_label")}
      data-cms-findbar=""
      className="absolute right-3 top-12 z-40 flex w-[min(380px,calc(100%-1.5rem))] flex-col gap-1.5 rounded-xl border bg-background p-2 shadow-lg"
      style={{ animation: `cms-find-in 140ms ${EASE} both` }}
      onKeyDown={keys}
    >
      <style>{`@keyframes cms-find-in { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }`}</style>
      <div className="flex items-center gap-1">
        <input
          ref={findRef}
          aria-label={t("find_input")}
          placeholder={t("find_input")}
          className={field}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span role="status" aria-live="polite" className="min-w-[3.25rem] shrink-0 text-center text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
        <button type="button" aria-label={t("find_prev")} title={`${t("find_prev")} (Shift+Enter)`} className={small} disabled={!res.count} onClick={() => step(-1)}>
          <ChevronUp className="size-4" />
        </button>
        <button type="button" aria-label={t("find_next")} title={`${t("find_next")} (Enter)`} className={small} disabled={!res.count} onClick={() => step(1)}>
          <ChevronDown className="size-4" />
        </button>
        <button type="button" aria-label={t("find_close")} title={`${t("find_close")} (Esc)`} className={small} onClick={close}>
          <X className="size-4" />
        </button>
      </div>
      {showReplace ? (
        <div className="flex items-center gap-1">
          <input
            ref={repRef}
            aria-label={t("find_replace_input")}
            placeholder={t("find_replace_input")}
            className={field}
            value={rep}
            onChange={(e) => setRep(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doReplace(e.metaKey || e.ctrlKey || e.altKey);
              }
            }}
          />
          <button type="button" className="h-7 shrink-0 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!res.count} onClick={() => doReplace(false)}>
            {t("find_replace")}
          </button>
          <button type="button" className="h-7 shrink-0 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!res.count} onClick={() => doReplace(true)}>
            {t("find_replace_all")}
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-xs text-muted-foreground">
        <label className="inline-flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="size-3.5 accent-sky-600" checked={caseSensitive} onChange={(e) => setCase(e.target.checked)} />
          <CaseSensitive aria-hidden className="size-3.5" />
          {t("find_case")}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="size-3.5 accent-sky-600" checked={wholeWord} onChange={(e) => setWhole(e.target.checked)} />
          <WholeWord aria-hidden className="size-3.5" />
          {t("find_word")}
        </label>
        {!showReplace && canWrite ? (
          <button type="button" className="ml-auto rounded px-1 hover:text-foreground" onClick={() => (setShowReplace(true), requestAnimationFrame(() => repRef.current?.focus()))}>
            {t("find_show_replace")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
