"use client";
// agent-cms: the block editor (Notion-style) for the document body.
// Written for this CMS, no editor library: every block is its own small
// editable element, and every change goes through plain functions
// (cms-blocks-convert.ts, cms-blocks-tree.ts, cms-blocks-inline.ts) that are
// tested in node.
//
// The body is still stored as markdown. This editor reads markdown, shows
// blocks, and writes markdown back:
// - opening a document and not touching it never changes a byte of it;
// - a block that was not touched writes its original text back;
// - what has no block of its own (HTML, page links, callouts with several
//   paragraphs...) is drawn as it will look and edited as markdown in place.
//
// What it does: / menu, markdown typed by hand (`## `, `- `, `1. `, `[] `,
// `> `, `>> `, `**bold**`, `` `code` ``...), a toolbar over selected text,
// links, blocks inside blocks (nested lists with Tab and Shift+Tab, toggles,
// columns), tables edited cell by cell, pictures with captions; block
// handles: drag to move (a picture of what moves follows the pointer, the
// page scrolls along, drop beside a block to make columns, Alt copies),
// click for a menu you can search (turn into, duplicate, move, indent, copy,
// delete); selecting blocks with Esc, Shift, dragging across them or drawing
// a box from the margin; copy and paste as markdown, pasted or dropped images
// uploaded to the media library, its own undo history, Korean and other IME
// input.
//
// Install: npx @mainsoft/agent-cms add cms-block-editor
// Use: <CmsProvider slots={{ blockEditor: CmsBlockEditor }}> (load it lazily).

import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Columns2,
  Columns3,
  CodeXml,
  Copy,
  CopyPlus,
  ExternalLink,
  GripVertical,
  Heading2,
  Heading3,
  ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Info,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  Minus,
  MoreHorizontal,
  MoveDown,
  MoveUp,
  Pencil,
  Pilcrow,
  Plus,
  Quote,
  Search,
  Strikethrough,
  Table,
  Trash2,
  Unlink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  blockPlain,
  blocksToClipboard,
  blocksToMarkdown,
  childrenOf,
  holdsBlocks,
  isList,
  isText,
  markdownToBlocks,
  newId,
  sameMarkdown,
  type EBlock,
  type TableAlign,
  type TableBlock,
  type TextBlock,
  type TextType,
  type Tone,
} from "./cms-blocks-convert";
import {
  APP_LINK,
  autoFormat,
  domToSpans,
  hasMark,
  insertText,
  linkAt,
  marksAt,
  mdToSpans,
  plain,
  selectionIn,
  setLink,
  setSelectionIn,
  sliceSpans,
  spansLength,
  spansToHtml,
  toggleMark,
  type Mark,
  type Span,
} from "./cms-blocks-inline";
import {
  accepts,
  ancestors,
  byId,
  cloneBlocks,
  indent as indentBlocks,
  insertAfter as insertAfterIn,
  isInside,
  makeColumns,
  moveTo,
  normalize,
  outdent as outdentBlocks,
  reachable,
  removeBlocks as removeFrom,
  roots,
  siblings,
  subtree,
  unwrap,
  type Where,
} from "./cms-blocks-tree";
import { MarkdownPreview, NativeSelect } from "./cms-parts";
import { pasteAsMarkdown } from "./cms-paste";
import { isApple, useCms, type BlockEditorProps } from "./use-cms";

type T = ReturnType<typeof useCms>["t"];
type Key = Parameters<T>[0];
type Icon = React.ComponentType<{ className?: string }>;

// ── history ───────────────────────────────────────────────────────────────────

interface Focus {
  id: string;
  start: number;
  end?: number;
  /** Text typed next is plain, not inside the bold/code/link the caret sits at the end of. */
  plain?: true;
}
interface Snap {
  blocks: EBlock[];
  focus: Focus | null;
}

const SOURCE_LABEL: Record<string, Key> = {
  html: "blk_src_html",
  "html-isolated": "blk_src_html_isolated",
  columns: "blk_src_columns",
  callout: "blk_src_callout",
  table: "blk_src_table",
  media: "blk_src_media",
  links: "blk_src_links",
  toggle: "blk_t_toggle",
};

// ── the / menu ────────────────────────────────────────────────────────────────

interface Item {
  key: string;
  label: Key;
  hint: Key;
  group: Key;
  icon: Icon;
  words: string;
  /** Turn the current (empty) block into this, or make it below. */
  make: () => EBlock | EBlock[] | "media";
}

const text = (type: TextType, extra: Partial<TextBlock> = {}): TextBlock => ({ id: newId(), type, spans: [], ...extra });
const source = (md: string, kind: string): EBlock => ({ id: newId(), type: "source", md, kind });
const emptyRow = (n: number) => Array.from({ length: n }, () => [] as Span[]);
const newTable = (): EBlock => ({ id: newId(), type: "table", align: [null, null, null], head: emptyRow(3), rows: [emptyRow(3), emptyRow(3)] });

const ITEMS: Item[] = [
  { key: "p", label: "blk_t_p", hint: "blk_t_p_text", group: "blk_group_basic", icon: Pilcrow, words: "text paragraph plain 텍스트 문단 본문", make: () => text("p") },
  { key: "h2", label: "blk_t_h2", hint: "blk_t_h2_text", group: "blk_group_basic", icon: Heading2, words: "heading title h2 ## 제목 헤딩", make: () => text("h2") },
  { key: "h3", label: "blk_t_h3", hint: "blk_t_h3_text", group: "blk_group_basic", icon: Heading3, words: "subheading heading h3 ### 작은 제목 소제목", make: () => text("h3") },
  { key: "bullet", label: "blk_t_bullet", hint: "blk_t_bullet_text", group: "blk_group_basic", icon: List, words: "bullet list ul - 글머리 목록 리스트", make: () => text("bullet") },
  { key: "number", label: "blk_t_number", hint: "blk_t_number_text", group: "blk_group_basic", icon: ListOrdered, words: "numbered list ol 1. 번호 목록 순서", make: () => text("number") },
  { key: "todo", label: "blk_t_todo", hint: "blk_t_todo_text", group: "blk_group_basic", icon: ListChecks, words: "todo task check checkbox [] 할 일 체크", make: () => text("todo", { checked: false }) },
  { key: "toggle", label: "blk_t_toggle", hint: "blk_t_toggle_text", group: "blk_group_basic", icon: ListCollapse, words: "toggle details collapse fold >> 접기 토글 펼치기", make: () => text("toggle") },
  { key: "quote", label: "blk_t_quote", hint: "blk_t_quote_text", group: "blk_group_basic", icon: Quote, words: "quote blockquote > 인용", make: () => text("quote") },
  { key: "callout", label: "blk_t_callout", hint: "blk_t_callout_text", group: "blk_group_basic", icon: Info, words: "callout note tip warning 알림 참고 팁 주의", make: () => text("callout", { tone: "note" }) },
  { key: "hr", label: "blk_t_hr", hint: "blk_t_hr_text", group: "blk_group_basic", icon: Minus, words: "divider rule hr line --- 구분선 선", make: () => ({ id: newId(), type: "hr" }) },
  { key: "media", label: "blk_slash_media", hint: "blk_slash_media_text", group: "blk_group_media", icon: ImageIcon, words: "image picture photo file media 이미지 사진 그림 파일 미디어", make: () => "media" },
  { key: "table", label: "blk_t_table", hint: "blk_t_table_text", group: "blk_group_advanced", icon: Table, words: "table grid rows columns 표 테이블", make: newTable },
  { key: "columns", label: "blk_slash_columns", hint: "blk_slash_columns_text", group: "blk_group_advanced", icon: Columns2, words: "columns two side 2단 단 칼럼 나란히", make: () => makeColumns(2) },
  { key: "columns3", label: "blk_slash_columns3", hint: "blk_slash_columns3_text", group: "blk_group_advanced", icon: Columns3, words: "columns three side 3단 단 칼럼 나란히", make: () => makeColumns(3) },
  { key: "code", label: "blk_t_code", hint: "blk_t_code_text", group: "blk_group_advanced", icon: Code, words: "code snippet ``` 코드", make: () => ({ id: newId(), type: "code", text: "", lang: "" }) },
  { key: "html", label: "blk_slash_html", hint: "blk_slash_html_text", group: "blk_group_advanced", icon: CodeXml, words: "html embed iframe markup 임베드", make: () => source(":::html\n\n:::", "html") },
];

type TurnType = TextType | "code";
const TURN_INTO: { type: TurnType; label: Key; icon: Icon; digit: string }[] = [
  { type: "p", label: "blk_t_p", icon: Pilcrow, digit: "0" },
  { type: "h2", label: "blk_t_h2", icon: Heading2, digit: "2" },
  { type: "h3", label: "blk_t_h3", icon: Heading3, digit: "3" },
  { type: "todo", label: "blk_t_todo", icon: ListChecks, digit: "4" },
  { type: "bullet", label: "blk_t_bullet", icon: List, digit: "5" },
  { type: "number", label: "blk_t_number", icon: ListOrdered, digit: "6" },
  { type: "toggle", label: "blk_t_toggle", icon: ListCollapse, digit: "7" },
  { type: "code", label: "blk_t_code", icon: Code, digit: "8" },
  { type: "quote", label: "blk_t_quote", icon: Quote, digit: "" },
  { type: "callout", label: "blk_t_callout", icon: Info, digit: "" },
];
/** ⌘⌥ + digit turns blocks into a kind (as in Notion). */
const DIGIT_TYPE: Record<string, TurnType> = Object.fromEntries(TURN_INTO.filter((x) => x.digit).map((x) => [x.digit, x.type]));

function matchItems(items: Item[], q: string, t: T): Item[] {
  const query = q.trim().toLowerCase();
  if (!query) return items;
  return items
    .map((i) => {
      const hay = `${t(i.label)} ${i.key} ${i.words}`.toLowerCase();
      const at = hay.indexOf(query);
      return { i, at: at < 0 ? -1 : t(i.label).toLowerCase().startsWith(query) ? 0 : at + 1 };
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.i);
}

/** Safe link targets: web, mail, phone, in-site paths, anchors, media library files and app links. */
export function okHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:|\/(?![/\\])|#|asset:|cms-link:)/i.test(href.trim());
}

// ── markdown typed at the start of a line ─────────────────────────────────────

