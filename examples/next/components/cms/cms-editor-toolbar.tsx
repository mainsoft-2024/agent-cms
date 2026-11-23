"use client";

// The body editor's top bar: icon buttons with a tooltip (name and shortcut),
// in two zones. Left, editing: history, text style, marks, lists and blocks,
// media, insert (+). Right, after a line, the view: blocks or markdown, find,
// section order, previews, and full screen always last at the far right (the
// same button enters and leaves it). The word count lives in the status line.
// One roving tab stop (role="toolbar", arrow keys move); buttons that do not
// fit go into a More menu. The same buttons work in the block editor (through
// its commands) and in the markdown text box (they edit the text around the
// selection). Also the find and replace bar (Ctrl/Cmd+F, Ctrl+H).

import * as React from "react";
import {
  AppWindow,
  Blocks as BlocksIcon,
  Bold,
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Code,
  CodeXml,
  Columns2,
  Ellipsis,
  FileCode2,
  Heading2,
  Heading3,
  Heading4,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  ListTree,
  Maximize2,
  MessageSquareWarning,
  Minimize2,
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
    if (/^####\s/.test(l)) return "h4";
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
        case "h4":
          return (setLines(() => "#### "), true);
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
        case "columns":
          return (block(":::columns\n:::col\nLeft\n:::col\nRight\n:::", "Left"), true);
        case "toggle":
          return (block(":::toggle Title\nText\n:::", "Title"), true);
        case "html":
          return (block(":::html\n<div></div>\n:::", "<div></div>"), true);
      }
      return false;
    },
    state: (cmd) => {
      if (m.readOnly?.()) return { enabled: false, active: false };
      if (cmd === "undo" || cmd === "redo") return { enabled: typeof document.execCommand === "function", active: false };
      if (["p", "h2", "h3", "h4", "bullet", "number", "todo", "quote", "callout"].includes(cmd)) return { enabled: true, active: lineType() === cmd };
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

/** Reading speed for the word count's minutes: words a minute (most languages)... */
export const READ_WPM = 200;
/** ...and characters a minute for Korean (and Chinese, Japanese). */
export const READ_CPM = 500;

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
  // Korean reads at 500 characters a minute (Hangul syllables, spaces left out), other text at 200
  // words a minute; a body that mixes them adds the two. Chinese and Japanese count like Korean.
  const wide = /[\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/g;
  const syllables = text.match(wide)?.length ?? 0;
  const otherWords = text.replace(wide, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  const minutes = Math.max(1, Math.round(syllables / READ_CPM + otherWords / READ_WPM));
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
  /**
   * Full screen: one button, always the last at the far right, in the page and in full screen. `on` turns
   * its icon into "leave" (Minimize2), its name into "Leave full screen" and sets aria-pressed.
   */
  fullscreen?: { on: boolean; toggle: () => void; buttonRef?: React.Ref<HTMLButtonElement> } | null;
  /** Show the find bar (with replace when true). */
  onFind: (replace: boolean) => void;
  findOpen?: boolean;
  /** The box's label (for screen readers; the switch says what the box is). */
  label?: React.ReactNode;
  /** Drawn inside another bar (the full-screen header): no border or padding of its own. */
  inline?: boolean;
  /**
   * More of the view zone, drawn just before the full-screen button (e.g. the full-screen view options).
   * Mark its buttons `data-tb-item` (tabIndex -1) so the arrow keys reach them.
   */
  extra?: React.ReactNode;
  /** Called after a button changed the text (or opened find): e.g. bring the body into view. */
  onUse?: () => void;
  /** Classes for the bar's outer box (e.g. sticky placement). */
  className?: string;
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
  /** Where its tooltip lines up ("end" near the bar's right edge). */
  tip?: "center" | "start" | "end";
}

/** A shortcut as this computer writes it ("⌘B" / "Ctrl+B"). */
export function shortcut(keys: string): string {
  if (isApple()) return keys.replace(/Mod\+/g, "⌘").replace(/Shift\+/g, "⇧").replace(/Alt\+/g, "⌥");
  return keys.replace(/Mod\+/g, "Ctrl+");
}
const ariaKeys = (keys: string) => [keys.replace(/Mod/g, "Control"), keys.replace(/Mod/g, "Meta")].filter((k, i, a) => a.indexOf(k) === i).join(" ");

/** A small bubble under a button: its name and shortcut. */
function Tip({ text, keys, show, align = "center" }: { text: string; keys?: string; show: boolean; align?: "center" | "start" | "end" }) {
  if (!show) return null;
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute top-[calc(100%+6px)] z-50 inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-xs font-normal text-primary-foreground shadow-md",
        align === "center" ? "left-1/2 -translate-x-1/2" : align === "start" ? "left-0" : "right-0",
      )}
      style={{ animation: `${align === "center" ? "cms-tip-in" : "cms-tip-in-side"} 120ms ${EASE} both` }}
    >
      {text}
      {keys ? <kbd className="font-mono text-[11px] opacity-70">{shortcut(keys)}</kbd> : null}
    </span>
  );
}
const TIP_KEYFRAMES = `@keyframes cms-tip-in { from { opacity: 0; transform: translate(-50%, -2px) } to { opacity: 1; transform: translate(-50%, 0) } } @keyframes cms-tip-in-side { from { opacity: 0; transform: translateY(-2px) } to { opacity: 1; transform: none } }`;

