"use client";
// agent-cms: the block editor (Notion-style) for the document body.
//
// Editing runs on Tiptap 3 / ProseMirror (MIT): one document, so text can be
// selected, copied, replaced and undone across blocks, and input methods
// (Korean, Japanese, Chinese, phone keyboards) go through a tested engine.
// Everything that makes it a CMS editor is ours:
// - the body is still markdown. cms-blocks-convert.ts reads it into blocks and
//   writes it back; cms-blocks-pm.ts maps blocks to the editor's document. A
//   block that was not touched writes its original text, byte for byte, and
//   opening a document never saves it;
// - the block interactions: hover handle (drag to move with a picture that
//   follows the pointer, the page scrolling along, drop beside a block to make
//   columns, into a toggle or under a list item, Alt copies, Esc cancels; click
//   for a searchable block menu), + to add, / menu, box selection from the
//   margin, block selection with Esc and Shift+arrows, Tab nesting, toggles,
//   tables, pictures with captions, markdown typed by hand, a toolbar over
//   selected text, links, paste and drop of images into the media library.
// Structural edits (nesting, moving, turning one kind into another) go through
// the tested functions in cms-blocks-tree.ts and come back as one undoable step.
//
// Motion: menus, handles and highlights ease out (--cms-ease), and nothing
// moves when the person asked for reduced motion.
//
// Install: npx @mainsoft/agent-cms add cms-block-editor
// Use: <CmsProvider slots={{ blockEditor: CmsBlockEditor }}> (load it lazily).

import * as React from "react";
import { createPortal } from "react-dom";
import { Extension, getMarkRange, InputRule, markInputRule, type Editor as TEditor } from "@tiptap/core";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { CellSelection, selectedRect, TableMap } from "@tiptap/pm/tables";
import { closeHistory } from "@tiptap/pm/history";
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
  Code,
  CodeXml,
  Columns2,
  Columns3,
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
  blocksToClipboard,
  blocksToMarkdown,
  childrenOf,
  isList,
  isText,
  keepEdges,
  markdownToBlocks,
  newId,
  refreshFingerprints,

  type EBlock,
  type TableAlign,
  type TextBlock,
  type TextType,
  type Tone,
} from "./cms-blocks-convert";
import { APP_LINK, mdToSpans, plain, sliceSpans, spansLength, spansToMd, type Span } from "./cms-blocks-inline";
import { blockAt, blocksToDoc, cmsSchema, docToBlocks, nodeSpans, schemaExtensions, textStartOf } from "./cms-blocks-pm";
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
import { MarkdownPreview } from "./cms-parts";
import { pasteAsMarkdown } from "./cms-paste";
import { merge3, resolveMerge } from "@mainsoft/agent-cms/diff";
import { isApple, useCms, type BlockEditorProps } from "./use-cms";

type T = ReturnType<typeof useCms>["t"];
type Key = Parameters<T>[0];
type Icon = React.ComponentType<{ className?: string }>;

/** The motion curve of the whole editor: ease-out. */
const EASE = "cubic-bezier(0.215, 0.61, 0.355, 1)";

const MOD = () => (isApple() ? "⌘" : "Ctrl+");
const ALT = () => (isApple() ? "⌥" : "Alt+");

/** Safe link targets: web, mail, phone, in-site paths, anchors, media library files and app links. */
export function okHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:|\/(?![/\\])|#|asset:|cms-link:)/i.test(href.trim());
}

// ── what can be made ──────────────────────────────────────────────────────────

const text = (type: TextType, extra: Partial<TextBlock> = {}): TextBlock => ({ id: newId(), type, spans: [], ...extra });
const emptyRow = (n: number) => Array.from({ length: n }, () => [] as Span[]);
const newTable = (): EBlock => ({ id: newId(), type: "table", align: [null, null, null], head: emptyRow(3), rows: [emptyRow(3), emptyRow(3)] });

interface Item {
  key: string;
  label: Key;
  hint: Key;
  group: Key;
  icon: Icon;
  words: string;
  keys?: string;
  make: () => EBlock | EBlock[] | "media";
}

const ITEMS: Item[] = [
  { key: "p", label: "blk_t_p", hint: "blk_t_p_text", group: "blk_group_basic", icon: Pilcrow, words: "text paragraph plain 텍스트 문단 본문", make: () => text("p") },
  { key: "h2", label: "blk_t_h2", hint: "blk_t_h2_text", group: "blk_group_basic", icon: Heading2, words: "heading title h2 ## 제목 헤딩", keys: "##", make: () => text("h2") },
  { key: "h3", label: "blk_t_h3", hint: "blk_t_h3_text", group: "blk_group_basic", icon: Heading3, words: "subheading heading h3 ### 작은 제목 소제목", keys: "###", make: () => text("h3") },
  { key: "bullet", label: "blk_t_bullet", hint: "blk_t_bullet_text", group: "blk_group_basic", icon: List, words: "bullet list ul - 글머리 목록 리스트", keys: "-", make: () => text("bullet") },
  { key: "number", label: "blk_t_number", hint: "blk_t_number_text", group: "blk_group_basic", icon: ListOrdered, words: "numbered list ol 1. 번호 목록 순서", keys: "1.", make: () => text("number") },
  { key: "todo", label: "blk_t_todo", hint: "blk_t_todo_text", group: "blk_group_basic", icon: ListChecks, words: "todo task check checkbox [] 할 일 체크", keys: "[]", make: () => text("todo", { checked: false }) },
  { key: "toggle", label: "blk_t_toggle", hint: "blk_t_toggle_text", group: "blk_group_basic", icon: ListCollapse, words: "toggle details collapse fold >> 접기 토글 펼치기", keys: ">>", make: () => text("toggle") },
  { key: "quote", label: "blk_t_quote", hint: "blk_t_quote_text", group: "blk_group_basic", icon: Quote, words: "quote blockquote > 인용", keys: ">", make: () => text("quote") },
  { key: "callout", label: "blk_t_callout", hint: "blk_t_callout_text", group: "blk_group_basic", icon: Info, words: "callout note tip warning 알림 참고 팁 주의", make: () => text("callout", { tone: "note" }) },
  { key: "hr", label: "blk_t_hr", hint: "blk_t_hr_text", group: "blk_group_basic", icon: Minus, words: "divider rule hr line --- 구분선 선", keys: "---", make: () => ({ id: newId(), type: "hr" }) },
  { key: "media", label: "blk_slash_media", hint: "blk_slash_media_text", group: "blk_group_media", icon: ImageIcon, words: "image picture photo file media 이미지 사진 그림 파일 미디어", make: () => "media" },
  { key: "table", label: "blk_t_table", hint: "blk_t_table_text", group: "blk_group_advanced", icon: Table, words: "table grid rows columns 표 테이블", make: newTable },
  { key: "columns", label: "blk_slash_columns", hint: "blk_slash_columns_text", group: "blk_group_advanced", icon: Columns2, words: "columns two side 2단 단 칼럼 나란히", make: () => makeColumns(2) },
  { key: "columns3", label: "blk_slash_columns3", hint: "blk_slash_columns3_text", group: "blk_group_advanced", icon: Columns3, words: "columns three side 3단 단 칼럼 나란히", make: () => makeColumns(3) },
  { key: "code", label: "blk_t_code", hint: "blk_t_code_text", group: "blk_group_advanced", icon: Code, words: "code snippet ``` 코드", keys: "```", make: () => ({ id: newId(), type: "code", text: "", lang: "" }) },
  { key: "html", label: "blk_slash_html", hint: "blk_slash_html_text", group: "blk_group_advanced", icon: CodeXml, words: "html embed iframe markup 임베드", make: () => ({ id: newId(), type: "source", md: ":::html\n\n:::", kind: "html" }) },
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
const DIGIT_TYPE: Record<string, TurnType> = Object.fromEntries(TURN_INTO.filter((x) => x.digit).map((x) => [x.digit, x.type]));

function matchItems<I extends { label: Key; key: string; words: string }>(items: I[], q: string, t: T): I[] {
  const query = q.trim().toLowerCase();
  if (!query) return items;
  return items
    .map((i) => {
      const label = t(i.label).toLowerCase();
      const hay = `${label} ${i.key} ${i.words}`.toLowerCase();
      const at = hay.indexOf(query);
      return { i, at: at < 0 ? -1 : label.startsWith(query) ? 0 : at + 1 };
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.i);
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

// ── turning blocks into other kinds ───────────────────────────────────────────

function turnBlocks(list: EBlock[], ids: string[], type: TurnType): EBlock[] {
  const set = new Set(ids);
  return normalize(
    list.map((b) => {
      if (!set.has(b.id)) return b;
      if (type === "code") return isText(b) ? ({ id: b.id, parent: b.parent, type: "code", text: plain(b.spans), lang: "" } as EBlock) : b;
      if (isText(b)) return { ...b, type, checked: type === "todo" ? !!b.checked : undefined, tone: type === "callout" ? (b.tone ?? "note") : undefined, start: type === "number" ? b.start : undefined, newList: undefined } as TextBlock;
      if (b.type === "code") return { id: b.id, parent: b.parent, type, spans: b.text ? [{ text: b.text }] : [] } as TextBlock;
      return b;
    })
  );
}

/** The column a block sits in ("" when none). */
const columnOf = (list: readonly EBlock[], id: string) => ancestors(list, id).find((a) => a.type === "col")?.id ?? "";

// ── the editor's own state (outside the document) ─────────────────────────────

interface Meta {
  /** Blocks selected as blocks (Esc, Shift+arrows, box selection). */
  selected: string[];
  /** Blocks being dragged (drawn faded). */
  dragging: string[];
}
const metaKey = new PluginKey<Meta>("cmsMeta");

/** Numbers of numbered lists, bullets, check boxes, toggle arrows, cell alignment, selection highlight. */
function decorations(state: EditorState, t: T, editable: boolean): DecorationSet {
  const meta = metaKey.getState(state) ?? { selected: [], dragging: [] };
  const sel = new Set(meta.selected);
  const drag = new Set(meta.dragging);
  const out: Decoration[] = [];
  const walk = (parent: PMNode, base: number) => {
    let num = 0;
    let prevNumber = false;
    parent.forEach((n, offset) => {
      const pos = base + offset;
      const id = n.attrs.bid as string | null;
      if (id && sel.has(id)) out.push(Decoration.node(pos, pos + n.nodeSize, { class: "cms-selected", "aria-selected": "true" }));
      if (id && drag.has(id)) out.push(Decoration.node(pos, pos + n.nodeSize, { class: "cms-dragging" }));
      if (n.type.name === "listItem") {
        const kind = n.attrs.kind as string;
        if (kind === "number") {
          num = prevNumber && !n.attrs.newList ? num + 1 : ((n.attrs.start as number | null) ?? 1);
          const shown = num;
          out.push(Decoration.widget(pos + 1, () => marker("number", String(shown)), { side: -1, key: `n${shown}`, ignoreSelection: true }));
        } else if (kind === "todo") {
          const checked = !!n.attrs.checked;
          out.push(Decoration.widget(pos + 1, (view, getPos) => checkbox(view, getPos, checked, plainOf(n), t, editable), { side: -1, key: `c${checked}${id}`, ignoreSelection: true, stopEvent: () => true }));
        } else out.push(Decoration.widget(pos + 1, () => marker("bullet", ""), { side: -1, key: "b", ignoreSelection: true }));
        prevNumber = kind === "number";
      } else prevNumber = false;
      if (n.type.name === "toggle") {
        const open = !!n.attrs.open;
        out.push(Decoration.widget(pos + 1, (view, getPos) => chevron(view, getPos, open, t), { side: -1, key: `t${open}${id}`, ignoreSelection: true, stopEvent: () => true }));
        if (open && n.childCount === 1 && editable)
          out.push(Decoration.widget(pos + n.nodeSize - 1, (view) => emptyToggle(view, pos, t), { side: 1, key: `e${id}`, ignoreSelection: true, stopEvent: () => true }));
      }
      if (n.type.name === "table") {
        const align = (n.attrs.align as TableAlign[] | undefined) ?? [];
        n.forEach((row, rOff) => {
          row.forEach((cell, cOff, c) => {
            const a = align[c];
            if (a === "center" || a === "right") {
              const at = pos + 1 + rOff + 1 + cOff;
              out.push(Decoration.node(at, at + cell.nodeSize, { class: a === "center" ? "text-center" : "text-right" }));
            }
          });
        });
      }
      if (!n.isTextblock && !n.isAtom && n.type.name !== "table") walk(n, pos + 1);
    });
  };
  walk(state.doc, 0);
  // The cell with the caret.
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--)
    if (/cell/.test(String($f.node(d).type.spec.tableRole))) {
      out.push(Decoration.node($f.before(d), $f.after(d), { class: "cms-cell-active" }));
      break;
    }
  return DecorationSet.create(state.doc, out);
}

const plainOf = (n: PMNode) => (n.firstChild?.type.name === "line" ? n.firstChild.textContent : n.textContent);

function marker(kind: "number" | "bullet", label: string): HTMLElement {
  const el = document.createElement("span");
  el.contentEditable = "false";
  el.setAttribute("aria-hidden", "true");
  el.className = "cms-marker absolute left-0 top-0 flex h-[34px] w-6 select-none items-center justify-center text-[15px] text-foreground/80";
  if (kind === "bullet") {
    const dot = document.createElement("span");
    dot.className = "size-[5px] rounded-full bg-current";
    el.appendChild(dot);
  } else {
    el.className += " justify-end pr-1 tabular-nums";
    el.textContent = `${label}.`;
  }
  return el;
}

function checkbox(view: EditorView, getPos: () => number | undefined, checked: boolean, label: string, t: T, editable: boolean): HTMLElement {
  const wrap = document.createElement("span");
  wrap.contentEditable = "false";
  wrap.className = "absolute left-0 top-0 flex h-[34px] w-6 items-center justify-center";
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "checkbox");
  b.setAttribute("aria-checked", String(checked));
  b.setAttribute("aria-label", label || t("blk_t_todo"));
  b.disabled = !editable;
  b.className = cn(
    "flex size-[17px] items-center justify-center rounded-[4px] border-[1.5px] transition-[background-color,border-color,transform] duration-150 active:scale-90",
    checked ? "border-sky-600 bg-sky-600 text-white dark:border-sky-500 dark:bg-sky-500" : "border-foreground/35 hover:bg-muted"
  );
  b.style.transitionTimingFunction = EASE;
  if (checked) b.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" style="animation: cms-check 180ms ${EASE} both"><path d="M20 6 9 17l-5-5"/></svg>`;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const pos = getPos();
    if (pos === undefined) return;
    const at = pos - 1;
    const node = view.state.doc.nodeAt(at);
    if (!node || node.type.name !== "listItem") return;
    view.dispatch(view.state.tr.setNodeAttribute(at, "checked", !node.attrs.checked));
  });
  wrap.appendChild(b);
  return wrap;
}