function lineShortcut(b: TextBlock, caret: number): { type: TextType; strip: number; extra?: Partial<TextBlock> } | null {
  if (b.type !== "p" && !(isList(b) && b.type !== "todo")) return null;
  const head = plain(b.spans).slice(0, caret);
  if (sliceSpans(b.spans, 0, caret).some((s) => s.code || s.href)) return null;
  let m: RegExpExecArray | null;
  if (b.type === "p" && (m = /^(#{1,3}) $/.exec(head))) return { type: m[1].length === 3 ? "h3" : "h2", strip: head.length };
  if (b.type === "p" && /^[-*+] $/.test(head)) return { type: "bullet", strip: 2 };
  if (b.type === "p" && (m = /^(\d{1,9})[.)] $/.exec(head))) return { type: "number", strip: head.length, extra: Number(m[1]) !== 1 ? { start: Number(m[1]) } : {} };
  if ((b.type === "p" || b.type === "bullet") && (m = /^(?:[-*+] )?\[( |x)?\] $/i.exec(b.type === "bullet" ? `- ${head}` : head))) return { type: "todo", strip: head.length, extra: { checked: (m[1] ?? "").toLowerCase() === "x" } };
  if (b.type === "p" && /^> $/.test(head)) return { type: "quote", strip: 2 };
  if (b.type === "p" && /^>> $/.test(head)) return { type: "toggle", strip: 3 };
  if (b.type === "p" && (m = /^> ?\[!(note|tip|warning)\] $/i.exec(head))) return { type: "callout", strip: head.length, extra: { tone: m[1].toLowerCase() as Tone } };
  return null;
}

/** The element that scrolls the editor (for scrolling while dragging); null: the page. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let cur = el?.parentElement ?? null; cur && cur !== document.body; cur = cur.parentElement) {
    const s = getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && cur.scrollHeight > cur.clientHeight + 1) return cur;
  }
  return null;
}

const MOD = () => (isApple() ? "⌘" : "Ctrl+");
const ALT = () => (isApple() ? "⌥" : "Alt+");

// ── the editor ────────────────────────────────────────────────────────────────

/** `opened`: the menu came from the + button (closing it without a pick takes back what + wrote). */
type Menu = { id: string; query: string; from: number; x: number; y: number; index: number; opened?: "fresh" | "slash" } | null;
type Box = { left: number; top: number; width: number; height: number };
type DropAt = { id: string; where: Where; box: Box };
interface Drag {
  ids: string[];
  from: string;
  handle: HTMLElement;
  x0: number;
  y0: number;
  x: number;
  y: number;
  started: boolean;
  copy: boolean;
  ghost: HTMLElement | null;
  at: DropAt | null;
  raf: number;
}
interface Marquee {
  x0: number;
  y0: number;
  started: boolean;
  base: string[];
  onRoot: boolean;
}

/** Toggles that start open: the empty ones (so their "empty" hint shows). */
function initialOpen(list: readonly EBlock[]): Set<string> {
  const kids = childrenOf(list);
  return new Set(list.filter((b) => b.type === "toggle" && !(kids.get(b.id) ?? []).length).map((b) => b.id));
}

export default function CmsBlockEditor({ value, onChange, readOnly, uploadFile, resolveFileUrl, onPickMedia, insertRef, id, describedBy }: BlockEditorProps) {
  const { t, toast } = useCms();
  const [blocks, setBlocksState] = React.useState<EBlock[]>(() => {
    const b = markdownToBlocks(value);
    return b.length ? b : [text("p")];
  });
  const blocksRef = React.useRef(blocks);
  const emitted = React.useRef(value);
  const past = React.useRef<Snap[]>([]);
  const future = React.useRef<Snap[]>([]);
  const lastGroup = React.useRef<{ key: string; at: number } | null>(null);
  const els = React.useRef(new Map<string, HTMLElement>());
  const pendingFocus = React.useRef<Focus | null>(null);
  const focused = React.useRef<Focus | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [selected, setSelectedState] = React.useState<string[]>([]);
  const selectedRef = React.useRef<string[]>([]);
  const setSelected = (ids: string[]) => {
    selectedRef.current = ids;
    setSelectedState(ids);
  };
  const anchor = React.useRef<string | null>(null);
  const [menu, setMenu] = React.useState<Menu>(null);
  const [editingSource, setEditingSource] = React.useState<string | null>(null);
  const [toolbar, setToolbar] = React.useState<{ id: string; start: number; end: number; x: number; y: number; link: ReturnType<typeof linkAt> } | null>(null);
  const [linkEdit, setLinkEdit] = React.useState<{ id: string; start: number; end: number; href: string; x: number; y: number } | null>(null);
  const [fileDrop, setFileDrop] = React.useState<{ id: string; after: boolean } | null>(null);
  const [blockMenu, setBlockMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  /** Where the caret was when the block menu opened from the text (Esc puts it back). */
  const menuFrom = React.useRef<Focus | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [open, setOpenState] = React.useState<Set<string>>(() => initialOpen(blocks));
  const openRef = React.useRef(open);
  const setOpen = (fn: (s: Set<string>) => void) => {
    const n = new Set(openRef.current);
    fn(n);
    openRef.current = n;
    setOpenState(n);
  };
  const [dragging, setDragging] = React.useState<{ ids: string[]; copy: boolean } | null>(null);
  const [dropBox, setDropBox] = React.useState<(Box & { side: boolean }) | null>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const hoverToggle = React.useRef<{ id: string; timer: number } | null>(null);
  const [marquee, setMarquee] = React.useState<Box | null>(null);
  const marqueeRef = React.useRef<Marquee | null>(null);
  const editable = !readOnly;

  // ── state changes ──
  const emit = React.useCallback(
    (next: EBlock[]) => {
      const md = blocksToMarkdown(next);
      if (md === emitted.current || sameMarkdown(md, emitted.current)) return;
      emitted.current = md;
      onChange(md);
    },
    [onChange]
  );

  const commit = React.useCallback(
    (next: EBlock[], focus?: Focus | null, group?: string) => {
      const now = Date.now();
      const merge = group && lastGroup.current?.key === group && now - lastGroup.current.at < 900;
      if (!merge) {
        past.current.push({ blocks: blocksRef.current, focus: focused.current });
        if (past.current.length > 300) past.current.shift();
      }
      future.current = [];
      lastGroup.current = group ? { key: group, at: now } : null;
      if (!next.length) next = [text("p")];
      blocksRef.current = next;
      if (focus !== undefined) pendingFocus.current = focus;
      setBlocksState(next);
      emit(next);
    },
    [emit]
  );

  const restore = React.useCallback(
    (from: React.MutableRefObject<Snap[]>, to: React.MutableRefObject<Snap[]>) => {
      const snap = from.current.pop();
      if (!snap) return;
      to.current.push({ blocks: blocksRef.current, focus: focused.current });
      lastGroup.current = null;
      blocksRef.current = snap.blocks;
      pendingFocus.current = snap.focus ?? (snap.blocks[0] ? { id: snap.blocks[0].id, start: 0 } : null);
      setSelected([]);
      setBlocksState(snap.blocks);
      emit(snap.blocks);
    },
    [emit]
  );
  const undo = React.useCallback(() => restore(past, future), [restore]);
  const redo = React.useCallback(() => restore(future, past), [restore]);

  // The text changed from outside (an agent's edit, a restore, a merge): load it.
  React.useEffect(() => {
    if (value === emitted.current || sameMarkdown(value, blocksToMarkdown(blocksRef.current))) {
      emitted.current = value;
      return;
    }
    const next = markdownToBlocks(value);
    emitted.current = value;
    blocksRef.current = next.length ? next : [text("p")];
    past.current = [];
    future.current = [];
    setSelected([]);
    openRef.current = initialOpen(blocksRef.current);
    setOpenState(openRef.current);
    setBlocksState(blocksRef.current);
  }, [value]);

  // Put the caret where the last change wants it (opening the toggles it is inside).
  React.useLayoutEffect(() => {
    const f = pendingFocus.current;
    if (!f) return;
    const el = els.current.get(f.id);
    if (!el) {
      const closed = ancestors(blocksRef.current, f.id).filter((a) => a.type === "toggle" && !openRef.current.has(a.id));
      if (closed.length) setOpen((s) => closed.forEach((a) => s.add(a.id)));
      else pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      setSelectionIn(el, f.start, f.end ?? f.start);
      if (f.plain) leaveMarks(el);
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.setSelectionRange(f.start, f.end ?? f.start);
    el.scrollIntoView({ block: "nearest" });
  });

  const find = (bid: string) => blocksRef.current.find((b) => b.id === bid);
  const replace = (bid: string, make: (b: EBlock) => EBlock | EBlock[]) => blocksRef.current.flatMap((b) => (b.id === bid ? make(b) : [b]));
  /** Blocks the arrow keys can reach, in order. */
  const visible = () => reachable(blocksRef.current, openRef.current);
  const neighbour = (bid: string, dir: -1 | 1) => {
    const v = visible();
    const i = v.findIndex((b) => b.id === bid);
    return i < 0 ? undefined : v[i + dir];
  };
  const kidsOf = (bid: string) => blocksRef.current.filter((b) => b.parent === bid);
  /** The column a block sits in ("" when none). */
  const columnOf = (bid: string) => ancestors(blocksRef.current, bid).find((a) => a.type === "col")?.id ?? "";

  // ── the screen can put markdown where the caret is ──
  React.useEffect(() => {
    if (!insertRef) return;
    insertRef.current = (md: string) => {
      const made = markdownToBlocks(md).map((b) => ({ ...b, orig: undefined, gap: undefined }));
      if (!made.length) return;
      insertAfter(focused.current?.id ?? blocksRef.current[blocksRef.current.length - 1]?.id, made);
    };
    return () => {
      insertRef.current = null;
    };
  });

  /** Put blocks below one block (after what is inside it); an empty text line is replaced. */
  const insertAfter = (bid: string | undefined, made: EBlock[], focusLast = true) => {
    const list = blocksRef.current;
    const cur = bid ? list.find((b) => b.id === bid) : list[list.length - 1];
    const empty = cur && cur.type === "p" && !plain((cur as TextBlock).spans).trim() && !kidsOf(cur.id).length;
    let next: EBlock[];
    if (cur && empty) {
      const ids = new Set(made.map((b) => b.id));
      const placed = made.map((b) => (!b.parent || !ids.has(b.parent) ? ({ ...b, parent: cur.parent } as EBlock) : b));
      const at = list.indexOf(cur);
      next = normalize([...list.slice(0, at), ...placed, ...list.slice(at + 1)]);
    } else next = insertAfterIn(list, cur?.id, made);
    const tops = made.filter((b) => !b.parent || !made.some((x) => x.id === b.parent));
    const last = [...made].reverse().find((b) => isText(b) || b.type === "code") ?? tops[tops.length - 1];
    commit(next, focusLast ? focusOf(last, "end") : undefined);
  };

  const focusOf = (b: EBlock | undefined, where: "start" | "end"): Focus | null => {
    if (!b) return null;
    if (isText(b)) return { id: b.id, start: where === "start" ? 0 : spansLength(b.spans) };
    if (b.type === "code") return { id: b.id, start: where === "start" ? 0 : b.text.length };
    if (b.type === "columns" || b.type === "col") {
      const first = blocksRef.current.find((x) => isInside(blocksRef.current, x.id, b.id) && (isText(x) || x.type === "code"));
      return first ? focusOf(first, where) : null;
    }
    return { id: b.id, start: 0 };
  };

  const focusBlock = (b: EBlock | undefined, where: "start" | "end") => {
    if (!b) return;
    if (!isText(b) && b.type !== "code" && b.type !== "table") {
      selectOnly(b.id);
      return;
    }
    pendingFocus.current = focusOf(b, where);
    setBlocksState([...blocksRef.current]);
  };

  // ── uploads ──
  const uploadInto = React.useCallback(
    async (files: File[], afterId: string | undefined, before = false) => {
      if (!uploadFile || !files.length) return;
      const made = files.map((f) => ({ id: newId(), type: "media" as const, target: "", alt: "", pending: f.name }));
      if (before && afterId) {
        const ref = find(afterId);
        const list = blocksRef.current;
        const at = list.findIndex((b) => b.id === afterId);
        commit(normalize([...list.slice(0, at), ...made.map((m) => ({ ...m, parent: ref?.parent }) as EBlock), ...list.slice(at)]));
      } else insertAfter(afterId, made as EBlock[], false);
      for (const [k, f] of files.entries()) {
        const bid = made[k].id;
        try {
          const target = await uploadFile(f);
          const next = blocksRef.current.map((b) => (b.id === bid ? ({ id: bid, parent: b.parent, type: "media", target, alt: "" } as EBlock) : b));
          blocksRef.current = next;
          setBlocksState(next);
          emit(next);
        } catch {
          const next = blocksRef.current.filter((b) => b.id !== bid);
          blocksRef.current = next.length ? next : [text("p")];
          setBlocksState(blocksRef.current);
          toast(t("blk_media_failed", { name: f.name }), { tone: "error" });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploadFile, emit, t, toast]
  );

  // ── block selection ──
  const selectOnly = (bid: string) => {
    anchor.current = bid;
    setSelected([bid]);
    setMenu(null);
    setToolbar(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();
    rootRef.current?.focus({ preventScroll: true });
  };
  const selectRange = (from: string, to: string) => {
    const list = visible();
    const a = list.findIndex((b) => b.id === from);
    const b = list.findIndex((x) => x.id === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected(list.slice(lo, hi + 1).map((x) => x.id));
  };

  const removeBlocks = (ids: string[], announce = true) => {
    const list = blocksRef.current;
    const top = roots(list, ids);
    const before = neighbour(top[0], -1);
    const next = removeFrom(list, top);
    setSelected([]);
    const keep = before && next.some((b) => b.id === before.id) ? before : next[0];
    commit(next.length ? next : [text("p")], next.length ? focusOf(keep, "end") : null);
    const count = top.reduce((n, r) => n + subtree(list, r).filter((b) => b.type !== "col" && b.type !== "columns").length, 0);
    if (announce && count > 1) toast(t("blk_deleted_n", { n: count }), { action: { label: t("undo"), run: () => undo() } });
  };

  /** Move blocks one place up or down among their siblings; at the edge, out of what they sit in. */
  const moveVertical = (ids: string[], dir: -1 | 1) => {
    const list = blocksRef.current;
    const top = roots(list, ids);
    if (!top.length) return;
    const edge = dir < 0 ? top[0] : top[top.length - 1];
    const sibs = siblings(list, edge);
    const i = sibs.findIndex((b) => b.id === edge);
    const map = byId(list);
    const parent = map.get(map.get(edge)?.parent ?? "");
    let next: EBlock[] | null = null;
    if (dir < 0 && i > 0) next = moveTo(list, top, sibs[i - 1].id, "before");
    else if (dir > 0 && i >= 0 && i < sibs.length - 1) next = moveTo(list, top, sibs[i + 1].id, "after");
    else if (parent && parent.type !== "col") next = moveTo(list, top, parent.id, dir < 0 ? "before" : "after");
    if (next) commit(next, focused.current && ids.includes(focused.current.id) ? focused.current : undefined);
  };

  const duplicate = (ids: string[]) => {
    const list = blocksRef.current;
    const top = roots(list, ids);
    if (!top.length) return;
    const copies = cloneBlocks(top.flatMap((r) => subtree(list, r)));
    const next = insertAfterIn(list, top[top.length - 1], copies);
    commit(next);
    const ids2 = new Set(copies.map((c) => c.id));
    setSelected(copies.filter((c) => !c.parent || !ids2.has(c.parent)).map((c) => c.id));
  };

  const turnInto = (ids: string[], type: TurnType) => {
    const set = new Set(ids);
    let next = blocksRef.current.map((b) => {
      if (!set.has(b.id)) return b;
      if (type === "code") {
        if (isText(b)) return { id: b.id, parent: b.parent, type: "code", text: plain(b.spans), lang: "" } as EBlock;
        return b;
      }
      if (isText(b)) return { ...b, type, checked: type === "todo" ? !!b.checked : undefined, tone: type === "callout" ? (b.tone ?? "note") : undefined, start: type === "number" ? b.start : undefined, newList: undefined } as TextBlock;
      if (b.type === "code") return { id: b.id, parent: b.parent, type, spans: b.text ? [{ text: b.text }] : [] } as TextBlock;
      return b;
    });
    next = normalize(next);
    if (type === "toggle") setOpen((s) => ids.forEach((x) => s.add(x)));
    const one = ids.length === 1 ? next.find((x) => x.id === ids[0]) : undefined;
    commit(next, one ? focusOf(one, "end") : undefined);
  };

  const indentIds = (ids: string[], out: boolean) => {
    const next = out ? outdentBlocks(blocksRef.current, ids) : indentBlocks(blocksRef.current, ids);
    if (!next) return false;
    // Going inside a closed toggle: open it so the block stays in sight.
    if (!out)
      for (const x of ids) {
        const p = next.find((b) => b.id === x)?.parent;
        if (p && next.find((b) => b.id === p)?.type === "toggle") setOpen((s) => s.add(p));
      }
    commit(next, focused.current && ids.includes(focused.current.id) ? { ...focused.current } : undefined);
    return true;
  };

  const copyBlocks = async (ids: string[], cut = false) => {
    const list = blocksRef.current;
    const md = blocksToClipboard(roots(list, ids).flatMap((r) => subtree(list, r)));
    try {
      await navigator.clipboard.writeText(md);
      if (!cut) toast(t("blk_copied"), { tone: "ok" });
    } catch {
      /* the browser refused the clipboard */
    }
    if (cut) removeBlocks(ids, false);
  };

  // ── text input ──
  const onTextInput = (b: TextBlock, el: HTMLElement, data: string | null) => {
    let spans = domToSpans(el);
    const sel = selectionIn(el);
    let caret = sel?.start ?? spansLength(spans);
    let next: TextBlock = { ...b, spans };
    let rerender = false;
    // Markdown typed at the start of a line.
    const sc = lineShortcut(next, caret);
    if (sc && data === " ") {
      next = { ...next, type: sc.type, spans: sliceSpans(spans, sc.strip), ...sc.extra };
      caret = 0;
      rerender = true;
      if (sc.type === "toggle") setOpen((s) => s.add(b.id));
    } else if (b.type === "p" && plain(spans) === "---" && data === "-") {
      const rule: EBlock = { id: newId(), parent: b.parent, type: "hr" };
      const after = text("p", { parent: b.parent });
      commit(replace(b.id, () => [rule, after]), { id: after.id, start: 0 });
      return;
    } else if (b.type === "p" && /^```[\w+-]*$/.test(plain(spans)) && data === "`" && plain(spans).length === 3) {
      const code: EBlock = { id: b.id, parent: b.parent, type: "code", text: "", lang: "" };
      commit(normalize(replace(b.id, () => code)), { id: b.id, start: 0 });
      return;
    } else if (data && /[*~`_]/.test(data)) {
      const f = autoFormat(spans, caret);
      if (f) {
        spans = f.spans;
        caret = f.caret;
        next = { ...next, spans };
        rerender = true;
      }
    }
    if (rerender) {
      (el as HTMLElement & { _spans?: Span[] })._spans = undefined;
      commit(normalize(replace(b.id, () => next)), { id: b.id, start: caret, plain: true }, undefined);
    } else {
      (el as HTMLElement & { _spans?: Span[] })._spans = next.spans;
      commit(replace(b.id, () => next), undefined, `type:${b.id}`);
    }
    focused.current = { id: b.id, start: caret };
    // The / menu: "/" at the start or after a space, then the query.
    const before = plain(next.spans).slice(0, caret);
    const m = /(^|\s)\/([^\s/]{0,24})$/.exec(before);
    if (m && editable) {
      const r = caretRect();
      setMenu((old) => ({ id: b.id, query: m[2], from: caret - m[2].length - 1, x: r?.left ?? 0, y: r?.bottom ?? 0, index: old?.id === b.id ? Math.min(old.index, 50) : 0, opened: old?.id === b.id && !m[2] ? old.opened : undefined }));
    } else if (menu) setMenu(null);
  };

  const applyItem = (item: Item) => {
    if (!menu) return;
    const b = find(menu.id);
    setMenu(null);
    if (!b || !isText(b)) return;
    // Take the "/query" out of the line.
    const end = menu.from + 1 + menu.query.length;
    const spans = [...sliceSpans(b.spans, 0, menu.from), ...sliceSpans(b.spans, end)];
    const emptyNow = !plain(spans).trim();
    const made = item.make();
    if (made === "media") {
      const keep = { ...b, spans };
      commit(replace(b.id, () => keep), { id: b.id, start: menu.from });
      void onPickMedia?.().then((md) => {
        if (!md) return;
        const blocksMade = markdownToBlocks(md).map((x) => ({ ...x, orig: undefined, gap: undefined }));
        insertAfter(b.id, blocksMade);
      });
      return;
    }
    if (!Array.isArray(made) && isText(made)) {
      // A text kind turns the line into it, keeping what was written.
      const turned = { ...b, ...made, id: b.id, parent: b.parent, spans, orig: b.orig, gap: b.gap } as TextBlock;
      if (made.type === "toggle") setOpen((s) => s.add(b.id));
      commit(normalize(replace(b.id, () => turned)), { id: b.id, start: menu.from });
      return;
    }
    const group = Array.isArray(made) ? made : [made];
    if (group[0].type === "hr") group.push(text("p"));
    const ids = new Set(group.map((x) => x.id));
    const placed = group.map((x) => (!x.parent || !ids.has(x.parent) ? ({ ...x, parent: b.parent } as EBlock) : x));
    const list = blocksRef.current;
    const at = list.findIndex((x) => x.id === b.id);
    const next = emptyNow && !kidsOf(b.id).length ? normalize([...list.slice(0, at), ...placed, ...list.slice(at + 1)]) : insertAfterIn(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), b.id, placed);
    const first = group[0];
    if (first.type === "source") setEditingSource(first.id);
    const focusTarget = first.type === "hr" ? group[1] : first.type === "columns" ? group.find((x) => x.type === "p") : first.type === "table" || first.type === "code" ? first : undefined;
    commit(next, focusTarget ? focusOf(focusTarget, "start") : undefined);
  };

  const menuItems = React.useMemo(() => {
    const all = onPickMedia ? ITEMS : ITEMS.filter((i) => i.key !== "media");
    return menu ? matchItems(all, menu.query, t) : [];
  }, [menu, onPickMedia, t]);

  /** Where a new line goes when Enter is pressed at the end of `b`: inside it when what is inside shows. */
  const lineAfter = (list: EBlock[], b: TextBlock, fresh: TextBlock): EBlock[] => {
    const inside = kidsOf(b.id);
    const intoToggle = b.type === "toggle" && openRef.current.has(b.id);
    if (intoToggle || (isList(b) && inside.length)) {
      const at = list.findIndex((x) => x.id === b.id) + 1;
      return normalize([...list.slice(0, at), { ...fresh, parent: b.id }, ...list.slice(at)]);
    }
    return insertAfterIn(list, b.id, [fresh]);
  };

  // ── keys in a text block ──
  const onTextKey = (b: TextBlock, el: HTMLElement, e: React.KeyboardEvent) => {
    const ev = e.nativeEvent;
    if (ev.isComposing || e.keyCode === 229) return;
    const mod = isApple() ? e.metaKey : e.ctrlKey;
    const sel = selectionIn(el) ?? { start: 0, end: 0, collapsed: true };
    const len = spansLength(b.spans);
    const list = blocksRef.current;
    const i = list.findIndex((x) => x.id === b.id);

    if (menu && menu.id === b.id) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = menuItems.length || 1;
        setMenu({ ...menu, index: (menu.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const item = menuItems[menu.index];
        if (item) {
          e.preventDefault();
          applyItem(item);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (menu.opened && !menu.query) undo();
        setMenu(null);
        return;
      }
    }

    if (e.key === "Tab" && !mod && !e.altKey) {
      // Tab nests where it can; elsewhere (a line that cannot nest) it moves focus on, as usual.
      if (indentIds([b.id], e.shiftKey)) e.preventDefault();
      return;
    }

    if (mod && e.altKey && /^Digit\d$/.test(e.code)) {
      const type = DIGIT_TYPE[e.code.slice(5)];
      if (type) {
        e.preventDefault();
        turnInto([b.id], type);
        return;
      }
    }

    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const markKey: Record<string, Mark> = { b: "b", i: "i", e: "code" };
      if (markKey[k] && !e.shiftKey) {
        e.preventDefault();
        format(b, markKey[k], sel.start, sel.end);
        return;
      }
      if ((k === "s" && e.shiftKey) || (k === "x" && e.shiftKey)) {
        e.preventDefault();
        format(b, "s", sel.start, sel.end);
        return;
      }
      if (k === "k") {
        e.preventDefault();
        openLink(b, sel.start, sel.end);
        return;
      }
      if (k === "/") {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        menuFrom.current = { id: b.id, start: sel.start, end: sel.end };
        setBlockMenu({ id: b.id, x: r.left, y: r.bottom + 4 });
        return;
      }
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (k === "a" && sel.start === 0 && sel.end === len && len > 0) {
        e.preventDefault();
        setSelected(visible().map((x) => x.id));
        rootRef.current?.focus({ preventScroll: true });
        return;
      }
      if (k === "d") {
        e.preventDefault();
        duplicate([b.id]);
        return;
      }
      if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        moveVertical([b.id], e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (e.key === "Enter" && b.type === "todo") {
        e.preventDefault();
        commit(replace(b.id, (x) => ({ ...(x as TextBlock), checked: !(x as TextBlock).checked })));
        return;
      }
      if (e.key === "Enter" && b.type === "toggle") {
        e.preventDefault();
        setOpen((s) => (s.has(b.id) ? s.delete(b.id) : s.add(b.id)));
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      selectOnly(b.id);
      return;
    }

    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      const like = marksAt(b.spans, sel.start);
      const spans = insertText([...sliceSpans(b.spans, 0, sel.start), ...sliceSpans(b.spans, sel.end)], sel.start, "\n", like);
      commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start: sel.start + 1 });
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const isEmpty = !plain(b.spans).trim();
      // An empty list item inside another one goes out a level; elsewhere an empty list item, quote or callout ends it.
      if (isEmpty && b.type !== "p") {
        const parent = b.parent ? find(b.parent) : undefined;
        if (isList(b) && parent && ["bullet", "number", "todo", "toggle"].includes(parent.type) && indentIds([b.id], true)) return;
        commit(normalize(replace(b.id, (x) => ({ ...(x as TextBlock), type: "p", checked: undefined, start: undefined, tone: undefined }))), { id: b.id, start: 0 });
        return;
      }
      // ``` then Enter: a code block.
      const m = /^```([\w+-]*)$/.exec(plain(b.spans));
      if (b.type === "p" && m) {
        commit(replace(b.id, () => ({ id: b.id, parent: b.parent, type: "code", text: "", lang: m[1] })), { id: b.id, start: 0 });
        return;
      }
      const left = sliceSpans(b.spans, 0, sel.start);
      const right = sliceSpans(b.spans, sel.end);
      const kind: TextType = isList(b) ? b.type : "p";
      // At the very start of a line with text: a new line above, the caret stays.
      if (sel.start === 0 && sel.end === 0 && len > 0) {
        const above = text(kind, { parent: b.parent, ...(kind === "todo" ? { checked: false } : {}) });
        commit(normalize([...list.slice(0, i), above, ...list.slice(i)]), { id: b.id, start: 0 });
        return;
      }
      const below = text(kind, { spans: right, ...(kind === "todo" ? { checked: false } : {}) });
      const withLeft = replace(b.id, () => ({ ...b, spans: left }));
      commit(lineAfter(withLeft, { ...b, spans: left }, below), { id: below.id, start: 0 });
      return;
    }

    if (e.key === "Backspace" && sel.collapsed && sel.start === 0) {
      // A heading, list item, quote, callout or toggle becomes text first (like in Notion).
      if (b.type !== "p") {
        e.preventDefault();
        commit(normalize(replace(b.id, (x) => ({ ...(x as TextBlock), type: "p", checked: undefined, start: undefined, tone: undefined, newList: undefined }))), { id: b.id, start: 0 });
        return;
      }
      // Text inside a list item or toggle goes out a level.
      const parent = b.parent ? find(b.parent) : undefined;
      if (parent && parent.type !== "col" && parent.type !== "columns") {
        e.preventDefault();
        indentIds([b.id], true);
        return;
      }
      const prev = neighbour(b.id, -1);
      if (!prev) return;
      e.preventDefault();
      // Not across the edge of a column (that would take the layout apart).
      if (columnOf(b.id) !== columnOf(prev.id)) return;
      if (isText(prev)) {
        const at = spansLength(prev.spans);
        const merged = replace(prev.id, () => ({ ...prev, spans: [...prev.spans, ...b.spans] }) as TextBlock);
        commit(unwrap(merged, b.id), { id: prev.id, start: at });
      } else if (!len) {
        commit(unwrap(list, b.id));
        selectOnly(prev.id);
      } else selectOnly(prev.id);
      return;
    }

    if (e.key === "Delete" && sel.collapsed && sel.start === len) {
      const nextB = neighbour(b.id, 1);
      if (!nextB) return;
      e.preventDefault();
      if (columnOf(b.id) !== columnOf(nextB.id)) return;
      if (isText(nextB)) {
        const merged = replace(b.id, () => ({ ...b, spans: [...b.spans, ...nextB.spans] }) as TextBlock);
        commit(unwrap(merged, nextB.id), { id: b.id, start: len });
      } else selectOnly(nextB.id);
      return;
    }

    if ((e.key === "ArrowUp" || (e.key === "ArrowLeft" && sel.collapsed && sel.start === 0)) && !e.shiftKey) {
      const prev = neighbour(b.id, -1);
      if (prev && (e.key === "ArrowLeft" || onEdgeLine(el, "top"))) {
        e.preventDefault();
        focusBlock(prev, "end");
      }
      return;
    }
    if ((e.key === "ArrowDown" || (e.key === "ArrowRight" && sel.collapsed && sel.start === len)) && !e.shiftKey) {
      const nx = neighbour(b.id, 1);
      if (nx && (e.key === "ArrowRight" || onEdgeLine(el, "bottom"))) {
        e.preventDefault();
        focusBlock(nx, "start");
      }
      return;
    }
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && ((e.key === "ArrowUp" && sel.start === 0) || (e.key === "ArrowDown" && sel.end === len))) {
      // Shift past the edge of a block selects blocks.
      e.preventDefault();
      const other = neighbour(b.id, e.key === "ArrowUp" ? -1 : 1);
      anchor.current = b.id;
      setSelected(other ? (e.key === "ArrowUp" ? [other.id, b.id] : [b.id, other.id]) : [b.id]);
      rootRef.current?.focus({ preventScroll: true });
    }
  };

  const format = (b: TextBlock, mark: Mark, start: number, end: number) => {
    if (start === end) return;
    const spans = toggleMark(b.spans, start, end, mark);
    commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start, end });
    requestAnimationFrame(updateToolbar);
  };

  const openLink = (b: TextBlock, start: number, end: number) => {
    const around = linkAt(b.spans, start);
    const s = around && start === end ? around.from : start;
    const en = around && start === end ? around.to : end;
    if (s === en) return;
    const r = caretRect() ?? els.current.get(b.id)?.getBoundingClientRect();
    setToolbar(null);
    setLinkEdit({ id: b.id, start: s, end: en, href: around?.href ?? "", x: r?.left ?? 0, y: (r?.bottom ?? 0) + 6 });
  };

  const applyLink = (href: string | null) => {
    if (!linkEdit) return;
    const b = find(linkEdit.id);
    setLinkEdit(null);
    if (!b || !isText(b)) return;
    const spans = setLink(b.spans, linkEdit.start, linkEdit.end, href ? href.trim() : null);
    commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start: linkEdit.end });
  };

  // ── paste and drop ──
  const onTextPaste = (b: TextBlock, el: HTMLElement, e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length && uploadFile) {
      e.preventDefault();
      void uploadInto(files, b.id);
      return;
    }
    const html = e.clipboardData.getData("text/html");
    const plainText = e.clipboardData.getData("text/plain");
    const converted = html ? pasteAsMarkdown({ html, plain: plainText }) : null;
    const md = (converted?.text ?? plainText).replace(/\r\n?/g, "\n");
    if (!md) return;
    e.preventDefault();
    const sel = selectionIn(el) ?? { start: 0, end: 0 };
    const left = sliceSpans(b.spans, 0, sel.start);
    const right = sliceSpans(b.spans, sel.end);
    const trimmed = md.replace(/^\n+|\n+$/g, "");
    const list = blocksRef.current;
    const i = list.findIndex((x) => x.id === b.id);
    // One line: inline, keeping links, bold and such.
    if (!trimmed.includes("\n")) {
      const isUrl = /^https?:\/\/\S+$/.test(trimmed);
      // A link pasted over selected text links that text.
      if (isUrl && sel.start !== sel.end) {
        const spans = setLink(b.spans, sel.start, sel.end, trimmed);
        commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start: sel.end });
        return;
      }
      const piece = isUrl ? [{ text: trimmed, href: trimmed }] : converted || /[*_`[~]/.test(trimmed) ? mdToSpans(trimmed) : [{ text: trimmed }];
      const spans = [...left, ...piece, ...right];
      commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start: sel.start + spansLength(piece) });
      return;
    }
    // Several lines: blocks (with what is inside them).
    const made = markdownToBlocks(trimmed).map((x) => ({ ...x, orig: undefined, gap: undefined })) as EBlock[];
    if (!made.length) return;
    const madeIds = new Set(made.map((x) => x.id));
    const isTop = (x: EBlock) => !x.parent || !madeIds.has(x.parent);
    const placed = made.map((x) => (isTop(x) ? ({ ...x, parent: b.parent } as EBlock) : x));
    const first = placed[0];
    // Pasted at the very start of a line: the pasted blocks go above it, the line keeps its place and what is inside it.
    if (!left.length && right.length) {
      const lastPasted = [...placed].reverse().find((x) => isText(x)) ?? placed[placed.length - 1];
      commit(normalize([...list.slice(0, i), ...placed, ...list.slice(i)]), focusOf(lastPasted, "end"));
      return;
    }
    const out: EBlock[] = [];
    if (isText(first) && isTop(first) && (left.length || b.type !== "p") && !made.some((x) => x.parent === first.id)) {
      out.push({ ...b, spans: [...left, ...first.spans] });
      placed.shift();
    } else if (left.length) out.push({ ...b, spans: left });
    out.push(...placed);
    // The text after the caret joins the last pasted block only when that is a line of text at
    // this level with nothing inside it; otherwise it gets a line of its own.
    const lastTop = out[out.length - 1];
    const joinable = lastTop && isText(lastTop) && lastTop.parent === b.parent && !out.some((x) => x.parent === lastTop.id);
    let focus: Focus | null = focusOf([...out].reverse().find((x) => isText(x)) ?? lastTop, "end");
    if (right.length) {
      if (joinable && lastTop && isText(lastTop)) {
        focus = { id: lastTop.id, start: spansLength(lastTop.spans) };
        const k = out.indexOf(lastTop);
        out[k] = { ...lastTop, spans: [...lastTop.spans, ...right] };
      } else out.push({ ...text(b.type === "p" ? "p" : b.type), parent: b.parent, spans: right });
    }
    if (!out.length) return;
    commit(normalize([...list.slice(0, i), ...out, ...list.slice(i + 1)]), focus);
  };

  // ── keys while blocks are selected ──
  const onRootKey = (e: React.KeyboardEvent) => {
    if (!selected.length || e.target !== rootRef.current) return;
    const mod = isApple() ? e.metaKey : e.ctrlKey;
    const list = visible();
    const first = list.findIndex((b) => b.id === selected[0]);
    const last = list.findIndex((b) => b.id === selected[selected.length - 1]);
    if (e.key === "Escape") {
      e.preventDefault();
      setSelected([]);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      removeBlocks(selected);
      return;
    }
    if (e.key === "Tab") {
      if (indentIds(selected, e.shiftKey)) e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !mod) {
      e.preventDefault();
      const b = list[first];
      setSelected([]);
      if (b?.type === "source") setEditingSource(b.id);
      focusBlock(b, "end");
      return;
    }
    if (mod && e.altKey && /^Digit\d$/.test(e.code)) {
      const type = DIGIT_TYPE[e.code.slice(5)];
      if (type) {
        e.preventDefault();
        turnInto(selected, type);
        return;
      }
    }
    if (mod && e.key === "/") {
      e.preventDefault();
      const r = rootRef.current?.querySelector(`[data-block-id="${selected[0]}"]`)?.getBoundingClientRect();
      if (r) setBlockMenu({ id: selected[0], x: r.left, y: r.bottom + 4 });
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copyBlocks(selected);
      return;
    }
    if (mod && e.key.toLowerCase() === "x") {
      e.preventDefault();
      void copyBlocks(selected, true);
      return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicate(selected);
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(list.map((b) => b.id));
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveVertical(selected, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const up = e.key === "ArrowUp";
      if (e.shiftKey) {
        const a = anchor.current ?? selected[0];
        const ai = list.findIndex((b) => b.id === a);
        const edge = ai === first ? last : first;
        const to = list[Math.max(0, Math.min(list.length - 1, edge + (up ? -1 : 1)))];
        if (to) selectRange(a, to.id);
      } else {
        const to = list[Math.max(0, Math.min(list.length - 1, (up ? first : last) + (up ? -1 : 1)))];
        if (to) selectOnly(to.id);
      }
    }
  };

  // Typing over a selection of blocks replaces them with a new line holding the key.
  const onRootKeyPress = (e: React.KeyboardEvent) => {
    if (!selected.length || e.target !== rootRef.current || e.key.length !== 1 || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const list = blocksRef.current;
    const top = roots(list, selected);
    const firstB = find(top[0]);
    const at = list.findIndex((b) => b.id === top[0]);
    const fresh = text("p", { parent: firstB?.parent, spans: [{ text: e.key }] });
    const next = removeFrom([...list.slice(0, at), fresh, ...list.slice(at)], top);
    setSelected([]);
    commit(next, { id: fresh.id, start: 1 });
  };

  const onRootCopy = (e: React.ClipboardEvent) => {
    if (!selected.length || e.target !== rootRef.current) return;
    e.preventDefault();
    const list = blocksRef.current;
    e.clipboardData.setData("text/plain", blocksToClipboard(roots(list, selected).flatMap((r) => subtree(list, r))));
  };

  // ── dragging across blocks selects them (the browser cannot select across separate editable parts) ──
  const pointer = React.useRef<{ id: string; x: number; y: number } | null>(null);
  const onPointerDownBlock = (bid: string, e: React.PointerEvent) => {
    if (e.button !== 0 || dragRef.current) return;
    if ((e.target as HTMLElement).closest("[data-cms-handle]")) return;
    if (e.shiftKey && (selected.length || focused.current)) {
      e.preventDefault();
      selectRange(anchor.current ?? selected[0] ?? focused.current!.id, bid);
      rootRef.current?.focus({ preventScroll: true });
      return;
    }
    pointer.current = { id: bid, x: e.clientX, y: e.clientY };
    if (selected.length) setSelected([]);
  };

  // ── the toolbar over selected text ──
  const updateToolbar = React.useCallback(() => {
    const f = focused.current;
    const el = f ? els.current.get(f.id) : null;
    if (!f || !el || !el.isContentEditable || document.activeElement !== el) {
      setToolbar(null);
      return;
    }
    const sel = selectionIn(el);
    const b = blocksRef.current.find((x) => x.id === f.id);
    if (!sel || !b || !isText(b)) {
      setToolbar(null);
      return;
    }
    const link = sel.collapsed ? linkAt(b.spans, sel.start) : null;
    if (sel.collapsed && !link) {
      setToolbar(null);
      return;
    }
    const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    if (!r) return;
    setToolbar({ id: b.id, start: sel.start, end: sel.end, x: r.left + r.width / 2, y: r.top, link });
  }, []);
  React.useEffect(() => {
    const on = () => {
      const f = focused.current;
      const el = f ? els.current.get(f.id) : null;
      if (el && el.isContentEditable) {
        const s = selectionIn(el);
        if (s && f) focused.current = { id: f.id, start: s.start, end: s.end };
      }
      updateToolbar();
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [updateToolbar]);

  // Close menus on a click elsewhere.
  React.useEffect(() => {
    if (!blockMenu && !linkEdit) return;
    const close = (e: MouseEvent) => {
      const at = e.target as HTMLElement;
      if (at.closest("[data-cms-pop]")) return;
      setBlockMenu(null);
      setLinkEdit(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [blockMenu, linkEdit]);

  // ── drag to move (pointer events: a picture follows the pointer, the page scrolls along) ──
  /** Where would blocks land if dropped at (x, y)? */
  const dropAt = (x: number, y: number, ids: string[], copy = false): DropAt | null => {
    const root = rootRef.current;
    if (!root) return null;
    const list = blocksRef.current;
    const map = byId(list);
    // A copy can land anywhere, a move not inside what moves.
    const banned = (bid: string) => !copy && (ids.includes(bid) || ids.some((r) => isInside(list, bid, r, map)));
    const movingCols = ids.some((i) => map.get(i)?.type === "columns");
    const movers = roots(list, ids).map((i) => map.get(i)!).filter(Boolean);
    // An empty toggle or column says "drop here".
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const into = under?.closest<HTMLElement>("[data-drop-into]");
    if (into && root.contains(into)) {
      const tid = into.dataset.dropInto!;
      const tb = map.get(tid);
      if (tb && !banned(tid) && movers.every((m) => accepts(tb, m))) {
        const r = into.getBoundingClientRect();
        return { id: tid, where: "last-child", box: { left: r.left, top: r.top, width: r.width, height: r.height } };
      }
    }
    // Nowhere near the editor (the sidebar, the toolbar): no drop.
    const area = root.getBoundingClientRect();
    if (x < area.left - 24 || x > area.right + 24 || y < area.top - 48 || y > area.bottom + 48) return null;
    // Over something drawn on top of the editor (a sticky bar, a menu, the sidebar): no drop.
    const top = document.elementFromPoint(x, y);
    if (top && !root.contains(top) && top !== document.body && top !== document.documentElement) return null;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-block-id]")).filter((el) => !banned(el.dataset.blockId!) && el.getClientRects().length);
    // The block under the pointer first (the innermost); the gutter beside it only when there is none.
    const pickIn = (pad: number) => {
      let found: HTMLElement | null = null;
      let foundArea = Infinity;
      for (const el of rows) {
        const r = el.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom && x >= r.left - pad && x <= r.right + pad && r.width * r.height < foundArea) {
          found = el;
          foundArea = r.width * r.height;
        }
      }
      return found;
    };
    let best = pickIn(0) ?? pickIn(96);
    if (!best) {
      let dist = Infinity;
      for (const el of rows) {
        const r = el.getBoundingClientRect();
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < dist) (dist = d), (best = el);
      }
    }
    if (!best) return null;
    const bid = best.dataset.blockId!;
    const b = map.get(bid);
    if (!b) return null;
    const r = best.getBoundingClientRect();
    const wrap = best.closest<HTMLElement>("[data-block-wrap]")?.getBoundingClientRect() ?? r;
    const anc = ancestors(list, bid, map);
    const sideOk = !movingCols && b.type !== "columns" && !movers.some((m) => m.type === "col") && (anc.length === 0 || (anc.length === 2 && anc[0].type === "col" && b.parent === anc[0].id));
    const line = (top: number, left = r.left, width = r.width): Box => ({ left, top: top - 1, width, height: 3 });
    // Beside a block (the pointer near its right edge, or just inside its left edge, not at its top or bottom): columns.
    const middle = y > r.top + r.height * 0.2 && y < r.bottom - r.height * 0.2;
    if (sideOk && middle && x > r.right - Math.min(72, r.width * 0.2)) return { id: bid, where: "right", box: { left: r.right + 2, top: r.top, width: 3, height: r.height } };
    if (sideOk && middle && x >= r.left + 4 && x < r.left + Math.min(24, r.width * 0.08)) return { id: bid, where: "left", box: { left: r.left - 5, top: r.top, width: 3, height: r.height } };
    const lower = y > r.top + r.height / 2;
    if (lower) {
      const kids = list.filter((k) => k.parent === bid);
      const toggleOpen = b.type === "toggle" && openRef.current.has(bid);
      const nest = (toggleOpen || (isList(b) && x > r.left + 44)) && movers.every((m) => accepts(b, m));
      if (nest) return { id: bid, where: "first-child", box: line(r.bottom, r.left + 24, r.width - 24) };
      // Below a block with blocks inside it that show: after all of them.
      const showsKids = kids.length && (b.type !== "toggle" || openRef.current.has(bid));
      // Below the last block inside a toggle or list item, with the pointer out to the left: after that toggle or item (as in Notion).
      let at = b;
      let atRow = r;
      for (;;) {
        const parent = at.parent ? map.get(at.parent) : undefined;
        if (!parent || parent.type === "col" || parent.type === "columns" || x >= atRow.left - 8) break;
        const sibs = list.filter((k) => k.parent === parent.id);
        if (sibs[sibs.length - 1]?.id !== at.id) break;
        const pRow = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(parent.id)}"]`);
        if (!pRow || banned(parent.id)) break;
        at = parent;
        atRow = pRow.getBoundingClientRect();
      }
      if (at !== b) {
        const w = root.querySelector<HTMLElement>(`[data-block-wrap="${CSS.escape(at.id)}"]`)?.getBoundingClientRect() ?? atRow;
        return { id: at.id, where: "after", box: line(w.bottom, atRow.left, atRow.width) };
      }
      return { id: bid, where: "after", box: line(showsKids ? wrap.bottom : r.bottom) };
    }
    return { id: bid, where: "before", box: line(r.top) };
  };

  const startHandle = (bid: string, e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return;
    e.preventDefault();
    const ids = selectedRef.current.includes(bid) ? selectedRef.current : [bid];
    dragRef.current = { ids, from: bid, handle: e.currentTarget as HTMLElement, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, copy: e.altKey, ghost: null, at: null, raf: 0 };
  };

  React.useEffect(() => {
    const endDrag = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      cancelAnimationFrame(d.raf);
      d.ghost?.remove();
      document.documentElement.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      setDragging(null);
      setDropBox(null);
    };
    const place = (d: Drag) => {
      if (d.ghost) {
        const w = d.ghost.offsetWidth;
        d.ghost.style.transform = `translate(${Math.max(8, Math.min(d.x + 14, window.innerWidth - w - 8))}px, ${d.y + 10}px)`;
      }
      d.at = dropAt(d.x, d.y, d.ids, d.copy);
      // Resting on a closed toggle opens it after a moment, so blocks can go inside.
      const over = (document.elementFromPoint(d.x, d.y) as HTMLElement | null)?.closest<HTMLElement>("[data-block-type=toggle]")?.dataset.blockId;
      if (over && !openRef.current.has(over) && !d.ids.includes(over)) {
        if (hoverToggle.current?.id !== over) {
          if (hoverToggle.current) clearTimeout(hoverToggle.current.timer);
          hoverToggle.current = {
            id: over,
            timer: window.setTimeout(() => {
              hoverToggle.current = null;
              if (dragRef.current) setOpen((s) => s.add(over));
            }, 650),
          };
        }
      } else if (hoverToggle.current && hoverToggle.current.id !== over) {
        clearTimeout(hoverToggle.current.timer);
        hoverToggle.current = null;
      }
      setDropBox(d.at ? { ...d.at.box, side: d.at.where === "left" || d.at.where === "right" } : null);
    };
    const scroll = () => {
      const d = dragRef.current;
      if (!d || !d.started) return;
      const scroller = scrollerOf(rootRef.current);
      const top = scroller ? Math.max(0, scroller.getBoundingClientRect().top) : 0;
      const bottom = scroller ? Math.min(window.innerHeight, scroller.getBoundingClientRect().bottom) : window.innerHeight;
      const edge = 64;
      let dy = 0;
      if (d.y < top + edge) dy = -Math.ceil((top + edge - d.y) / 3);
      else if (d.y > bottom - edge) dy = Math.ceil((d.y - (bottom - edge)) / 3);
      if (dy) {
        if (scroller) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        place(d);
      }
      d.raf = requestAnimationFrame(scroll);
    };
    const move = (e: PointerEvent) => {
      // Dragging across blocks from inside text selects them.
      const p = pointer.current;
      if (p && !dragRef.current && e.buttons & 1) {
        const under = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-block-id]");
        const over = under?.dataset.blockId;
        if (over && over !== p.id && rootRef.current?.contains(under!) && under!.dataset.blockType !== "columns") {
          anchor.current = p.id;
          window.getSelection()?.removeAllRanges();
          (document.activeElement as HTMLElement | null)?.blur?.();
          rootRef.current?.focus({ preventScroll: true });
          selectRange(p.id, over);
        }
      }
      // A box drawn from the margin selects the blocks it touches.
      const mq = marqueeRef.current;
      if (mq && e.buttons & 1) {
        if (!mq.started && Math.hypot(e.clientX - mq.x0, e.clientY - mq.y0) > 5) {
          mq.started = true;
          (document.activeElement as HTMLElement | null)?.blur?.();
          window.getSelection()?.removeAllRanges();
          document.body.style.userSelect = "none";
        }
        if (mq.started) {
          const box = { left: Math.min(mq.x0, e.clientX), top: Math.min(mq.y0, e.clientY), width: Math.abs(e.clientX - mq.x0), height: Math.abs(e.clientY - mq.y0) };
          setMarquee(box);
          const hit = new Set(mq.base);
          for (const el of Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-block-id]") ?? [])) {
            if (el.dataset.blockType === "columns") continue;
            const r = el.getBoundingClientRect();
            if (r.right > box.left && r.left < box.left + box.width && r.bottom > box.top && r.top < box.top + box.height) hit.add(el.dataset.blockId!);
          }
          setSelected(visible().filter((b) => hit.has(b.id)).map((b) => b.id));
          rootRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      d.x = e.clientX;
      d.y = e.clientY;
      d.copy = e.altKey;
      if (!d.started) {
        if (Math.hypot(d.x - d.x0, d.y - d.y0) < 5) return;
        d.started = true;
        setMenu(null);
        setToolbar(null);
        setBlockMenu(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
        window.getSelection()?.removeAllRanges();
        d.ghost = makeGhost(rootRef.current, d.ids);
        document.documentElement.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        setDragging({ ids: d.ids, copy: d.copy });
        d.raf = requestAnimationFrame(scroll);
      }
      setDragging((g) => (g && g.copy !== d.copy ? { ...g, copy: d.copy } : g));
      place(d);
    };
    const up = (e: PointerEvent) => {
      pointer.current = null;
      const mq = marqueeRef.current;
      if (mq) {
        marqueeRef.current = null;
        setMarquee(null);
        document.body.style.removeProperty("user-select");
        // A plain click on the empty space under the last block: go there.
        if (!mq.started && mq.onRoot && editable) {
          const last = blocksRef.current.filter((b) => !b.parent).pop();
          if (last && isText(last) && !plain(last.spans) && !kidsOf(last.id).length) focusBlock(last, "end");
          else {
            const fresh = text("p");
            commit([...blocksRef.current, fresh], { id: fresh.id, start: 0 });
          }
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (!d.started) {
        // A click on the handle: the block's menu.
        endDrag();
        const r = d.handle.getBoundingClientRect();
        if (!selectedRef.current.includes(d.from)) selectOnly(d.from);
        setBlockMenu({ id: d.from, x: r.left, y: r.bottom + 4 });
        return;
      }
      d.x = e.clientX;
      d.y = e.clientY;
      const copy = e.altKey;
      const at = dropAt(d.x, d.y, d.ids, copy);
      endDrag();
      if (!at) return;
      const before = new Set(blocksRef.current.map((b) => b.id));
      const next = moveTo(blocksRef.current, d.ids, at.id, at.where, copy);
      if (!next) return;
      if (at.where === "first-child" || at.where === "last-child") {
        const tb = next.find((b) => b.id === at.id);
        if (tb?.type === "toggle") setOpen((s) => s.add(at.id));
      }
      commit(next);
      const fresh = next.filter((b) => !before.has(b.id) && b.type !== "col" && b.type !== "columns");
      const freshIds = new Set(fresh.map((b) => b.id));
      setSelected(copy ? fresh.filter((b) => !b.parent || !freshIds.has(b.parent)).map((b) => b.id) : roots(next, d.ids));
      rootRef.current?.focus({ preventScroll: true });
    };
    const key = (e: KeyboardEvent) => {
      const d = dragRef.current;
      if (e.key === "Escape" && d?.started) {
        e.preventDefault();
        e.stopPropagation();
        endDrag();
      }
      // Alt pressed or let go without moving: the preview says copy or move at once.
      if (e.key === "Alt" && d?.started && d.copy !== (e.type === "keydown")) {
        e.preventDefault();
        d.copy = e.type === "keydown";
        setDragging((g) => (g ? { ...g, copy: d.copy } : g));
        place(d);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    return () => {
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("keydown", key, true);
    };
  });

  /** A box drawn from the margin or the empty space between blocks. */
  const onRootPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const at = e.target as HTMLElement;
    const root = rootRef.current;
    if (!root) return;
    const blank = at === root || at.matches("[data-block-wrap],[data-kids],[data-col-id],[data-block-type=columns]");
    if (!blank) return;
    e.preventDefault();
    marqueeRef.current = { x0: e.clientX, y0: e.clientY, started: false, base: e.shiftKey ? selectedRef.current : [], onRoot: at === root };
    if (!e.shiftKey && selectedRef.current.length) setSelected([]);
  };

  // ── files dropped from the computer ──
  const onFileDragOver = (bid: string, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files") || !uploadFile) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    setFileDrop((d) => (d?.id === bid && d.after === after ? d : { id: bid, after }));
  };
  const onFileDrop = (bid: string, e: React.DragEvent) => {
    const d = fileDrop;
    setFileDrop(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length || !uploadFile) return;
    e.preventDefault();
    void uploadInto(files, bid, d ? !d.after : false);
  };

  // ── numbering of numbered lists (per level) ──
  const kids = React.useMemo(() => childrenOf(blocks), [blocks]);
  const numbers = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const sibs of kids.values()) {
      let n = 0;
      let prev: EBlock | null = null;
      for (const b of sibs) {
        if (b.type === "number") {
          n = prev?.type === "number" && !b.newList ? n + 1 : (b.start ?? 1);
          out[b.id] = n;
        }
        prev = b;
      }
    }
    return out;
  }, [kids]);

  const onlyEmpty = blocks.length === 1 && isText(blocks[0]) && !plain(blocks[0].spans);
  const dragged = React.useMemo(() => {
    if (!dragging || dragging.copy) return new Set<string>();
    const list = blocksRef.current;
    return new Set(roots(list, dragging.ids).flatMap((r) => subtree(list, r).map((b) => b.id)));
  }, [dragging]);

  const addChild = (parentId: string) => {
    const fresh = text("p", { parent: parentId });
    const list = blocksRef.current;
    const at = list.findIndex((b) => b.id === parentId) + 1;
    commit(normalize([...list.slice(0, at), fresh, ...list.slice(at)]), { id: fresh.id, start: 0 });
  };

  const blockMap = React.useMemo(() => byId(blocks), [blocks]);
  const rowProps = (b: EBlock) => ({
    inCol: !!b.parent && blockMap.get(b.parent)?.type === "col",
    block: b,
    t,
    editable,
    selected: selected.includes(b.id),
    dimmed: dragged.has(b.id),
    fileDrop: (fileDrop?.id === b.id ? (fileDrop.after ? "after" : "before") : null) as "after" | "before" | null,
    number: numbers[b.id],
    open: open.has(b.id),
    placeholder: onlyEmpty ? t("blk_placeholder") : focusId === b.id ? (b.type === "toggle" ? t("blk_t_toggle") : t("blk_placeholder_line")) : undefined,
    editingSource: editingSource === b.id,
    resolveFileUrl,
  });

  const handlers = (b: EBlock): RowHandlers => ({
    register: (el) => {
      if (el) els.current.set(b.id, el);
      else els.current.delete(b.id);
    },
    onFocus: (start) => {
      focused.current = { id: b.id, start };
      anchor.current = b.id;
      setFocusId(b.id);
      if (selectedRef.current.length) setSelected([]);
    },
    onBlur: () => {
      setFocusId((f) => (f === b.id ? null : f));
      if (menu?.id === b.id) setTimeout(() => setMenu((m) => (m?.id === b.id && !rootRef.current?.contains(document.activeElement) ? null : m)), 150);
    },
    onPointerDown: (e) => onPointerDownBlock(b.id, e),
    onTextInput: (el, data) => {
      const cur = find(b.id);
      if (cur && isText(cur)) onTextInput(cur, el, data);
    },
    onTextKey: (el, e) => {
      const cur = find(b.id);
      if (cur && isText(cur)) onTextKey(cur, el, e);
    },
    onTextPaste: (el, e) => {
      const cur = find(b.id);
      if (cur && isText(cur)) onTextPaste(cur, el, e);
    },
    onChange: (nb, group) => commit(replace(b.id, () => nb), undefined, group),
    onToggleTodo: () => commit(replace(b.id, (x) => ({ ...(x as TextBlock), checked: !(x as TextBlock).checked }))),
    onToggleOpen: () => setOpen((s) => (s.has(b.id) ? s.delete(b.id) : s.add(b.id))),
    onSourceEdit: (on) => setEditingSource(on ? b.id : null),
    onSelect: () => selectOnly(b.id),
    onRemove: () => removeBlocks([b.id]),
    onExit: (where) => {
      if (where === "next") {
        const nb = neighbour(b.id, 1);
        if (nb) focusBlock(nb, "start");
        else {
          const fresh = text("p", { parent: find(b.id)?.parent });
          commit(insertAfterIn(blocksRef.current, b.id, [fresh]), { id: fresh.id, start: 0 });
        }
      } else focusBlock(neighbour(b.id, -1), "end");
    },
    onUndo: (redoIt) => (redoIt ? redo() : undo()),
    onPickMedia: onPickMedia
      ? () =>
          void onPickMedia().then((md) => {
            if (!md) return;
            const made = markdownToBlocks(md)[0];
            if (made && made.type === "media") commit(replace(b.id, (x) => ({ ...(x as EBlock), target: made.target, alt: (x as { alt?: string }).alt || made.alt }) as EBlock));
          })
      : undefined,
    onAdd: (e) => {
      const above = e.altKey;
      const list = blocksRef.current;
      const cur = find(b.id);
      if (cur && isText(cur) && !plain(cur.spans) && !above) {
        const withSlash = { ...cur, spans: [{ text: "/" }] };
        commit(replace(cur.id, () => withSlash), { id: cur.id, start: 1 });
        requestAnimationFrame(() => {
          const r = els.current.get(cur.id)?.getBoundingClientRect();
          setMenu({ id: cur.id, query: "", from: 0, x: r?.left ?? 0, y: r?.bottom ?? 0, index: 0, opened: "slash" });
        });
        return;
      }
      const fresh = text("p", { spans: [{ text: "/" }], parent: cur?.parent });
      const next = above ? normalize([...list.slice(0, list.findIndex((x) => x.id === b.id)), fresh, ...list.slice(list.findIndex((x) => x.id === b.id))]) : insertAfterIn(list, b.id, [fresh]);
      commit(next, { id: fresh.id, start: 1 });
      requestAnimationFrame(() => {
        const r = els.current.get(fresh.id)?.getBoundingClientRect();
        setMenu({ id: fresh.id, query: "", from: 0, x: r?.left ?? 0, y: r?.bottom ?? 0, index: 0, opened: "fresh" });
      });
    },
    onHandleDown: (e) => startHandle(b.id, e),
    onHandleKey: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (!selectedRef.current.includes(b.id)) selectOnly(b.id);
        setBlockMenu({ id: b.id, x: r.left, y: r.bottom + 4 });
      }
    },
    onMenuButton: (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (focused.current?.id === b.id) menuFrom.current = { ...focused.current };
      if (!selectedRef.current.includes(b.id)) selectOnly(b.id);
      setBlockMenu({ id: b.id, x: Math.max(8, r.right - 256), y: r.bottom + 4 });
    },
    onFileDragOver: (e) => onFileDragOver(b.id, e),
    onFileDragLeave: () => setFileDrop((d) => (d?.id === b.id ? null : d)),
    onFileDrop: (e) => onFileDrop(b.id, e),
    onTone: (tone) => commit(replace(b.id, (x) => ({ ...(x as TextBlock), tone }))),
  });

  const renderLevel = (parent: string): React.ReactNode => (kids.get(parent) ?? []).map((b) => renderBlock(b));
  const renderBlock = (b: EBlock): React.ReactNode => {
    const inside = kids.get(b.id) ?? [];
    if (b.type === "columns") {
      const cols = inside.filter((c) => c.type === "col");
      return (
        <div key={b.id} data-block-wrap={b.id}>
          <BlockRow {...rowProps(b)} {...handlers(b)}>
            <div className="flex gap-9 max-sm:flex-col max-sm:gap-1">
              {cols.map((c) => {
                const items = kids.get(c.id) ?? [];
                return (
                  <div key={c.id} data-col-id={c.id} className={cn("min-w-0 flex-1 rounded-md", dragged.has(c.id) && "opacity-40")}>
                    {items.length ? (
                      items.map(renderBlock)
                    ) : (
                      <EmptyDrop id={c.id} label={t("blk_col_empty")} editable={editable} onClick={() => addChild(c.id)} />
                    )}
                  </div>
                );
              })}
            </div>
          </BlockRow>
        </div>
      );
    }
    const showKids = b.type === "toggle" ? open.has(b.id) : inside.length > 0 && holdsBlocks(b);
    return (
      <div key={b.id} data-block-wrap={b.id}>
        <BlockRow {...rowProps(b)} {...handlers(b)} />
        {showKids ? (
          <div data-kids={b.id} role="group" className={cn(b.type === "toggle" ? "pl-7" : "pl-6", b.type === "number" && "pl-7")}>
            {inside.length ? renderLevel(b.id) : <EmptyDrop id={b.id} label={t("blk_toggle_empty")} editable={editable} onClick={() => addChild(b.id)} />}
          </div>
        ) : null}
      </div>
    );
  };

  const menuIds = blockMenu ? (selected.includes(blockMenu.id) ? selected : [blockMenu.id]) : [];
  React.useEffect(() => {
    if (!blockMenu) menuFrom.current = null;
  }, [blockMenu]);

  return (
    <div
      ref={rootRef}
      id={id}
      aria-describedby={describedBy}
      tabIndex={-1}
      role="group"
      aria-label={t("blk_body")}
      className="cms-blocks relative flex min-h-[360px] flex-1 flex-col pb-24 pt-2 outline-none sm:-ml-16 sm:-mr-10 sm:pl-16 sm:pr-10"
      onKeyDown={onRootKey}
      onKeyPress={onRootKeyPress}
      onCopy={onRootCopy}
      onPointerDown={onRootPointerDown}
    >
      {selected.length ? (
        <div className="sr-only" aria-live="polite">
          {t("blk_selected_n", { n: selected.length })}
        </div>
      ) : null}
      {renderLevel("")}

      {dropBox ? <div aria-hidden data-cms-drop-line className={cn("pointer-events-none fixed z-50 rounded-full bg-sky-500 dark:bg-sky-400", dropBox.side && "shadow-[0_0_0_3px_rgb(14_165_233/0.18)]")} style={{ left: dropBox.left, top: dropBox.top, width: dropBox.width, height: dropBox.height }} /> : null}
      {marquee ? <div aria-hidden className="pointer-events-none fixed z-40 rounded-sm border border-sky-500/40 bg-sky-500/10" style={marquee} /> : null}

      {menu && menuItems ? <SlashMenu t={t} items={menuItems} index={menu.index} x={menu.x} y={menu.y} onPick={applyItem} onHover={(index) => setMenu({ ...menu, index })} /> : null}

      {toolbar && !menu && !linkEdit && !dragging ? (
        <Toolbar
          t={t}
          at={toolbar}
          block={blocks.find((b) => b.id === toolbar.id) as TextBlock | undefined}
          onMark={(m) => {
            const b = find(toolbar.id);
            if (b && isText(b)) format(b, m, toolbar.start, toolbar.end);
          }}
          onLink={() => {
            const b = find(toolbar.id);
            if (b && isText(b)) openLink(b, toolbar.start, toolbar.end);
          }}
          onUnlink={() => {
            const b = find(toolbar.id);
            if (!b || !isText(b) || !toolbar.link) return;
            const spans = setLink(b.spans, toolbar.link.from, toolbar.link.to, null);
            commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start: toolbar.start });
          }}
          onTurn={(type) => turnInto([toolbar.id], type)}
          resolveFileUrl={resolveFileUrl}
        />
      ) : null}

      {linkEdit ? <LinkPopover t={t} at={linkEdit} onApply={applyLink} onCancel={() => setLinkEdit(null)} /> : null}

      {blockMenu ? (
        <BlockMenu
          t={t}
          at={blockMenu}
          blocks={menuIds.map((x) => blocks.find((b) => b.id === x)).filter((b): b is EBlock => !!b)}
          canIndent={!!indentBlocks(blocks, menuIds)}
          canOutdent={!!outdentBlocks(blocks, menuIds)}
          onClose={() => {
            setBlockMenu(null);
            const back = menuFrom.current;
            menuFrom.current = null;
            if (back && find(back.id)) {
              setSelected([]);
              pendingFocus.current = back;
              setBlocksState([...blocksRef.current]);
            } else rootRef.current?.focus({ preventScroll: true });
          }}
          onTurn={(type) => {
            setBlockMenu(null);
            setSelected([]);
            turnInto(menuIds, type);
          }}
          onDuplicate={() => {
            setBlockMenu(null);
            duplicate(menuIds);
          }}
          onMove={(dir) => moveVertical(menuIds, dir)}
          onIndent={(out) => {
            setBlockMenu(null);
            indentIds(menuIds, out);
          }}
          onCopy={() => {
            setBlockMenu(null);
            void copyBlocks(menuIds);
          }}
          onDelete={() => {
            setBlockMenu(null);
            removeBlocks(menuIds);
          }}
        />
      ) : null}
    </div>
  );
}

/** The picture of the blocks being dragged that follows the pointer. */
function makeGhost(root: HTMLElement | null, ids: string[]): HTMLElement | null {
  if (!root) return null;
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  const width = Math.min(root.getBoundingClientRect().width, 560);
  Object.assign(box.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${width}px`,
    maxHeight: "220px",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "60",
    opacity: "0.72",
    borderRadius: "8px",
    boxShadow: "0 8px 28px rgba(0,0,0,.18)",
    padding: "4px 8px",
  } satisfies Partial<CSSStyleDeclaration>);
  box.className = "bg-background text-foreground";
  for (const bid of ids.slice(0, 4)) {
    const wrap = root.querySelector(`[data-block-wrap="${CSS.escape(bid)}"]`);
    if (!wrap) continue;
    const copy = wrap.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-block-id],[data-block-wrap],[data-col-id],[data-kids],[data-drop-into]").forEach((el) => {
      el.removeAttribute("data-block-id");
      el.removeAttribute("data-block-wrap");
      el.removeAttribute("data-col-id");
      el.removeAttribute("data-kids");
      el.removeAttribute("data-drop-into");
    });
    copy.removeAttribute("data-block-wrap");
    copy.querySelectorAll("[contenteditable]").forEach((el) => el.setAttribute("contenteditable", "false"));
    copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    box.appendChild(copy);
  }
  if (ids.length > 4) {
    const more = document.createElement("div");
    more.textContent = `+${ids.length - 4}`;
    more.style.cssText = "font-size:12px;opacity:.7;padding:2px 0";
    box.appendChild(more);
  }
  document.body.appendChild(box);
  return box;
}

/** "Empty toggle / column": click to write, drop blocks here. */
function EmptyDrop({ id, label, editable, onClick }: { id: string; label: string; editable: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-drop-into={id}
      disabled={!editable}
      onClick={onClick}
      className="my-0.5 flex min-h-8 w-full items-center rounded-md px-2 py-1 text-left text-sm text-muted-foreground/70 hover:bg-muted/50 hover:text-muted-foreground disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
}
// ── helpers that read the page ────────────────────────────────────────────────

/**
 * The caret is at the end of bold, code or a link: put it in an empty text
 * node after them, so what comes next is plain text (as in Notion).
 */
function leaveMarks(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  let node: Node = r.startContainer;
  if (node.nodeType === 3 && r.startOffset !== (node.nodeValue ?? "").length) return;
  let outer: Node | null = null;
  // Climb while the caret is at the end of each element on the way up.
  while (node.parentNode && node.parentNode !== root) {
    const parent = node.parentNode as HTMLElement;
    const after = node.nextSibling;
    if (after && !(after.nodeType === 3 && !(after.nodeValue ?? "").replace(/\u200b/g, ""))) break;
    if (/^(STRONG|EM|S|CODE|A)$/.test(parent.tagName)) outer = parent;
    node = parent;
  }
  if (!outer) return;
  const zw = document.createTextNode("\u200b");
  outer.parentNode!.insertBefore(zw, outer.nextSibling);
  const nr = document.createRange();
  nr.setStart(zw, 1);
  nr.collapse(true);
  sel.removeAllRanges();
  sel.addRange(nr);
}

function caretRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  const rects = r.getClientRects();
  if (rects.length) return rects[rects.length - 1] as DOMRect;
  // An empty line has no rectangle: measure with a marker.
  const mark = document.createElement("span");
  mark.textContent = "\u200b";
  r.insertNode(mark);
  const rect = mark.getBoundingClientRect();
  mark.remove();
  return rect;
}

/** Is the caret on the first (or last) visual line of the element? */
function onEdgeLine(el: HTMLElement, edge: "top" | "bottom"): boolean {
  const r = caretRect();
  if (!r || (!r.height && !r.top)) return true;
  const box = el.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
  return edge === "top" ? r.top - box.top < line * 0.8 : box.bottom - r.bottom < line * 0.8;
}


// ── one block ─────────────────────────────────────────────────────────────────

interface RowHandlers {
  register: (el: HTMLElement | null) => void;
  onFocus: (start: number) => void;
  onBlur: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onTextInput: (el: HTMLElement, data: string | null) => void;
  onTextKey: (el: HTMLElement, e: React.KeyboardEvent) => void;
  onTextPaste: (el: HTMLElement, e: React.ClipboardEvent) => void;
  onChange: (b: EBlock, group?: string) => void;
  onToggleTodo: () => void;
  onToggleOpen: () => void;
  onSourceEdit: (on: boolean) => void;
  onSelect: () => void;
  onRemove: () => void;
  onExit: (where: "prev" | "next") => void;
  onUndo: (redo: boolean) => void;
  onPickMedia?: () => void;
  onAdd: (e: React.MouseEvent) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  onHandleKey: (e: React.KeyboardEvent) => void;
  onMenuButton: (e: React.MouseEvent) => void;
  onFileDragOver: (e: React.DragEvent) => void;
  onFileDragLeave: () => void;
  onFileDrop: (e: React.DragEvent) => void;
  onTone: (tone: Tone) => void;
}

interface RowProps extends RowHandlers {
  block: EBlock;
  t: T;
  editable: boolean;
  selected: boolean;
  dimmed: boolean;
  fileDrop: "before" | "after" | null;
  number?: number;
  open: boolean;
  /** Directly inside a column: a smaller handle that fits the gap between columns. */
  inCol?: boolean;
  placeholder?: string;
  editingSource: boolean;
  resolveFileUrl?: (target: string) => string;
  children?: React.ReactNode;
}

/** How far down the handle sits, so it lines up with the first line of text. */
const HANDLE_TOP: Partial<Record<EBlock["type"], string>> = { h2: "top-7", h3: "top-[18px]", columns: "top-1.5", table: "top-2.5", code: "top-1.5", callout: "top-2", media: "top-2" };

function BlockRow(p: RowProps) {
  const { block: b, t, editable } = p;
  const pad = b.type === "h2" ? "pt-6" : b.type === "h3" ? "pt-4" : "";
  return (
    <div
      data-block-id={b.id}
      data-block-type={b.type}
      aria-selected={p.selected || undefined}
      className={cn("group/blk relative rounded-md transition-[opacity,background-color]", editable && b.type !== "columns" && "max-sm:focus-within:pr-7 max-sm:aria-selected:pr-7", pad, p.selected && "bg-sky-500/[0.13] dark:bg-sky-400/[0.16]", p.dimmed && "opacity-35")}
      onPointerDown={p.onPointerDown}
      onDragOver={p.onFileDragOver}
      onDragLeave={p.onFileDragLeave}
      onDrop={p.onFileDrop}
    >
      {p.fileDrop ? <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 h-0.5 rounded bg-primary", p.fileDrop === "before" ? "-top-px" : "-bottom-px")} /> : null}
      {editable ? (
        <div
          contentEditable={false}
          data-cms-handle
          className={cn(
            // Only the buttons take the pointer: the margin around them stays free for drawing a selection box.
            "pointer-events-none absolute right-full flex select-none items-center gap-0.5 pr-1.5 opacity-0 transition-opacity duration-100 group-hover/blk:opacity-100 group-focus-within/blk:opacity-100 max-sm:hidden [&>button]:pointer-events-auto",
            HANDLE_TOP[b.type] ?? "top-0.5",
            (p.selected || p.dimmed) && "opacity-100",
            b.type === "columns" && "group-hover/blk:opacity-0 group-focus-within/blk:opacity-0 hover:!opacity-100"
          )}
        >
          {p.inCol ? null : (
            <button type="button" tabIndex={-1} aria-label={t("blk_add_below")} title={t("blk_add_hint")} className="flex size-6 items-center justify-center rounded text-muted-foreground/80 hover:bg-muted hover:text-foreground" onClick={p.onAdd}>
              <Plus className="size-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={t("blk_handle")}
            title={t("blk_handle_hint")}
            aria-haspopup="menu"
            className="flex h-6 w-[18px] cursor-grab touch-none items-center justify-center rounded text-muted-foreground/80 hover:bg-muted hover:text-foreground active:cursor-grabbing"
            onPointerDown={p.onHandleDown}
            onKeyDown={p.onHandleKey}
          >
            <GripVertical className="size-4" />
          </button>
        </div>
      ) : null}
      {editable && b.type !== "columns" ? (
        // Phones have no margin for the handle: a menu button shows on the block being edited.
        <button
          type="button"
          contentEditable={false}
          aria-label={t("blk_options")}
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={p.onMenuButton}
          className="absolute -right-1 top-0.5 hidden size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted max-sm:group-focus-within/blk:flex max-sm:group-aria-selected/blk:flex"
        >
          <GripVertical className="size-4" />
        </button>
      ) : null}
      {p.children ?? <BlockBody {...p} />}
    </div>
  );
}

function BlockBody(p: RowProps) {
  const { block: b, t } = p;
  if (isText(b)) return <TextBody {...p} block={b} />;
  if (b.type === "code") return <CodeBody {...p} block={b} />;
  if (b.type === "table") return <TableBody {...p} block={b} />;
  if (b.type === "hr")
    return (
      <button type="button" ref={p.register} aria-label={t("blk_t_hr")} className="block w-full py-3 outline-none" onKeyDown={(e) => keysOnObject(e, p)} onFocus={() => p.onFocus(0)} onBlur={p.onBlur} onClick={p.onSelect}>
        <hr className="border-t-2" />
      </button>
    );
  if (b.type === "media") return <MediaBody {...p} block={b} />;
  if (b.type === "source") return <SourceBody {...p} block={b} />;
  return null;
}

/** Keys on a block that is not text (divider, image, drawn source): move, delete, undo. */
function keysOnObject(e: React.KeyboardEvent, p: RowProps) {
  const mod = isApple() ? e.metaKey : e.ctrlKey;
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
    e.preventDefault();
    p.onExit("prev");
  } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
    e.preventDefault();
    p.onExit("next");
  } else if ((e.key === "Backspace" || e.key === "Delete") && p.editable) {
    e.preventDefault();
    p.onRemove();
  } else if (e.key === "Escape") {
    e.preventDefault();
    p.onSelect();
  } else if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    p.onUndo(e.shiftKey);
  }
}

const TEXT_CLASS: Record<TextType, string> = {
  p: "text-[15px] leading-7",
  h2: "text-2xl font-semibold leading-tight tracking-tight",
  h3: "text-lg font-semibold leading-snug",
  quote: "border-l-[3px] border-foreground/70 pl-4 text-[15px] leading-7",
  callout: "text-[15px] leading-7",
  bullet: "text-[15px] leading-7",
  number: "text-[15px] leading-7",
  todo: "text-[15px] leading-7",
  toggle: "text-[15px] leading-7",
};

const TONE_STYLE: Record<Tone, string> = {
  note: "bg-sky-500/10 border-sky-500/30",
  tip: "bg-emerald-500/10 border-emerald-500/30",
  warning: "bg-amber-500/10 border-amber-500/40",
};

/** An editable piece of formatted text (a block's line, a table cell). */
function useSpansElement(spans: Span[]) {
  const ref = React.useRef<HTMLDivElement & { _spans?: Span[] }>(null);
  const composing = React.useRef(false);
  // Draw the spans unless they came from this element's own typing.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || composing.current) return;
    if (el._spans === spans) return;
    el._spans = spans;
    const html = spansToHtml(spans);
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [spans]);
  return { ref, composing };
}

function TextBody(p: RowProps & { block: TextBlock }) {
  const { block: b, t, editable } = p;
  const { ref, composing } = useSpansElement(b.spans);
  const setRef = (el: HTMLDivElement | null) => {
    (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    p.register(el);
  };
  const empty = !b.spans.length;
  const editableEl = (
    <div
      ref={setRef}
      role="textbox"
      aria-multiline="true"
      aria-label={t(`blk_t_${b.type}` as Key)}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={empty ? p.placeholder : undefined}
      className={cn(
        "min-h-[1.75rem] whitespace-pre-wrap break-words py-[3px] outline-none",
        TEXT_CLASS[b.type],
        b.type === "todo" && b.checked && "text-muted-foreground line-through decoration-muted-foreground/60",
        "[&_a]:cursor-pointer [&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/40 [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.88em]",
        empty && p.placeholder && "before:pointer-events-none before:absolute before:text-muted-foreground/60 before:content-[attr(data-placeholder)]"
      )}
      onFocus={() => {
        const s = ref.current ? selectionIn(ref.current) : null;
        p.onFocus(s?.start ?? 0);
      }}
      onBlur={p.onBlur}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        p.onTextInput(e.currentTarget, null);
      }}
      onInput={(e) => {
        const ne = e.nativeEvent as InputEvent;
        if (composing.current || ne.isComposing) return;
        if (ne.inputType === "historyUndo" || ne.inputType === "historyRedo") return;
        // Text formatting from the browser's own menu goes through our spans too.
        p.onTextInput(e.currentTarget, ne.data ?? null);
      }}
      onBeforeInput={(e) => {
        const ne = e.nativeEvent as InputEvent;
        if (ne.inputType === "historyUndo" || ne.inputType === "historyRedo") {
          e.preventDefault();
          p.onUndo(ne.inputType === "historyRedo");
        }
        if (ne.inputType === "formatBold" || ne.inputType === "formatItalic" || ne.inputType === "formatUnderline") e.preventDefault();
      }}
      onKeyDown={(e) => p.onTextKey(e.currentTarget, e)}
      onPaste={(e) => p.onTextPaste(e.currentTarget, e)}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        const href = a?.getAttribute("data-href");
        // ⌘/Ctrl-click opens a link (a plain click puts the caret in it).
        if (href && (e.metaKey || e.ctrlKey) && /^https?:|^\//.test(href)) window.open(href, "_blank", "noopener,noreferrer");
      }}
    />
  );
  if (b.type === "toggle")
    return (
      <div className="relative flex items-start gap-1">
        <button
          type="button"
          contentEditable={false}
          aria-expanded={p.open}
          aria-label={p.open ? t("blk_toggle_close") : t("blk_toggle_open")}
          title={p.open ? t("blk_toggle_close") : t("blk_toggle_open")}
          onClick={p.onToggleOpen}
          onMouseDown={(e) => e.preventDefault()}
          className="mt-[5px] flex size-6 shrink-0 items-center justify-center rounded text-foreground/70 hover:bg-muted"
        >
          <ChevronRight className={cn("size-4 transition-transform duration-150", p.open && "rotate-90")} />
        </button>
        <div className="relative min-w-0 flex-1">{editableEl}</div>
      </div>
    );
  if (b.type === "bullet" || b.type === "number" || b.type === "todo")
    return (
      <div className="relative flex items-start gap-2">
        <span contentEditable={false} className="flex h-[34px] min-w-6 shrink-0 select-none items-center justify-center text-[15px] text-muted-foreground">
          {b.type === "bullet" ? (
            <span className="size-1.5 rounded-full bg-foreground/80" />
          ) : b.type === "number" ? (
            <span className="tabular-nums text-foreground/80">{p.number ?? 1}.</span>
          ) : (
            <button
              type="button"
              role="checkbox"
              aria-checked={!!b.checked}
              aria-label={plain(b.spans) || t("blk_t_todo")}
              disabled={!editable}
              onClick={p.onToggleTodo}
              className={cn("flex size-[18px] items-center justify-center rounded border-[1.5px] transition-colors", b.checked ? "border-primary bg-primary text-primary-foreground" : "border-foreground/40 hover:bg-muted")}
            >
              {b.checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
            </button>
          )}
        </span>
        <div className="relative min-w-0 flex-1">{editableEl}</div>
      </div>
    );
  if (b.type === "callout") {
    const tone = b.tone ?? "note";
    return (
      <div className={cn("relative my-1 flex items-start gap-2.5 rounded-lg border px-3 py-2", TONE_STYLE[tone])}>
        <NativeSelect
          aria-label={t("blk_callout_tone")}
          value={tone}
          disabled={!editable}
          onChange={(e) => p.onTone(e.target.value as Tone)}
          contentEditable={false}
          className="mt-1 h-6 shrink-0 cursor-pointer appearance-none rounded bg-transparent px-1 text-xs font-semibold uppercase tracking-wide text-foreground/70 outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {(["note", "tip", "warning"] as const).map((x) => (
            <option key={x} value={x}>
              {t(`blk_tone_${x}` as Key)}
            </option>
          ))}
        </NativeSelect>
        <div className="relative min-w-0 flex-1">{editableEl}</div>
      </div>
    );
  }
  return <div className="relative">{editableEl}</div>;
}

// ── tables ────────────────────────────────────────────────────────────────────

/** One table cell: formatted text on one line. */
function CellText({
  spans,
  editable,
  label,
  align,
  head,
  register,
  onSpans,
  onKey,
  onFocusCell,
}: {
  spans: Span[];
  editable: boolean;
  label: string;
  align: TableAlign;
  head: boolean;
  register?: (el: HTMLElement | null) => void;
  onSpans: (s: Span[]) => void;
  onKey: (e: React.KeyboardEvent<HTMLDivElement>, el: HTMLDivElement) => void;
  onFocusCell: () => void;
}) {
  const { ref, composing } = useSpansElement(spans);
  return (
    <div
      ref={(el) => {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        register?.(el);
      }}
      role="textbox"
      aria-label={label}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck
      className={cn(
        "min-h-[1.6rem] whitespace-pre-wrap break-words px-2 py-1.5 outline-none [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.88em]",
        head && "font-semibold",
        align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left"
      )}
      onFocus={onFocusCell}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        const s = domToSpans(e.currentTarget);
        (e.currentTarget as HTMLDivElement & { _spans?: Span[] })._spans = s;
        onSpans(s);
      }}
      onInput={(e) => {
        const ne = e.nativeEvent as InputEvent;
        if (composing.current || ne.isComposing) return;
        const s = domToSpans(e.currentTarget).map((x) => ({ ...x, text: x.text.replace(/\n/g, " ") }));
        (e.currentTarget as HTMLDivElement & { _spans?: Span[] })._spans = s;
        onSpans(s);
      }}
      onBeforeInput={(e) => {
        const ne = e.nativeEvent as InputEvent;
        if (/^format|insertParagraph|insertLineBreak/.test(ne.inputType)) e.preventDefault();
      }}
      onPaste={(e) => {
        e.preventDefault();
        const one = e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
        document.execCommand("insertText", false, one);
      }}
      onKeyDown={(e) => onKey(e, e.currentTarget)}
    />
  );
}

type TableMenu = { kind: "row" | "col" | "cell"; row: number; col: number; x: number; y: number; back?: HTMLElement | null } | null;

function TableBody(p: RowProps & { block: TableBlock }) {
  const { block: b, t, editable } = p;
  const cells = React.useRef(new Map<string, HTMLDivElement>());
  const [menu, setMenu] = React.useState<TableMenu>(null);
  const width = Math.max(1, b.head.length, ...b.rows.map((r) => r.length));
  const fill = (r: Span[][]) => Array.from({ length: width }, (_, k) => r[k] ?? []);
  const head = fill(b.head);
  const rows = b.rows.map(fill);
  const align: TableAlign[] = Array.from({ length: width }, (_, k) => b.align[k] ?? null);
  const save = (next: Partial<TableBlock>, group?: string) => p.onChange({ ...b, head, rows, align, ...next } as TableBlock, group);

  // Focus moves at once (keys typed right after Tab land in the new cell); a cell that is
  // not drawn yet (a row just added) gets it as soon as it is.
  const pendingCell = React.useRef<{ r: number; c: number; at: "start" | "end" } | null>(null);
  const putCaret = (el: HTMLDivElement, at: "start" | "end") => {
    el.focus({ preventScroll: true });
    const len = (el.textContent ?? "").replace(/\u200b/g, "").length;
    setSelectionIn(el, at === "end" ? len : 0);
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const focusCell = (r: number, c: number, at: "start" | "end" = "end") => {
    const el = cells.current.get(`${r}:${c}`);
    if (el) putCaret(el, at);
    else pendingCell.current = { r, c, at };
  };
  React.useLayoutEffect(() => {
    const want = pendingCell.current;
    if (!want) return;
    const el = cells.current.get(`${want.r}:${want.c}`);
    if (!el) return;
    pendingCell.current = null;
    putCaret(el, want.at);
  });

  const setCell = (r: number, c: number, spans: Span[]) => {
    if (r < 0) save({ head: head.map((x, k) => (k === c ? spans : x)) }, `cell:${b.id}:${r}:${c}`);
    else save({ rows: rows.map((row, i) => (i === r ? row.map((x, k) => (k === c ? spans : x)) : row)) }, `cell:${b.id}:${r}:${c}`);
  };
  const addRow = (at: number) => save({ rows: [...rows.slice(0, at), emptyRow(width), ...rows.slice(at)] });
  const addCol = (at: number) =>
    save({
      head: [...head.slice(0, at), [], ...head.slice(at)],
      rows: rows.map((r) => [...r.slice(0, at), [], ...r.slice(at)]),
      align: [...align.slice(0, at), null, ...align.slice(at)],
    });
  const delRow = (i: number) => save({ rows: rows.filter((_, k) => k !== i) });
  const delCol = (c: number) => {
    if (width <= 1) return p.onRemove();
    save({ head: head.filter((_, k) => k !== c), rows: rows.map((r) => r.filter((_, k) => k !== c)), align: align.filter((_, k) => k !== c) });
  };

  const onKey = (r: number, c: number) => (e: React.KeyboardEvent<HTMLDivElement>, el: HTMLDivElement) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = isApple() ? e.metaKey : e.ctrlKey;
    const sel = selectionIn(el) ?? { start: 0, end: 0, collapsed: true };
    const len = (el.textContent ?? "").replace(/\u200b/g, "").length;
    const last = rows.length - 1;
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (c > 0) focusCell(r, c - 1);
        else if (r > -1) focusCell(r - 1, width - 1);
        else p.onExit("prev");
      } else if (c < width - 1) focusCell(r, c + 1, "start");
      else if (r < last) focusCell(r + 1, 0, "start");
      else {
        addRow(rows.length);
        focusCell(rows.length, 0, "start");
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mod) return p.onExit("next");
      if (r < last) focusCell(r + 1, c);
      else {
        addRow(rows.length);
        focusCell(rows.length, c);
      }
      return;
    }
    if (e.key === "Enter") return e.preventDefault();
    if (e.key === "ArrowUp" && !e.shiftKey) {
      e.preventDefault();
      if (r > -1) focusCell(r - 1, c);
      else p.onExit("prev");
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey) {
      e.preventDefault();
      if (r < last) focusCell(r + 1, c);
      else p.onExit("next");
      return;
    }
    if (e.key === "ArrowLeft" && sel.collapsed && sel.start === 0 && !e.shiftKey && c > 0) {
      e.preventDefault();
      focusCell(r, c - 1);
      return;
    }
    if (e.key === "ArrowRight" && sel.collapsed && sel.start === len && !e.shiftKey && c < width - 1) {
      e.preventDefault();
      focusCell(r, c + 1, "start");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      p.onSelect();
      return;
    }
    if (mod && !e.altKey && e.key === "/") {
      // The row and column actions from the keyboard.
      e.preventDefault();
      const rr = el.getBoundingClientRect();
      setMenu({ kind: "cell", row: r, col: c, x: rr.left, y: rr.bottom + 2, back: el });
      return;
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const marks: Record<string, Mark> = { b: "b", i: "i", e: "code" };
      if (marks[k] && sel.start !== sel.end) {
        e.preventDefault();
        const cur = r < 0 ? head[c] : rows[r][c];
        setCell(r, c, toggleMark(cur, sel.start, sel.end, marks[k]));
        requestAnimationFrame(() => setSelectionIn(el, sel.start, sel.end));
        return;
      }
      if (k === "z") {
        e.preventDefault();
        p.onUndo(e.shiftKey);
      }
    }
  };

  const cell = (r: number, c: number, spans: Span[]) => (
    <CellText
      spans={spans}
      editable={editable}
      head={r < 0}
      align={align[c]}
      label={r < 0 ? t("blk_table_head_cell", { col: c + 1 }) : t("blk_table_cell", { row: r + 1, col: c + 1 })}
      register={(el) => {
        if (el) cells.current.set(`${r}:${c}`, el as HTMLDivElement);
        else cells.current.delete(`${r}:${c}`);
        if (r === -1 && c === 0) p.register(el);
      }}
      onSpans={(s) => setCell(r, c, s)}
      onKey={onKey(r, c)}
      onFocusCell={() => p.onFocus(0)}
    />
  );

  const menuButton = (kind: "row" | "col", index: number, cls: string) =>
    editable ? (
      <button
        type="button"
        tabIndex={-1}
        contentEditable={false}
        aria-label={kind === "row" ? t("blk_table_row_menu") : t("blk_table_col_menu")}
        title={kind === "row" ? t("blk_table_row_menu") : t("blk_table_col_menu")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ kind, row: kind === "row" ? index : -1, col: kind === "col" ? index : 0, x: r.left, y: r.bottom + 2, back: cells.current.get(kind === "row" ? `${index}:0` : `-1:${index}`) });
        }}
        className={cn("absolute z-[1] flex items-center justify-center rounded bg-background/95 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:text-foreground", cls)}
      >
        <MoreHorizontal className="size-3.5" />
      </button>
    ) : null;

  React.useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-cms-pop]")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);
  const menuRef = React.useRef<HTMLDivElement>(null);
  // The menu takes the focus; Esc closes it and gives the focus back to the cell.
  React.useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [menu]);
  const closeMenu = () => {
    const back = menu?.back;
    setMenu(null);
    if (back?.isConnected) back.focus();
  };

  const menuItem = (label: string, Icon: Icon, run: () => void, danger?: boolean) => (
    <button
      role="menuitem"
      type="button"
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted", danger && "text-destructive")}
      onClick={() => {
        closeMenu();
        run();
      }}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
  const rowItems = (i: number) => (
    <>
      {menuItem(t("blk_table_above"), ArrowUpToLine, () => addRow(i))}
      {menuItem(t("blk_table_below"), ArrowDownToLine, () => addRow(i + 1))}
      {menuItem(t("blk_table_del_row"), Trash2, () => delRow(i), true)}
    </>
  );
  const colItems = (c: number) => (
    <>
      {menuItem(t("blk_table_align_left"), AlignLeft, () => save({ align: align.map((a, k) => (k === c ? "left" : a)) }))}
      {menuItem(t("blk_table_align_center"), AlignCenter, () => save({ align: align.map((a, k) => (k === c ? "center" : a)) }))}
      {menuItem(t("blk_table_align_right"), AlignRight, () => save({ align: align.map((a, k) => (k === c ? "right" : a)) }))}
      <div className="my-1 h-px bg-border" />
      {menuItem(t("blk_table_left"), ArrowLeftToLine, () => addCol(c))}
      {menuItem(t("blk_table_right"), ArrowRightToLine, () => addCol(c + 1))}
      {menuItem(t("blk_table_del_col"), Trash2, () => delCol(c), true)}
    </>
  );

  return (
    <div className="group/table relative my-2 flex items-stretch gap-1">
      <div className="min-w-0 flex-1">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-max border-collapse text-[14px] leading-6">
            <thead>
              <tr className="bg-muted/50">
                {head.map((s, c) => (
                  <th key={c} className="group/th relative min-w-24 border-b border-r p-0 align-top font-normal last:border-r-0">
                    {cell(-1, c, s)}
                    {menuButton("col", c, cn("top-1.5 size-5 group-hover/th:opacity-100 focus:opacity-100", align[c] === "right" ? "left-1" : "right-1"))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="group/tr">
                  {row.map((s, c) => (
                    <td key={c} className="relative min-w-24 border-b border-r p-0 align-top last:border-r-0 [tr:last-child_&]:border-b-0">
                      {cell(r, c, s)}
                      {c === 0 ? menuButton("row", r, "-left-0 top-1/2 h-5 w-3.5 -translate-y-1/2 group-hover/tr:opacity-100") : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable ? (
          <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => (addRow(rows.length), focusCell(rows.length, 0, "start"))} aria-label={t("blk_table_add_row")} title={t("blk_table_add_row")} className="mt-1 flex h-5 w-full items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/table:opacity-100 focus-visible:opacity-100">
            <Plus className="size-3.5" />
          </button>
        ) : null}
      </div>
      {editable ? (
        <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => (addCol(width), focusCell(-1, width, "start"))} aria-label={t("blk_table_add_col")} title={t("blk_table_add_col")} className="mb-6 flex w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/table:opacity-100 focus-visible:opacity-100">
          <Plus className="size-3.5" />
        </button>
      ) : null}
      {menu ? (
        <Floating x={menu.x} y={menu.y} className="w-52 p-1">
          <div
            ref={menuRef}
            role="menu"
            aria-label={menu.kind === "row" ? t("blk_table_row_menu") : t("blk_table_col_menu")}
            onKeyDown={(e) => {
              const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
              const i = items.indexOf(document.activeElement as HTMLElement);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeMenu();
              }
            }}
          >
            {menu.kind === "row" ? rowItems(menu.row) : menu.kind === "col" ? colItems(menu.col) : (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{t("blk_table_col_menu")}</div>
                {colItems(menu.col)}
                {menu.row >= 0 ? (
                  <>
                    <div className="my-1 h-px bg-border" />
                    <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{t("blk_table_row_menu")}</div>
                    {rowItems(menu.row)}
                  </>
                ) : null}
              </>
            )}
          </div>
        </Floating>
      ) : null}
    </div>
  );
}

// ── pictures and files ────────────────────────────────────────────────────────

function MediaBody(p: RowProps & { block: Extract<EBlock, { type: "media" }> & { pending?: string } }) {
  const { block: b, t, editable } = p;
  const name = decodeURIComponent(b.target.replace(/^asset:[a-z0-9]+\//i, "").split(/[?#]/)[0].split("/").pop() ?? "");
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name) || /^https?:/.test(b.target);
  const url = b.target ? (p.resolveFileUrl ? p.resolveFileUrl(b.target) : b.target) : "";
  const exitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      p.onExit("next");
    }
  };
  return (
    <figure
      ref={p.register as React.Ref<HTMLElement>}
      tabIndex={0}
      className="group/media my-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onFocus={(e) => e.target === e.currentTarget && p.onFocus(0)}
      onBlur={p.onBlur}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget) keysOnObject(e, p);
      }}
    >
      {b.pending ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground" role="status">
          {t("blk_media_uploading", { name: b.pending })}
        </div>
      ) : isImage && url ? (
        <div className="relative w-fit max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={b.alt} className="max-h-[480px] w-auto max-w-full rounded-lg border object-contain" draggable={false} />
          {editable ? (
            <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
              {p.onPickMedia ? (
                <button type="button" className="rounded-md bg-background/90 px-2 py-1 text-xs font-medium shadow-sm ring-1 ring-border hover:bg-background" onClick={p.onPickMedia}>
                  {t("blk_media_replace")}
                </button>
              ) : null}
              <button type="button" aria-label={t("blk_delete")} className="rounded-md bg-background/90 px-1.5 py-1 shadow-sm ring-1 ring-border hover:bg-background" onClick={p.onRemove}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <ImageIcon className="size-4 text-muted-foreground" />
          <span className="truncate font-medium">{name || b.target}</span>
          <span className="text-xs text-muted-foreground">{t("blk_media_file")}</span>
        </div>
      )}
      {!b.pending ? (
        <figcaption className="mt-1 space-y-0.5">
          <input
            aria-label={t("blk_caption")}
            value={b.caption ?? ""}
            readOnly={!editable}
            placeholder={editable ? t("blk_caption_placeholder") : ""}
            onChange={(e) => p.onChange({ ...b, caption: e.target.value || undefined }, `cap:${b.id}`)}
            onKeyDown={exitOnEnter}
            className={cn("h-7 w-full rounded bg-transparent px-1 text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/50 focus:bg-muted/60", !b.caption && "opacity-0 focus:opacity-100 group-hover/media:opacity-100 [@media(hover:none)]:opacity-100")}
          />
          <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <span className="shrink-0 font-medium">{t("blk_alt_short")}</span>
            <input
              aria-label={t("blk_alt")}
              title={t("blk_alt_hint")}
              value={b.alt}
              readOnly={!editable}
              placeholder={t("blk_alt_missing")}
              onChange={(e) => p.onChange({ ...b, alt: e.target.value }, `alt:${b.id}`)}
              onKeyDown={exitOnEnter}
              className={cn("h-6 min-w-0 flex-1 rounded bg-transparent px-1 outline-none placeholder:text-amber-600/80 focus:bg-muted/60", !b.alt && "italic")}
            />
          </label>
        </figcaption>
      ) : null}
    </figure>
  );
}
function useGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [ref, value]);
}

function CodeBody(p: RowProps & { block: Extract<EBlock, { type: "code" }> }) {
  const { block: b, t, editable } = p;
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  useGrow(ref, b.text);
  return (
    <div className="my-1 overflow-hidden rounded-lg border bg-muted/50">
      <div className="flex items-center gap-2 border-b px-3 py-1" contentEditable={false}>
        <Code className="size-3.5 text-muted-foreground" />
        <input
          aria-label={t("blk_code_lang")}
          value={b.lang}
          placeholder={t("blk_code_lang_none")}
          readOnly={!editable}
          spellCheck={false}
          onChange={(e) => p.onChange({ ...b, lang: e.target.value.replace(/[^\w+#.-]/g, "").slice(0, 24) })}
          className="h-6 w-40 bg-transparent font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      <textarea
        ref={(el) => {
          ref.current = el;
          p.register(el);
        }}
        aria-label={t("blk_t_code")}
        value={b.text}
        readOnly={!editable}
        spellCheck={false}
        dir="ltr"
        rows={1}
        className="block w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] leading-5 outline-none"
        onFocus={(e) => p.onFocus(e.currentTarget.selectionStart)}
        onBlur={p.onBlur}
        onChange={(e) => p.onChange({ ...b, text: e.target.value }, `code:${b.id}`)}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          const mod = isApple() ? e.metaKey : e.ctrlKey;
          if (e.key === "Tab" && !e.shiftKey && editable) {
            e.preventDefault();
            const s = el.selectionStart;
            const next = b.text.slice(0, s) + "  " + b.text.slice(el.selectionEnd);
            p.onChange({ ...b, text: next }, `code:${b.id}`);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          } else if ((e.key === "Enter" && mod) || (e.key === "ArrowDown" && el.selectionStart === b.text.length) || (e.key === "ArrowRight" && el.selectionStart === b.text.length && el.selectionEnd === b.text.length)) {
            e.preventDefault();
            p.onExit("next");
          } else if ((e.key === "ArrowUp" && el.selectionStart === 0) || (e.key === "ArrowLeft" && el.selectionStart === 0 && el.selectionEnd === 0)) {
            e.preventDefault();
            p.onExit("prev");
          } else if (e.key === "Backspace" && !b.text && editable) {
            e.preventDefault();
            p.onChange({ id: b.id, type: "p", spans: [] } as TextBlock);
          } else if (e.key === "Escape") {
            e.preventDefault();
            p.onSelect();
          } else if (mod && e.key.toLowerCase() === "z") {
            e.preventDefault();
            p.onUndo(e.shiftKey);
          }
        }}
      />
    </div>
  );
}
function SourceBody(p: RowProps & { block: Extract<EBlock, { type: "source" }> }) {
  const { block: b, t, editable } = p;
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = React.useState(b.md);
  React.useEffect(() => setDraft(b.md), [b.md]);
  useGrow(ref, p.editingSource ? draft : "");
  const label = t(SOURCE_LABEL[b.kind] ?? "blk_src_raw");
  const done = () => {
    if (draft !== b.md) p.onChange({ ...b, md: draft });
    p.onSourceEdit(false);
  };
  if (p.editingSource && editable)
    return (
      <div className="my-1 overflow-hidden rounded-lg border border-primary/40 bg-muted/40" data-cms-source={b.kind}>
        <div className="flex items-center gap-2 border-b px-3 py-1 text-[11px] text-muted-foreground">
          <span className="rounded bg-background px-1.5 py-0.5 font-medium text-foreground">{label}</span>
          <span className="truncate">{t("blk_src_hint")}</span>
          <span className="grow" />
          <button type="button" className="rounded px-2 py-0.5 font-medium text-foreground hover:bg-background" onMouseDown={(e) => e.preventDefault()} onClick={done}>
            {t("blk_src_done")}
          </button>
        </div>
        <textarea
          ref={(el) => {
            ref.current = el;
            p.register(el);
          }}
          aria-label={label}
          value={draft}
          spellCheck={false}
          dir="ltr"
          rows={2}
          className="block w-full resize-none bg-transparent px-3 py-2 font-mono text-[12.5px] leading-5 outline-none"
          onFocus={() => p.onFocus(0)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            done();
            p.onBlur();
          }}
          onKeyDown={(e) => {
            const mod = isApple() ? e.metaKey : e.ctrlKey;
            if (e.key === "Escape" || (e.key === "Enter" && mod)) {
              e.preventDefault();
              done();
              p.onSelect();
            }
          }}
        />
      </div>
    );
  return (
    <div
      ref={p.register as React.Ref<HTMLDivElement>}
      tabIndex={0}
      role="button"
      aria-label={`${label}: ${t("blk_src_edit")}`}
      data-cms-source={b.kind}
      className="group/src relative my-1 cursor-text rounded-lg outline-none ring-offset-2 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
      onFocus={() => p.onFocus(0)}
      onBlur={p.onBlur}
      onDoubleClick={() => editable && p.onSourceEdit(true)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" && editable) {
          e.preventDefault();
          p.onSourceEdit(true);
        } else keysOnObject(e, p);
      }}
    >
      <div className="pointer-events-none [&_iframe]:pointer-events-none">
        <MarkdownPreview body={b.md} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
      </div>
      {editable ? (
        <button
          type="button"
          tabIndex={-1}
          className="absolute right-1 top-1 flex items-center gap-1 rounded-md bg-background/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:text-foreground group-hover/src:opacity-100 group-focus/src:opacity-100"
          onClick={() => p.onSourceEdit(true)}
        >
          <Pencil className="size-3" />
          {label}
        </button>
      ) : null}
    </div>
  );
}

// ── floating parts ────────────────────────────────────────────────────────────

function Floating({ x, y, above, children, className, label }: { x: number; y: number; above?: boolean; children: React.ReactNode; className?: string; label?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ left: x, top: y });
  // Placed after every render: what is inside can grow or shrink (a filtered menu).
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vh = window.innerHeight;
    let left = above ? x - w / 2 : x;
    let top = above ? y - h - 8 : y + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (!above && top + h > vh - 8) {
      // Not enough room below: above if there is more room there, else as low as fits.
      const up = y - h - 28;
      top = up >= 8 && y - 28 > vh - y ? up : Math.max(8, vh - h - 8);
    }
    if (above && top < 8) top = y + 28;
    if (pos.left !== left || pos.top !== top) setPos({ left, top });
  });
  return (
    <div ref={ref} data-cms-pop role={label ? "toolbar" : undefined} aria-label={label} className={cn("fixed z-50 rounded-lg border bg-popover text-popover-foreground shadow-lg", className)} style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}

function SlashMenu({ t, items, index, x, y, onPick, onHover }: { t: T; items: Item[]; index: number; x: number; y: number; onPick: (i: Item) => void; onHover: (i: number) => void }) {
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  let lastGroup = "";
  return (
    <Floating x={x} y={y} className="w-72 p-1">
      <div ref={list} role="listbox" aria-label={t("blk_slash_label")} className="max-h-80 overflow-y-auto">
        {items.length ? (
          items.map((it, n) => {
            const head = it.group !== lastGroup ? t(it.group) : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <React.Fragment key={it.key}>
                {head ? <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground first:pt-1">{head}</div> : null}
                <div
                  role="option"
                  aria-selected={n === index}
                  data-index={n}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5", n === index && "bg-accent text-accent-foreground")}
                  onMouseEnter={() => onHover(n)}
                  onClick={() => onPick(it)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(it.label)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t(it.hint)}</span>
                  </span>
                </div>
              </React.Fragment>
            );
          })
        ) : (
          <div className="px-2 py-3 text-sm text-muted-foreground">{t("blk_slash_none")}</div>
        )}
      </div>
    </Floating>
  );
}

function Toolbar({
  t,
  at,
  block,
  onMark,
  onLink,
  onUnlink,
  onTurn,
  resolveFileUrl,
}: {
  t: T;
  at: { id: string; start: number; end: number; x: number; y: number; link: ReturnType<typeof linkAt> };
  block: TextBlock | undefined;
  onMark: (m: Mark) => void;
  onLink: () => void;
  onUnlink: () => void;
  onTurn: (type: TurnType) => void;
  resolveFileUrl?: (target: string) => string;
}) {
  const [turnOpen, setTurnOpen] = React.useState(false);
  if (!block) return null;
  const mod = isApple() ? "⌘" : "Ctrl+";
  if (at.start === at.end && at.link) {
    const href = at.link.href;
    const shown = href.startsWith(APP_LINK) ? href.slice(APP_LINK.length) : href;
    const openable = /^https?:|^\//.test(href) || href.startsWith("asset:");
    return (
      <Floating x={at.x} y={at.y} above label={t("blk_fmt_link")} className="flex items-center gap-1 p-1 text-xs">
        <span className="max-w-64 truncate px-1.5 font-mono text-muted-foreground" dir="ltr">
          {shown}
        </span>
        {openable ? (
          <a className="flex size-7 items-center justify-center rounded hover:bg-muted" href={href.startsWith("asset:") && resolveFileUrl ? resolveFileUrl(href) : href} target="_blank" rel="noopener noreferrer" aria-label={t("blk_link_open")} title={t("blk_link_open")}>
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
        <button type="button" className="flex size-7 items-center justify-center rounded hover:bg-muted" aria-label={t("blk_link_edit")} title={t("blk_link_edit")} onClick={onLink}>
          <Pencil className="size-3.5" />
        </button>
        <button type="button" className="flex size-7 items-center justify-center rounded hover:bg-muted" aria-label={t("blk_link_remove")} title={t("blk_link_remove")} onClick={onUnlink}>
          <Unlink className="size-3.5" />
        </button>
      </Floating>
    );
  }
  const btn = (m: Mark, Icon: React.ComponentType<{ className?: string }>, label: Key, keys: string) => {
    const on = hasMark(block.spans, at.start, at.end, m);
    return (
      <button type="button" aria-pressed={on} aria-label={t(label)} title={`${t(label)} (${keys})`} className={cn("flex size-8 items-center justify-center rounded-md hover:bg-muted", on && "bg-muted text-primary")} onClick={() => onMark(m)}>
        <Icon className="size-4" />
      </button>
    );
  };
  const cur = TURN_INTO.find((x) => x.type === block.type) ?? TURN_INTO[0];
  return (
    <Floating x={at.x} y={at.y} above label={t("blk_toolbar")} className="flex items-center gap-0.5 p-1">
      <div className="relative">
        <button type="button" aria-haspopup="menu" aria-expanded={turnOpen} className="flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted" onClick={() => setTurnOpen((o) => !o)}>
          {t(cur.label)}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
        {turnOpen ? (
          <div role="menu" className="absolute left-0 top-full z-10 mt-1 w-48 rounded-lg border bg-popover p-1 shadow-lg">
            {TURN_INTO.map((x) => (
              <button key={x.type} role="menuitem" type="button" className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted", x.type === block.type && "font-medium text-primary")} onClick={() => onTurn(x.type)}>
                <x.icon className="size-4" />
                {t(x.label)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className="mx-0.5 h-5 w-px bg-border" />
      {btn("b", Bold, "blk_fmt_bold", `${mod}B`)}
      {btn("i", Italic, "blk_fmt_italic", `${mod}I`)}
      {btn("s", Strikethrough, "blk_fmt_strike", `${mod}⇧S`)}
      {btn("code", Code, "blk_fmt_code", `${mod}E`)}
      <button type="button" aria-label={t("blk_fmt_link")} title={`${t("blk_fmt_link")} (${mod}K)`} className="flex size-8 items-center justify-center rounded-md hover:bg-muted" onClick={onLink}>
        <LinkIcon className="size-4" />
      </button>
    </Floating>
  );
}

function LinkPopover({ t, at, onApply, onCancel }: { t: T; at: { href: string; x: number; y: number }; onApply: (href: string | null) => void; onCancel: () => void }) {
  const [href, setHref] = React.useState(at.href);
  const bad = !!href.trim() && !okHref(href);
  return (
    <Floating x={at.x} y={at.y} className="w-80 p-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (bad) return;
          onApply(href.trim() || null);
        }}
        className="flex flex-col gap-1.5"
      >
        <div className="flex gap-1.5">
          <input
            autoFocus
            aria-label={t("blk_fmt_link")}
            aria-invalid={bad || undefined}
            value={href}
            placeholder={t("blk_link_placeholder")}
            dir="ltr"
            onChange={(e) => setHref(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className={cn("h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", bad && "border-destructive")}
          />
          <button type="submit" disabled={bad} className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {t("blk_link_apply")}
          </button>
        </div>
        {bad ? <p className="text-xs text-destructive">{t("blk_link_bad")}</p> : null}
        {at.href ? (
          <button type="button" className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => onApply(null)}>
            <Unlink className="size-3" />
            {t("blk_link_remove")}
          </button>
        ) : null}
      </form>
    </Floating>
  );
}


// ── the block menu (the handle, ⌘/) ───────────────────────────────────────────

interface MenuAction {
  key: string;
  label: string;
  icon: Icon;
  run: () => void;
  keys?: string;
  danger?: boolean;
  group: "turn" | "act" | "danger";
  words?: string;
}

function BlockMenu({
  t,
  at,
  blocks,
  canIndent,
  canOutdent,
  onClose,
  onTurn,
  onDuplicate,
  onMove,
  onIndent,
  onCopy,
  onDelete,
}: {
  t: T;
  at: { x: number; y: number };
  blocks: EBlock[];
  canIndent: boolean;
  canOutdent: boolean;
  onClose: () => void;
  onTurn: (type: TurnType) => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
  onIndent: (out: boolean) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [q, setQ] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const list = React.useRef<HTMLDivElement>(null);
  const count = blocks.filter((b) => b.type !== "col").length;
  const turnable = blocks.length > 0 && blocks.every((b) => isText(b) || b.type === "code");
  const mod = MOD();
  const alt = ALT();
  const current = blocks.length === 1 ? blocks[0].type : null;
  const actions: MenuAction[] = [
    ...(turnable
      ? TURN_INTO.map((x) => ({
          key: `turn-${x.type}`,
          label: t(x.label),
          icon: x.icon,
          run: () => onTurn(x.type),
          keys: x.digit ? `${mod}${alt}${x.digit}` : undefined,
          group: "turn" as const,
          words: `turn into ${x.type} 바꾸기`,
        }))
      : []),
    { key: "duplicate", label: t("blk_duplicate"), icon: CopyPlus, run: onDuplicate, keys: `${mod}D`, group: "act", words: "duplicate copy 복제" },
    { key: "up", label: t("blk_move_up"), icon: MoveUp, run: () => onMove(-1), keys: `${mod}⇧↑`, group: "act", words: "move up 위로" },
    { key: "down", label: t("blk_move_down"), icon: MoveDown, run: () => onMove(1), keys: `${mod}⇧↓`, group: "act", words: "move down 아래로" },
    ...(canIndent ? [{ key: "indent", label: t("blk_indent"), icon: IndentIncrease, run: () => onIndent(false), keys: "Tab", group: "act" as const, words: "indent nest 들여쓰기" }] : []),
    ...(canOutdent ? [{ key: "outdent", label: t("blk_outdent"), icon: IndentDecrease, run: () => onIndent(true), keys: "⇧Tab", group: "act" as const, words: "outdent unnest 내어쓰기" }] : []),
    { key: "copy", label: t("blk_copy_md"), icon: Copy, run: onCopy, keys: `${mod}C`, group: "act", words: "copy markdown clipboard 복사" },
    { key: "delete", label: count > 1 ? `${t("blk_delete")} (${count})` : t("blk_delete"), icon: Trash2, run: onDelete, keys: "Del", danger: true, group: "danger", words: "delete remove 삭제 지우기" },
  ];
  const query = q.trim().toLowerCase();
  const shown = query ? actions.filter((a) => `${a.label} ${a.words ?? ""}`.toLowerCase().includes(query)) : actions;
  const pick = Math.min(index, Math.max(0, shown.length - 1));
  React.useEffect(() => setIndex(0), [q]);
  React.useEffect(() => {
    list.current?.querySelector(`[data-index="${pick}"]`)?.scrollIntoView({ block: "nearest" });
  }, [pick]);
  if (!blocks.length) return null;
  let lastGroup = "";
  return (
    <Floating x={at.x} y={at.y} className="w-64 p-1">
      <div className="flex items-center gap-1.5 border-b px-2 pb-1.5 pt-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="cms-block-menu"
          aria-activedescendant={shown[pick] ? `cms-block-menu-${shown[pick].key}` : undefined}
          aria-label={t("blk_menu_search")}
          placeholder={t("blk_menu_search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = shown.length || 1;
              setIndex((pick + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
            } else if (e.key === "Enter") {
              e.preventDefault();
              shown[pick]?.run();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      <div ref={list} id="cms-block-menu" role="listbox" aria-label={t("blk_handle")} className="max-h-[min(20rem,calc(100dvh-8rem))] overflow-y-auto pt-1">
        {shown.length ? (
          shown.map((a, n) => {
            const head = a.group !== lastGroup && a.group === "turn" ? (blocks.length > 1 ? t("blk_turn_n", { n: blocks.length }) : t("blk_turn_into")) : null;
            const rule = a.group !== lastGroup && lastGroup !== "" && !query;
            lastGroup = a.group;
            const Ic = a.icon;
            return (
              <React.Fragment key={a.key}>
                {rule ? <div className="my-1 h-px bg-border" /> : null}
                {head ? <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{head}</div> : null}
                <div
                  id={`cms-block-menu-${a.key}`}
                  role="option"
                  aria-selected={n === pick}
                  data-index={n}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", n === pick && "bg-accent text-accent-foreground", a.danger && "text-destructive")}
                  onMouseEnter={() => setIndex(n)}
                  onClick={a.run}
                >
                  <Ic className="size-4 shrink-0" />
                  <span className="grow truncate">{a.label}</span>
                  {a.group === "turn" && current && `turn-${current}` === a.key ? <Check className="size-3.5 text-primary" /> : null}
                  {a.keys ? <kbd className="shrink-0 font-sans text-[11px] text-muted-foreground">{a.keys}</kbd> : null}
                </div>
              </React.Fragment>
            );
          })
        ) : (
          <div className="px-2 py-3 text-sm text-muted-foreground">{t("blk_menu_none")}</div>
        )}
      </div>
    </Floating>
  );
}

/** Text of a block for screen readers and the outline. */
export { blockPlain };