/** The tooltip's keyframes, put in the page once. */
function tipStyle() {
  if (typeof document === "undefined" || document.getElementById("cms-tip-style")) return;
  const el = document.createElement("style");
  el.id = "cms-tip-style";
  el.textContent = TIP_KEYFRAMES;
  document.head.appendChild(el);
}

/** The one tooltip on screen: showing another hides it (a hovered button and a focused one never both talk). */
let shownTip: { hide: () => void } | null = null;

/** Shows the tooltip after a short hover, or at once on keyboard focus. */
function useTip() {
  const [show, setShowState] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const self = React.useRef({ hide: () => setShowState(false) });
  const setShow = (on: boolean) => {
    if (on) {
      if (shownTip && shownTip !== self.current) shownTip.hide();
      shownTip = self.current;
    } else if (shownTip === self.current) shownTip = null;
    setShowState(on);
  };
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => {
    tipStyle();
    const me = self.current;
    return () => {
      clear();
      if (shownTip === me) shownTip = null;
    };
  }, []);
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

/** 32px squares on a desktop, 40px where fingers tap (phone widths, coarse pointers). */
const BTN = "relative inline-grid size-8 shrink-0 place-items-center rounded-md text-foreground/80 outline-none transition-colors duration-100 ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-muted-foreground/45 aria-pressed:bg-muted aria-pressed:text-foreground max-md:size-10 [@media(pointer:coarse)]:size-10";
/** A menu button with text (text style): a row, not a square. */
const WIDE = "inline-flex w-auto items-center gap-1 px-2 text-[13px] max-md:w-auto [@media(pointer:coarse)]:w-auto";