function chevron(view: EditorView, getPos: () => number | undefined, open: boolean, t: T): HTMLElement {
  const wrap = document.createElement("span");
  wrap.contentEditable = "false";
  wrap.className = "absolute left-0 top-0 flex h-[34px] w-6 items-center justify-center";
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("aria-expanded", String(open));
  b.setAttribute("aria-label", open ? t("blk_toggle_close") : t("blk_toggle_open"));
  b.title = open ? t("blk_toggle_close") : t("blk_toggle_open");
  b.className = "flex size-6 items-center justify-center rounded-md text-foreground/70 hover:bg-muted active:scale-95 transition-transform";
  b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="transition: transform 180ms ${EASE}; transform: rotate(${open ? 90 : 0}deg)"><path d="M8 5.5v13a1 1 0 0 0 1.6.8l8.7-6.5a1 1 0 0 0 0-1.6L9.6 4.7A1 1 0 0 0 8 5.5z"/></svg>`;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const pos = getPos();
    if (pos === undefined) return;
    const at = pos - 1;
    const node = view.state.doc.nodeAt(at);
    if (!node || node.type.name !== "toggle") return;
    view.dispatch(view.state.tr.setNodeAttribute(at, "open", !node.attrs.open).setMeta("addToHistory", false));
  });
  wrap.appendChild(b);
  return wrap;
}

function emptyToggle(view: EditorView, togglePos: number, t: T): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.contentEditable = "false";
  b.textContent = t("blk_toggle_empty");
  b.className = "my-0.5 block w-full rounded-md px-2 py-1 text-left text-sm text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-muted-foreground";
  b.setAttribute("data-drop-into", "");
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const node = view.state.doc.nodeAt(togglePos);
    if (!node) return;
    const at = togglePos + node.nodeSize - 1;
    const p = view.state.schema.nodes.paragraph.create({ bid: newId() });
    const tr = view.state.tr.insert(at, p);
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
  return b;
}

// ── small DOM helpers ─────────────────────────────────────────────────────────

/** The element that scrolls the editor (for scrolling while dragging); null: the page. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let cur = el?.parentElement ?? null; cur && cur !== document.body; cur = cur.parentElement) {
    const s = getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && cur.scrollHeight > cur.clientHeight + 1) return cur;
  }
  return null;
}

/** The block's own row (for an item or a toggle: its line, not the blocks inside it). */
function rowOf(el: HTMLElement): HTMLElement {
  const t = el.dataset.blockType;
  if (t === "bullet" || t === "number" || t === "todo" || t === "toggle") return (el.querySelector(":scope > .cms-line") as HTMLElement | null) ?? el;
  return el;
}

type Box = { left: number; top: number; width: number; height: number };
type DropAt = { id: string; where: Where; box: Box };

/** The innermost block whose own row is at (x, y), or the nearest one. */
function pickRow(root: HTMLElement, x: number, y: number, skip: (id: string) => boolean, pad = 96): HTMLElement | null {
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-block-id]")).filter((el) => !skip(el.dataset.blockId!) && el.getClientRects().length && el.dataset.blockType !== "columns");
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const p of [0, pad]) {
    for (const el of rows) {
      const r = rowOf(el).getBoundingClientRect();
      if (y >= r.top - 2 && y <= r.bottom + 2 && x >= r.left - p && x <= r.right + p && r.width * r.height < bestArea) {
        best = el;
        bestArea = r.width * r.height;
      }
    }
    if (best) return best;
  }
  let dist = Infinity;
  for (const el of rows) {
    const r = rowOf(el).getBoundingClientRect();
    if (x < r.left - pad || x > r.right + pad) continue;
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < dist) (dist = d), (best = el);
  }
  return best;
}

/** The picture of the blocks being dragged that follows the pointer. */
function makeGhost(root: HTMLElement | null, ids: string[]): HTMLElement | null {
  if (!root) return null;
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.setAttribute("data-cms-ghost", "");
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
    opacity: "0",
    borderRadius: "10px",
    boxShadow: "0 12px 32px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.08)",
    padding: "6px 10px",
    transition: `opacity 120ms ${EASE}`,
  } satisfies Partial<CSSStyleDeclaration>);
  box.className = "cms-ghost bg-background text-foreground";
  for (const bid of ids.slice(0, 4)) {
    const el = root.querySelector(`[data-block-id="${CSS.escape(bid)}"]`);
    if (!el) continue;
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-block-id],[contenteditable],[id]").forEach((x) => {
      x.removeAttribute("data-block-id");
      x.removeAttribute("id");
      if (x.hasAttribute("contenteditable")) x.setAttribute("contenteditable", "false");
    });
    copy.removeAttribute("data-block-id");
    copy.classList.remove("cms-selected", "cms-dragging");
    box.appendChild(copy);
  }
  if (ids.length > 4) {
    const more = document.createElement("div");
    more.textContent = `+${ids.length - 4}`;
    more.style.cssText = "font-size:12px;opacity:.7;padding:2px 0";
    box.appendChild(more);
  }
  document.body.appendChild(box);
  requestAnimationFrame(() => (box.style.opacity = "0.82"));
  return box;
}

// ── context for node views ────────────────────────────────────────────────────

interface Upload {
  name: string;
  file: File;
  failed?: boolean;
}

interface EdCtx {
  uploads: ReadonlyMap<string, Upload>;
  retryUpload: (bid: string) => void;
  t: T;
  editable: boolean;
  resolveFileUrl?: (target: string) => string;
  onPickMedia?: () => Promise<string | null>;
  editingSource: string | null;
  setEditingSource: (id: string | null) => void;
}
const Ctx = React.createContext<EdCtx | null>(null);
const useEd = () => React.useContext(Ctx)!;

function CodeView({ node, updateAttributes }: NodeViewProps) {
  const { t, editable } = useEd();
  return (
    <NodeViewWrapper data-block-id={node.attrs.bid} data-block-type="code" className="cms-b my-1.5 overflow-hidden rounded-xl border bg-muted/50">
      <div contentEditable={false} className="flex select-none items-center gap-2 border-b border-border/70 px-3 py-1">
        <Code className="size-3.5 text-muted-foreground" />
        <input
          aria-label={t("blk_code_lang")}
          value={(node.attrs.lang as string) ?? ""}
          placeholder={t("blk_code_lang_none")}
          readOnly={!editable}
          spellCheck={false}
          onChange={(e) => updateAttributes({ lang: e.target.value.replace(/[^\w+#.-]/g, "").slice(0, 24) })}
          className="h-6 w-40 bg-transparent font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      <pre className="m-0 overflow-x-auto px-4 py-3 font-mono text-[13px] leading-[1.6]" spellCheck={false}>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

function MediaView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { t, editable, resolveFileUrl, onPickMedia, uploads, retryUpload } = useEd();
  const target = (node.attrs.target as string) ?? "";
  const upload = uploads.get(node.attrs.bid as string);
  const pending = upload && !upload.failed ? upload.name : null;
  const name = decodeURIComponent(target.replace(/^asset:[a-z0-9]+\//i, "").split(/[?#]/)[0].split("/").pop() ?? "");
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name) || /^https?:/.test(target);
  const url = target ? (resolveFileUrl ? resolveFileUrl(target) : target) : "";
  const [loaded, setLoaded] = React.useState(false);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    setLoaded(false);
    setBroken(false);
  }, [url]);
  const pick = () =>
    void onPickMedia?.().then((md) => {
      const m = md ? /\]\((\S+?)(?:\s+"[^"]*")?\)/.exec(md) : null;
      if (m) updateAttributes({ target: m[1] });
    });
  return (
    <NodeViewWrapper data-block-id={node.attrs.bid} data-block-type="media" className="cms-b group/media my-2">
      <figure contentEditable={false} className={cn("m-0 rounded-xl transition-shadow duration-200", selected && "ring-2 ring-sky-500/70 ring-offset-2 ring-offset-background")} style={{ transitionTimingFunction: EASE }}>
        {pending ? (
          <div role="status" className="flex h-36 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground">
            <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
            {t("blk_media_uploading", { name: pending })}
          </div>
        ) : upload?.failed || (!target && !upload) || broken ? (
          <div role={broken || upload?.failed ? "alert" : undefined} className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center text-sm">
            <ImageIcon className="size-5 text-muted-foreground" />
            <span className="max-w-full truncate font-medium">{upload?.name ?? (name || (node.attrs.alt as string) || t("blk_slash_media"))}</span>
            <span className="text-xs text-muted-foreground">{upload?.failed ? t("blk_media_upload_failed") : broken ? t("blk_media_broken") : t("blk_media_empty")}</span>
            {editable ? (
              <span className="flex flex-wrap justify-center gap-1.5 pt-1">
                {upload?.failed ? (
                  <button type="button" className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted" onClick={() => retryUpload(node.attrs.bid as string)}>
                    {t("retry")}
                  </button>
                ) : null}
                {onPickMedia ? (
                  <button type="button" className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted" onClick={pick}>
                    {target ? t("blk_media_replace") : t("blk_media_choose")}
                  </button>
                ) : null}
                <button type="button" className="rounded-md px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10" onClick={() => deleteNode()}>
                  {t("blk_delete")}
                </button>
              </span>
            ) : null}
          </div>
        ) : isImage && url ? (
          <div className="relative w-fit max-w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={(node.attrs.alt as string) ?? ""}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setBroken(true)}
              className="max-h-[520px] w-auto max-w-full rounded-xl border object-contain transition-opacity duration-300"
              style={{ opacity: loaded ? 1 : 0, transitionTimingFunction: EASE }}
            />
            {editable ? (
              <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/media:opacity-100 group-focus-within/media:opacity-100" style={{ transitionTimingFunction: EASE }}>
                {onPickMedia ? (
                  <button
                    type="button"
                    className="rounded-md bg-background/90 px-2 py-1 text-xs font-medium shadow-sm ring-1 ring-border backdrop-blur hover:bg-background"
                    onClick={pick}
                  >
                    {t("blk_media_replace")}
                  </button>
                ) : null}
                <button type="button" aria-label={t("blk_delete")} className="rounded-md bg-background/90 px-1.5 py-1 shadow-sm ring-1 ring-border backdrop-blur hover:bg-background" onClick={() => deleteNode()}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm">
            <ImageIcon className="size-4 text-muted-foreground" />
            <span className="truncate font-medium">{name || target}</span>
            <span className="text-xs text-muted-foreground">{t("blk_media_file")}</span>
          </div>
        )}
        {!pending ? (
          <figcaption className="mt-1.5 space-y-0.5">
            <input
              aria-label={t("blk_caption")}
              value={(node.attrs.caption as string) ?? ""}
              readOnly={!editable}
              placeholder={editable ? t("blk_caption_placeholder") : ""}
              onChange={(e) => updateAttributes({ caption: e.target.value })}
              className={cn(
                "h-7 w-full rounded-md bg-transparent px-1 text-sm text-muted-foreground outline-none transition-opacity duration-150 placeholder:text-muted-foreground/50 focus:bg-muted/60",
                !node.attrs.caption && "opacity-0 focus:opacity-100 group-hover/media:opacity-100 [@media(hover:none)]:opacity-100"
              )}
            />
            <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <span className="shrink-0 font-medium">{t("blk_alt_short")}</span>
              <input
                aria-label={t("blk_alt")}
                title={t("blk_alt_hint")}
                value={(node.attrs.alt as string) ?? ""}
                readOnly={!editable}
                placeholder={t("blk_alt_missing")}
                onChange={(e) => updateAttributes({ alt: e.target.value })}
                className={cn("h-6 min-w-0 flex-1 rounded-md bg-transparent px-1 outline-none placeholder:text-amber-600/80 focus:bg-muted/60", !node.attrs.alt && "italic")}
              />
            </label>
          </figcaption>
        ) : null}
      </figure>
    </NodeViewWrapper>
  );
}

function SourceView({ node, updateAttributes, selected }: NodeViewProps) {
  const { t, editable, editingSource, setEditingSource } = useEd();
  const id = node.attrs.bid as string;
  const md = (node.attrs.md as string) ?? "";
  const kind = (node.attrs.kind as string) ?? "p";
  const editing = editable && editingSource === id;
  const [draft, setDraft] = React.useState(md);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => setDraft(md), [md]);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft, editing]);
  React.useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const label = t(SOURCE_LABEL[kind] ?? "blk_src_raw");
  const done = () => {
    if (draft !== md) updateAttributes({ md: draft });
    setEditingSource(null);
  };
  return (
    <NodeViewWrapper data-block-id={id} data-block-type="source" data-cms-source={kind} className="cms-b my-1.5">
      {editing ? (
        <div contentEditable={false} className="overflow-hidden rounded-xl border border-sky-500/50 bg-muted/40 shadow-sm" style={{ animation: `cms-pop 160ms ${EASE} both` }}>
          <div className="flex items-center gap-2 border-b px-3 py-1 text-[11px] text-muted-foreground">
            <span className="rounded bg-background px-1.5 py-0.5 font-medium text-foreground">{label}</span>
            <span className="truncate">{t("blk_src_hint")}</span>
            <span className="grow" />
            <button type="button" className="rounded px-2 py-0.5 font-medium text-foreground hover:bg-background" onMouseDown={(e) => e.preventDefault()} onClick={done}>
              {t("blk_src_done")}
            </button>
          </div>
          <textarea
            ref={ref}
            aria-label={label}
            value={draft}
            spellCheck={false}
            dir="ltr"
            rows={2}
            className="block w-full resize-none bg-transparent px-3 py-2 font-mono text-[12.5px] leading-5 outline-none"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={done}
            onKeyDown={(e) => {
              const mod = isApple() ? e.metaKey : e.ctrlKey;
              if (e.key === "Escape" || (e.key === "Enter" && mod)) {
                e.preventDefault();
                done();
              }
            }}
          />
        </div>
      ) : (
        <div
          contentEditable={false}
          role="button"
          tabIndex={editable ? 0 : -1}
          aria-label={`${label}: ${t("blk_src_edit")}`}
          onKeyDown={(e) => {
            if (editable && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setEditingSource(id);
            }
          }}
          className={cn("group/src relative cursor-text rounded-xl px-1 transition-[background-color,box-shadow] duration-150 hover:bg-muted/40", selected && "ring-2 ring-sky-500/70")}
          style={{ transitionTimingFunction: EASE }}
          onDoubleClick={() => editable && setEditingSource(id)}
        >
          <div className="pointer-events-none [&_iframe]:pointer-events-none">
            <MarkdownPreview body={md} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
          </div>
          {editable ? (
            <button
              type="button"
              tabIndex={-1}
              className="absolute right-1 top-1 flex items-center gap-1 rounded-md bg-background/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity duration-150 hover:text-foreground group-hover/src:opacity-100"
              onClick={() => setEditingSource(id)}
            >
              <Pencil className="size-3" />
              {label}
            </button>
          ) : null}
        </div>
      )}
    </NodeViewWrapper>
  );
}

// ── the editor ────────────────────────────────────────────────────────────────

type Menu = { query: string; from: number; x: number; y: number; index: number; opened?: boolean } | null;
type Hover = { id: string; top: number; left: number; inCol: boolean } | null;
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
  below: boolean;
}

/** Everything the keyboard shortcuts and plugins call (kept current by the screen). */
interface Ctl {
  /** The next typed change starts a new undo step (set after a structural edit). */
  closeNext?: boolean;
  enter: () => boolean;
  backspace: () => boolean;
  del: () => boolean;
  tab: (out: boolean) => boolean;
  turn: (type: TurnType) => boolean;
  duplicate: () => boolean;
  move: (dir: -1 | 1) => boolean;
  selectBlock: () => boolean;
  modEnter: () => boolean;
  blockMenu: () => boolean;
  link: () => boolean;
  keyDown: (view: EditorView, e: KeyboardEvent) => boolean;
  textInput: (view: EditorView, text: string) => boolean;
  paste: (view: EditorView, e: ClipboardEvent) => boolean;
  drop: (view: EditorView, e: DragEvent) => boolean;
  clip: (view: EditorView, e: ClipboardEvent, cut: boolean) => boolean;
  click: (view: EditorView, pos: number, e: MouseEvent) => boolean;
  t: T;
  editable: boolean;
}

function buildExtensions(ctl: React.MutableRefObject<Ctl>) {
  const keys = Extension.create({
    name: "cmsKeys",
    priority: 200,
    dispatchTransaction({ transaction, next }) {
      const c = ctl.current;
      if (c && c.closeNext && transaction.docChanged && !transaction.getMeta("cms-tree") && transaction.getMeta("addToHistory") !== false) {
        c.closeNext = false;
        closeHistory(transaction);
      }
      next(transaction);
    },
    addKeyboardShortcuts() {
      const c = () => ctl.current;
      const turn: Record<string, () => boolean> = {};
      for (const [d, type] of Object.entries(DIGIT_TYPE)) turn[`Mod-Alt-${d}`] = () => c().turn(type);
      return {
        Enter: () => c().enter(),
        Backspace: () => c().backspace(),
        Delete: () => c().del(),
        Tab: () => c().tab(false),
        "Shift-Tab": () => c().tab(true),
        "Mod-d": () => c().duplicate(),
        "Mod-Shift-ArrowUp": () => c().move(-1),
        "Mod-Shift-ArrowDown": () => c().move(1),
        Escape: () => c().selectBlock(),
        "Mod-Enter": () => c().modEnter(),
        "Mod-/": () => c().blockMenu(),
        "Mod-k": () => c().link(),
        "Mod-b": () => this.editor.commands.toggleMark("bold"),
        "Mod-i": () => this.editor.commands.toggleMark("italic"),
        "Mod-e": () => this.editor.commands.toggleMark("code"),
        "Mod-Shift-s": () => this.editor.commands.toggleMark("strike"),
        "Mod-Shift-x": () => this.editor.commands.toggleMark("strike"),
        "Shift-Enter": () => this.editor.commands.insertContent({ type: "hardBreak" }),
        ...turn,
      };
    },
    addInputRules() {
      const schema = this.editor.schema;
      const inParagraph = (state: EditorState, from: number) => state.doc.resolve(from).parent.type.name === "paragraph";
      /** Replace the paragraph the rule is typed in (its text after the rule stays). */
      const block = (find: RegExp, make: (match: RegExpMatchArray, content: Fragment, bid: string) => PMNode | PMNode[], caretIn = 1) =>
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            if (!inParagraph(state, range.from)) return null;
            const tr = state.tr;
            const $from = state.doc.resolve(range.from);
            const start = $from.before();
            tr.delete(range.from, range.to);
            const para = tr.doc.nodeAt(start);
            if (!para) return null;
            const made = make(match, para.content, para.attrs.bid as string);
            tr.replaceWith(start, start + para.nodeSize, made);
            tr.setSelection(TextSelection.near(tr.doc.resolve(start + caretIn)));
          },
        });
      const line = (content: Fragment) => schema.nodes.line.create(null, content);
      const item = (kind: string, attrs: Record<string, unknown> = {}) => (_m: RegExpMatchArray, content: Fragment, bid: string) => schema.nodes.listItem.create({ bid, kind, ...attrs }, line(content));
      return [
        block(/^(#{1,2})\s$/, (_m, c, bid) => schema.nodes.heading.create({ bid, level: 2 }, c)),
        block(/^###\s$/, (_m, c, bid) => schema.nodes.heading.create({ bid, level: 3 }, c)),
        block(/^[-*+]\s$/, item("bullet"), 2),
        block(/^(\d{1,9})[.)]\s$/, (m, c, bid) => schema.nodes.listItem.create({ bid, kind: "number", start: Number(m[1]) === 1 ? null : Number(m[1]) }, line(c)), 2),
        block(/^\[( |x)?\]\s$/i, (m, c, bid) => schema.nodes.listItem.create({ bid, kind: "todo", checked: (m[1] ?? "").toLowerCase() === "x" }, line(c)), 2),
        block(/^>>\s$/, (_m, c, bid) => schema.nodes.toggle.create({ bid, open: true }, line(c)), 2),
        block(/^>\s$/, (_m, c, bid) => schema.nodes.quote.create({ bid }, c)),
        block(/^>?\s?\[!(note|tip|warning)\]\s$/i, (m, c, bid) => schema.nodes.callout.create({ bid, tone: m[1].toLowerCase() }, c)),
        block(/^```([\w+#.-]*)\s$/, (m, c, bid) => schema.nodes.codeBlock.create({ bid, lang: m[1] }, c.size ? schema.text(c.textBetween(0, c.size, "\n")) : null)),
        block(/^---$/, (_m, c, bid) => [schema.nodes.rule.create({ bid }), schema.nodes.paragraph.create({ bid: newId() }, c)], 2),
        block(/^"\s$/, (_m, c, bid) => schema.nodes.quote.create({ bid }, c)),
        // "[ ] " typed at the start of a bullet item makes it a to-do.
        new InputRule({
          find: /^\[( |x)?\]\s$/i,
          handler: ({ state, range, match }) => {
            const $f = state.doc.resolve(range.from);
            if ($f.parent.type.name !== "line" || $f.depth < 2) return null;
            const item = $f.node($f.depth - 1);
            if (item.type.name !== "listItem" || item.attrs.kind !== "bullet") return null;
            state.tr.delete(range.from, range.to).setNodeMarkup($f.before($f.depth - 1), undefined, { ...item.attrs, kind: "todo", checked: (match[1] ?? "").toLowerCase() === "x" });
          },
        }),
        markInputRule({ find: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/, type: schema.marks.bold }),
        markInputRule({ find: /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/, type: schema.marks.italic }),
        markInputRule({ find: /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/, type: schema.marks.italic }),
        markInputRule({ find: /(?:^|\s)(~~(?!\s+~~)((?:[^~]+))~~(?!\s+~~))$/, type: schema.marks.strike }),
        markInputRule({ find: /(^|[^`])`([^`]+)`(?!`)$/, type: schema.marks.code }),
      ];
    },
    addProseMirrorPlugins() {
      return [
        new Plugin<Meta>({
          key: metaKey,
          state: {
            init: () => ({ selected: [], dragging: [] }),
            apply: (tr, v) => {
              const m = tr.getMeta(metaKey) as Partial<Meta> | undefined;
              return m ? { ...v, ...m } : v;
            },
          },
          props: {
            decorations: (state) => decorations(state, ctl.current.t, ctl.current.editable),
            handleKeyDown: (view, e) => ctl.current.keyDown(view, e),
            handleTextInput: (view, _f, _t, text) => ctl.current.textInput(view, text),
            handlePaste: (view, e) => ctl.current.paste(view, e),
            handleDrop: (view, e) => ctl.current.drop(view, e as DragEvent),
            handleDOMEvents: {
              copy: (view, e) => ctl.current.clip(view, e, false),
              cut: (view, e) => ctl.current.clip(view, e, true),
            },
            handleClick: (view, pos, e) => ctl.current.click(view, pos, e),
            attributes: (state): Record<string, string> => ((metaKey.getState(state)?.selected.length ?? 0) > 0 ? { class: "cms-blocksel" } : {}),
          },
        }),
      ];
    },
  });

  const views = [
    ...schemaExtensions.map((ext) => {
      if (ext.name === "codeBlock") return (ext as typeof ext & { extend: (c: object) => typeof ext }).extend({ addNodeView: () => ReactNodeViewRenderer(CodeView) });
      if (ext.name === "media") return (ext as typeof ext & { extend: (c: object) => typeof ext }).extend({ addNodeView: () => ReactNodeViewRenderer(MediaView) });
      if (ext.name === "source") return (ext as typeof ext & { extend: (c: object) => typeof ext }).extend({ addNodeView: () => ReactNodeViewRenderer(SourceView) });
      return ext;
    }),
  ];
  return [
    ...views,
    keys,
    UndoRedo.configure({ depth: 300, newGroupDelay: 600 }),
    Dropcursor.configure({ color: "rgb(14 165 233)", width: 3 }),
    Gapcursor,
    Placeholder.configure({
      includeChildren: true,
      showOnlyCurrent: true,
      placeholder: ({ node, editor }) => {
        const t = ctl.current.t;
        if (node.type.name === "heading") return node.attrs.level === 3 ? t("blk_t_h3") : t("blk_t_h2");
        if (editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.type.name === "paragraph" && !editor.state.doc.textContent) return t("blk_placeholder");
        if (node.type.name === "line") {
          const parent = editor.state.selection.$from.node(editor.state.selection.$from.depth - 1);
          if (parent?.type.name === "toggle") return t("blk_t_toggle");
          return t("blk_t_bullet");
        }
        if (node.type.name === "quote" || node.type.name === "callout") return t("blk_empty_hint");
        return t("blk_placeholder_line");
      },
    }),
  ];
}

export default function CmsBlockEditor({ value, onChange, readOnly, uploadFile, resolveFileUrl, onPickMedia, insertRef, id, describedBy }: BlockEditorProps) {
  const { t, toast } = useCms();
  const editable = !readOnly;
  const loaded = React.useRef(value);
  const emitted = React.useRef(value);
  const origs = React.useRef(new Map<string, Pick<EBlock, "orig" | "gap">>());
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [menu, setMenu] = React.useState<Menu>(null);
  const menuRef = React.useRef<Menu>(null);
  menuRef.current = menu;
  const [toolbar, setToolbar] = React.useState<{ x: number; y: number; from: number; to: number; link: string | null } | null>(null);
  const [linkEdit, setLinkEdit] = React.useState<{ from: number; to: number; href: string; x: number; y: number } | null>(null);
  const [blockMenu, setBlockMenu] = React.useState<{ ids: string[]; x: number; y: number; back?: number } | null>(null);
  const [selected, setSelectedState] = React.useState<string[]>([]);
  const selectedRef = React.useRef<string[]>([]);
  const anchor = React.useRef<string | null>(null);
  const [hover, setHover] = React.useState<Hover>(null);
  const [dragging, setDragging] = React.useState(false);
  const [dropBox, setDropBox] = React.useState<(Box & { side: boolean }) | null>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const hoverToggle = React.useRef<{ id: string; timer: number } | null>(null);
  const [marquee, setMarquee] = React.useState<Box | null>(null);
  const marqueeRef = React.useRef<Marquee | null>(null);
  const [editingSource, setEditingSource] = React.useState<string | null>(null);
  const [tableBar, setTableBar] = React.useState<{ pos: number; top: number; left: number; width: number; col: number; row: number; align: TableAlign } | null>(null);
  const [focusRow, setFocusRow] = React.useState<{ id: string; top: number } | null>(null);

  /** Markdown → the editor's document, remembering the original text of each block. */
  const load = React.useCallback((md: string) => {
    const blocks = markdownToBlocks(md);
    const kids = childrenOf(blocks);
    const open = new Set(blocks.filter((b) => b.type === "toggle" && !(kids.get(b.id) ?? []).length).map((b) => b.id));
    const json = blocksToDoc(blocks, { open });
    const src = new Map(blocks.map((b) => [b.id, b]));
    // Fingerprints as the editor's model spells each block, so a block comes back "untouched".
    const back = docToBlocksFromJson(json).map((b) => ({ ...b, orig: src.get(b.id)?.orig, gap: src.get(b.id)?.gap }) as EBlock);
    origs.current = new Map(refreshFingerprints(back).map((b) => [b.id, { orig: b.orig, gap: b.gap }]));
    return json;
  }, []);

  const initial = React.useMemo(() => load(value), []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The editor's document → markdown (untouched blocks write their original text). */
  const serialize = React.useCallback((doc: PMNode) => {
    const blocks = docToBlocks(doc)
      // A picture still uploading (or failed) is not written yet.
      .filter((b) => b.type !== "media" || !!b.target)
      .map((b) => {
        const o = origs.current.get(b.id);
        return o ? ({ ...b, orig: o.orig, gap: o.gap } as EBlock) : b;
      });
    return keepEdges(loaded.current, blocksToMarkdown(blocks));
  }, []);

  const pendingRef = React.useRef<string | null>(null);
  const ctl = React.useRef<Ctl>(null!);
  const extensions = React.useMemo(() => buildExtensions(ctl), []);

  const editor = useEditor({
    extensions,
    content: initial,
    editable,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "cms-pm outline-none",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("blk_body"),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      },
      clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
      clipboardTextParser: (txt, $ctx) => markdownSlice(txt, $ctx.doc.type.schema),
    },
    onUpdate: ({ editor: ed, transaction }) => {
      if (transaction.getMeta("cms-load")) return;
      // A change from outside is waiting: what is edited now is merged with it when it is applied.
      if (pendingRef.current !== null) return;
      const md = serialize(ed.state.doc);
      if (md === emitted.current) return;
      emitted.current = md;
      onChange(md);
    },
  });

  const setSelected = React.useCallback(
    (ids: string[]) => {
      selectedRef.current = ids;
      setSelectedState(ids);
      if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(metaKey, { selected: ids }).setMeta("addToHistory", false));
    },
    [editor]
  );

  // The text changed from outside (an agent's edit, a restore, a merge): load it. Only the blocks
  // that differ are replaced, so the caret, open toggles and a picture being uploaded elsewhere stay.
  // Waits while a word is being composed (Korean, Japanese...) or a source block is being edited.
  const [syncTick, setSyncTick] = React.useState(0);
  React.useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const again = () => window.setTimeout(() => setSyncTick((x) => x + 1), 0);
    dom.addEventListener("compositionend", again);
    return () => dom.removeEventListener("compositionend", again);
  }, [editor]);
  React.useEffect(() => {
    if (!editor) return;
    const held = editor.view.composing || !!editingSource;
    if (value === emitted.current) {
      // The waiting change was taken back: nothing to merge; edits held meanwhile go out now.
      if (pendingRef.current !== null) {
        pendingRef.current = null;
        if (!held) {
          const md = serialize(editor.state.doc);
          if (md !== emitted.current) {
            emitted.current = md;
            onChange(md);
          }
        }
      }
      return;
    }
    if (held) {
      // Held until the word or the source block is done; local changes meanwhile are merged with it.
      pendingRef.current = value;
      return;
    }
    pendingRef.current = null;
    let target = value;
    const mine = serialize(editor.state.doc);
    if (mine !== emitted.current) {
      // Edited here while the other change waited: three-way merge on lines, nothing dropped.
      const m = merge3(emitted.current, mine, value);
      target = m.text ?? resolveMerge(m, Object.fromEntries(m.conflicts.map((c) => [c.id, "both" as const])));
      if (m.conflicts.length) toast(t("blk_merged_both"), { tone: "info" });
    }
    loaded.current = target;
    emitted.current = target;
    if (target !== value) onChange(target);
    const fresh = origs.current;
    const next = editor.schema.nodeFromJSON(load(target));
    const made = origs.current;
    origs.current = fresh;
    const old = editor.state.doc;
    const shape = (n: PMNode) => JSON.stringify(n.toJSON(), (k, v) => (k === "bid" || k === "open" ? undefined : v));
    // Blocks that stay keep their ids; their original text is the new text (maybe spelled differently).
    const ids = new Map<string, string>();
    const pair = (o: PMNode, n: PMNode) => {
      const ob = o.attrs.bid as string | undefined;
      const nb = n.attrs.bid as string | undefined;
      if (ob && nb) ids.set(nb, ob);
      for (let k = 0; k < Math.min(o.childCount, n.childCount); k++) pair(o.child(k), n.child(k));
    };
    const na = old.childCount;
    const nb = next.childCount;
    let a = 0;
    while (a < na && a < nb && shape(old.child(a)) === shape(next.child(a))) pair(old.child(a), next.child(a++));
    let z = 0;
    while (z < na - a && z < nb - a && shape(old.child(na - 1 - z)) === shape(next.child(nb - 1 - z))) pair(old.child(na - 1 - z), next.child(nb - 1 - z++));
    for (const [nid, meta] of made) {
      const gap = meta.gap ? { ...meta.gap, after: ids.get(meta.gap.after) ?? meta.gap.after } : meta.gap;
      fresh.set(ids.get(nid) ?? nid, { orig: meta.orig, gap });
    }
    if (a === na && a === nb) return;
    // Pictures still uploading (not in the markdown yet) stay where they were: in the same
    // container (toggle, list item, column), after the block they followed.
    const waiting: { node: PMNode; parent: string | null; after: string | null }[] = [];
    old.descendants((n, pos) => {
      if (n.type.name !== "media" || n.attrs.target) return;
      const $p = old.resolve(pos);
      const i = $p.index();
      let after: string | null = null;
      for (let k = i - 1; k >= 0 && after === null; k--) {
        const sib = $p.parent.child(k);
        if (!(sib.type.name === "media" && !sib.attrs.target)) after = (sib.attrs.bid as string) ?? null;
      }
      waiting.push({ node: n, parent: $p.depth ? ((($p.parent.attrs.bid as string) ?? null)) : null, after });
    });
    let from = 0;
    for (let k = 0; k < a; k++) from += old.child(k).nodeSize;
    let to = old.content.size;
    for (let k = 0; k < z; k++) to -= old.child(na - 1 - k).nodeSize;
    const middle: PMNode[] = [];
    for (let k = a; k < nb - z; k++) middle.push(next.child(k));
    const tr = editor.state.tr.replaceWith(from, to, middle);
    const findPos = (bid: string) => {
      let at = -1;
      tr.doc.descendants((n, pos) => {
        if (at >= 0) return false;
        if (n.attrs.bid === bid) at = pos;
      });
      return at;
    };
    for (const w of waiting) {
      if (findPos(w.node.attrs.bid as string) >= 0) continue;
      let at = -1;
      if (w.after) {
        const p = findPos(w.after);
        if (p >= 0) at = p + tr.doc.nodeAt(p)!.nodeSize;
      } else if (w.parent) {
        const p = findPos(w.parent);
        const parent = p >= 0 ? tr.doc.nodeAt(p) : null;
        // Inside a list item or toggle, after its line.
        if (parent) at = p + 1 + (parent.firstChild?.type.name === "line" ? parent.firstChild.nodeSize : 0);
      } else at = 0;
      try {
        tr.insert(at < 0 ? tr.doc.content.size : at, w.node);
      } catch {
        tr.insert(tr.doc.content.size, w.node);
      }
    }
    editor.view.dispatch(tr.setMeta("cms-load", true).setMeta("addToHistory", false));
    setSelected([]);
  }, [value, editor, load, serialize, setSelected, editingSource, syncTick]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // ── structural edits through the block functions ──
  const openIds = (doc: PMNode) => {
    const s = new Set<string>();
    doc.descendants((n) => {
      if (n.type.name === "toggle" && n.attrs.open) s.add(n.attrs.bid as string);
    });
    return s;
  };

  type Focus = { id: string; offset?: number | "end"; node?: boolean };
  /** Change the blocks with a function, as one undoable step; put the caret back where it belongs. */
  const applyTree = React.useCallback(
    (
      fn: (blocks: EBlock[], at: { doc: PMNode; from: number }) => { blocks: EBlock[]; focus?: Focus | null; open?: string[] } | null,
      o: { before?: (tr: Transaction) => void } = {}
    ) => {
      if (!editor) return false;
      // One transaction for the whole action (a selection deleted first, then the blocks changed).
      const tr = editor.state.tr;
      o.before?.(tr);
      const res = fn(docToBlocks(tr.doc), { doc: tr.doc, from: tr.selection.from });
      if (!res) return false;
      const open = openIds(tr.doc);
      res.open?.forEach((x) => open.add(x));
      const node = editor.schema.nodeFromJSON(blocksToDoc(res.blocks, { open }));
      // Replace only what changed: pictures, open source blocks and the rest keep their views.
      const start = tr.doc.content.findDiffStart(node.content);
      if (start !== null) {
        let { a: endA, b: endB } = tr.doc.content.findDiffEnd(node.content)!;
        const overlap = start - Math.min(endA, endB);
        if (overlap > 0) {
          endA += overlap;
          endB += overlap;
        }
        tr.replace(start, endA, node.slice(start, endB));
      }
      // A structural edit is its own undo step: typing before or after it is not undone with it.
      closeHistory(tr);
      ctl.current.closeNext = true;
      tr.setMeta("cms-tree", true);
      if (res.focus) {
        const at = textStartOf(tr.doc, res.focus.id);
        if (at >= 0) {
          const target = tr.doc.nodeAt(res.focus.node ? at : Math.max(0, at - 1));
          if (res.focus.node && target) tr.setSelection(NodeSelection.create(tr.doc, at));
          else {
            const $at = tr.doc.resolve(at);
            const len = $at.parent.isTextblock ? $at.parent.content.size : 0;
            const off = res.focus.offset === "end" ? len : Math.min(res.focus.offset ?? 0, len);
            tr.setSelection($at.parent.isTextblock ? TextSelection.create(tr.doc, at + off) : Selection.near($at));
          }
        }
      }
      editor.view.dispatch(tr.scrollIntoView());
      return true;
    },
    [editor]
  );

  /** Blocks touched by the selection (the outermost ones). */
  const idsInSelection = (state: EditorState): string[] => {
    const { from, to, empty } = state.selection;
    if (state.selection instanceof NodeSelection) {
      const b = state.selection.node.attrs.bid as string | undefined;
      if (b) return [b];
    }
    if (empty) {
      const b = blockAt(state.doc, from);
      return b ? [b.id] : [];
    }
    const out: string[] = [];
    state.doc.nodesBetween(from, to, (n, pos) => {
      if (n.isTextblock || (n.isAtom && n.isBlock)) {
        const b = blockAt(state.doc, n.isTextblock ? pos + 1 : pos + 1);
        const id = n.isAtom ? (n.attrs.bid as string) : b?.id;
        if (id && !out.includes(id)) out.push(id);
        return false;
      }
    });
    return out;
  };

  const caretBlock = () => (editor ? blockAt(editor.state.doc, editor.state.selection.from) : null);
  const inTable = (state: EditorState) => {
    const $f = state.selection.$from;
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === "table") return d;
    return 0;
  };

  const removeBlocks = (ids: string[], announce = true) =>
    applyTree((list) => {
      const top = roots(list, ids);
      if (!top.length) return null;
      const vis = reachable(list, openIds(editor!.state.doc));
      const i = vis.findIndex((b) => b.id === top[0]);
      const before = vis.slice(0, Math.max(0, i)).reverse().find((b) => !top.some((r) => r === b.id || isInside(list, b.id, r)));
      const next = removeFrom(list, top);
      const count = top.reduce((n, r) => n + subtree(list, r).filter((b) => b.type !== "col" && b.type !== "columns").length, 0);
      if (announce && count > 1) toast(t("blk_deleted_n", { n: count }), { action: { label: t("undo"), run: () => void editor?.commands.undo() } });
      const blocks = next.length ? next : [text("p")];
      const keep = before && blocks.some((b) => b.id === before.id) ? before : blocks[0];
      return { blocks, focus: keep && (isText(keep) || keep.type === "code") ? { id: keep.id, offset: "end" } : null };
    });

  const turnInto = (ids: string[], type: TurnType) => {
    const caret = caretBlock();
    return applyTree((list) => ({
      blocks: turnBlocks(list, ids, type),
      open: type === "toggle" ? ids : [],
      focus: caret && ids.includes(caret.id) ? { id: caret.id, offset: caret.offset } : null,
    }));
  };

  const duplicate = (ids: string[]) => {
    let made: string[] = [];
    const ok = applyTree((list) => {
      const top = roots(list, ids);
      if (!top.length) return null;
      const copies = cloneBlocks(top.flatMap((r) => subtree(list, r)));
      const set = new Set(copies.map((c) => c.id));
      made = copies.filter((c) => !c.parent || !set.has(c.parent)).map((c) => c.id);
      return { blocks: insertAfterIn(list, top[top.length - 1], copies) };
    });
    if (ok) setSelected(made);
    return ok;
  };

  const moveVertical = (ids: string[], dir: -1 | 1) => {
    const caret = caretBlock();
    return applyTree((list) => {
      const top = roots(list, ids);
      if (!top.length) return null;
      const edge = dir < 0 ? top[0] : top[top.length - 1];
      const sibs = siblings(list, edge);
      const i = sibs.findIndex((b) => b.id === edge);
      const map = byId(list);
      const parent = map.get(map.get(edge)?.parent ?? "");
      let next: EBlock[] | null = null;
      if (dir < 0 && i > 0) next = moveTo(list, top, sibs[i - 1].id, "before");
      else if (dir > 0 && i >= 0 && i < sibs.length - 1) next = moveTo(list, top, sibs[i + 1].id, "after");
      else if (parent && parent.type !== "col") next = moveTo(list, top, parent.id, dir < 0 ? "before" : "after");
      if (!next) return null;
      return { blocks: next, focus: caret && !selectedRef.current.length ? { id: caret.id, offset: caret.offset } : null };
    });
  };

  const indentIds = (ids: string[], out: boolean) => {
    const caret = caretBlock();
    const sel = editor?.state.selection;
    return applyTree((list) => {
      const next = out ? outdentBlocks(list, ids) : indentBlocks(list, ids);
      if (!next) return null;
      const open: string[] = [];
      if (!out) for (const x of ids) {
        const p = next.find((b) => b.id === x)?.parent;
        if (p && next.find((b) => b.id === p)?.type === "toggle") open.push(p);
      }
      return { blocks: next, open, focus: caret && sel?.empty ? { id: caret.id, offset: caret.offset } : null };
    });
  };

  const blocksMd = (ids: string[]) => {
    const list = docToBlocks(editor!.state.doc);
    return blocksToClipboard(roots(list, ids).flatMap((r) => subtree(list, r)));
  };
  /** The block menu's "Copy as markdown" (an explicit click: the async clipboard). */
  const copyBlocks = async (ids: string[]) => {
    if (!editor) return;
    try {
      await navigator.clipboard.writeText(blocksMd(ids));
      toast(t("blk_copied"), { tone: "ok" });
    } catch {
      toast(t("blk_copy_failed"), { tone: "error" });
    }
  };

  // ── uploads ──
  // Where uploads stand lives outside the document (and its undo history): a picture being uploaded
  // shows its progress whatever is moved or undone around it, and an upload that finishes while its
  // block is undone fills it in when it comes back.
  const [uploads, setUploads] = React.useState<ReadonlyMap<string, Upload>>(new Map());
  const done = React.useRef(new Map<string, string>());
  const setUpload = (bid: string, u: Upload | null) =>
    setUploads((m) => {
      const n = new Map(m);
      if (u) n.set(bid, u);
      else n.delete(bid);
      return n;
    });
  const fillIn = React.useCallback(() => {
    if (!editor || !done.current.size) return;
    const tr = editor.state.tr;
    editor.state.doc.descendants((n, pos) => {
      const target = n.type.name === "media" && !n.attrs.target ? done.current.get(n.attrs.bid as string) : undefined;
      if (target) tr.setNodeMarkup(pos, undefined, { ...n.attrs, target });
    });
    if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
  }, [editor]);
  React.useEffect(() => {
    if (!editor) return;
    editor.on("update", fillIn);
    return () => void editor.off("update", fillIn);
  }, [editor, fillIn]);

  const runUpload = async (bid: string, f: File) => {
    if (!uploadFile) return;
    setUpload(bid, { name: f.name, file: f });
    try {
      const target = await uploadFile(f);
      done.current.set(bid, target);
      setUpload(bid, null);
      fillIn();
    } catch {
      setUpload(bid, { name: f.name, file: f, failed: true });
      toast(t("blk_media_failed", { name: f.name }), { tone: "error" });
    }
  };

  const uploadInto = async (files: File[], at: number | null) => {
    if (!uploadFile || !files.length || !editor) return;
    const made = files.map(() => newId());
    const nodes = made.map((bid) => editor.schema.nodes.media.create({ bid }));
    const state = editor.state;
    // After the innermost block at that place (inside a column, toggle or list item it stays there).
    const b = blockAt(state.doc, at ?? state.selection.from);
    const pos = b ? b.pos + b.node.nodeSize : state.doc.content.size;
    editor.view.dispatch(state.tr.insert(pos, nodes).scrollIntoView());
    await Promise.all(files.map((f, k) => runUpload(made[k], f)));
  };

  // ── the / menu ──
  const menuItems = React.useMemo(() => {
    const all = onPickMedia ? ITEMS : ITEMS.filter((i) => i.key !== "media");
    return menu ? matchItems(all, menu.query, t) : [];
  }, [menu, onPickMedia, t]);
  const menuItemsRef = React.useRef(menuItems);
  menuItemsRef.current = menuItems;
  const menuIndex = menu ? Math.min(menu.index, Math.max(0, menuItems.length - 1)) : 0;
  React.useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    if (menu && menuItems[menuIndex]) {
      dom.setAttribute("aria-controls", "cms-slash-menu");
      dom.setAttribute("aria-activedescendant", `cms-slash-${menuItems[menuIndex].key}`);
      dom.setAttribute("aria-expanded", "true");
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      dom.removeAttribute("aria-expanded");
    }
  }, [editor, menu, menuItems, menuIndex]);

  const applyItem = (item: Item) => {
    const m = menuRef.current;
    if (!editor || !m) return;
    setMenu(null);
    const state = editor.state;
    const end = m.from + 1 + m.query.length;
    editor.view.dispatch(state.tr.delete(m.from, Math.min(end, state.selection.from)));
    const cur = caretBlock();
    if (!cur) return;
    const made = item.make();
    if (made === "media") {
      void onPickMedia?.().then((md) => {
        if (!md) return;
        const blocksMade = markdownToBlocks(md).map((x) => ({ ...x, orig: undefined, gap: undefined }) as EBlock);
        insertBlocks(cur.id, blocksMade);
      });
      return;
    }
    if (!Array.isArray(made) && isText(made)) {
      turnInto([cur.id], made.type);
      if (made.type === "callout" || made.type === "todo") return;
      return;
    }
    insertBlocks(cur.id, Array.isArray(made) ? made : made.type === "hr" ? [made, text("p")] : [made]);
  };

  /** Put blocks after a block (an empty paragraph is replaced); the caret goes into the first place to write. */
  const insertBlocks = (afterId: string, made: EBlock[]) => {
    const set = new Set(made.map((b) => b.id));
    const first = made.find((b) => b.type === "p" && b.parent && set.has(b.parent)) ?? (made[0].type === "hr" ? made[1] : made[0]);
    if (made[0].type === "source") setEditingSource(made[0].id);
    applyTree((list) => {
      const cur = list.find((b) => b.id === afterId);
      const empty = cur && cur.type === "p" && !plain(cur.spans).trim() && !list.some((b) => b.parent === cur.id);
      let next: EBlock[];
      if (cur && empty) {
        const placed = made.map((b) => (!b.parent || !set.has(b.parent) ? ({ ...b, parent: cur.parent } as EBlock) : b));
        const at = list.indexOf(cur);
        next = normalize([...list.slice(0, at), ...placed, ...list.slice(at + 1)]);
      } else next = insertAfterIn(list, afterId, made);
      const f = first && (isText(first) || first.type === "code" || first.type === "table") ? { id: first.id, offset: 0 } : first ? { id: first.id, node: true } : null;
      return { blocks: next, focus: f };
    });
  };

  // ── the toolbar over selected text ──
  const updateToolbar = React.useCallback(() => {
    if (!editor || dragRef.current) return setToolbar(null);
    const { state, view } = editor;
    const sel = state.selection;
    if (!view.hasFocus() || sel instanceof NodeSelection || inTable(state) && !sel.empty && sel.$from.parent !== sel.$to.parent) return setToolbar(null);
    if (sel.$from.parent.type.spec.code) return setToolbar(null);
    const linkMark = editor.schema.marks.link;
    const at = sel.$from.marks().find((m) => m.type === linkMark);
    if (sel.empty && !at) return setToolbar(null);
    try {
      const a = view.coordsAtPos(sel.from);
      const b = view.coordsAtPos(sel.to);
      const top = Math.min(a.top, b.top);
      const x = sel.empty ? a.left : (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2;
      setToolbar({ x, y: top, from: sel.from, to: sel.to, link: at ? (at.attrs.href as string) : null });
    } catch {
      setToolbar(null);
    }
  }, [editor]);

  /** The / menu follows what is typed after the slash. */
  const updateMenu = React.useCallback(() => {
    if (!editor) return;
    const { state, view } = editor;
    const sel = state.selection;
    if (!sel.empty || !view.hasFocus() || sel.$from.parent.type.spec.code || !editable) {
      if (menuRef.current) setMenu(null);
      return;
    }
    const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, "\n", "\ufffc");
    const m = /(^|\s)\/([^\s/]{0,24})$/.exec(before);
    if (!m) {
      if (menuRef.current) setMenu(null);
      return;
    }
    const from = sel.from - m[2].length - 1;
    const r = view.coordsAtPos(from);
    // A new search starts at the first match.
    setMenu((old) => ({ query: m[2], from, x: r.left, y: r.bottom, index: old && old.from === from && old.query === m[2] ? old.index : 0, opened: old?.from === from ? old.opened : undefined }));
  }, [editor, editable]);

  /** Where the table toolbar sits, and which row and column the caret is in. */
  const updateTableBar = React.useCallback(() => {
    if (!editor || !editable) return setTableBar(null);
    const { state, view } = editor;
    const d = inTable(state);
    if (!d || !view.hasFocus()) return setTableBar(null);
    const $f = state.selection.$from;
    const pos = $f.before(d);
    const table = $f.node(d);
    const map = TableMap.get(table);
    let cellPos = -1;
    for (let k = $f.depth; k > d; k--) if ($f.node(k).type.spec.tableRole === "cell" || $f.node(k).type.spec.tableRole === "header_cell") cellPos = $f.before(k) - pos - 1;
    const rect = cellPos >= 0 ? map.findCell(cellPos) : { left: 0, top: 0 };
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    const wrap = wrapRef.current;
    if (!dom || !wrap) return setTableBar(null);
    const r = dom.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setTableBar({ pos, top: r.top - w.top, left: r.left - w.left, width: r.width, col: rect.left, row: rect.top, align: ((table.attrs.align as TableAlign[] | undefined) ?? [])[rect.left] ?? null });
  }, [editor, editable]);

  /** On phones: a block options button next to the block with the caret. */
  const updateFocusRow = React.useCallback(() => {
    // Phones and narrow windows have no hover handle: a block options button stays by the block being written.
    if (!editor || !editable || !window.matchMedia("(pointer: coarse), (max-width: 639px)").matches) return setFocusRow(null);
    const b = caretBlock();
    const wrap = wrapRef.current;
    const el = b && wrap?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(b.id)}"]`);
    if (!b || !el || !wrap || !editor.view.hasFocus()) return setFocusRow(null);
    setFocusRow({ id: b.id, top: rowOf(el).getBoundingClientRect().top - wrap.getBoundingClientRect().top });
  }, [editor, editable]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!editor) return;
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged || transaction.selectionSet) {
        updateMenu();
        updateToolbar();
        updateTableBar();
        updateFocusRow();
      }
    };
    const onBlur = () => {
      window.setTimeout(() => {
        if (editor.isDestroyed || editor.view.hasFocus()) return;
        setToolbar(null);
        setMenu(null);
        setTableBar(null);
        setFocusRow(null);
      }, 120);
    };
    const onFocus = () => {
      updateToolbar();
      updateTableBar();
      updateFocusRow();
    };
    editor.on("transaction", onTr);
    editor.on("blur", onBlur);
    editor.on("focus", onFocus);
    return () => {
      editor.off("transaction", onTr);
      editor.off("blur", onBlur);
      editor.off("focus", onFocus);
    };
  }, [editor, updateMenu, updateToolbar, updateTableBar, updateFocusRow]);

  // ── keys ──
  const visibleList = () => (editor ? reachable(docToBlocks(editor.state.doc), openIds(editor.state.doc)) : []);

  const selectRange = (from: string, to: string) => {
    const list = visibleList();
    const a = list.findIndex((b) => b.id === from);
    const b = list.findIndex((x) => x.id === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected(list.slice(lo, hi + 1).map((x) => x.id));
  };

  const selectOnly = (bid: string) => {
    anchor.current = bid;
    setMenu(null);
    setToolbar(null);
    setSelected([bid]);
  };

  ctl.current = {
    closeNext: ctl.current?.closeNext,
    t,
    editable,
    enter: () => {
      if (!editor) return false;
      const state = editor.state;
      if (menuRef.current) return false;
      if (inTable(state)) {
        // Enter in a cell: the cell below (a new row at the end).
        const d = inTable(state);
        const $f = state.selection.$from;
        const tablePos = $f.before(d);
        const table = $f.node(d);
        const map = TableMap.get(table);
        let cellPos = -1;
        for (let k = $f.depth; k > d; k--) if (/cell/.test(String($f.node(k).type.spec.tableRole))) cellPos = $f.before(k) - tablePos - 1;
        if (cellPos < 0) return true;
        const rect = map.findCell(cellPos);
        if (rect.bottom >= map.height) {
          editor.chain().addRowAfter().run();
          const t2 = editor.state.doc.nodeAt(tablePos)!;
          const m2 = TableMap.get(t2);
          const p = tablePos + 1 + m2.map[(rect.bottom) * m2.width + rect.left];
          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(p + 1))));
        } else {
          const p = tablePos + 1 + map.map[rect.bottom * map.width + rect.left];
          editor.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(p + 1))));
        }
        return true;
      }
      const $f = state.selection.$from;
      const parent = $f.parent;
      const cur = blockAt(state.doc, state.selection.from);
      if (!cur) return false;
      // ``` then Enter: a code block.
      if (parent.type.name === "paragraph" && /^```[\w+#.-]*$/.test(parent.textContent) && state.selection.empty) {
        const lang = parent.textContent.slice(3);
        const pos = $f.before();
        const tr = state.tr.replaceWith(pos, pos + parent.nodeSize, editor.schema.nodes.codeBlock.create({ bid: parent.attrs.bid, lang }));
        tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        editor.view.dispatch(tr);
        return true;
      }
      if (parent.type.name === "codeBlock") {
        // Two empty lines at the end leave the code block.
        if ($f.parentOffset === parent.content.size && parent.textContent.endsWith("\n\n")) {
          const pos = $f.before();
          const tr = state.tr.delete($f.pos - 2, $f.pos);
          const after = pos + tr.doc.nodeAt(pos)!.nodeSize;
          tr.insert(after, editor.schema.nodes.paragraph.create({ bid: newId() }));
          tr.setSelection(TextSelection.create(tr.doc, after + 1));
          editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        return false;
      }
      // Empty, or only spaces (no line breaks, no pictures).
      const empty = !parent.textContent.trim() && parent.content.size === parent.textContent.length;
      const isLine = parent.type.name === "line";
      if (empty && (isLine || parent.type.name === "quote" || parent.type.name === "callout" || parent.type.name === "heading")) {
        // An empty nested item goes up a level; elsewhere an empty item, quote or callout becomes text.
        return applyTree((list) => {
          const b = list.find((x) => x.id === cur.id);
          if (!b) return null;
          const p = b.parent ? list.find((x) => x.id === b.parent) : undefined;
          if (isLine && isList(b) && p && ["bullet", "number", "todo", "toggle"].includes(p.type)) {
            const next = outdentBlocks(list, [b.id]);
            if (next) return { blocks: next, focus: { id: b.id, offset: 0 } };
          }
          return { blocks: turnBlocks(list, [b.id], "p"), focus: { id: b.id, offset: 0 } };
        });
      }
      if (!isLine) return false; // paragraphs, headings, quotes: ProseMirror splits them
      // A list item or toggle line: split into a new item (inside, when what is inside it shows).
      const openNow = openIds(state.doc);
      return applyTree(
        (list, at) => {
        const c2 = blockAt(at.doc, at.from);
        if (!c2) return null;
        const b = list.find((x) => x.id === c2.id) as TextBlock | undefined;
        if (!b || !isText(b)) return null;
        const left = sliceSpans(b.spans, 0, c2.offset);
        const right = sliceSpans(b.spans, c2.offset);
        const kind: TextType = b.type === "toggle" ? "p" : b.type;
        // At the very start of a line with text: a new line above, the caret stays.
        if (c2.offset === 0 && spansLength(b.spans) > 0) {
          const above = text(kind === "p" ? "p" : kind, { parent: b.parent, ...(kind === "todo" ? { checked: false } : {}) });
          const at = list.indexOf(b);
          return { blocks: normalize([...list.slice(0, at), above, ...list.slice(at)]), focus: { id: b.id, offset: 0 } };
        }
        // After a closed toggle comes a line of text (as before); after an item, another item.
        const fresh = b.type === "toggle" ? text("p", { spans: right }) : text(kind, { spans: right, ...(kind === "todo" ? { checked: false } : {}) });
        const withLeft = list.map((x) => (x.id === b.id ? ({ ...b, spans: left } as EBlock) : x));
        const kids = list.filter((x) => x.parent === b.id);
        const open = openNow;
        let next: EBlock[];
        if ((b.type === "toggle" && open.has(b.id)) || (isList(b) && kids.length)) {
          const child = b.type === "toggle" ? text("p", { spans: right }) : fresh;
          const at = withLeft.findIndex((x) => x.id === b.id) + 1;
          next = normalize([...withLeft.slice(0, at), { ...child, parent: b.id }, ...withLeft.slice(at)]);
          return { blocks: next, focus: { id: child.id, offset: 0 } };
        }
        next = insertAfterIn(withLeft, b.id, [fresh]);
        return { blocks: next, focus: { id: fresh.id, offset: 0 } };
        },
        { before: (tr) => void (!tr.selection.empty && tr.deleteSelection()) }
      );
    },
    backspace: () => {
      if (!editor) return false;
      const state = editor.state;
      const sel = state.selection;
      if (!sel.empty || sel.$from.parentOffset !== 0 || inTable(state)) return false;
      const parent = sel.$from.parent;
      if (!parent.isTextblock) return false;
      const cur = blockAt(state.doc, sel.from);
      if (!cur) return false;
      if (parent.type.name === "codeBlock") {
        if (parent.content.size) return false;
        return turnInto([cur.id], "p");
      }
      // A heading, item, quote, callout or toggle becomes text first (as in Notion).
      if (parent.type.name !== "paragraph") return applyTree((list) => ({ blocks: turnBlocks(list, [cur.id], "p"), focus: { id: cur.id, offset: 0 } }));
      return applyTree((list) => {
        const b = list.find((x) => x.id === cur.id);
        if (!b || !isText(b)) return null;
        const p = b.parent ? list.find((x) => x.id === b.parent) : undefined;
        // Text inside an item or a toggle goes out a level.
        if (p && p.type !== "col" && p.type !== "columns") {
          const next = outdentBlocks(list, [b.id]);
          return next ? { blocks: next, focus: { id: b.id, offset: 0 } } : null;
        }
        const vis = reachable(list, openIds(state.doc));
        const i = vis.findIndex((x) => x.id === b.id);
        const prev = vis[i - 1];
        if (!prev || columnOf(list, prev.id) !== columnOf(list, b.id)) return null;
        if (isText(prev)) {
          const at = spansLength(prev.spans);
          const merged = list.map((x) => (x.id === prev.id ? ({ ...prev, spans: [...prev.spans, ...b.spans] } as EBlock) : x));
          return { blocks: unwrap(merged, b.id), focus: { id: prev.id, offset: at } };
        }
        if (!spansLength(b.spans)) return { blocks: unwrap(list, b.id), focus: { id: prev.id, node: prev.type !== "code", offset: "end" } };
        return { blocks: list, focus: { id: prev.id, node: prev.type !== "code", offset: "end" } };
      });
    },
    del: () => {
      if (!editor) return false;
      const state = editor.state;
      const sel = state.selection;
      const parent = sel.$from.parent;
      if (!sel.empty || !parent.isTextblock || sel.$from.parentOffset !== parent.content.size || inTable(state) || parent.type.spec.code) return false;
      const cur = blockAt(state.doc, sel.from);
      if (!cur) return false;
      return applyTree((list) => {
        const vis = reachable(list, openIds(state.doc));
        const i = vis.findIndex((x) => x.id === cur.id);
        const b = vis[i];
        const nx = vis[i + 1];
        if (!b || !nx || !isText(b) || columnOf(list, nx.id) !== columnOf(list, b.id)) return null;
        if (!isText(nx)) return { blocks: list, focus: { id: nx.id, node: true } };
        const at = spansLength(b.spans);
        const merged = list.map((x) => (x.id === b.id ? ({ ...b, spans: [...b.spans, ...nx.spans] } as EBlock) : x));
        return { blocks: unwrap(merged, nx.id), focus: { id: b.id, offset: at } };
      });
    },
    tab: (out) => {
      if (!editor) return false;
      const state = editor.state;
      if (inTable(state)) return false;
      if (state.selection.$from.parent.type.spec.code && !out) {
        editor.commands.insertContent("  ");
        return true;
      }
      const ids = idsInSelection(state);
      if (!ids.length) return false;
      // Nests or un-nests when it can; when it cannot, Tab moves on to the next control (keyboard users get out).
      return indentIds(ids, out);
    },
    turn: (type) => {
      if (!editor) return false;
      const ids = idsInSelection(editor.state);
      return ids.length ? turnInto(ids, type) : false;
    },
    duplicate: () => (editor ? duplicate(idsInSelection(editor.state)) : false),
    move: (dir) => (editor ? moveVertical(idsInSelection(editor.state), dir) : false),
    selectBlock: () => {
      if (menuRef.current) {
        if (menuRef.current.opened && !menuRef.current.query) editor?.commands.undo();
        setMenu(null);
        return true;
      }
      if (!editor) return false;
      const ids = idsInSelection(editor.state);
      if (!ids.length) return false;
      anchor.current = ids[0];
      setSelected(roots(docToBlocks(editor.state.doc), ids));
      setToolbar(null);
      return true;
    },
    modEnter: () => {
      if (!editor) return false;
      const state = editor.state;
      const $f = state.selection.$from;
      const td = inTable(state);
      if (td) {
        // Leave the table: to the line below it (a new one when a block of another kind follows).
        const after = $f.after(td);
        const next = state.doc.resolve(after).nodeAfter;
        const tr = state.tr;
        if (!next || !next.isTextblock) tr.insert(after, editor.schema.nodes.paragraph.create({ bid: newId() }));
        tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      }
      for (let d = $f.depth; d > 0; d--) {
        const n = $f.node(d);
        if (n.type.name === "listItem" && n.attrs.kind === "todo") {
          editor.view.dispatch(state.tr.setNodeAttribute($f.before(d), "checked", !n.attrs.checked));
          return true;
        }
        if (n.type.name === "toggle") {
          editor.view.dispatch(state.tr.setNodeAttribute($f.before(d), "open", !n.attrs.open).setMeta("addToHistory", false));
          return true;
        }
      }
      return false;
    },
    blockMenu: () => {
      if (!editor) return false;
      const ids = selectedRef.current.length ? selectedRef.current : idsInSelection(editor.state);
      if (!ids.length) return false;
      const el = wrapRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(ids[0])}"]`);
      const r = el ? rowOf(el).getBoundingClientRect() : null;
      setBlockMenu({ ids, x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4, back: editor.state.selection.from });
      return true;
    },
    link: () => {
      if (!editor) return false;
      const { state, view } = editor;
      let { from, to } = state.selection;
      const linkType = editor.schema.marks.link;
      const mark = state.selection.$from.marks().find((m) => m.type === linkType) ?? (state.doc.rangeHasMark(from, to, linkType) ? state.doc.resolve(from + 1).marks().find((m) => m.type === linkType) : undefined);
      if (from === to && !mark) return true;
      if (mark) {
        // The whole link, across bold or italic parts inside it.
        const range = getMarkRange(state.doc.resolve(from === to ? from : from + 1), linkType, mark.attrs);
        if (range && from === to) ({ from, to } = range);
        else if (range) {
          from = Math.min(from, range.from);
          to = Math.max(to, range.to);
        }
      }
      const r = view.coordsAtPos(from);
      setToolbar(null);
      setLinkEdit({ from, to, href: (mark?.attrs.href as string) ?? "", x: r.left, y: r.bottom + 6 });
      return true;
    },
    keyDown: (view, e) => {
      const m = menuRef.current;
      const mod = isApple() ? e.metaKey : e.ctrlKey;
      if (e.isComposing || e.keyCode === 229) return false;
      if (m) {
        const items = menuItemsRef.current;
        const at = Math.min(m.index, Math.max(0, items.length - 1));
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const n = items.length || 1;
          setMenu({ ...m, index: (at + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          const it = items[at];
          if (it) {
            e.preventDefault();
            applyItem(it);
            return true;
          }
          setMenu(null);
        }
      }
      const sel = selectedRef.current;
      if (!sel.length) {
        // ⌘A: the text of this block first; again, every block (as in Notion).
        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a" && !inTable(view.state)) {
          const { $from, $to, from, to } = view.state.selection;
          const p = $from.parent;
          if (p.isTextblock && $from.sameParent($to)) {
            const a = $from.start();
            const z = $from.end();
            if (from === a && to === z) {
              setSelected(roots(docToBlocks(view.state.doc), visibleList().map((b) => b.id)));
              setToolbar(null);
            } else view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, z)));
            e.preventDefault();
            return true;
          }
        }
        return false;
      }
      // Blocks are selected as blocks.
      const list = visibleList();
      const first = list.findIndex((b) => b.id === sel[0]);
      const last = list.findIndex((b) => b.id === sel[sel.length - 1]);
      const done = () => {
        e.preventDefault();
        return true;
      };
      if (e.key === "Escape") {
        setSelected([]);
        (view.dom as HTMLElement).blur();
        return done();
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setSelected([]);
        removeBlocks(sel);
        return done();
      }
      if (e.key === "Tab") {
        if (!indentIds(sel, e.shiftKey)) return false;
        setSelected([...sel]);
        return done();
      }
      if (e.key === "Enter" && !mod) {
        const b = list[first];
        setSelected([]);
        if (b?.type === "source") setEditingSource(b.id);
        else if (b) applyTree((l) => ({ blocks: l, focus: isText(b) || b.type === "code" ? { id: b.id, offset: "end" } : { id: b.id, node: true } }));
        return done();
      }
      if (mod && e.altKey && /^Digit\d$/.test(e.code)) {
        const type = DIGIT_TYPE[e.code.slice(5)];
        if (type) {
          turnInto(sel, type);
          setSelected([...sel]);
          return done();
        }
      }
      if (mod && e.key === "/") {
        const el = wrapRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(sel[0])}"]`);
        const r = el ? rowOf(el).getBoundingClientRect() : null;
        setBlockMenu({ ids: sel, x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
        return done();
      }
      // ⌘C / ⌘X go to the browser's copy and cut events (see clip), which hold the clipboard in hand.
      if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) return false;
      if (mod && e.key.toLowerCase() === "d") {
        duplicate(sel);
        return done();
      }
      if (mod && e.key.toLowerCase() === "a") {
        setSelected(list.map((b) => b.id));
        return done();
      }
      if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        moveVertical(sel, e.key === "ArrowUp" ? -1 : 1);
        setSelected([...sel]);
        return done();
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const up = e.key === "ArrowUp";
        if (e.shiftKey) {
          const a = anchor.current ?? sel[0];
          const ai = list.findIndex((b) => b.id === a);
          const edge = ai === first ? last : first;
          const to = list[Math.max(0, Math.min(list.length - 1, edge + (up ? -1 : 1)))];
          if (to) selectRange(a, to.id);
        } else {
          const to = list[Math.max(0, Math.min(list.length - 1, (up ? first : last) + (up ? -1 : 1)))];
          if (to) selectOnly(to.id);
        }
        return done();
      }
      if (mod && e.key.toLowerCase() === "z") {
        setSelected([]);
        return false;
      }
      if (e.key.length === 1 && !mod && !e.altKey) return false; // typed text: handled by textInput
      if (["Shift", "Alt", "Meta", "Control"].includes(e.key)) return false;
      setSelected([]);
      return false;
    },
    textInput: (_view, typed) => {
      const sel = selectedRef.current;
      if (!sel.length || !editor) return false;
      // Typing over selected blocks replaces them with a line holding what was typed.
      setSelected([]);
      return applyTree((list) => {
        const top = roots(list, sel);
        const firstB = list.find((b) => b.id === top[0]);
        const at = list.findIndex((b) => b.id === top[0]);
        const fresh = text("p", { parent: firstB?.parent, spans: [{ text: typed }] });
        return { blocks: removeFrom([...list.slice(0, at), fresh, ...list.slice(at)], top), focus: { id: fresh.id, offset: typed.length } };
      });
    },
    paste: (view, e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length && uploadFile) {
        e.preventDefault();
        void uploadInto(files, null);
        return true;
      }
      const html = e.clipboardData?.getData("text/html") ?? "";
      const plainText = e.clipboardData?.getData("text/plain") ?? "";
      const sel = view.state.selection;
      // A link pasted over selected text links that text; pasted alone, it is a link.
      if (/^https?:\/\/\S+$/.test(plainText.trim()) && !sel.$from.parent.type.spec.code && sel.$from.parent.isTextblock) {
        e.preventDefault();
        const href = plainText.trim();
        const link = view.state.schema.marks.link.create({ href });
        if (!sel.empty) view.dispatch(view.state.tr.addMark(sel.from, sel.to, link));
        else view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(href, [link]), false).removeStoredMark(link).scrollIntoView());
        return true;
      }
      if (sel.$from.parent.type.spec.code) return false;
      // Our own copies keep their structure; other pages are turned into markdown first.
      if (html && !/data-pm-slice/.test(html)) {
        const converted = pasteAsMarkdown({ html, plain: plainText });
        if (converted?.text) {
          e.preventDefault();
          const slice = markdownSlice(converted.text.replace(/\r\n?/g, "\n"), view.state.schema, inTable(view.state) > 0);
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        }
      }
      return false;
    },
    click: (view, pos, e) => {
      // ⌘/Ctrl-click opens a link.
      if (!(isApple() ? e.metaKey : e.ctrlKey)) return false;
      const mark = view.state.doc.resolve(pos).marks().find((m) => m.type.name === "link");
      const href = mark?.attrs.href as string | undefined;
      if (!href || !okHref(href) || href.startsWith(APP_LINK)) return false;
      window.open(href.startsWith("asset:") && resolveFileUrl ? resolveFileUrl(href) : href, "_blank", "noopener,noreferrer");
      return true;
    },
    clip: (_view, e, cut) => {
      const sel = selectedRef.current;
      if (!sel.length || !e.clipboardData) return false;
      // Blocks selected as blocks: markdown on the clipboard, deleted only once it is there.
      e.preventDefault();
      e.clipboardData.setData("text/plain", blocksMd(sel));
      if (cut) {
        setSelected([]);
        removeBlocks(sel, false);
      }
      return true;
    },
    drop: (view, e) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length || !uploadFile) return false;
      e.preventDefault();
      const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
      void uploadInto(files, at ? at.pos : null);
      return true;
    },
  };

  // The screen can put markdown where the caret is.
  React.useEffect(() => {
    if (!insertRef) return;
    insertRef.current = (md: string) => {
      const made = markdownToBlocks(md).map((b) => ({ ...b, orig: undefined, gap: undefined }) as EBlock);
      if (!made.length || !editor) return;
      const cur = caretBlock() ?? (() => {
        const list = docToBlocks(editor.state.doc);
        const last = list.filter((b) => !b.parent).pop();
        return last ? { id: last.id } : null;
      })();
      if (cur) insertBlocks(cur.id, made);
    };
    return () => {
      insertRef.current = null;
    };
  });

  // ── hover handle ──
  const hoverRaf = React.useRef(0);
  const onWrapMove = (e: React.PointerEvent) => {
    if (dragRef.current || marqueeRef.current || e.pointerType === "touch" || !editable) return;
    const x = e.clientX;
    const y = e.clientY;
    cancelAnimationFrame(hoverRaf.current);
    hoverRaf.current = requestAnimationFrame(() => {
      const root = editor?.view.dom as HTMLElement | undefined;
      const wrap = wrapRef.current;
      if (!root || !wrap) return;
      if ((document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-cms-handle]")) return;
      const area = root.getBoundingClientRect();
      if (y < area.top - 8 || y > area.bottom + 8) return setHover(null);
      const el = pickRow(root, Math.max(x, area.left + 1), y, () => false, 80);
      if (!el) return setHover(null);
      const row = rowOf(el);
      const r = row.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      const textEl = (el.dataset.blockType === "media" || el.dataset.blockType === "source" || el.dataset.blockType === "table" || el.dataset.blockType === "code" || el.dataset.blockType === "hr" ? el : row) as HTMLElement;
      const cs = getComputedStyle(textEl);
      const lh = parseFloat(cs.lineHeight) || 26;
      const pad = parseFloat(cs.paddingTop) || 0;
      const kind = el.dataset.blockType;
      const firstLine = kind === "media" || kind === "table" || kind === "code" || kind === "source" ? 6 : kind === "hr" ? r.height / 2 - 12 : pad + lh / 2 - 12;
      const inCol = !!el.parentElement?.closest("[data-col-id]");
      const id = el.dataset.blockId!;
      // Beside the block itself (for list items and toggles: left of their bullet or arrow).
      const left = (kind === "bullet" || kind === "number" || kind === "todo" || kind === "toggle" ? el.getBoundingClientRect().left : r.left) - w.left;
      setHover((h) => (h && h.id === id && Math.abs(h.top - (r.top - w.top + firstLine)) < 1 && h.left === left ? h : { id, top: r.top - w.top + firstLine, left, inCol }));
    });
  };

  // ── drag to move ──
  const dropAt = (x: number, y: number, ids: string[], copy: boolean): DropAt | null => {
    const root = editor?.view.dom as HTMLElement | undefined;
    if (!root || !editor) return null;
    const list = docToBlocks(editor.state.doc);
    const map = byId(list);
    const open = openIds(editor.state.doc);
    const banned = (bid: string) => !copy && (ids.includes(bid) || ids.some((r) => isInside(list, bid, r, map)));
    const movers = roots(list, ids).map((i) => map.get(i)!).filter(Boolean);
    const area = root.getBoundingClientRect();
    if (x < area.left - 72 || x > area.right + 72 || y < area.top - 48 || y > area.bottom + 48) return null;
    const top = document.elementFromPoint(x, y);
    if (top && !root.contains(top) && !wrapRef.current?.contains(top) && top !== document.body && top !== document.documentElement) return null;
    // An open toggle with nothing inside says "drop here".
    const into = (top as HTMLElement | null)?.closest<HTMLElement>("[data-drop-into]")?.closest<HTMLElement>("[data-block-id]");
    if (into && root.contains(into)) {
      const tb = map.get(into.dataset.blockId!);
      if (tb && !banned(tb.id) && movers.every((m) => accepts(tb, m))) {
        const r = into.getBoundingClientRect();
        return { id: tb.id, where: "last-child", box: { left: r.left + 28, top: r.bottom - 2, width: r.width - 28, height: 3 } };
      }
    }
    const best = pickRow(root, x, y, banned, 96);
    if (!best) return null;
    const bid = best.dataset.blockId!;
    const b = map.get(bid);
    if (!b) return null;
    const row = rowOf(best);
    const r = row.getBoundingClientRect();
    const wrapR = best.getBoundingClientRect();
    const anc = ancestors(list, bid, map);
    const sideOk = !movers.some((m) => m.type === "columns" || m.type === "col") && (anc.length === 0 || (anc.length === 2 && anc[0].type === "col" && b.parent === anc[0].id));
    const line = (t0: number, left = r.left, width = r.width): Box => ({ left, top: t0 - 1, width, height: 3 });
    const middle = y > r.top + r.height * 0.2 && y < r.bottom - r.height * 0.2;
    if (sideOk && middle && x > r.right - Math.min(72, r.width * 0.2)) return { id: bid, where: "right", box: { left: r.right + 4, top: r.top, width: 3, height: r.height } };
    if (sideOk && middle && x >= r.left - 28 && x < r.left + Math.min(24, r.width * 0.08)) return { id: bid, where: "left", box: { left: r.left - 7, top: r.top, width: 3, height: r.height } };
    const lower = y > r.top + r.height / 2;
    if (lower) {
      const kidsOf = list.filter((k) => k.parent === bid);
      const toggleOpen = b.type === "toggle" && open.has(bid);
      const nest = (toggleOpen || (isList(b) && x > r.left + 44)) && movers.every((m) => accepts(b, m));
      if (nest) return { id: bid, where: "first-child", box: line(r.bottom, r.left + 28, r.width - 28) };
      // Below the last block inside a toggle or item, with the pointer out to the left: after that toggle or item.
      let at = b;
      let atRow = r;
      for (;;) {
        const parent = at.parent ? map.get(at.parent) : undefined;
        if (!parent || parent.type === "col" || parent.type === "columns" || x >= atRow.left - 8) break;
        const sibs = list.filter((k) => k.parent === parent.id);
        if (sibs[sibs.length - 1]?.id !== at.id) break;
        const pEl = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(parent.id)}"]`);
        if (!pEl || banned(parent.id)) break;
        at = parent;
        atRow = rowOf(pEl).getBoundingClientRect();
      }
      if (at !== b) {
        const w = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(at.id)}"]`)?.getBoundingClientRect() ?? atRow;
        return { id: at.id, where: "after", box: line(w.bottom, atRow.left, atRow.width) };
      }
      const shows = kidsOf.length && (b.type !== "toggle" || open.has(bid));
      return { id: bid, where: "after", box: line(shows ? wrapR.bottom : r.bottom) };
    }
    return { id: bid, where: "before", box: line(r.top) };
  };

  const startHandle = (bid: string, e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return;
    e.preventDefault();
    const ids = selectedRef.current.includes(bid) ? selectedRef.current : [bid];
    dragRef.current = { ids, from: bid, handle: e.currentTarget as HTMLElement, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, copy: e.altKey, ghost: null, at: null, raf: 0 };
  };

  const setDragMeta = (ids: string[]) => editor?.view.dispatch(editor.state.tr.setMeta(metaKey, { dragging: ids }).setMeta("addToHistory", false));

  React.useEffect(() => {
    const endDrag = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (hoverToggle.current) clearTimeout(hoverToggle.current.timer);
      hoverToggle.current = null;
      if (!d) return;
      cancelAnimationFrame(d.raf);
      if (d.ghost) {
        const g = d.ghost;
        g.style.opacity = "0";
        window.setTimeout(() => g.remove(), 140);
      }
      document.documentElement.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      setDragging(false);
      setDropBox(null);
      if (d.started) setDragMeta([]);
    };
    const place = (d: Drag) => {
      if (d.ghost) {
        const w = d.ghost.offsetWidth;
        d.ghost.style.transform = `translate(${Math.max(8, Math.min(d.x + 14, window.innerWidth - w - 8))}px, ${d.y + 12}px)`;
      }
      d.at = dropAt(d.x, d.y, d.ids, d.copy);
      setDropBox(d.at ? { ...d.at.box, side: d.at.where === "left" || d.at.where === "right" } : null);
      // Resting on a closed toggle opens it after a moment, so blocks can go inside.
      const over = (document.elementFromPoint(d.x, d.y) as HTMLElement | null)?.closest<HTMLElement>("[data-block-type=toggle]");
      const oid = over?.dataset.blockId;
      if (oid && over?.dataset.open === "false" && !d.ids.includes(oid)) {
        if (hoverToggle.current?.id !== oid) {
          if (hoverToggle.current) clearTimeout(hoverToggle.current.timer);
          hoverToggle.current = {
            id: oid,
            timer: window.setTimeout(() => {
              hoverToggle.current = null;
              if (!dragRef.current || !editor) return;
              editor.state.doc.descendants((n, pos) => {
                if (n.attrs.bid === oid) {
                  editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "open", true).setMeta("addToHistory", false));
                  return false;
                }
              });
            }, 600),
          };
        }
      } else if (hoverToggle.current && hoverToggle.current.id !== oid) {
        clearTimeout(hoverToggle.current.timer);
        hoverToggle.current = null;
      }
    };
    const scroll = () => {
      const d = dragRef.current;
      if (!d || !d.started) return;
      const scroller = scrollerOf(wrapRef.current);
      const top = scroller ? Math.max(0, scroller.getBoundingClientRect().top) : 0;
      const bottom = scroller ? Math.min(window.innerHeight, scroller.getBoundingClientRect().bottom) : window.innerHeight;
      const edge = 72;
      let dy = 0;
      if (d.y < top + edge) dy = -Math.ceil(((top + edge - d.y) / edge) ** 2 * 18);
      else if (d.y > bottom - edge) dy = Math.ceil(((d.y - (bottom - edge)) / edge) ** 2 * 18);
      if (dy) {
        if (scroller) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        place(d);
      }
      d.raf = requestAnimationFrame(scroll);
    };
    const move = (e: PointerEvent) => {
      const mq = marqueeRef.current;
      if (mq && e.buttons & 1) {
        if (!mq.started && Math.hypot(e.clientX - mq.x0, e.clientY - mq.y0) > 5) {
          mq.started = true;
          window.getSelection()?.removeAllRanges();
          document.body.style.userSelect = "none";
          setHover(null);
        }
        if (mq.started) {
          const box = { left: Math.min(mq.x0, e.clientX), top: Math.min(mq.y0, e.clientY), width: Math.abs(e.clientX - mq.x0), height: Math.abs(e.clientY - mq.y0) };
          setMarquee(box);
          const hit = new Set(mq.base);
          for (const el of Array.from(editor?.view.dom.querySelectorAll<HTMLElement>("[data-block-id]") ?? [])) {
            if (el.dataset.blockType === "columns") continue;
            const r = rowOf(el).getBoundingClientRect();
            if (r.right > box.left && r.left < box.left + box.width && r.bottom > box.top && r.top < box.top + box.height) hit.add(el.dataset.blockId!);
          }
          const vis = visibleList().filter((b) => hit.has(b.id)).map((b) => b.id);
          const list = editor ? docToBlocks(editor.state.doc) : [];
          setSelected(roots(list, vis));
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
        window.getSelection()?.removeAllRanges();
        d.ghost = makeGhost(editor?.view.dom as HTMLElement, d.ids);
        document.documentElement.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        setDragging(true);
        setDragMeta(d.ids);
        d.raf = requestAnimationFrame(scroll);
      }
      place(d);
    };
    const up = (e: PointerEvent) => {
      const mq = marqueeRef.current;
      if (mq) {
        marqueeRef.current = null;
        setMarquee(null);
        document.body.style.removeProperty("user-select");
        if (!mq.started && mq.below && editor && editable) {
          // A click on the empty space under the last block: write there.
          const list = docToBlocks(editor.state.doc);
          const last = list.filter((b) => !b.parent).pop();
          if (last && last.type === "p" && !plain(last.spans) && !list.some((b) => b.parent === last.id)) applyTree((l) => ({ blocks: l, focus: { id: last.id, offset: 0 } }));
          else {
            const fresh = text("p");
            applyTree((l) => ({ blocks: [...l, fresh], focus: { id: fresh.id, offset: 0 } }));
          }
          editor.view.focus();
        } else if (mq.started) editor?.view.focus();
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (!d.started) {
        // A click on the handle: the block's menu.
        endDrag();
        const r = d.handle.getBoundingClientRect();
        if (!selectedRef.current.includes(d.from)) selectOnly(d.from);
        editor?.view.focus();
        setBlockMenu({ ids: selectedRef.current.includes(d.from) ? selectedRef.current : [d.from], x: r.left, y: r.bottom + 4 });
        return;
      }
      d.x = e.clientX;
      d.y = e.clientY;
      const copy = e.altKey;
      const at = dropAt(d.x, d.y, d.ids, copy);
      endDrag();
      if (!at || !editor) return;
      const before = new Set(docToBlocks(editor.state.doc).map((b) => b.id));
      let after: EBlock[] = [];
      applyTree((list) => {
        const next = moveTo(list, d.ids, at.id, at.where, copy);
        if (!next) return null;
        after = next;
        return { blocks: next, open: at.where === "first-child" || at.where === "last-child" ? [at.id] : [] };
      });
      if (!after.length) return;
      const fresh = after.filter((b) => !before.has(b.id) && b.type !== "col" && b.type !== "columns");
      const freshIds = new Set(fresh.map((b) => b.id));
      editor.view.focus();
      setSelected(copy ? fresh.filter((b) => !b.parent || !freshIds.has(b.parent)).map((b) => b.id) : roots(after, d.ids));
      flash(copy ? [...freshIds] : d.ids);
    };
    const key = (e: KeyboardEvent) => {
      const d = dragRef.current;
      if (e.key === "Escape" && d?.started) {
        e.preventDefault();
        e.stopPropagation();
        endDrag();
      }
      if (e.key === "Alt" && d?.started && d.copy !== (e.type === "keydown")) {
        e.preventDefault();
        d.copy = e.type === "keydown";
        place(d);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
    };
  });

  /** A short highlight on blocks that just landed. */
  const flash = (ids: string[]) =>
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    requestAnimationFrame(() => {
      for (const x of ids) {
        const el = editor?.view.dom.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(x)}"]`);
        if (!el) continue;
        el.animate([{ backgroundColor: "rgb(14 165 233 / 0.18)" }, { backgroundColor: "transparent" }], { duration: 700, easing: EASE });
      }
    });

  /** A box drawn from the margin or the space under the blocks. */
  const onWrapPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === "touch" || !editor) return;
    const at = e.target as HTMLElement;
    const root = editor.view.dom as HTMLElement;
    if (at.closest("[data-cms-handle],[data-cms-pop],[data-cms-tablebar]")) return;
    const inside = root.contains(at);
    // Inside the text: ProseMirror. A click clears a block selection.
    if (inside && at !== root) {
      if (selectedRef.current.length) setSelected([]);
      return;
    }
    const r = root.getBoundingClientRect();
    const below = e.clientY > r.bottom - 4;
    e.preventDefault();
    marqueeRef.current = { x0: e.clientX, y0: e.clientY, started: false, base: e.shiftKey ? selectedRef.current : [], below };
    if (!e.shiftKey && selectedRef.current.length) setSelected([]);
  };

  // Close menus on a click elsewhere.
  React.useEffect(() => {
    if (!blockMenu && !linkEdit) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-cms-pop]")) return;
      setBlockMenu(null);
      setLinkEdit(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [blockMenu, linkEdit]);

  // Scrolling moves what is drawn over the text.
  React.useEffect(() => {
    const on = () => {
      setHover(null);
      if (menuRef.current) updateMenu();
      updateToolbar();
      updateTableBar();
      updateFocusRow();
    };
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [updateMenu, updateToolbar, updateTableBar, updateFocusRow]);

  /** A table command and the column alignment that goes with it, as one undo step. */
  const tableCmd = (k: TableKey) => {
    if (!editor || !tableBar) return;
    const { pos } = tableBar;
    // Several cells selected: the commands act on the whole rectangle.
    const rect = editor.state.selection instanceof CellSelection ? selectedRect(editor.state) : { left: tableBar.col, right: tableBar.col + 1, top: tableBar.row, bottom: tableBar.row + 1 };
    if ((k === "rowAbove" || k === "delRow") && rect.top === 0) return;
    // A table keeps at least one column: deleting them all is refused, alignment untouched.
    const tableNode = editor.state.doc.nodeAt(pos);
    if (k === "delCol" && tableNode && rect.right - rect.left >= TableMap.get(tableNode).width) return;
    const col = k === "colRight" ? rect.right - 1 : rect.left;
    const cols = rect.right - rect.left;
    const alignEdit: ((a: TableAlign[]) => TableAlign[]) | null =
      k === "colLeft"
        ? (a) => [...a.slice(0, col), null, ...a.slice(col)]
        : k === "colRight"
          ? (a) => [...a.slice(0, col + 1), null, ...a.slice(col + 1)]
          : k === "delCol"
            ? (a) => a.filter((_, i) => i < rect.left || i >= rect.right)
            : k === "alignLeft" || k === "alignCenter" || k === "alignRight"
              ? (a) => {
                  const n = [...a];
                  while (n.length < rect.right) n.push(null);
                  for (let i = rect.left; i < rect.left + cols; i++) n[i] = k === "alignCenter" ? "center" : k === "alignRight" ? "right" : "left";
                  return n;
                }
              : null;
    let c = editor.chain().focus();
    if (k === "rowAbove") c = c.addRowBefore();
    else if (k === "rowBelow") c = c.addRowAfter();
    else if (k === "colLeft") c = c.addColumnBefore();
    else if (k === "colRight") c = c.addColumnAfter();
    else if (k === "delRow") c = c.deleteRow();
    else if (k === "delCol") c = c.deleteColumn();
    else if (k === "delTable") c = c.deleteTable();
    if (alignEdit)
      c = c.command(({ tr }) => {
        const node = tr.doc.nodeAt(pos);
        if (node?.type.name === "table") tr.setNodeAttribute(pos, "align", alignEdit([...((node.attrs.align as TableAlign[]) ?? [])]));
        return true;
      });
    c.run();
  };

  const menuItemsForBlocks = (ids: string[]) => (editor ? docToBlocks(editor.state.doc).filter((b) => ids.includes(b.id)) : []);
  const ctx: EdCtx = {
    uploads,
    retryUpload: (bid) => {
      const u = uploads.get(bid);
      if (u) void runUpload(bid, u.file);
    },
    t,
    editable, resolveFileUrl, onPickMedia, editingSource, setEditingSource };

  return (
    <Ctx.Provider value={ctx}>
      <div
        ref={wrapRef}
        id={id}
        className="cms-blocks group/editor relative flex min-h-[360px] flex-1 flex-col pb-28 pr-10 pt-2 sm:-ml-16 sm:-mr-10 sm:pl-16 sm:pr-10 [@media(pointer:coarse)]:pr-10"
        onPointerMove={onWrapMove}
        onPointerLeave={() => !dragRef.current && setHover(null)}
        onPointerDown={onWrapPointerDown}
      >
        <style>{EDITOR_CSS}</style>
        <div className="sr-only" aria-live="polite">
          {selected.length ? t("blk_selected_n", { n: selected.length }) : menu ? (menuItems.length ? t("blk_slash_count", { n: menuItems.length }) : t("blk_slash_none")) : ""}
        </div>
        <EditorContent editor={editor} className="flex-1" />

        {hover && editable && !dragging && !marquee ? (
          <div
            data-cms-handle
            contentEditable={false}
            className="absolute z-10 hidden items-center gap-0.5 sm:flex"
            style={{ top: hover.top, left: hover.left - (hover.inCol ? 26 : 52), transition: `top 90ms ${EASE}, left 90ms ${EASE}`, animation: `cms-fade 140ms ${EASE} both` }}
          >
            {hover.inCol ? null : (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t("blk_add_below")}
                title={t("blk_add_hint")}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-100 hover:bg-muted hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  const bid = hover.id;
                  const above = e.altKey;
                  const list = editor ? docToBlocks(editor.state.doc) : [];
                  const cur = list.find((b) => b.id === bid);
                  if (!cur || !editor) return;
                  const fresh = text("p", { spans: [{ text: "/" }] });
                  editor.view.focus();
                  applyTree((l) => {
                    if (cur.type === "p" && !plain(cur.spans) && !above) return { blocks: l.map((b) => (b.id === bid ? ({ ...b, spans: [{ text: "/" }] } as EBlock) : b)), focus: { id: bid, offset: 1 } };
                    const at = l.findIndex((b) => b.id === bid);
                    const placed = { ...fresh, parent: cur.parent };
                    return { blocks: above ? normalize([...l.slice(0, at), placed, ...l.slice(at)]) : insertAfterIn(l, bid, [fresh]), focus: { id: fresh.id, offset: 1 } };
                  });
                  updateMenu();
                  setMenu((m) => (m ? { ...m, opened: true } : m));
                }}
              >
                <Plus className="size-[18px]" />
              </button>
            )}
            <button
              type="button"
              aria-label={t("blk_handle")}
              title={t("blk_handle_hint")}
              aria-haspopup="menu"
              className="flex h-6 w-[18px] cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-100 hover:bg-muted hover:text-foreground active:cursor-grabbing"
              onPointerDown={(e) => startHandle(hover.id, e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  selectOnly(hover.id);
                  setBlockMenu({ ids: [hover.id], x: r.left, y: r.bottom + 4 });
                }
              }}
            >
              <GripVertical className="size-4" />
            </button>
          </div>
        ) : null}

        {focusRow && editable && !blockMenu ? (
          <button
            type="button"
            data-cms-handle
            aria-label={t("blk_options")}
            aria-haspopup="menu"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setBlockMenu({ ids: [focusRow.id], x: Math.max(8, r.right - 256), y: r.bottom + 4, back: editor?.state.selection.from });
            }}
            className="absolute -right-1 z-10 flex size-10 items-center justify-center rounded-lg text-muted-foreground active:bg-muted sm:right-0 sm:size-8"
            style={{ top: focusRow.top - 4, animation: `cms-fade 140ms ${EASE} both` }}
          >
            <GripVertical className="size-4" />
          </button>
        ) : null}

        {tableBar && !dragging ? (
          <TableBar
            t={t}
            at={tableBar}
            onCmd={tableCmd}
          />
        ) : null}

        {dropBox ? (
          <div
            key={dropBox.side ? "side" : "line"}
            aria-hidden
            data-cms-drop-line
            className={cn("pointer-events-none fixed z-50 rounded-full bg-sky-500 dark:bg-sky-400", dropBox.side && "shadow-[0_0_0_3px_rgb(14_165_233/0.18)]")}
            style={{ left: dropBox.left, top: dropBox.top, width: dropBox.width, height: dropBox.height, transition: `top 80ms ${EASE}, left 80ms ${EASE}, width 80ms ${EASE}, height 80ms ${EASE}` }}
          />
        ) : null}
        {marquee ? <div aria-hidden className="pointer-events-none fixed z-40 rounded-[3px] border border-sky-500/40 bg-sky-500/10" style={marquee} /> : null}

        {menu && editable ? (
          <SlashMenu t={t} items={menuItems} index={menuIndex} x={menu.x} y={menu.y} query={menu.query} onPick={applyItem} onHover={(index) => setMenu((m) => (m ? { ...m, index } : m))} />
        ) : null}

        {toolbar && !menu && !linkEdit && !dragging && editor ? (
          <Toolbar
            t={t}
            editor={editor}
            at={toolbar}
            resolveFileUrl={resolveFileUrl}
            onLink={() => ctl.current.link()}
            onUnlink={() => {
              ctl.current.link();
              setLinkEdit(null);
              editor.chain().focus().extendMarkRange("link").unsetMark("link").run();
            }}
            onTurn={(type) => {
              const ids = idsInSelection(editor.state);
              const sel = editor.state.selection;
              turnInto(ids, type);
              try {
                editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, Math.min(sel.from, editor.state.doc.content.size), Math.min(sel.to, editor.state.doc.content.size))));
              } catch {
                /* the text moved */
              }
              editor.view.focus();
            }}
          />
        ) : null}

        {linkEdit && editor ? (
          <LinkPopover
            t={t}
            at={linkEdit}
            onApply={(href) => {
              const { from, to } = linkEdit;
              setLinkEdit(null);
              const tr = editor.state.tr.removeMark(from, to, editor.schema.marks.link);
              if (href) tr.addMark(from, to, editor.schema.marks.link.create({ href: href.trim() }));
              tr.setSelection(TextSelection.create(tr.doc, to));
              editor.view.dispatch(tr);
              editor.view.focus();
            }}
            onCancel={() => {
              setLinkEdit(null);
              editor.view.focus();
            }}
          />
        ) : null}

        {blockMenu && editor ? (
          <BlockMenu
            t={t}
            at={blockMenu}
            blocks={menuItemsForBlocks(blockMenu.ids)}
            canIndent={!!indentBlocks(docToBlocks(editor.state.doc), blockMenu.ids)}
            canOutdent={!!outdentBlocks(docToBlocks(editor.state.doc), blockMenu.ids)}
            onClose={() => {
              const back = blockMenu.back;
              setBlockMenu(null);
              editor.view.focus();
              if (back !== undefined) {
                setSelected([]);
                try {
                  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(Math.min(back, editor.state.doc.content.size)))));
                } catch {
                  /* gone */
                }
              }
            }}
            onTurn={(type) => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              setSelected([]);
              turnInto(ids, type);
              editor.view.focus();
            }}
            onTone={(tone) => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              applyTree((l) => ({ blocks: l.map((b) => (ids.includes(b.id) && b.type === "callout" ? ({ ...b, tone } as EBlock) : b)) }));
              editor.view.focus();
            }}
            onDuplicate={() => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              duplicate(ids);
              editor.view.focus();
            }}
            onMove={(dir) => {
              moveVertical(blockMenu.ids, dir);
              setSelected(blockMenu.ids);
            }}
            onIndent={(out) => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              indentIds(ids, out);
              setSelected(ids);
              editor.view.focus();
            }}
            onInsert={(above) => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              setSelected([]);
              const fresh = text("p");
              applyTree((l) => {
                const top = roots(l, ids);
                const edge = above ? top[0] : top[top.length - 1];
                const b = l.find((x) => x.id === edge);
                if (!b) return null;
                const placed = { ...fresh, parent: b.parent } as EBlock;
                if (above) {
                  const at = l.indexOf(b);
                  return { blocks: normalize([...l.slice(0, at), placed, ...l.slice(at)]), focus: { id: fresh.id, offset: 0 } };
                }
                return { blocks: insertAfterIn(l, edge, [fresh]), focus: { id: fresh.id, offset: 0 } };
              });
              editor.view.focus();
            }}
            onCopy={() => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              void copyBlocks(ids);
              editor.view.focus();
            }}
            onDelete={() => {
              const ids = blockMenu.ids;
              setBlockMenu(null);
              setSelected([]);
              removeBlocks(ids);
              editor.view.focus();
            }}
          />
        ) : null}
      </div>
    </Ctx.Provider>
  );
}

