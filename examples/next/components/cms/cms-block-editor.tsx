"use client";
// agent-cms: the block editor (Notion-style) for the document body.
// Written for this CMS, no editor library: every block is its own small
// editable element, and every change goes through plain functions
// (cms-blocks-convert.ts, cms-blocks-inline.ts) that are tested in node.
//
// The body is still stored as markdown. This editor reads markdown, shows
// blocks, and writes markdown back:
// - opening a document and not touching it never changes a byte of it;
// - a block that was not touched writes its original text back;
// - what has no block of its own (HTML, columns, toggles, tables with
//   alignment...) is drawn as it will look and edited as markdown in place.
//
// What it does: / menu, markdown typed by hand (`## `, `- `, `1. `, `[] `,
// `> `, `**bold**`, `` `code` ``...), a toolbar over selected text, links,
// block handles (drag to move, menu to turn into / duplicate / delete),
// selecting blocks with Esc, Shift and dragging across them, copy and paste
// as markdown, pasted or dropped images uploaded to the media library,
// its own undo history, Korean and other IME input.
//
// Install: npx @mainsoft/agent-cms add cms-block-editor
// Use: <CmsProvider slots={{ blockEditor: CmsBlockEditor }}> (load it lazily).

import * as React from "react";
import { Bold, Check, ChevronDown, Code, Copy, CopyPlus, ExternalLink, GripVertical, Heading2, Heading3, ImageIcon, Info, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Minus, MoveDown, MoveUp, Pencil, Pilcrow, Plus, Quote, Strikethrough, Table, Trash2, Unlink, Columns2, CodeXml, ListCollapse } from "lucide-react";
import { cn } from "@/lib/utils";
import { blockPlain, blocksToClipboard, blocksToMarkdown, isList, isText, markdownToBlocks, newId, sameMarkdown, type EBlock, type TextBlock, type TextType, type Tone } from "./cms-blocks-convert";
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
import { MarkdownPreview } from "./cms-parts";
import { pasteAsMarkdown } from "./cms-paste";
import { isApple, useCms, type BlockEditorProps } from "./use-cms";

type T = ReturnType<typeof useCms>["t"];
type Key = Parameters<T>[0];

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
  icon: React.ComponentType<{ className?: string }>;
  words: string;
  /** Turn the current (empty) block into this, or make it below. */
  make: () => EBlock | "media";
}

const text = (type: TextType, extra: Partial<TextBlock> = {}): TextBlock => ({ id: newId(), type, spans: [], ...extra });
const source = (md: string, kind: string): EBlock => ({ id: newId(), type: "source", md, kind });

const ITEMS: Item[] = [
  { key: "p", label: "blk_t_p", hint: "blk_t_p_text", group: "blk_group_basic", icon: Pilcrow, words: "text paragraph plain 텍스트 문단 본문", make: () => text("p") },
  { key: "h2", label: "blk_t_h2", hint: "blk_t_h2_text", group: "blk_group_basic", icon: Heading2, words: "heading title h2 ## 제목 헤딩", make: () => text("h2") },
  { key: "h3", label: "blk_t_h3", hint: "blk_t_h3_text", group: "blk_group_basic", icon: Heading3, words: "subheading heading h3 ### 작은 제목 소제목", make: () => text("h3") },
  { key: "bullet", label: "blk_t_bullet", hint: "blk_t_bullet_text", group: "blk_group_basic", icon: List, words: "bullet list ul - 글머리 목록 리스트", make: () => text("bullet") },
  { key: "number", label: "blk_t_number", hint: "blk_t_number_text", group: "blk_group_basic", icon: ListOrdered, words: "numbered list ol 1. 번호 목록 순서", make: () => text("number") },
  { key: "todo", label: "blk_t_todo", hint: "blk_t_todo_text", group: "blk_group_basic", icon: ListChecks, words: "todo task check checkbox [] 할 일 체크", make: () => text("todo", { checked: false }) },
  { key: "quote", label: "blk_t_quote", hint: "blk_t_quote_text", group: "blk_group_basic", icon: Quote, words: "quote blockquote > 인용", make: () => text("quote") },
  { key: "callout", label: "blk_t_callout", hint: "blk_t_callout_text", group: "blk_group_basic", icon: Info, words: "callout note tip warning 알림 참고 팁 주의", make: () => text("callout", { tone: "note" }) },
  { key: "hr", label: "blk_t_hr", hint: "blk_t_hr_text", group: "blk_group_basic", icon: Minus, words: "divider rule hr line --- 구분선 선", make: () => ({ id: newId(), type: "hr" }) },
  { key: "media", label: "blk_slash_media", hint: "blk_slash_media_text", group: "blk_group_media", icon: ImageIcon, words: "image picture photo file media 이미지 사진 그림 파일 미디어", make: () => "media" },
  { key: "code", label: "blk_t_code", hint: "blk_t_code_text", group: "blk_group_advanced", icon: Code, words: "code snippet ``` 코드", make: () => ({ id: newId(), type: "code", text: "", lang: "" }) },
  { key: "table", label: "blk_t_table", hint: "blk_t_table_text", group: "blk_group_advanced", icon: Table, words: "table grid rows columns 표 테이블", make: () => source("|  |  |\n| --- | --- |\n|  |  |", "table") },
  { key: "toggle", label: "blk_t_toggle", hint: "blk_t_toggle_text", group: "blk_group_advanced", icon: ListCollapse, words: "toggle details collapse 접기 토글", make: () => source(":::toggle \n\n:::", "toggle") },
  { key: "columns", label: "blk_slash_columns", hint: "blk_slash_columns_text", group: "blk_group_advanced", icon: Columns2, words: "columns two side 2단 단 칼럼", make: () => source(":::columns\n:::col\n\n:::col\n\n:::", "columns") },
  { key: "html", label: "blk_slash_html", hint: "blk_slash_html_text", group: "blk_group_advanced", icon: CodeXml, words: "html embed iframe markup 임베드", make: () => source(":::html\n\n:::", "html") },
];

