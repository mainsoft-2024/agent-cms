// agent-cms registry: cms-doc-editor (0.11.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// What the body editor does besides typing: the order of the sections,
// keeping the preview beside the text you are looking at, and going from a
// block in the preview to its lines in the text.
"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCms } from "./use-cms";

// ── sections ─────────────────────────────────────────────────────────────────

export interface BodySection {
  title: string;
  level: 1 | 2;
  /** Where the heading line starts, and where the next section starts. */
  start: number;
  end: number;
  /** The first line of text under the heading. */
  excerpt: string;
}

/** The `#` / `##` sections of a body, the way `splitSections` cuts them (headings inside code fences do not count). */
export function bodySections(body: string): BodySection[] {
  const out: BodySection[] = [];
  let at = 0;
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (out.length) out[out.length - 1].end = at;
      out.push({ title: h[2], level: h[1].length as 1 | 2, start: at, end: body.length, excerpt: "" });
    } else if (out.length && !out[out.length - 1].excerpt && line.trim() && !/^(```|!\[|---+$)/.test(line.trim())) {
      out[out.length - 1].excerpt = line
        .trim()
        .replace(/^(#{3,6}|>|[-*+]|\d+\.)\s+/, "")
        .replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, "$1")
        .slice(0, 120);
    }
    at += line.length + 1;
  }
  return out;
}

/** `body` with section `from` moved to place `to` (both count sections, 0-based). The text before the first heading stays where it is. */
export function moveSection(body: string, from: number, to: number): string {
  const secs = bodySections(body);
  if (from === to || !secs[from] || !secs[to]) return body;
  const parts = secs.map((s) => body.slice(s.start, s.end).replace(/\s+$/, ""));
  const [moved] = parts.splice(from, 1);
  parts.splice(to, 0, moved);
  return body.slice(0, secs[0].start) + parts.join("\n\n") + (/\n$/.test(body) ? "\n" : "");
}

export interface SectionMove {
  title: string;
  /** 1-based place the section is in now. */
  place: number;
  total: number;
}

export interface SectionsOrderProps {
  body: string;
  onChange: (body: string, moved: SectionMove) => void;
  /** Someone pressed a section's title: show it in the text. */
  onOpen?: (section: BodySection) => void;
  className?: string;
}

/**
 * The body as one card per section. Drag a card, or use its arrows, to
 * change the order. Text before the first heading is shown but stays first.
 */
export function SectionsOrder({ body, onChange, onOpen, className }: SectionsOrderProps) {
  const { t } = useCms();
  const secs = React.useMemo(() => bodySections(body), [body]);
  const intro = secs.length ? body.slice(0, secs[0].start).trim() : body.trim();
  const list = React.useRef<HTMLOListElement>(null);
  const [drag, setDrag] = React.useState<number | null>(null);
  const [slot, setSlot] = React.useState<number | null>(null);
  const focusNext = React.useRef<{ i: number; dir: "up" | "down" } | null>(null);

  // After a move by keyboard, stay on the same card's arrow (or its other arrow at either end).
  React.useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const row = list.current?.querySelector(`[data-section="${f.i}"]`);
    (row?.querySelector<HTMLButtonElement>(`[data-move="${f.dir}"]:not(:disabled)`) ?? row?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)"))?.focus();
  }, [body]);

  const move = (from: number, to: number, dir?: "up" | "down") => {
    if (to < 0 || to >= secs.length || from === to) return;
    if (dir) focusNext.current = { i: to, dir };
    onChange(moveSection(body, from, to), { title: secs[from].title, place: to + 1, total: secs.length });
  };
  const drop = () => {
    // `slot` is the gap the card goes into: 0 is before the first card.
    if (drag !== null && slot !== null) move(drag, slot > drag ? slot - 1 : slot);
    setDrag(null);
    setSlot(null);
  };

  return (
    <ol ref={list} aria-label={t("sections_order")} className={cn("flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-3", className)} onDragOver={(e) => drag !== null && e.preventDefault()} onDrop={drop}>
      {intro ? (
        <li className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <span className="w-3.5 shrink-0" />
          <span className="shrink-0 text-xs">{t("section_intro")}</span>
          <span className="min-w-0 flex-1 truncate">{intro.split("\n")[0].slice(0, 120)}</span>
        </li>
      ) : null}
      {secs.map((s, i) => (
        <li
          key={`${i}:${s.title}`}
          data-section={i}
          draggable
          onDragStart={(e) => {
            setDrag(i);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", s.title);
          }}
          onDragEnd={() => {
            setDrag(null);
            setSlot(null);
          }}
          onDragOver={(e) => {
            if (drag === null) return;
            const box = e.currentTarget.getBoundingClientRect();
            setSlot(e.clientY > box.top + box.height / 2 ? i + 1 : i);
          }}
          className={cn(
            "relative flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm",
            drag === i && "opacity-50",
            // A line where the card would land (not next to the card itself: that is no move).
            drag !== null && slot === i && slot !== drag && slot !== drag + 1 && "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded-full before:bg-primary",
            drag !== null && slot === i + 1 && i === secs.length - 1 && slot !== drag + 1 && "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-primary"
          )}
        >
          <GripVertical aria-hidden className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
          <span aria-hidden className="w-5 shrink-0 font-mono text-xs text-muted-foreground">
            {s.level === 1 ? "#" : "##"}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            {onOpen ? (
              <button type="button" className="min-w-0 shrink truncate rounded-sm text-left font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(s)}>
                {s.title}
              </button>
            ) : (
              <span className="min-w-0 shrink truncate font-semibold">{s.title}</span>
            )}
            <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">{s.excerpt}</span>
          </span>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" data-move="up" disabled={i === 0} aria-label={t("section_up", { title: s.title })} onClick={() => move(i, i - 1, "up")}>
            <ArrowUp aria-hidden className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" data-move="down" disabled={i === secs.length - 1} aria-label={t("section_down", { title: s.title })} onClick={() => move(i, i + 1, "down")}>
            <ArrowDown aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </li>
      ))}
    </ol>
  );
}

// ── lines of the text box ────────────────────────────────────────────────────

/** Where 1-based `line` starts in `text`, and where `endLine` ends. */
export function lineRange(text: string, line: number, endLine = line): [number, number] {
  let start = 0;
  for (let i = 1; i < line; i++) {
    const n = text.indexOf("\n", start);
    if (n < 0) return [text.length, text.length];
    start = n + 1;
  }
  let end = start;
  for (let i = line; i <= endLine; i++) {
    const n = text.indexOf("\n", end);
    if (n < 0) return [start, text.length];
    end = i === endLine ? n : n + 1;
  }
  return [start, end];
}

/** The 1-based line the character at `offset` is on. */
export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * How far down (px, inside the box's scrolled content) each 1-based line
 * starts. Long lines wrap, so this lays the text out once in a hidden copy
 * with the box's font and width.
 */
export function lineTops(el: HTMLTextAreaElement, text: string, lines: number[]): number[] {
  const cs = getComputedStyle(el);
  const copy = document.createElement("div");
  Object.assign(copy.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-99999px",
    boxSizing: "border-box",
    width: `${el.clientWidth}px`,
    font: cs.font,
    letterSpacing: cs.letterSpacing,
    lineHeight: cs.lineHeight,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    paddingRight: cs.paddingRight,
    tabSize: cs.tabSize,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  const marks = new Map<number, HTMLSpanElement>();
  let at = 0;
  for (const l of [...new Set(lines)].sort((a, b) => a - b)) {
    const [start] = lineRange(text, l);
    copy.append(text.slice(at, start));
    const mark = document.createElement("span");
    mark.textContent = "\u200b";
    copy.append(mark);
    marks.set(l, mark);
    at = start;
  }
  copy.append(`${text.slice(at)}\n`);
  document.body.append(copy);
  const tops = lines.map((l) => marks.get(l)?.offsetTop ?? 0);
  copy.remove();
  return tops;
}

// ── the preview beside the text ──────────────────────────────────────────────

export interface PreviewSync {
  /** Bring the block that holds `line` into view in the preview (after the cursor moved). */
  reveal: (line: number) => void;
  /** Select lines in the text box and bring them into view, leaving the preview where it is. */
  select: (line: number, endLine: number) => void;
}

/**
 * Keeps the text box and the preview on the same part of the document.
 * Every top-level block in the preview says which source lines it came from
 * (`data-line`); scrolling either side moves the other so the same block is
 * at the top, with the distance between two blocks stretched to fit.
 *
 * `on` turns following on scroll off (one pane at a time on a phone);
 * `select` works either way. `stamp` is anything that changes the layout
 * of the preview without changing the text (its width).
 */
export function usePreviewSync(box: React.RefObject<HTMLTextAreaElement | null>, pane: React.RefObject<HTMLElement | null>, text: string, on: boolean, stamp?: unknown): PreviewSync {
  const textRef = React.useRef(text);
  textRef.current = text;
  const map = React.useRef<{ a: number[]; b: number[] } | null>(null);
  const lock = React.useRef<{ who: "box" | "pane" | null; timer: number }>({ who: null, timer: 0 });
  const hold = React.useCallback((who: "box" | "pane") => {
    window.clearTimeout(lock.current.timer);
    lock.current = { who, timer: window.setTimeout(() => (lock.current.who = null), 160) };
  }, []);

  React.useEffect(() => {
    map.current = null;
  }, [text, stamp]);

  React.useEffect(() => {
    const el = box.current;
    const pv = pane.current;
    if (!on || !el || !pv) return;
    const build = () => {
      const blocks = [...pv.querySelectorAll<HTMLElement>("[data-line]")];
      const zero = pv.getBoundingClientRect().top - pv.scrollTop;
      const tops = lineTops(el, textRef.current, blocks.map((m) => Number(m.dataset.line)));
      const a = [0];
      const b = [0];
      blocks.forEach((m, i) => {
        const y = m.getBoundingClientRect().top - zero;
        if (tops[i] > a[a.length - 1] && y > b[b.length - 1]) (a.push(tops[i]), b.push(y));
      });
      a.push(Math.max(a[a.length - 1] + 1, el.scrollHeight));
      b.push(Math.max(b[b.length - 1] + 1, pv.scrollHeight));
      return (map.current = { a, b });
    };
    const convert = (y: number, from: number[], to: number[], fromEnd: number, toEnd: number) => {
      if (y <= 0) return 0;
      if (y >= fromEnd - 1) return toEnd; // the two ends meet, whatever the heights
      let i = 1;
      while (i < from.length - 1 && from[i] <= y) i++;
      return to[i - 1] + ((y - from[i - 1]) / (from[i] - from[i - 1] || 1)) * (to[i] - to[i - 1]);
    };
    const onBox = () => {
      if (lock.current.who === "pane") return;
      const m = map.current ?? build();
      hold("box");
      pv.scrollTop = convert(el.scrollTop, m.a, m.b, el.scrollHeight - el.clientHeight, pv.scrollHeight - pv.clientHeight);
    };
    const onPane = () => {
      if (lock.current.who === "box") return;
      const m = map.current ?? build();
      hold("pane");
      el.scrollTop = convert(pv.scrollTop, m.b, m.a, pv.scrollHeight - pv.clientHeight, el.scrollHeight - el.clientHeight);
    };
    const stale = () => {
      map.current = null;
    };
    el.addEventListener("scroll", onBox, { passive: true });
    pv.addEventListener("scroll", onPane, { passive: true });
    pv.addEventListener("load", stale, true); // a picture arrived: heights changed
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(stale);
    ro?.observe(el);
    ro?.observe(pv);
    return () => {
      el.removeEventListener("scroll", onBox);
      pv.removeEventListener("scroll", onPane);
      pv.removeEventListener("load", stale, true);
      ro?.disconnect();
    };
  }, [box, pane, on, hold]);

  return React.useMemo<PreviewSync>(
    () => ({
      reveal(line) {
        const pv = pane.current;
        if (!on || !pv) return;
        let block: HTMLElement | null = null;
        for (const m of pv.querySelectorAll<HTMLElement>("[data-line]")) {
          if (Number(m.dataset.line) > line) break;
          block = m;
        }
        if (!block) return;
        const view = pv.getBoundingClientRect();
        const r = block.getBoundingClientRect();
        if (r.top >= view.top && r.top <= view.bottom - 48) return; // already in view
        hold("box");
        pv.scrollTop += r.top - view.top - view.height / 4;
      },
      select(line, endLine) {
        const el = box.current;
        if (!el) return;
        const [start, end] = lineRange(textRef.current, line, endLine);
        el.focus({ preventScroll: true });
        el.setSelectionRange(start, end);
        const [top] = lineTops(el, textRef.current, [line]);
        if (top >= el.scrollTop && top <= el.scrollTop + el.clientHeight - 48) return;
        hold("pane");
        el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      },
    }),
    [box, pane, on, hold]
  );
}