// ── conversions for the clipboard ─────────────────────────────────────────────

function docToBlocksFromJson(json: ReturnType<typeof blocksToDoc>): EBlock[] {
  return docToBlocks(cmsSchema().nodeFromJSON(json));
}

/** What is copied, as markdown (blocks), or inline markdown (part of one line). */
function sliceToMarkdown(slice: Slice): string {
  const content = slice.content;
  try {
    let inlineOnly = true;
    content.forEach((n) => {
      if (n.isBlock) inlineOnly = false;
    });
    if (inlineOnly) return spansToMd(nodeSpans(cmsSchema().nodes.paragraph.create(null, content)));
    // One block whose text was partly copied: its inline markdown.
    if (content.childCount === 1 && content.firstChild!.isTextblock && slice.openStart > 0) return spansToMd(nodeSpans(content.firstChild!));
    const schema = cmsSchema();
    const pieces: PMNode[] = [];
    content.forEach((n) => {
      if (n.type.name === "line") pieces.push(schema.nodes.paragraph.create(null, n.content));
      else if (n.type.name === "column") n.forEach((c) => pieces.push(c));
      else if (n.type.name === "tableRow" || /cell/.test(String(n.type.spec.tableRole))) pieces.push(schema.nodes.paragraph.create(null, schema.text(n.textContent || " ")));
      else pieces.push(n);
    });
    const doc = schema.topNodeType.create(null, pieces);
    return blocksToClipboard(docToBlocks(doc));
  } catch {
    return content.textBetween(0, content.size, "\n\n");
  }
}