const TURN_INTO: { type: TextType; label: Key; icon: React.ComponentType<{ className?: string }> }[] = [
  { type: "p", label: "blk_t_p", icon: Pilcrow },
  { type: "h2", label: "blk_t_h2", icon: Heading2 },
  { type: "h3", label: "blk_t_h3", icon: Heading3 },
  { type: "bullet", label: "blk_t_bullet", icon: List },
  { type: "number", label: "blk_t_number", icon: ListOrdered },
  { type: "todo", label: "blk_t_todo", icon: ListChecks },
  { type: "quote", label: "blk_t_quote", icon: Quote },
  { type: "callout", label: "blk_t_callout", icon: Info },
];

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
  if (b.type === "p" && (m = /^> ?\[!(note|tip|warning)\] $/i.exec(head))) return { type: "callout", strip: head.length, extra: { tone: m[1].toLowerCase() as Tone } };
  return null;
}

// ── the editor ────────────────────────────────────────────────────────────────

type Menu = { id: string; query: string; from: number; x: number; y: number; index: number } | null;

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
  const [selected, setSelected] = React.useState<string[]>([]);
  const anchor = React.useRef<string | null>(null);
  const [menu, setMenu] = React.useState<Menu>(null);
  const [editingSource, setEditingSource] = React.useState<string | null>(null);
  const [toolbar, setToolbar] = React.useState<{ id: string; start: number; end: number; x: number; y: number; link: ReturnType<typeof linkAt> } | null>(null);
  const [linkEdit, setLinkEdit] = React.useState<{ id: string; start: number; end: number; href: string; x: number; y: number } | null>(null);
  const [drop, setDrop] = React.useState<{ id: string; after: boolean } | null>(null);
  const dragging = React.useRef<string[] | null>(null);
  const [blockMenu, setBlockMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
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
    setBlocksState(blocksRef.current);
  }, [value]);

  // Put the caret where the last change wants it.
  React.useLayoutEffect(() => {
    const f = pendingFocus.current;
    if (!f) return;
    pendingFocus.current = null;
    const el = els.current.get(f.id);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      setSelectionIn(el, f.start, f.end ?? f.start);
      if (f.plain) leaveMarks(el);
    }
    else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.setSelectionRange(f.start, f.end ?? f.start);
    el.scrollIntoView({ block: "nearest" });
  });

  const indexOf = (bid: string) => blocksRef.current.findIndex((b) => b.id === bid);
  const replace = (bid: string, make: (b: EBlock) => EBlock | EBlock[]) => blocksRef.current.flatMap((b) => (b.id === bid ? make(b) : [b]));

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

  /** Put blocks below one block; an empty text line is replaced. */
  const insertAfter = (bid: string | undefined, made: EBlock[], focusLast = true) => {
    const list = blocksRef.current;
    const at = bid ? list.findIndex((b) => b.id === bid) : list.length - 1;
    const cur = list[at];
    const empty = cur && cur.type === "p" && !plain((cur as TextBlock).spans).trim();
    const next = empty ? [...list.slice(0, at), ...made, ...list.slice(at + 1)] : [...list.slice(0, at + 1), ...made, ...list.slice(at + 1)];
    const last = made[made.length - 1];
    commit(next, focusLast ? focusOf(last, "end") : undefined);
  };

  const focusOf = (b: EBlock | undefined, where: "start" | "end"): Focus | null => {
    if (!b) return null;
    if (isText(b)) return { id: b.id, start: where === "start" ? 0 : spansLength(b.spans) };
    if (b.type === "code") return { id: b.id, start: where === "start" ? 0 : b.text.length };
    return { id: b.id, start: 0 };
  };

  const focusBlock = (b: EBlock | undefined, where: "start" | "end") => {
    if (!b) return;
    if (!isText(b) && b.type !== "code") {
      selectOnly(b.id);
      return;
    }
    pendingFocus.current = focusOf(b, where);
    setBlocksState([...blocksRef.current]);
  };

  // ── uploads ──
  const uploadInto = React.useCallback(
    async (files: File[], afterId: string | undefined) => {
      if (!uploadFile || !files.length) return;
      const made = files.map((f) => ({ id: newId(), type: "media" as const, target: "", alt: "", pending: f.name }));
      insertAfter(afterId, made as EBlock[], false);
      for (const [k, f] of files.entries()) {
        const bid = made[k].id;
        try {
          const target = await uploadFile(f);
          const next = blocksRef.current.map((b) => (b.id === bid ? ({ id: bid, type: "media", target, alt: "" } as EBlock) : b));
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
    const list = blocksRef.current;
    const a = list.findIndex((b) => b.id === from);
    const b = list.findIndex((x) => x.id === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected(list.slice(lo, hi + 1).map((x) => x.id));
  };

  const removeBlocks = (ids: string[], announce = true) => {
    const list = blocksRef.current;
    const first = list.findIndex((b) => ids.includes(b.id));
    const next = list.filter((b) => !ids.includes(b.id));
    const neighbour = next[Math.max(0, first - 1)];
    setSelected([]);
    commit(next.length ? next : [text("p")], next.length ? focusOf(neighbour, "end") : null);
    if (announce && ids.length > 1) toast(t("blk_deleted_n", { n: ids.length }), { action: { label: t("undo"), run: () => undo() } });
  };

  const moveBlocks = (ids: string[], dir: -1 | 1) => {
    const list = [...blocksRef.current];
    const idx = list.map((b, i) => (ids.includes(b.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const lo = idx[0];
    const hi = idx[idx.length - 1];
    if ((dir < 0 && lo === 0) || (dir > 0 && hi === list.length - 1)) return;
    const part = list.splice(lo, hi - lo + 1);
    list.splice(lo + dir, 0, ...part);
    commit(list, focused.current && ids.includes(focused.current.id) ? focused.current : undefined);
  };

  const duplicate = (ids: string[]) => {
    const list = blocksRef.current;
    const lastIdx = Math.max(...ids.map((x) => list.findIndex((b) => b.id === x)));
    const copies = list.filter((b) => ids.includes(b.id)).map((b) => ({ ...b, id: newId(), orig: undefined, gap: undefined }) as EBlock);
    commit([...list.slice(0, lastIdx + 1), ...copies, ...list.slice(lastIdx + 1)]);
    setSelected(copies.map((c) => c.id));
  };

  const turnInto = (bid: string, type: TextType) => {
    const next = replace(bid, (b) => {
      if (isText(b)) return { ...b, type, ...(type === "todo" ? { checked: !!b.checked } : {}), ...(type === "callout" ? { tone: b.tone ?? "note" } : {}) };
      if (b.type === "code") return { id: b.id, type, spans: b.text ? [{ text: b.text }] : [] } as TextBlock;
      return b;
    });
    const b = next.find((x) => x.id === bid);
    commit(next, focusOf(b, "end"));
  };

  const copyBlocks = async (ids: string[], cut = false) => {
    const md = blocksToClipboard(blocksRef.current.filter((b) => ids.includes(b.id)));
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
    } else if (b.type === "p" && plain(spans) === "---" && data === "-") {
      const rule: EBlock = { id: newId(), type: "hr" };
      const after = text("p");
      commit(replace(b.id, () => [rule, after]), { id: after.id, start: 0 });
      return;
    } else if (b.type === "p" && /^```[\w+-]*$/.test(plain(spans)) && data === "`" && plain(spans).length === 3) {
      const code: EBlock = { id: b.id, type: "code", text: "", lang: "" };
      commit(replace(b.id, () => code), { id: b.id, start: 0 });
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
      commit(replace(b.id, () => next), { id: b.id, start: caret, plain: true }, undefined);
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
      setMenu((old) => ({ id: b.id, query: m[2], from: caret - m[2].length - 1, x: r?.left ?? 0, y: r?.bottom ?? 0, index: old?.id === b.id ? Math.min(old.index, 50) : 0 }));
    } else if (menu) setMenu(null);
  };

  const applyItem = (item: Item) => {
    if (!menu) return;
    const b = blocksRef.current.find((x) => x.id === menu.id);
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
    if (isText(made)) {
      // A text kind turns the line into it, keeping what was written.
      const turned = { ...b, ...made, id: b.id, spans, orig: b.orig, gap: b.gap } as TextBlock;
      commit(replace(b.id, () => turned), { id: b.id, start: menu.from });
      return;
    }
    const after: EBlock[] = made.type === "hr" ? [made, text("p")] : [made];
    const next = emptyNow ? replace(b.id, () => after) : replace(b.id, (x) => [{ ...(x as TextBlock), spans }, ...after]);
    if (made.type === "source") setEditingSource(made.id);
    commit(next, made.type === "hr" ? { id: after[1].id, start: 0 } : made.type === "code" ? { id: made.id, start: 0 } : made.type === "source" ? { id: made.id, start: made.md.indexOf("\n") > 0 && made.kind === "toggle" ? 9 : 0 } : undefined);
  };

  const menuItems = React.useMemo(() => {
    const all = onPickMedia ? ITEMS : ITEMS.filter((i) => i.key !== "media");
    return menu ? matchItems(all, menu.query, t) : [];
  }, [menu, onPickMedia, t]);

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
        setMenu(null);
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
        setSelected(list.map((x) => x.id));
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
        moveBlocks([b.id], e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (e.key === "Enter" && b.type === "todo") {
        e.preventDefault();
        commit(replace(b.id, (x) => ({ ...(x as TextBlock), checked: !(x as TextBlock).checked })));
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
      // An empty list item, quote or callout ends it.
      if (isEmpty && b.type !== "p") {
        commit(replace(b.id, (x) => ({ ...(x as TextBlock), type: "p", checked: undefined, start: undefined, tone: undefined })), { id: b.id, start: 0 });
        return;
      }
      // ``` then Enter: a code block.
      const m = /^```([\w+-]*)$/.exec(plain(b.spans));
      if (b.type === "p" && m) {
        commit(replace(b.id, () => ({ id: b.id, type: "code", text: "", lang: m[1] })), { id: b.id, start: 0 });
        return;
      }
      const left = sliceSpans(b.spans, 0, sel.start);
      const right = sliceSpans(b.spans, sel.end);
      const kind: TextType = isList(b) ? b.type : "p";
      // At the very start of a line with text: a new line above, the caret stays.
      if (sel.start === 0 && sel.end === 0 && len > 0) {
        const above = text(kind, kind === "todo" ? { checked: false } : {});
        commit([...list.slice(0, i), above, ...list.slice(i)], { id: b.id, start: 0 });
        return;
      }
      const below = text(kind, { spans: right, ...(kind === "todo" ? { checked: false } : {}) });
      commit([...list.slice(0, i), { ...b, spans: left }, below, ...list.slice(i + 1)], { id: below.id, start: 0 });
      return;
    }

    if (e.key === "Backspace" && sel.collapsed && sel.start === 0) {
      // A heading, list item, quote or callout becomes text first (like in Notion).
      if (b.type !== "p") {
        e.preventDefault();
        commit(replace(b.id, (x) => ({ ...(x as TextBlock), type: "p", checked: undefined, start: undefined, tone: undefined, newList: undefined })), { id: b.id, start: 0 });
        return;
      }
      const prev = list[i - 1];
      if (!prev) return;
      e.preventDefault();
      if (isText(prev)) {
        const at = spansLength(prev.spans);
        const merged = { ...prev, spans: [...prev.spans, ...b.spans] } as TextBlock;
        commit([...list.slice(0, i - 1), merged, ...list.slice(i + 1)], { id: prev.id, start: at });
      } else if (!len) {
        commit([...list.slice(0, i), ...list.slice(i + 1)]);
        selectOnly(prev.id);
      } else selectOnly(prev.id);
      return;
    }

    if (e.key === "Delete" && sel.collapsed && sel.start === len) {
      const nextB = list[i + 1];
      if (!nextB) return;
      e.preventDefault();
      if (isText(nextB)) {
        const merged = { ...b, spans: [...b.spans, ...nextB.spans] } as TextBlock;
        commit([...list.slice(0, i), merged, ...list.slice(i + 2)], { id: b.id, start: len });
      } else selectOnly(nextB.id);
      return;
    }

    if ((e.key === "ArrowUp" || (e.key === "ArrowLeft" && sel.collapsed && sel.start === 0)) && !e.shiftKey && i > 0) {
      if (e.key === "ArrowLeft" || onEdgeLine(el, "top")) {
        e.preventDefault();
        focusBlock(list[i - 1], "end");
      }
      return;
    }
    if ((e.key === "ArrowDown" || (e.key === "ArrowRight" && sel.collapsed && sel.start === len)) && !e.shiftKey && i < list.length - 1) {
      if (e.key === "ArrowRight" || onEdgeLine(el, "bottom")) {
        e.preventDefault();
        focusBlock(list[i + 1], "start");
      }
      return;
    }
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && ((e.key === "ArrowUp" && sel.start === 0) || (e.key === "ArrowDown" && sel.end === len))) {
      // Shift past the edge of a block selects blocks.
      e.preventDefault();
      const other = list[i + (e.key === "ArrowUp" ? -1 : 1)];
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
    const b = blocksRef.current.find((x) => x.id === linkEdit.id);
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
    // Several lines: blocks.
    const made = markdownToBlocks(trimmed).map((x) => ({ ...x, orig: undefined, gap: undefined })) as EBlock[];
    if (!made.length) return;
    const first = made[0];
    const out: EBlock[] = [];
    if (isText(first) && (left.length || b.type !== "p")) {
      out.push({ ...b, spans: [...left, ...first.spans] });
      made.shift();
    } else if (left.length) out.push({ ...b, spans: left });
    out.push(...made);
    const last = out[out.length - 1];
    let focus: Focus | null = focusOf(last, "end");
    if (right.length) {
      if (last && isText(last)) {
        focus = { id: last.id, start: spansLength(last.spans) };
        out[out.length - 1] = { ...last, spans: [...last.spans, ...right] };
      } else out.push({ ...text(b.type === "p" ? "p" : b.type), spans: right });
    }
    if (!out.length) return;
    commit([...list.slice(0, i), ...out, ...list.slice(i + 1)], focus);
  };

  const onDropFiles = (e: React.DragEvent, bid: string) => {
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length || !uploadFile) return false;
    e.preventDefault();
    void uploadInto(files, bid);
    return true;
  };

  // ── keys while blocks are selected ──
  const onRootKey = (e: React.KeyboardEvent) => {
    if (!selected.length || e.target !== rootRef.current) return;
    const mod = isApple() ? e.metaKey : e.ctrlKey;
    const list = blocksRef.current;
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
    if (e.key === "Enter") {
      e.preventDefault();
      const b = list[first];
      setSelected([]);
      if (b?.type === "source") setEditingSource(b.id);
      focusBlock(b, "end");
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
      moveBlocks(selected, e.key === "ArrowUp" ? -1 : 1);
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
    const first = list.findIndex((b) => b.id === selected[0]);
    const fresh = text("p", { spans: [{ text: e.key }] });
    const next = [...list.slice(0, first), fresh, ...list.slice(first).filter((b) => !selected.includes(b.id))];
    setSelected([]);
    commit(next, { id: fresh.id, start: 1 });
  };

  const onRootCopy = (e: React.ClipboardEvent) => {
    if (!selected.length || e.target !== rootRef.current) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", blocksToClipboard(blocksRef.current.filter((b) => selected.includes(b.id))));
  };

  // ── dragging across blocks selects them (the browser cannot select across separate editable parts) ──
  const pointer = React.useRef<{ id: string; x: number; y: number } | null>(null);
  const onPointerDownBlock = (bid: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey && (selected.length || focused.current)) {
      e.preventDefault();
      selectRange(anchor.current ?? selected[0] ?? focused.current!.id, bid);
      rootRef.current?.focus({ preventScroll: true });
      return;
    }
    pointer.current = { id: bid, x: e.clientX, y: e.clientY };
    if (selected.length) setSelected([]);
  };
  React.useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pointer.current;
      if (!p || !(e.buttons & 1)) return;
      const under = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-block-id]");
      const over = under?.dataset.blockId;
      if (over && over !== p.id && rootRef.current?.contains(under!)) {
        anchor.current = p.id;
        window.getSelection()?.removeAllRanges();
        (document.activeElement as HTMLElement | null)?.blur?.();
        rootRef.current?.focus({ preventScroll: true });
        selectRange(p.id, over);
      }
    };
    const up = () => (pointer.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

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

  // ── drag to move ──
  const onDragStartHandle = (bid: string, e: React.DragEvent) => {
    const ids = selected.includes(bid) ? selected : [bid];
    dragging.current = ids;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", blocksToClipboard(blocksRef.current.filter((b) => ids.includes(b.id))));
    const row = els.current.get(bid)?.closest("[data-block-id]");
    if (row) e.dataTransfer.setDragImage(row, 20, 12);
  };
  const onDragOverBlock = (bid: string, e: React.DragEvent) => {
    if (!dragging.current && !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    setDrop((d) => (d?.id === bid && d.after === after ? d : { id: bid, after }));
  };
  const onDropBlock = (bid: string, e: React.DragEvent) => {
    const d = drop;
    setDrop(null);
    if (!dragging.current) {
      onDropFiles(e, bid);
      return;
    }
    e.preventDefault();
    const ids = dragging.current;
    dragging.current = null;
    if (!d || ids.includes(bid)) return;
    const list = blocksRef.current;
    const moving = list.filter((b) => ids.includes(b.id));
    const rest = list.filter((b) => !ids.includes(b.id));
    const at = rest.findIndex((b) => b.id === bid) + (d.after ? 1 : 0);
    commit([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
    setSelected(ids);
  };

  // ── numbering of numbered lists ──
  const numbers = React.useMemo(() => {
    const out: Record<string, number> = {};
    let n = 0;
    let prev: EBlock | null = null;
    for (const b of blocks) {
      if (b.type === "number") {
        n = prev?.type === "number" && !b.newList ? n + 1 : b.start || 1;
        out[b.id] = n;
      }
      prev = b;
    }
    return out;
  }, [blocks]);

  const onlyEmpty = blocks.length === 1 && isText(blocks[0]) && !plain(blocks[0].spans);

  return (
    <div
      ref={rootRef}
      id={id}
      aria-describedby={describedBy}
      tabIndex={-1}
      role="group"
      aria-label={t("blk_body")}
      className="cms-blocks relative flex min-h-[360px] flex-1 flex-col pb-24 pt-2 outline-none"
      onKeyDown={onRootKey}
      onKeyPress={onRootKeyPress}
      onCopy={onRootCopy}
      onMouseDown={(e) => {
        // A click on the empty space under the last block goes to the end.
        if (e.target === rootRef.current && editable) {
          const last = blocksRef.current[blocksRef.current.length - 1];
          if (last && isText(last) && !plain(last.spans)) focusBlock(last, "end");
          else {
            const fresh = text("p");
            commit([...blocksRef.current, fresh], { id: fresh.id, start: 0 });
          }
          e.preventDefault();
        }
      }}
    >
      {selected.length ? (
        <div className="sr-only" aria-live="polite">
          {t("blk_selected_n", { n: selected.length })}
        </div>
      ) : null}
      {blocks.map((b) => (
        <BlockRow
          key={b.id}
          block={b}
          t={t}
          editable={editable}
          selected={selected.includes(b.id)}
          drop={drop?.id === b.id ? (drop.after ? "after" : "before") : null}
          number={numbers[b.id]}
          placeholder={onlyEmpty ? t("blk_placeholder") : focusId === b.id ? t("blk_placeholder_line") : undefined}
          editingSource={editingSource === b.id}
          resolveFileUrl={resolveFileUrl}
          register={(el) => {
            if (el) els.current.set(b.id, el);
            else els.current.delete(b.id);
          }}
          onFocus={(start) => {
            focused.current = { id: b.id, start };
            setFocusId(b.id);
            if (selected.length) setSelected([]);
          }}
          onBlur={() => {
            setFocusId((f) => (f === b.id ? null : f));
            if (menu?.id === b.id) setTimeout(() => setMenu((m) => (m?.id === b.id && !rootRef.current?.contains(document.activeElement) ? null : m)), 150);
          }}
          onPointerDown={(e) => onPointerDownBlock(b.id, e)}
          onTextInput={(el, data) => isText(b) && onTextInput(b, el, data)}
          onTextKey={(el, e) => isText(b) && onTextKey(b, el, e)}
          onTextPaste={(el, e) => isText(b) && onTextPaste(b, el, e)}
          onChange={(nb, group) => commit(replace(b.id, () => nb), undefined, group)}
          onToggleTodo={() => isText(b) && commit(replace(b.id, (x) => ({ ...(x as TextBlock), checked: !(x as TextBlock).checked })))}
          onSourceEdit={(on) => setEditingSource(on ? b.id : null)}
          onSelect={() => selectOnly(b.id)}
          onRemove={() => removeBlocks([b.id])}
          onExit={(where) => {
            const i = indexOf(b.id);
            if (where === "next") {
              const nb = blocksRef.current[i + 1];
              if (nb) focusBlock(nb, "start");
              else {
                const fresh = text("p");
                commit([...blocksRef.current, fresh], { id: fresh.id, start: 0 });
              }
            } else focusBlock(blocksRef.current[i - 1], "end");
          }}
          onUndo={(redoIt) => (redoIt ? redo() : undo())}
          onPickMedia={
            onPickMedia
              ? () =>
                  void onPickMedia().then((md) => {
                    if (!md) return;
                    const made = markdownToBlocks(md)[0];
                    if (made && made.type === "media") commit(replace(b.id, (x) => ({ ...(x as EBlock), target: made.target, alt: (x as { alt?: string }).alt || made.alt }) as EBlock));
                  })
              : undefined
          }
          onAdd={() => {
            const fresh = text("p");
            const i = indexOf(b.id);
            const list = blocksRef.current;
            const cur = list[i];
            if (cur && isText(cur) && !plain(cur.spans)) {
              pendingFocus.current = { id: cur.id, start: 0 };
              const withSlash = { ...cur, spans: [{ text: "/" }] };
              commit(replace(cur.id, () => withSlash), { id: cur.id, start: 1 });
              const r = els.current.get(cur.id)?.getBoundingClientRect();
              setMenu({ id: cur.id, query: "", from: 0, x: r?.left ?? 0, y: r?.bottom ?? 0, index: 0 });
              return;
            }
            const withSlash = { ...fresh, spans: [{ text: "/" }] };
            commit([...list.slice(0, i + 1), withSlash, ...list.slice(i + 1)], { id: fresh.id, start: 1 });
            requestAnimationFrame(() => {
              const r = els.current.get(fresh.id)?.getBoundingClientRect();
              setMenu({ id: fresh.id, query: "", from: 0, x: r?.left ?? 0, y: r?.bottom ?? 0, index: 0 });
            });
          }}
          onHandleClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            if (!selected.includes(b.id)) selectOnly(b.id);
            setBlockMenu({ id: b.id, x: r.left, y: r.bottom + 4 });
          }}
          onDragStart={(e) => onDragStartHandle(b.id, e)}
          onDragOver={(e) => onDragOverBlock(b.id, e)}
          onDragLeave={() => setDrop((d) => (d?.id === b.id ? null : d))}
          onDrop={(e) => onDropBlock(b.id, e)}
          onDragEnd={() => {
            dragging.current = null;
            setDrop(null);
          }}
          onTone={(tone) => commit(replace(b.id, (x) => ({ ...(x as TextBlock), tone })))}
        />
      ))}

      {menu && menuItems ? (
        <SlashMenu t={t} items={menuItems} index={menu.index} x={menu.x} y={menu.y} onPick={applyItem} onHover={(index) => setMenu({ ...menu, index })} />
      ) : null}

      {toolbar && !menu && !linkEdit ? (
        <Toolbar
          t={t}
          at={toolbar}
          block={blocks.find((b) => b.id === toolbar.id) as TextBlock | undefined}
          onMark={(m) => {
            const b = blocksRef.current.find((x) => x.id === toolbar.id);
            if (b && isText(b)) format(b, m, toolbar.start, toolbar.end);
          }}
          onLink={() => {
            const b = blocksRef.current.find((x) => x.id === toolbar.id);
            if (b && isText(b)) openLink(b, toolbar.start, toolbar.end);
          }}
          onUnlink={() => {
            const b = blocksRef.current.find((x) => x.id === toolbar.id);
            if (!b || !isText(b) || !toolbar.link) return;
            const spans = setLink(b.spans, toolbar.link.from, toolbar.link.to, null);
            commit(replace(b.id, (x) => ({ ...(x as TextBlock), spans })), { id: b.id, start: toolbar.start });
          }}
          onTurn={(type) => turnInto(toolbar.id, type)}
          resolveFileUrl={resolveFileUrl}
        />
      ) : null}

      {linkEdit ? <LinkPopover t={t} at={linkEdit} onApply={applyLink} onCancel={() => setLinkEdit(null)} /> : null}

      {blockMenu ? (
        <BlockMenu
          t={t}
          at={blockMenu}
          block={blocks.find((b) => b.id === blockMenu.id)}
          count={selected.length > 1 && selected.includes(blockMenu.id) ? selected.length : 1}
          onClose={() => setBlockMenu(null)}
          onTurn={(type) => {
            setBlockMenu(null);
            setSelected([]);
            turnInto(blockMenu.id, type);
          }}
          onDuplicate={() => {
            setBlockMenu(null);
            duplicate(selected.includes(blockMenu.id) ? selected : [blockMenu.id]);
          }}
          onMove={(dir) => moveBlocks(selected.includes(blockMenu.id) ? selected : [blockMenu.id], dir)}
          onCopy={() => {
            setBlockMenu(null);
            void copyBlocks(selected.includes(blockMenu.id) ? selected : [blockMenu.id]);
          }}
          onDelete={() => {
            setBlockMenu(null);
            removeBlocks(selected.includes(blockMenu.id) ? selected : [blockMenu.id]);
          }}
        />
      ) : null}
    </div>
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

interface RowProps {
  block: EBlock;
  t: T;
  editable: boolean;
  selected: boolean;
  drop: "before" | "after" | null;
  number?: number;
  placeholder?: string;
  editingSource: boolean;
  resolveFileUrl?: (target: string) => string;
  register: (el: HTMLElement | null) => void;
  onFocus: (start: number) => void;
  onBlur: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onTextInput: (el: HTMLElement, data: string | null) => void;
  onTextKey: (el: HTMLElement, e: React.KeyboardEvent) => void;
  onTextPaste: (el: HTMLElement, e: React.ClipboardEvent) => void;
  onChange: (b: EBlock, group?: string) => void;
  onToggleTodo: () => void;
  onSourceEdit: (on: boolean) => void;
  onSelect: () => void;
  onRemove: () => void;
  onExit: (where: "prev" | "next") => void;
  onUndo: (redo: boolean) => void;
  onPickMedia?: () => void;
  onAdd: () => void;
  onHandleClick: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onTone: (tone: Tone) => void;
}

const BlockRow = React.memo(function BlockRow(p: RowProps) {
  const { block: b, t, editable } = p;
  const pad = b.type === "h2" ? "pt-6" : b.type === "h3" ? "pt-4" : "";
  return (
    <div
      data-block-id={b.id}
      data-block-type={b.type}
      className={cn("group/blk relative -mx-2 flex items-start gap-0.5 rounded-md px-2", pad, p.selected && "bg-primary/10 ring-1 ring-primary/30")}
      onPointerDown={p.onPointerDown}
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
      onDrop={p.onDrop}
    >
      {p.drop ? <div aria-hidden className={cn("pointer-events-none absolute inset-x-2 h-0.5 rounded bg-primary", p.drop === "before" ? "-top-px" : "-bottom-px")} /> : null}
      {editable ? (
        <div className={cn("flex shrink-0 select-none items-center opacity-0 transition-opacity group-hover/blk:opacity-100 group-focus-within/blk:opacity-100 max-sm:hidden", b.type === "h2" ? "mt-1.5" : b.type === "h3" ? "mt-0.5" : "mt-0.5", p.selected && "opacity-100")} contentEditable={false}>
          <button type="button" tabIndex={-1} aria-label={t("blk_add_below")} title={t("blk_add_below")} className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" onClick={p.onAdd}>
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            draggable
            aria-label={t("blk_handle")}
            title={t("blk_handle")}
            className="flex h-6 w-4 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
            onClick={p.onHandleClick}
            onDragStart={p.onDragStart}
            onDragEnd={p.onDragEnd}
          >
            <GripVertical className="size-4" />
          </button>
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <BlockBody {...p} />
      </div>
    </div>
  );
});

function BlockBody(p: RowProps) {
  const { block: b, t } = p;
  if (isText(b)) return <TextBody {...p} block={b} />;
  if (b.type === "code") return <CodeBody {...p} block={b} />;
  if (b.type === "hr")
    return (
      <button
        type="button"
        ref={p.register}
        aria-label={t("blk_t_hr")}
        className="block w-full py-3 outline-none"
        onKeyDown={(e) => keysOnObject(e, p)}
        onFocus={() => p.onFocus(0)}
        onBlur={p.onBlur}
        onClick={p.onSelect}
      >
        <hr className="border-t-2" />
      </button>
    );
  if (b.type === "media") return <MediaBody {...p} block={b} />;
  return <SourceBody {...p} block={b} />;
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
};

const TONE_STYLE: Record<Tone, string> = {
  note: "bg-sky-500/10 border-sky-500/30",
  tip: "bg-emerald-500/10 border-emerald-500/30",
  warning: "bg-amber-500/10 border-amber-500/40",
};

function TextBody(p: RowProps & { block: TextBlock }) {
  const { block: b, t, editable } = p;
  const ref = React.useRef<HTMLDivElement & { _spans?: Span[] }>(null);
  const composing = React.useRef(false);
  // Draw the spans unless they came from this element's own typing.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || composing.current) return;
    if (el._spans === b.spans) return;
    el._spans = b.spans;
    const html = spansToHtml(b.spans);
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [b.spans]);
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
        <select
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
        </select>
        <div className="relative min-w-0 flex-1">{editableEl}</div>
      </div>
    );
  }
  return <div className="relative">{editableEl}</div>;
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

function MediaBody(p: RowProps & { block: Extract<EBlock, { type: "media" }> & { pending?: string } }) {
  const { block: b, t, editable } = p;
  const name = decodeURIComponent(b.target.replace(/^asset:[a-z0-9]+\//i, "").split(/[?#]/)[0].split("/").pop() ?? "");
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name) || /^https?:/.test(b.target);
  const url = b.target ? (p.resolveFileUrl ? p.resolveFileUrl(b.target) : b.target) : "";
  return (
    <figure
      ref={p.register as React.Ref<HTMLElement>}
      tabIndex={0}
      className="group/media my-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onFocus={() => p.onFocus(0)}
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
        <div className="relative">
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
        <figcaption className="mt-1.5 flex items-center gap-2">
          <input
            aria-label={t("blk_alt")}
            title={t("blk_alt_hint")}
            value={b.alt}
            readOnly={!editable}
            placeholder={t("blk_alt_missing")}
            onChange={(e) => p.onChange({ ...b, alt: e.target.value }, `alt:${b.id}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                p.onExit("next");
              }
            }}
            className={cn("h-7 w-full rounded bg-transparent px-1 text-sm text-muted-foreground outline-none placeholder:text-amber-600/80 focus:bg-muted/60", !b.alt && "italic")}
          />
        </figcaption>
      ) : null}
    </figure>
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
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = above ? x - w / 2 : x;
    let top = above ? y - h - 8 : y + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (!above && top + h > window.innerHeight - 8) top = Math.max(8, y - h - 28);
    if (above && top < 8) top = y + 28;
    setPos({ left, top });
  }, [x, y, above]);
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
  onTurn: (type: TextType) => void;
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

function BlockMenu({
  t,
  at,
  block,
  count,
  onClose,
  onTurn,
  onDuplicate,
  onMove,
  onCopy,
  onDelete,
}: {
  t: T;
  at: { x: number; y: number };
  block: EBlock | undefined;
  count: number;
  onClose: () => void;
  onTurn: (type: TextType) => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, []);
  if (!block) return null;
  const mod = isApple() ? "⌘" : "Ctrl+";
  const item = (label: string, Icon: React.ComponentType<{ className?: string }>, run: () => void, keys?: string, danger?: boolean) => (
    <button role="menuitem" type="button" className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted", danger && "text-destructive")} onClick={run}>
      <Icon className="size-4" />
      <span className="grow text-left">{label}</span>
      {keys ? <kbd className="text-[11px] text-muted-foreground">{keys}</kbd> : null}
    </button>
  );
  return (
    <Floating x={at.x} y={at.y} className="w-60 p-1">
      <div
        ref={ref}
        role="menu"
        onKeyDown={(e) => {
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
          const i = items.indexOf(document.activeElement as HTMLElement);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {isText(block) && count === 1 ? (
          <>
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{t("blk_turn_into")}</div>
            {TURN_INTO.map((x) => (
              <React.Fragment key={x.type}>{item(t(x.label), x.icon, () => onTurn(x.type))}</React.Fragment>
            ))}
            <div className="my-1 h-px bg-border" />
          </>
        ) : null}
        {item(t("blk_duplicate"), CopyPlus, onDuplicate, `${mod}D`)}
        {item(t("blk_move_up"), MoveUp, () => onMove(-1), `${mod}⇧↑`)}
        {item(t("blk_move_down"), MoveDown, () => onMove(1), `${mod}⇧↓`)}
        {item(t("blk_copy_md"), Copy, onCopy, `${mod}C`)}
        <div className="my-1 h-px bg-border" />
        {item(count > 1 ? `${t("blk_delete")} (${count})` : t("blk_delete"), Trash2, onDelete, "Del", true)}
      </div>
    </Floating>
  );
}

/** Text of a block for screen readers and the outline. */
export { blockPlain };