const ToolButton = React.forwardRef<HTMLButtonElement, { b: Btn; t: (k: MessageKey) => string; onRun: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>>(function ToolButton({ b, t, onRun, className, ...rest }, ref) {
  const tip = useTip();
  const I = b.icon;
  return (
    <button
      ref={ref}
      type="button"
      data-tb-item=""
      data-tb-key={b.key}
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
      <Tip text={t(b.label)} keys={b.keys} show={tip.show} align={b.tip} />
    </button>
  );
});

/**
 * An icon button with the toolbar's tooltip (name and shortcut), for bars around the editor
 * (the full-screen header). Children are optional so it can be a menu trigger's child.
 */
export const TipButton = React.forwardRef<HTMLButtonElement, { label: string; tip?: string; keys?: string; tipAlign?: "center" | "start" | "end"; children?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>>(function TipButton({ label, tip: tipText, keys, tipAlign, children, className, onClick, ...rest }, ref) {
  const tip = useTip();
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-keyshortcuts={keys ? ariaKeys(keys) : undefined}
      className={cn(BTN, "size-8", className)}
      onClick={(e) => {
        tip.hide();
        onClick?.(e);
      }}
      {...tip.props}
      {...rest}
    >
      {children}
      <Tip text={tipText ?? label} keys={keys} show={tip.show} align={tipAlign} />
    </button>
  );
});

/** A link drawn like `TipButton` (an icon with the toolbar's tooltip), e.g. the public page in a header. */
export const TipLink = React.forwardRef<HTMLAnchorElement, { label: string; tipAlign?: "center" | "start" | "end"; children?: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>>(function TipLink({ label, tipAlign, children, className, ...rest }, ref) {
  const tip = useTip();
  return (
    <a ref={ref} aria-label={label} className={cn(BTN, className)} {...tip.props} {...rest}>
      {children}
      <Tip text={label} show={tip.show} align={tipAlign} />
    </a>
  );
});

/**
 * A button that opens a menu (text style, insert, More, full screen's view options), with the toolbar's
 * tooltip. It *is* the menu's trigger, with no `asChild`: the Radix and the Base UI flavours of
 * shadcn/ui both draw their trigger as a button and pass these props on. Put it inside a `DropdownMenu`.
 */
export function TipMenuTrigger({ label, keys, children, wide, disabled, tipAlign, className, ...rest }: { label: string; keys?: string; children?: React.ReactNode; wide?: boolean; disabled?: boolean; tipAlign?: "center" | "start" | "end" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const tip = useTip();
  return (
    <DropdownMenuTrigger
      type="button"
      data-tb-item=""
      aria-label={label}
      disabled={disabled}
      tabIndex={-1}
      className={cn(BTN, wide && WIDE, className)}
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
      {...tip.props}
      {...rest}
      onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
        tip.hide();
        rest.onPointerDown?.(e);
      }}
      onFocus={(e: React.FocusEvent<HTMLButtonElement>) => {
        tip.props.onFocus(e);
        rest.onFocus?.(e);
      }}
      onBlur={(e: React.FocusEvent<HTMLButtonElement>) => {
        tip.props.onBlur();
        rest.onBlur?.(e);
      }}
    >
      {children}
      <Tip text={label} keys={keys} show={tip.show} align={tipAlign} />
    </DropdownMenuTrigger>
  );
}

const Sep = (p: { "data-tb-m"?: string }) => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" {...p} />;

// ── what fits ─────────────────────────────────────────────────────────────────

/**
 * The bar's groups, in the order they are drawn. The editing groups on the left have a line between
 * them; "view" is the right zone (find, section order, previews), after one line of its own.
 */
export type ToolbarGroup = "history" | "style" | "marks" | "lists" | "blocks" | "media" | "insert" | "view";
const LEFT_GROUPS: ToolbarGroup[] = ["history", "style", "marks", "lists", "blocks", "media", "insert"];

/**
 * How long each item stays when the bar gets narrow: the lowest goes first. The rarer blocks and
 * marks go first, then find, lists, the menus and the everyday marks; history and media stay longest
 * among the editing buttons, and the view buttons (previews, section order) are the last to go. The
 * view switch and the full-screen button never go into More: they are counted as fixed.
 */
export const TOOLBAR_PRIORITY: Readonly<Record<string, number>> = {
  hr: 1,
  codeblock: 2,
  table: 3,
  callout: 4,
  quote: 5,
  todo: 6,
  strike: 7,
  code: 8,
  find: 9,
  number: 10,
  bullet: 11,
  style: 12,
  insert: 13,
  link: 14,
  italic: 15,
  bold: 16,
  redo: 17,
  undo: 18,
  media: 19,
  window: 20,
  side: 21,
  outline: 22,
};

export interface FitItem {
  key: string;
  group: ToolbarGroup;
  /** Width it takes in the bar (gap included). */
  width: number;
}

/**
 * Which items to hide so the bar fits `avail` pixels. `fixed` is what never leaves (padding, the
 * label, the line before the view zone, the view switch, the full-screen button, the spacer); `sep`
 * a line between editing groups; `more` the More button, counted once anything goes into it. Items
 * leave one by one by `TOOLBAR_PRIORITY`; a group left empty also loses its line.
 */
export function fitToolbar(o: { avail: number; fixed: number; items: readonly FitItem[]; sep: number; more: number; leadSep: boolean }): Set<string> {
  const hidden = new Set<string>();
  const total = () => {
    let sum = o.fixed;
    let before = o.leadSep;
    for (const g of LEFT_GROUPS) {
      const shown = o.items.filter((i) => i.group === g && !hidden.has(i.key));
      if (!shown.length) continue;
      sum += (before ? o.sep : 0) + shown.reduce((s, i) => s + i.width, 0);
      before = true;
    }
    for (const i of o.items) if (i.group === "view" && !hidden.has(i.key)) sum += i.width;
    if (hidden.size) sum += o.more;
    return sum;
  };
  const order = [...o.items].sort((a, b) => (TOOLBAR_PRIORITY[a.key] ?? 50) - (TOOLBAR_PRIORITY[b.key] ?? 50));
  for (const i of order) {
    if (total() <= o.avail) break;
    hidden.add(i.key);
  }
  return hidden;
}

/** The width an item takes beyond its own box (the bar's 1px gap). */
const GAP = 1;

interface Slot {
  key: string;
  group: ToolbarGroup;
  btn?: Btn;
}

export function EditorToolbar({ commands, tick, view, onView, canWrite, body, outline, onMedia, sidePreview, previewWindow, fullscreen, onFind, findOpen, label, inline, extra, onUse, className }: EditorToolbarProps) {
  const { t, locale } = useCms();
  void tick;
  void body;
  const st = (cmd: EditorCommand) => (commands && canWrite ? commands.state(cmd) : { enabled: false, active: false });
  const run = (cmd: EditorCommand) => {
    commands?.run(cmd);
    onUse?.();
  };
  const b = (key: string, labelKey: MessageKey, icon: Icon, cmd: EditorCommand, keys?: string, toggle = false): Btn => {
    const s = st(cmd);
    return { key, label: labelKey, icon, cmd, keys, disabled: !s.enabled, pressed: toggle ? s.active : undefined };
  };

  const history = [b("undo", "tb_undo", Undo2, "undo", "Mod+Z"), b("redo", "tb_redo", Redo2, "redo", isApple() ? "Mod+Shift+Z" : "Mod+Y")];
  const marks = [b("bold", "tb_bold", Bold, "bold", "Mod+B", true), b("italic", "tb_italic", Italic, "italic", "Mod+I", true), b("strike", "tb_strike", Strikethrough, "strike", "Mod+Shift+X", true), b("code", "tb_code", Code, "code", "Mod+E", true), b("link", "tb_link", LinkIcon, "link", "Mod+K", true)];
  const lists = [
    b("bullet", "tb_bullet", List, "bullet", undefined, true),
    b("number", "tb_number", ListOrdered, "number", undefined, true),
    b("todo", "tb_todo", ListChecks, "todo", undefined, true),
    b("quote", "tb_quote", TextQuote, "quote", undefined, true),
    b("callout", "tb_callout", MessageSquareWarning, "callout", undefined, true),
  ];
  const blocks = [b("table", "tb_table", Table, "table"), b("codeblock", "tb_codeblock", SquareCode, "codeblock"), b("hr", "tb_hr", Minus, "hr")];
  const styles: { cmd: EditorCommand; label: MessageKey; icon: Icon; keys?: string }[] = [
    { cmd: "p", label: "tb_style_p", icon: Pilcrow, keys: "Mod+Alt+0" },
    { cmd: "h2", label: "tb_style_h2", icon: Heading2, keys: "Mod+Alt+2" },
    { cmd: "h3", label: "tb_style_h3", icon: Heading3, keys: "Mod+Alt+3" },
    { cmd: "h4", label: "tb_style_h4", icon: Heading4 },
  ];
  const styleNow = styles.find((s) => st(s.cmd).active) ?? styles[0];
  const styleEnabled = styles.some((s) => st(s.cmd).enabled);
  const inserts: { cmd: EditorCommand; label: MessageKey; icon: Icon; hint: string }[] = [
    { cmd: "steps", label: "blk_steps", icon: ListOrdered, hint: ":::steps" },
    { cmd: "card", label: "blk_card", icon: SquareArrowOutUpRight, hint: ":::card" },
    { cmd: "video", label: "blk_video", icon: Clapperboard, hint: ":::video" },
    { cmd: "snippet", label: "blk_snippet", icon: Puzzle, hint: "[[snippet:…]]" },
    { cmd: "columns", label: "blk_slash_columns", icon: Columns2, hint: ":::columns" },
    { cmd: "toggle", label: "blk_t_toggle", icon: ListCollapse, hint: ":::toggle" },
    { cmd: "html", label: "blk_slash_html", icon: CodeXml, hint: ":::html" },
  ];
  const insertEnabled = !!commands && canWrite && st("steps").enabled;
  const media: Btn[] = onMedia ? [{ key: "media", label: "media_insert_button", icon: ImagePlus, run: onMedia, disabled: !canWrite }] : [];

  // The view zone: what the person sees, not what the text says. Tooltips line up with the right edge.
  const viewBtns: Btn[] = [
    { key: "find", label: "tb_find", icon: Search, keys: "Mod+F", run: () => (onFind(false), onUse?.()), pressed: !!findOpen, tip: "end" },
    ...(outline ? [{ key: "outline", label: "sections_order" as MessageKey, icon: ListTree, run: outline.toggle, pressed: outline.on, tip: "end" as const }] : []),
    ...(sidePreview ? [{ key: "side", label: "blk_preview_side" as MessageKey, icon: PanelRight, run: sidePreview.toggle, pressed: sidePreview.on, tip: "end" as const }] : []),
    ...(previewWindow ? [{ key: "window", label: "blk_preview_window" as MessageKey, icon: AppWindow, run: previewWindow.toggle, pressed: previewWindow.on, tip: "end" as const }] : []),
  ];
  // Full screen: the same button enters and leaves, always last at the far right.
  const fullBtn: Btn | null = fullscreen
    ? { key: "full", label: fullscreen.on ? "focus_exit" : "focus_enter", icon: fullscreen.on ? Minimize2 : Maximize2, keys: "Mod+Shift+F", run: fullscreen.toggle, pressed: fullscreen.on, ref: fullscreen.buttonRef, tip: "end" }
    : null;
  const viewSwitchBtns: Btn[] =
    view && onView
      ? [
          { key: "view-blocks", label: "tb_view_blocks", icon: BlocksIcon, run: () => onView("blocks"), pressed: view === "blocks" },
          { key: "view-markdown", label: "tb_view_markdown", icon: FileCode2, run: () => onView("markdown"), pressed: view === "markdown" },
        ]
      : [];

  const slots: Slot[] = [
    ...history.map((x) => ({ key: x.key, group: "history" as const, btn: x })),
    { key: "style", group: "style" },
    ...marks.map((x) => ({ key: x.key, group: "marks" as const, btn: x })),
    ...lists.map((x) => ({ key: x.key, group: "lists" as const, btn: x })),
    ...blocks.map((x) => ({ key: x.key, group: "blocks" as const, btn: x })),
    ...media.map((x) => ({ key: x.key, group: "media" as const, btn: x })),
    { key: "insert", group: "insert" },
    ...viewBtns.map((x) => ({ key: x.key, group: "view" as const, btn: x })),
  ];

  // ── which items fit; the rest go into More ──
  const barRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const fitRef = React.useRef<() => void>(() => undefined);
  fitRef.current = () => {
    const bar = barRef.current;
    const m = measureRef.current;
    if (!bar || !m) return;
    const avail = bar.clientWidth;
    if (!avail) return;
    // Width with the side margins (the group line has some).
    const w = (k: string) => {
      const el = m.querySelector<HTMLElement>(`[data-tb-m="${k}"]`);
      if (!el) return 0;
      const st = getComputedStyle(el);
      return el.getBoundingClientRect().width + (parseFloat(st.marginLeft) || 0) + (parseFloat(st.marginRight) || 0);
    };
    const cs = getComputedStyle(bar);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const lead = bar.querySelector<HTMLElement>('[data-tb-group="lead"]')?.getBoundingClientRect().width ?? 0;
    const items: FitItem[] = slots.map((x) => ({ key: x.key, group: x.group, width: w(x.key) + GAP }));
    const sep = w("sep") + GAP;
    // Padding, the label, the line before the view zone, the view switch and full screen (they never
    // leave), the spacer (at least 4px) and 2px to spare for rounding.
    const extraW = bar.querySelector<HTMLElement>("[data-tb-extra]")?.getBoundingClientRect().width ?? 0;
    const fixed = pad + (lead ? lead + GAP : 0) + (extraW ? extraW + GAP : 0) + sep + (viewSwitchBtns.length ? w("view") + GAP : 0) + (fullBtn ? w("full") + GAP : 0) + 4 + GAP + 2;
    const out = fitToolbar({ avail, fixed, items, sep, more: w("more") + GAP, leadSep: false });
    setHidden((old) => (old.size === out.size && [...out].every((k) => old.has(k)) ? old : out));
  };
  // Fit again when the bar or what is in it changes size, and when the set of buttons changes.
  const signature = `${slots.map((x) => x.key).join(",")}|${view ?? ""}|${styleNow.cmd}|${locale}|${inline ? 1 : 0}|${fullBtn ? 1 : 0}`;
  React.useLayoutEffect(() => fitRef.current(), [signature]);
  React.useLayoutEffect(() => {
    const bar = barRef.current;
    const m = measureRef.current;
    if (!bar || !m || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(bar);
    ro.observe(m);
    const lead = bar.querySelector('[data-tb-group="lead"]');
    if (lead) ro.observe(lead);
    return () => ro.disconnect();
  }, []);

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
    const k = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    setFocusKey(k);
    list[k].focus();
  };
  const onFocusIn = (e: React.FocusEvent) => {
    const at = items().indexOf(e.target as HTMLButtonElement);
    if (at >= 0 && at !== focusKey) setFocusKey(at);
  };

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
  const toText = () => commands?.focus();

  const styleItems = styles.map((x) => (
    <DropdownMenuItem key={x.cmd} disabled={!st(x.cmd).enabled} onClick={act(() => run(x.cmd), toText)} className="gap-2">
      <x.icon className="size-4" />
      <span className="grow">{t(x.label)}</span>
      {st(x.cmd).active ? <Check aria-hidden className="size-3.5 text-muted-foreground" /> : null}
      {x.keys ? <kbd className="font-mono text-[11px] text-muted-foreground">{shortcut(x.keys)}</kbd> : null}
    </DropdownMenuItem>
  ));
  const insertItems = inserts.map((x) => (
    <DropdownMenuItem key={x.cmd} onClick={act(() => run(x.cmd))} className="gap-2">
      <x.icon className="size-4" />
      <span className="grow">{t(x.label)}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{x.hint}</span>
    </DropdownMenuItem>
  ));

  const styleMenu = (
    <DropdownMenu modal={false}>
      <TipMenuTrigger onFocus={onTriggerFocus} label={t("tb_style")} wide disabled={!styleEnabled} className="min-w-[5rem] justify-between">
          <span className="truncate">{t(styleNow.label)}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </TipMenuTrigger>
      <DropdownMenuContent align="start" className="w-52" {...closeFocus(toText)}>
        {styleItems}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // Insert: a "+" like the other icons; its tooltip says "Insert", its name says what it puts in.
  const insertMenu = (
    <DropdownMenu modal={false}>
      <TipMenuTrigger onFocus={onTriggerFocus} label={t("tb_insert")} disabled={!insertEnabled}>
          <Plus className="size-4" />
        </TipMenuTrigger>
      <DropdownMenuContent align="start" className="w-60" {...closeFocus()}>
        {insertItems}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const runBtn = (x: Btn) => (x.cmd ? run(x.cmd) : x.run?.());
  const draw = (x: Slot) => (x.key === "style" ? <React.Fragment key="style">{styleMenu}</React.Fragment> : x.key === "insert" ? <React.Fragment key="insert">{insertMenu}</React.Fragment> : <ToolButton key={x.key} ref={x.btn!.ref} b={x.btn!} t={t} onRun={() => runBtn(x.btn!)} />);

  const left: React.ReactNode[] = [];
  let lineBefore = false;
  for (const g of LEFT_GROUPS) {
    const shown = slots.filter((x) => x.group === g && !hidden.has(x.key));
    if (!shown.length) continue;
    if (lineBefore) left.push(<Sep key={`sep-${g}`} />);
    left.push(
      <div key={g} data-tb-group={g} className="flex shrink-0 items-center gap-px">
        {shown.map(draw)}
      </div>,
    );
    lineBefore = true;
  }

  // Hidden items in More: flat, in toolbar order, a line between groups; text style and insert stay submenus.
  const moreSlots = slots.filter((x) => hidden.has(x.key));
  const moreBody: React.ReactNode[] = [];
  let lastGroup: string | null = null;
  for (const x of moreSlots) {
    if (lastGroup !== null && lastGroup !== x.group) moreBody.push(<DropdownMenuSeparator key={`sep-${x.key}`} />);
    lastGroup = x.group;
    if (x.key === "style")
      moreBody.push(
        <DropdownMenuSub key="style">
          <DropdownMenuSubTrigger className="gap-2" disabled={!styleEnabled}>
            <Heading2 className="size-4" />
            {t("tb_style")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">{styleItems}</DropdownMenuSubContent>
        </DropdownMenuSub>,
      );
    else if (x.key === "insert")
      moreBody.push(
        <DropdownMenuSub key="insert">
          <DropdownMenuSubTrigger className="gap-2" disabled={!insertEnabled}>
            <Plus className="size-4" />
            {t("tb_insert")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">{insertItems}</DropdownMenuSubContent>
        </DropdownMenuSub>,
      );
    else {
      const btn = x.btn!;
      moreBody.push(
        <DropdownMenuItem key={x.key} data-tb-more={x.key} disabled={btn.disabled} onClick={act(() => runBtn(btn), btn.cmd ? toText : undefined)} className="gap-2">
          <btn.icon className="size-4" />
          <span className="grow">{t(btn.label)}</span>
          {btn.pressed ? <Check aria-hidden className="size-3.5 text-muted-foreground" /> : null}
          {btn.keys ? <kbd className="font-mono text-[11px] text-muted-foreground">{shortcut(btn.keys)}</kbd> : null}
        </DropdownMenuItem>,
      );
    }
  }
  const more = moreSlots.length ? (
    <DropdownMenu modal={false}>
      <TipMenuTrigger onFocus={onTriggerFocus} label={t("tb_more")}>
          <Ellipsis className="size-4" />
        </TipMenuTrigger>
      <DropdownMenuContent align="start" className="w-60" {...closeFocus()}>
        {moreBody}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  // Blocks or markdown: two icons side by side, the one shown pressed (a segmented switch).
  const viewSwitch = viewSwitchBtns.length ? (
    <div role="group" aria-label={t("blk_view")} data-tb-group="switch" className="flex shrink-0 items-center gap-px rounded-md bg-muted/70">
      {viewSwitchBtns.map((x) => (
        <ToolButton key={x.key} b={x} t={t} onRun={() => runBtn(x)} className="text-muted-foreground hover:bg-background/70 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm aria-pressed:ring-1 aria-pressed:ring-border" />
      ))}
    </div>
  ) : null;

  return (
    <div className={cn("relative min-w-0", !inline && "border-b", inline && "h-full flex-1", className)}>
      <div ref={barRef} role="toolbar" aria-label={t("tb_label")} aria-orientation="horizontal" className={cn("flex min-w-0 items-center gap-px overflow-visible", inline ? "h-full" : "h-11 px-2 sm:px-3 max-md:h-12 [@media(pointer:coarse)]:h-12")} onKeyDown={onKeyDown} onFocus={onFocusIn}>
        {label ? (
          <div data-tb-group="lead" className="flex shrink-0 items-center gap-1.5 empty:hidden">
            {label}
          </div>
        ) : null}
        {left}
        {more}
        <span className="min-w-1 flex-1" />
        <Sep />
        <div data-tb-group="view" className="flex shrink-0 items-center gap-px">
          {viewSwitch}
          {viewSwitch ? <span aria-hidden className="w-1 shrink-0" /> : null}
          {slots.filter((x) => x.group === "view" && !hidden.has(x.key)).map(draw)}
          {extra ? (
            <div data-tb-extra="" className="flex shrink-0 items-center gap-px">
              {extra}
            </div>
          ) : null}
          {fullBtn ? <ToolButton key="full" ref={fullBtn.ref} b={fullBtn} t={t} onRun={() => runBtn(fullBtn)} /> : null}
        </div>
      </div>
      {/* Copies of the items, never shown: their widths decide what fits. The zero-size box around them keeps
          their full width from widening the scrolling page (a sideways scrollbar under a narrow window). */}
      <div aria-hidden className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden">
        <div ref={measureRef} data-tb-measure="" className="flex h-0 w-max items-center gap-px whitespace-nowrap">
          {slots.map((x) =>
            x.key === "style" ? (
              <span key={x.key} data-tb-m="style" className={cn(BTN, WIDE, "min-w-[5rem] justify-between")}>
                <span className="truncate">{t(styleNow.label)}</span>
                <ChevronDown className="size-3" />
              </span>
            ) : (
              <span key={x.key} data-tb-m={x.key} className={BTN} />
            ),
          )}
          <span data-tb-m="more" className={BTN} />
          <span data-tb-m="full" className={BTN} />
          <span data-tb-m="view" className="flex shrink-0 gap-px">
            <span className={BTN} />
            <span className={BTN} />
            <span className="w-1 shrink-0" />
          </span>
          <Sep data-tb-m="sep" />
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
  className?: string;
}

export function FindBar({ commands, replace: withReplace, canWrite, onClose, initial, className }: FindBarProps) {
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
      className={cn("absolute right-3 top-12 z-40 flex w-[min(380px,calc(100%-1.5rem))] flex-col gap-1.5 rounded-xl border bg-background p-2 shadow-lg", className)}
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