/** Pasted text, read as markdown: one line stays inline (with its marks), several lines become blocks. */
function markdownSlice(txt: string, schema: import("@tiptap/pm/model").Schema, inline = false): Slice {
  const md = txt.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!md.includes("\n") || inline) {
      const p = schema.nodeFromJSON(blocksToDoc([text("p", { spans: mdToSpans(md.replace(/\n/g, " ")) })]).content![0]);
    return new Slice(Fragment.from(p), 1, 1);
  }
  const blocks = markdownToBlocks(md).map((b) => ({ ...b, id: b.id, orig: undefined, gap: undefined }) as EBlock);
  const doc = schema.nodeFromJSON(blocksToDoc(cloneBlocks(blocks)));
  return Slice.maxOpen(doc.content);
}

// ── floating parts ────────────────────────────────────────────────────────────

function Floating({ x, y, above, children, className, label }: { x: number; y: number; above?: boolean; children: React.ReactNode; className?: string; label?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number; up: boolean } | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // The part of the page the keyboard does not cover.
    const vv = window.visualViewport;
    const vh = vv ? vv.height + vv.offsetTop : window.innerHeight;
    let left = above ? x - w / 2 : x;
    let top = above ? y - h - 8 : y + 4;
    let up = !!above;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (!above && top + h > vh - 8) {
      const u = y - h - 28;
      if (u >= 8 && y - 28 > vh - y) {
        top = u;
        up = true;
      } else top = Math.max(8, vh - h - 8);
    }
    if (above && top < 8) {
      top = y + 28;
      up = false;
    }
    if (!pos || pos.left !== left || pos.top !== top) setPos({ left, top, up });
  });
  return createPortal(
    <div
      ref={ref}
      data-cms-pop
      role={label ? "toolbar" : undefined}
      aria-label={label}
      className={cn("fixed z-50 rounded-xl border bg-popover text-popover-foreground shadow-[0_10px_38px_-10px_rgba(0,0,0,.25),0_10px_20px_-15px_rgba(0,0,0,.2)]", className)}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, opacity: pos ? undefined : 0, animation: pos ? `${pos.up ? "cms-pop-up" : "cms-pop"} 150ms ${EASE} both` : undefined }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("input,textarea")) e.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body
  );
}

function SlashMenu({ t, items, index, x, y, query, onPick, onHover }: { t: T; items: Item[]; index: number; x: number; y: number; query: string; onPick: (i: Item) => void; onHover: (i: number) => void }) {
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  let lastGroup = "";
  return (
    <Floating x={x} y={y} className="w-[300px] overflow-hidden p-1">
      <div ref={list} id="cms-slash-menu" role="listbox" aria-label={t("blk_slash_label")} className="max-h-[min(22rem,calc(100dvh-8rem))] overflow-y-auto overscroll-contain">
        {items.length ? (
          items.map((it, n) => {
            const head = !query && it.group !== lastGroup ? t(it.group) : null;
            lastGroup = it.group;
            const I = it.icon;
            return (
              <React.Fragment key={it.key}>
                {head ? <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground first:pt-1">{head}</div> : null}
                <div
                  role="option"
                  id={`cms-slash-${it.key}`}
                  aria-selected={n === index}
                  data-index={n}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-75", n === index && "bg-accent text-accent-foreground")}
                  onMouseMove={() => n !== index && onHover(n)}
                  onClick={() => onPick(it)}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background shadow-sm">
                    <I className="size-[18px]" />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="block text-sm font-medium">{t(it.label)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t(it.hint)}</span>
                  </span>
                  {it.keys ? <kbd className="shrink-0 font-mono text-[11px] text-muted-foreground/80 [@media(pointer:coarse)]:hidden">{it.keys}</kbd> : null}
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
  editor,
  at,
  onLink,
  onUnlink,
  onTurn,
  resolveFileUrl,
}: {
  t: T;
  editor: TEditor;
  at: { x: number; y: number; from: number; to: number; link: string | null };
  onLink: () => void;
  onUnlink: () => void;
  onTurn: (type: TurnType) => void;
  resolveFileUrl?: (target: string) => string;
}) {
  const [turnOpen, setTurnOpen] = React.useState(false);
  const mod = MOD();
  if (at.from === at.to && at.link) {
    const href = at.link;
    const shown = href.startsWith(APP_LINK) ? href.slice(APP_LINK.length) : href;
    const openable = /^https?:|^\//.test(href) || href.startsWith("asset:");
    return (
      <Floating x={at.x} y={at.y} above label={t("blk_fmt_link")} className="flex items-center gap-1 p-1 text-xs">
        <span className="max-w-64 truncate px-1.5 font-mono text-muted-foreground" dir="ltr">
          {shown}
        </span>
        {openable ? (
          <a className="flex size-7 items-center justify-center rounded-md hover:bg-muted" href={href.startsWith("asset:") && resolveFileUrl ? resolveFileUrl(href) : href} target="_blank" rel="noopener noreferrer" aria-label={t("blk_link_open")} title={t("blk_link_open")}>
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
        <button type="button" className="flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label={t("blk_link_edit")} title={t("blk_link_edit")} onClick={onLink}>
          <Pencil className="size-3.5" />
        </button>
        <button type="button" className="flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label={t("blk_link_remove")} title={t("blk_link_remove")} onClick={onUnlink}>
          <Unlink className="size-3.5" />
        </button>
      </Floating>
    );
  }
  const btn = (mark: string, I: Icon, label: Key, keys: string) => {
    const on = editor.isActive(mark);
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={t(label)}
        title={`${t(label)} (${keys})`}
        className={cn("flex size-8 items-center justify-center rounded-lg transition-colors duration-100 hover:bg-muted", on && "bg-sky-500/10 text-sky-600 dark:text-sky-400")}
        onClick={() => editor.chain().focus().toggleMark(mark).run()}
      >
        <I className="size-4" />
      </button>
    );
  };
  const ids = (() => {
    const b = blockAt(editor.state.doc, at.from);
    return b;
  })();
  const kind = ids?.node.type.name === "heading" ? (ids.node.attrs.level === 3 ? "h3" : "h2") : ids?.node.type.name === "listItem" ? (ids.node.attrs.kind as string) : ids?.node.type.name === "paragraph" ? "p" : ids?.node.type.name ?? "p";
  const cur = TURN_INTO.find((x) => x.type === kind) ?? TURN_INTO[0];
  return (
    <Floating x={at.x} y={at.y} above label={t("blk_toolbar")} className="flex items-center gap-0.5 p-1">
      <div className="relative">
        <button type="button" aria-haspopup="menu" aria-expanded={turnOpen} className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm transition-colors duration-100 hover:bg-muted" onClick={() => setTurnOpen((o) => !o)}>
          {t(cur.label)}
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform duration-150", turnOpen && "rotate-180")} style={{ transitionTimingFunction: EASE }} />
        </button>
        {turnOpen ? (
          <div role="menu" className="absolute left-0 top-full z-10 mt-1.5 w-52 rounded-xl border bg-popover p-1 shadow-lg" style={{ animation: `cms-pop 140ms ${EASE} both` }}>
            {TURN_INTO.map((x) => (
              <button key={x.type} role="menuitem" type="button" className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted", x.type === kind && "font-medium text-sky-600 dark:text-sky-400")} onClick={() => onTurn(x.type)}>
                <x.icon className="size-4" />
                <span className="grow text-left">{t(x.label)}</span>
                {x.type === kind ? <Check className="size-3.5" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className="mx-0.5 h-5 w-px bg-border" />
      {btn("bold", Bold, "blk_fmt_bold", `${mod}B`)}
      {btn("italic", Italic, "blk_fmt_italic", `${mod}I`)}
      {btn("strike", Strikethrough, "blk_fmt_strike", `${mod}⇧S`)}
      {btn("code", Code, "blk_fmt_code", `${mod}E`)}
      <button type="button" aria-label={t("blk_fmt_link")} title={`${t("blk_fmt_link")} (${mod}K)`} className={cn("flex size-8 items-center justify-center rounded-lg transition-colors duration-100 hover:bg-muted", editor.isActive("link") && "bg-sky-500/10 text-sky-600")} onClick={onLink}>
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
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className={cn("h-8 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", bad && "border-destructive")}
          />
          <button type="submit" disabled={bad} className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50">
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

type TableKey = "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "delRow" | "delCol" | "alignLeft" | "alignCenter" | "alignRight" | "delTable";

function TableBar({ t, at, onCmd }: { t: T; at: { top: number; left: number; width: number; row: number; col: number; align: TableAlign }; onCmd: (k: TableKey) => void }) {
  // The header row stays the first row (markdown tables have exactly one).
  const head = at.row === 0;
  const b = (k: TableKey, I: Icon, label: Key, o: { danger?: boolean; off?: boolean; on?: boolean } = {}) => (
    <button
      type="button"
      aria-label={t(label)}
      title={t(label)}
      disabled={o.off}
      aria-pressed={o.on === undefined ? undefined : o.on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onCmd(k)}
      className={cn(
        "flex size-7 items-center justify-center rounded-md transition-colors duration-100 hover:bg-muted disabled:pointer-events-none disabled:opacity-35 [@media(pointer:coarse)]:size-10",
        o.danger && "text-destructive hover:bg-destructive/10",
        o.on && "bg-sky-500/10 text-sky-600 dark:text-sky-400"
      )}
    >
      <I className="size-3.5" />
    </button>
  );
  const group = (label: Key, kids: React.ReactNode) => (
    <span role="group" aria-label={t(label)} className="flex items-center gap-0.5">
      {kids}
    </span>
  );
  return (
    <div
      data-cms-tablebar
      role="toolbar"
      aria-label={t("blk_t_table")}
      contentEditable={false}
      className="absolute z-20 flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-x-0.5 gap-y-1 rounded-lg border bg-popover p-0.5 shadow-md"
      style={{ bottom: `calc(100% - ${at.top}px + 6px)`, left: Math.max(0, at.left), animation: `cms-pop-up 140ms ${EASE} both` }}
    >
      {group("blk_table_row", <>
        {b("rowAbove", ArrowUpToLine, "blk_table_above", { off: head })}
        {b("rowBelow", ArrowDownToLine, "blk_table_below")}
        {b("delRow", Trash2, "blk_table_del_row", { danger: true, off: head })}
      </>)}
      <span className="mx-0.5 h-4 w-px bg-border" />
      {group("blk_table_col", <>
        {b("colLeft", ArrowLeftToLine, "blk_table_left")}
        {b("colRight", ArrowRightToLine, "blk_table_right")}
        {b("delCol", Trash2, "blk_table_del_col", { danger: true })}
      </>)}
      <span className="mx-0.5 h-4 w-px bg-border" />
      {group("blk_table_align", <>
        {b("alignLeft", AlignLeft, "blk_table_align_left", { on: !at.align || at.align === "left" })}
        {b("alignCenter", AlignCenter, "blk_table_align_center", { on: at.align === "center" })}
        {b("alignRight", AlignRight, "blk_table_align_right", { on: at.align === "right" })}
      </>)}
      <span className="mx-0.5 h-4 w-px bg-border" />
      <span className="px-1.5 text-[11px] tabular-nums text-muted-foreground">{t("blk_table_cell", { row: at.row + 1, col: at.col + 1 })}</span>
    </div>
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
  group: "turn" | "tone" | "act" | "danger";
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
  onTone,
  onDuplicate,
  onMove,
  onIndent,
  onInsert,
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
  onTone: (tone: Tone) => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
  onIndent: (out: boolean) => void;
  onInsert: (above: boolean) => void;
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
  const callouts = blocks.length > 0 && blocks.every((b) => b.type === "callout");
  const actions: MenuAction[] = [
    ...(turnable
      ? TURN_INTO.map((x) => ({ key: `turn-${x.type}`, label: t(x.label), icon: x.icon, run: () => onTurn(x.type), keys: x.digit ? `${mod}${alt}${x.digit}` : undefined, group: "turn" as const, words: `turn into ${x.type} 바꾸기` }))
      : []),
    ...(callouts ? (["note", "tip", "warning"] as const).map((tone) => ({ key: `tone-${tone}`, label: t(`blk_tone_${tone}` as Key), icon: Info, run: () => onTone(tone), group: "tone" as const, words: `tone ${tone} 종류` })) : []),
    { key: "above", label: t("blk_add_above"), icon: ArrowUpToLine, run: () => onInsert(true), group: "act", words: "insert add above new 위에 추가" },
    { key: "below", label: t("blk_add_below"), icon: ArrowDownToLine, run: () => onInsert(false), group: "act", words: "insert add below new 아래에 추가" },
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
      <div ref={list} id="cms-block-menu" role="listbox" aria-label={t("blk_handle")} className="max-h-[min(20rem,calc(100dvh-8rem))] overflow-y-auto overscroll-contain pt-1">
        {shown.length ? (
          shown.map((a, n) => {
            const head = a.group !== lastGroup && a.group === "turn" ? (blocks.length > 1 ? t("blk_turn_n", { n: blocks.length }) : t("blk_turn_into")) : null;
            const rule = a.group !== lastGroup && lastGroup !== "" && !query;
            lastGroup = a.group;
            const I = a.icon;
            return (
              <React.Fragment key={a.key}>
                {rule ? <div className="my-1 h-px bg-border" /> : null}
                {head ? <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{head}</div> : null}
                <div
                  id={`cms-block-menu-${a.key}`}
                  role="option"
                  aria-selected={n === pick}
                  data-index={n}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-75", n === pick && (a.danger ? "bg-destructive/10" : "bg-accent text-accent-foreground"), a.danger && "text-destructive")}
                  onMouseMove={() => n !== pick && setIndex(n)}
                  onClick={a.run}
                >
                  <I className="size-4 shrink-0" />
                  <span className="grow truncate">{a.label}</span>
                  {a.group === "turn" && current && `turn-${current}` === a.key ? <Check className="size-3.5 text-sky-600" /> : null}
                  {a.keys ? <kbd className="shrink-0 font-sans text-[11px] text-muted-foreground [@media(pointer:coarse)]:hidden">{a.keys}</kbd> : null}
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

// ── styles that only CSS can do (keyframes, ProseMirror's own classes) ───────

const EDITOR_CSS = `
@keyframes cms-pop { from { opacity: .35; transform: translateY(-4px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes cms-pop-up { from { opacity: .35; transform: translateY(4px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes cms-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes cms-check { from { stroke-dasharray: 24; stroke-dashoffset: 24 } to { stroke-dasharray: 24; stroke-dashoffset: 0 } }
@keyframes cms-open { from { opacity: 0; transform: translateY(-3px) } to { opacity: 1; transform: none } }
.cms-blocks .cms-pm { font-size: 15.5px; line-height: 1.75; caret-color: rgb(14 165 233); word-break: break-word; }
.cms-blocks .cms-pm > * + * { margin-top: 2px; }
.cms-blocks .cms-b { position: relative; border-radius: 6px; transition: background-color 160ms ${EASE}, opacity 160ms ${EASE}; }
.cms-blocks .cms-p { padding: 3px 2px; min-height: 1.75em; }
.cms-blocks .cms-h2 { font-size: 1.6em; font-weight: 650; line-height: 1.3; letter-spacing: -0.015em; margin-top: 1.4em; padding: 3px 2px; }
.cms-blocks .cms-h3 { font-size: 1.25em; font-weight: 620; line-height: 1.35; margin-top: 1em; padding: 3px 2px; }
.cms-blocks .cms-pm > .cms-h2:first-child, .cms-blocks .cms-pm > .cms-h3:first-child { margin-top: 0.2em; }
.cms-blocks .cms-quote { border-left: 3px solid currentColor; padding: 2px 2px 2px 16px; margin: 6px 0; }
.cms-blocks .cms-callout { display: block; padding: 12px 16px 12px 44px; margin: 6px 0; border-radius: 10px; border: 1px solid transparent; }
.cms-blocks .cms-callout::before { position: absolute; left: 14px; top: 13px; font-size: 16px; line-height: 1.6; }
.cms-blocks .cms-callout[data-tone="note"] { background: rgb(14 165 233 / .08); border-color: rgb(14 165 233 / .2); }
.cms-blocks .cms-callout[data-tone="note"]::before { content: "ℹ️"; }
.cms-blocks .cms-callout[data-tone="tip"] { background: rgb(16 185 129 / .08); border-color: rgb(16 185 129 / .22); }
.cms-blocks .cms-callout[data-tone="tip"]::before { content: "💡"; }
.cms-blocks .cms-callout[data-tone="warning"] { background: rgb(245 158 11 / .1); border-color: rgb(245 158 11 / .3); }
.cms-blocks .cms-callout[data-tone="warning"]::before { content: "⚠️"; }
.cms-blocks .cms-item, .cms-blocks .cms-toggle { padding-left: 28px; }
.cms-blocks .cms-line { padding: 3px 2px; min-height: 1.75em; }
.cms-blocks .cms-item[data-kind="todo"][data-checked="true"] > .cms-line { color: color-mix(in srgb, currentColor 50%, transparent); text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); transition: color 200ms ${EASE}; }
.cms-blocks .cms-toggle[data-open="false"] > :not(.cms-line):not(span) { display: none; }
.cms-blocks .cms-toggle[data-open="true"] > :not(.cms-line):not(span) { animation: cms-open 180ms ${EASE} both; }
.cms-blocks .cms-code { margin: 6px 0; }
.cms-blocks .cms-hr { padding: 10px 0; }
.cms-blocks .cms-hr hr { border: 0; border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); margin: 0; }
.cms-blocks .cms-columns { display: flex; gap: 48px; margin: 4px 0; }
.cms-blocks .cms-column { flex: 1 1 0; min-width: 0; }
@media (max-width: 640px) { .cms-blocks .cms-columns { flex-direction: column; gap: 4px; } }
.cms-blocks .cms-table { margin: 8px 0; overflow-x: auto; }
.cms-blocks .cms-table table { border-collapse: collapse; width: 100%; min-width: max-content; font-size: 14.5px; line-height: 1.55; }
.cms-blocks .cms-table td, .cms-blocks .cms-table th { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); padding: 7px 10px; min-width: 96px; vertical-align: top; text-align: left; }
.cms-blocks .cms-table th { font-weight: 600; background: color-mix(in srgb, currentColor 4%, transparent); }
.cms-blocks .cms-table td.text-center, .cms-blocks .cms-table th.text-center { text-align: center; }
.cms-blocks .cms-table td.text-right, .cms-blocks .cms-table th.text-right { text-align: right; }
.cms-blocks .cms-table .selectedCell { background: rgb(14 165 233 / .12); }
.cms-blocks .cms-link { color: rgb(2 132 199); text-decoration: underline; text-decoration-color: rgb(2 132 199 / .35); text-underline-offset: 3px; cursor: pointer; transition: text-decoration-color 120ms ${EASE}; }
.cms-blocks .cms-link:hover { text-decoration-color: rgb(2 132 199); }
.dark .cms-blocks .cms-link { color: rgb(56 189 248); }
.cms-blocks .cms-pm code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; padding: .15em .35em; border-radius: 5px; background: color-mix(in srgb, currentColor 8%, transparent); color: rgb(225 29 72); }
.dark .cms-blocks .cms-pm code { color: rgb(251 113 133); }
.cms-blocks .cms-pm pre code { padding: 0; background: none; color: inherit; font-size: inherit; }
.cms-blocks .cms-selected { background: rgb(14 165 233 / .1); box-shadow: 0 0 0 1px rgb(14 165 233 / .45); }
.cms-blocks .cms-cell-active { outline: 2px solid rgb(14 165 233 / .7); outline-offset: -2px; }
.cms-blocks .cms-dragging { opacity: .35; }
.cms-blocks .cms-blocksel { caret-color: transparent; }
.cms-blocks .cms-blocksel ::selection { background: transparent; }
.cms-blocks .cms-pm ::selection { background: rgb(14 165 233 / .22); }
.cms-blocks .is-empty::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: color-mix(in srgb, currentColor 32%, transparent); }
.cms-blocks .ProseMirror-selectednode.cms-hr hr { border-top-color: rgb(14 165 233); }
.cms-blocks .ProseMirror-gapcursor { position: relative; }
.cms-blocks .ProseMirror-gapcursor::after { content: ""; display: block; position: absolute; top: -2px; width: 20px; border-top: 2px solid rgb(14 165 233); animation: cms-fade 1s steps(2) infinite; }
@media (prefers-reduced-motion: reduce) { .cms-blocks *, [data-cms-pop], [data-cms-ghost] { animation-duration: 1ms !important; transition-duration: 1ms !important; } }
`;
