// agent-cms registry: cms-doc-editor (0.21.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Field widgets of the 0.21.0 content model: relations to other documents (a
// search dialog, keyboard picking, reordering), galleries (several files from
// the media library, reordered by dragging or Alt+arrows), rows (a list of
// small objects) and groups (an object shown as fields instead of JSON).
"use client";

import * as React from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, GripVertical, Link2, Plus, Search, X } from "lucide-react";
import type { RestClient } from "@mainsoft/agent-cms/client";

type DocSummary = Awaited<ReturnType<RestClient["list"]>>["docs"][number];
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AssetThumb, CmsMediaPicker } from "./cms-media-picker";
import { DIALOG, StateBadge } from "./cms-parts";
import { errorMessage } from "./cms-messages";
import { useAsset, useCms, useDebounced } from "./use-cms";

// ── shared: what the editor knows about related documents ────────────────────

/** A related document as the editor shows it. */
export interface RelatedLabel {
  id: string;
  collection: string;
  slug: string;
  title: string;
  status?: string | null;
}

/** id → label, filled by the editor (`?expand=`) and by picks; `remember` adds picks. */
export const RelatedLabels = React.createContext<{ labels: Record<string, RelatedLabel | null>; remember: (l: RelatedLabel) => void; /** The document being edited: never offered as its own relation. */ self?: string | null } | null>(null);

/** Move item `from` to `to` in a copy of `arr`. */
export function moved<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = [...arr];
  if (to < 0 || to >= next.length || from === to) return next;
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Alt+↑ / Alt+↓ on a row moves it (keyboard partner of dragging); Alt+← / Alt+→ as well (pictures in a row). */
function moveKeys(i: number, n: number, move: (from: number, to: number) => void) {
  return (e: React.KeyboardEvent) => {
    if (!e.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    // Alt+←/→ in a text box inside a row moves by words: only the item itself takes them.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target !== e.currentTarget) return;
    const to = e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : i + 1;
    if (to < 0 || to >= n) return;
    e.preventDefault();
    move(i, to);
  };
}

/** Rows that can be dragged into a new order (HTML drag and drop; Alt+arrows do the same). */
function useDragOrder(n: number, move: (from: number, to: number) => void) {
  const [from, setFrom] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<number | null>(null);
  const rowProps = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setFrom(i);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    },
    onDragOver: (e: React.DragEvent) => {
      if (from === null) return;
      e.preventDefault();
      setOver(i);
    },
    onDragEnd: () => (setFrom(null), setOver(null)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (from !== null && from !== i) move(from, i);
      setFrom(null);
      setOver(null);
    },
    "data-drop-target": over === i && from !== null && from !== i ? "" : undefined,
  });
  return { rowProps, dragging: from, n };
}

/**
 * A picker closed because the field became full: its "Add" button is then off or gone, so focus would fall to
 * the page. Call the returned function when that happens; once the dialog is gone, the last item gets focus
 * (where Alt+arrows reorder and Tab reaches its buttons).
 */
function useFocusLastWhenFull(open: boolean, listRef: React.RefObject<HTMLElement | null>) {
  const want = React.useRef(false);
  React.useEffect(() => {
    if (open || !want.current) return;
    let tries = 0;
    let timer = 0;
    const step = () => {
      const at = document.activeElement;
      // Still in the closing dialog (it keeps focus until its exit is done): look again shortly.
      if (at?.closest('[role="dialog"]') && ++tries < 40) return void (timer = window.setTimeout(step, 25));
      want.current = false;
      const items = listRef.current?.querySelectorAll<HTMLElement>(":scope > li[tabindex]");
      if (!at || at === document.body || (at instanceof HTMLButtonElement && at.disabled)) items?.[items.length - 1]?.focus();
    };
    timer = window.setTimeout(step, 0);
    return () => window.clearTimeout(timer);
  }, [open, listRef]);
  return React.useCallback(() => void (want.current = true), []);
}

// ── relation ─────────────────────────────────────────────────────────────────

export interface RelationSpec {
  key: string;
  label: string;
  collections: string[];
  many: boolean;
  max: number | null;
}

/** One or more documents of other collections, picked from a search dialog. */
export function RelationField({ spec, id, value, onChange, invalid, describedBy }: { spec: RelationSpec; id: string; value: unknown; onChange: (v: unknown) => void; invalid?: boolean; describedBy?: string }) {
  const { t, me } = useCms();
  const ctx = React.useContext(RelatedLabels);
  const ids = spec.many ? (Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === "string") : []) : typeof value === "string" && value ? [value] : [];
  const [open, setOpen] = React.useState(false);
  const [say, setSay] = React.useState("");
  const set = (next: string[]) => onChange(spec.many ? (next.length ? next : undefined) : (next[0] ?? undefined));
  const move = (a: number, b: number) => {
    set(moved(ids, a, b));
    setSay(t("rel_moved", { n: b + 1, total: ids.length }));
  };
  const drag = useDragOrder(ids.length, move);
  const full = spec.many && spec.max !== null && ids.length >= spec.max;
  const listRef = React.useRef<HTMLUListElement>(null);
  const focusLast = useFocusLastWhenFull(open, listRef);
  const colLabel = (c: string) => me?.collections.find((x) => x.slug === c)?.label ?? c;
  return (
    <div className={cn("rounded-md border border-input", invalid && "border-destructive")} aria-describedby={describedBy}>
      {ids.length ? (
        <ul ref={listRef} className="divide-y" aria-label={spec.label}>
          {ids.map((rid, i) => {
            const l = ctx?.labels[rid];
            const missing = l === null;
            return (
              <li key={rid} {...(spec.many ? drag.rowProps(i) : {})} tabIndex={spec.many ? 0 : undefined} onKeyDown={spec.many ? moveKeys(i, ids.length, move) : undefined} className="group flex min-h-9 items-center gap-2 px-2 py-1 text-sm outline-none focus-visible:bg-accent data-[drop-target]:border-t-2 data-[drop-target]:border-t-primary">
                {spec.many ? <GripVertical aria-hidden className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" /> : <Link2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", missing && "text-destructive line-through")}>{missing ? t("rel_missing") : (l?.title ?? rid)}</span>
                  {l ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {colLabel(l.collection)} · <span className="font-mono">{l.slug}</span>
                      {l.status && l.status !== "published" ? <> · {t(`state_${l.status}` as never)}</> : null}
                    </span>
                  ) : null}
                </span>
                {spec.many ? (
                  <span className="flex shrink-0 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("rel_move_up")} disabled={i === 0} onClick={() => move(i, i - 1)}>
                      <ArrowUp aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("rel_move_down")} disabled={i === ids.length - 1} onClick={() => move(i, i + 1)}>
                      <ArrowDown aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                ) : null}
                {!spec.many ? (
                  // One document: change it from the same line (no second row under it).
                  <Button type="button" variant="ghost" size="sm" id={id} className="h-7 shrink-0 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
                    {t("rel_change")}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t("rel_remove", { title: l?.title ?? rid })} onClick={() => set(ids.filter((x) => x !== rid))}>
                  <X aria-hidden className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {spec.many || !ids.length ? (
        <div className={cn("flex items-center gap-2 px-1 py-0.5", ids.length && "border-t")}>
          <Button type="button" variant="ghost" size="sm" id={id} className="h-8 gap-1.5 px-2 text-muted-foreground" disabled={full} onClick={() => setOpen(true)}>
            <Plus aria-hidden className="h-4 w-4" />
            {spec.many ? t("rel_add") : t("rel_choose")}
          </Button>
          {spec.many && spec.max !== null ? <span className="ml-auto pr-1 text-xs tabular-nums text-muted-foreground">{t("rel_count", { n: ids.length, max: spec.max })}</span> : null}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {say}
      </span>
      {open ? (
        <RelationPicker
          title={spec.label}
          collections={spec.collections}
          exclude={ctx?.self ? [...ids, ctx.self] : ids}
          onClose={() => setOpen(false)}
          onPick={(d) => {
            ctx?.remember({ id: d.id, collection: d.collection, slug: d.slug, title: d.title, status: d.status });
            set(spec.many ? [...ids, d.id] : [d.id]);
            if (spec.many && spec.max !== null && ids.length + 1 >= spec.max) focusLast();
            if (!spec.many || (spec.max !== null && ids.length + 1 >= spec.max)) setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Search documents of some collections and pick one (Enter), ↑/↓ to move. Several picks in a row for many-relations. */
export function RelationPicker({ title, collections, exclude = [], onPick, onClose }: { title: string; collections: string[]; exclude?: string[]; onPick: (d: DocSummary) => void; onClose: () => void }) {
  const { client, t, me } = useCms();
  const [q, setQ] = React.useState("");
  const [col, setCol] = React.useState(collections[0]);
  // Results belong to the search that asked for them (collection + text): an answer for an older search
  // is dropped, and while the current one is on its way nothing can be picked (Enter would pick a stale row).
  const [result, setResult] = React.useState<{ key: string; col: string; rows: DocSummary[]; error: string | null } | null>(null);
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const seq = React.useRef(0);
  const searchKey = `${col}\n${q}`;
  const load = useDebounced((c: string, text: string, key: string) => {
    const mine = ++seq.current;
    client.list(c, { q: text || undefined, limit: 30 }).then(
      (r) => {
        if (mine !== seq.current) return;
        setResult({ key, col: c, rows: r.docs, error: null });
        setActive(0);
      },
      (e) => {
        if (mine !== seq.current) return;
        setResult({ key, col: c, rows: [], error: errorMessage(e, t) });
      }
    );
  }, 150);
  React.useEffect(() => {
    // A new search: anything still on its way for the old one no longer counts.
    seq.current++;
    load(col, q, `${col}\n${q}`);
  }, [col, q, load]);
  const pending = result?.key !== searchKey;
  // While the next answer is on its way the last rows of the same collection stay (dimmed, not pickable).
  const kept = result && result.col === col ? result : null;
  const rows = kept ? kept.rows : null;
  const error = kept && !pending ? kept.error : null;
  const shown = (rows ?? []).filter((d) => !exclude.includes(d.id));
  // A pick takes its row out of the list: the highlight stays on a row that is still there.
  const cur = Math.max(0, Math.min(active, shown.length - 1));
  const pick = (d: DocSummary | undefined) => !pending && d && onPick(d);
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    // The search box takes focus, not the first collection tab: a dialog puts focus on the first thing it can
    // (the tabs, when there are several collections), and typing would then go nowhere.
    const id = window.requestAnimationFrame(() => (searchRef.current ?? document.querySelector<HTMLInputElement>(`[aria-controls="${listId}"]`))?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [listId]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn(DIALOG.md, "gap-3")}>
        <DialogHeader>
          <DialogTitle>{t("rel_pick_title", { field: title })}</DialogTitle>
          <DialogDescription>{t("rel_pick_help")}</DialogDescription>
        </DialogHeader>
        {collections.length > 1 ? (
          <div role="tablist" aria-label={t("rel_collection")} className="flex flex-wrap gap-1">
            {collections.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={c === col} tabIndex={c === col ? 0 : -1} onClick={() => setCol(c)}
                onKeyDown={(e) => {
                  // Arrow keys move between collections (a tab list), Enter/Space pick as a click does.
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const i = collections.indexOf(c) + (e.key === "ArrowRight" ? 1 : -1);
                  const next = collections[(i + collections.length) % collections.length];
                  setCol(next);
                  (e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-col="${next}"]`))?.focus();
                }}
                data-col={c} className={cn("rounded-md border px-2.5 py-1 text-xs transition-colors duration-150 ease-out", c === col ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent")}>
                {me?.collections.find((x) => x.slug === c)?.label ?? c}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={shown[cur] ? `${listId}-${shown[cur].id}` : undefined}
            aria-label={t("rel_search")}
            placeholder={t("rel_search")}
            className="h-9 pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // A Korean (or other IME) word still being composed: its Enter and arrows belong to the IME.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "ArrowDown") (e.preventDefault(), setActive(Math.min(cur + 1, shown.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setActive(Math.max(cur - 1, 0)));
              else if (e.key === "Enter") (e.preventDefault(), pick(shown[cur]));
            }}
          />
        </div>
        <ul id={listId} role="listbox" aria-label={t("rel_results")} aria-busy={pending || undefined} className="max-h-72 min-h-24 overflow-y-auto rounded-md border">
          {rows === null ? <li className="p-3 text-sm text-muted-foreground">{t("loading")}</li> : null}
          {error ? <li className="p-3 text-sm text-destructive">{error}</li> : null}
          {rows !== null && !pending && !error && !shown.length ? <li className="p-3 text-sm text-muted-foreground">{t("rel_none")}</li> : null}
          {shown.map((d, i) => (
            <li
              key={d.id}
              id={`${listId}-${d.id}`}
              role="option"
              aria-selected={i === cur}
              aria-disabled={pending || undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(d)}
              className={cn("flex items-center gap-2 px-3 py-2 text-sm transition-opacity duration-150 ease-out", pending ? "cursor-default opacity-60" : "cursor-pointer", i === cur && "bg-accent")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{d.title || d.slug}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{d.slug}</span>
              </span>
              <StateBadge className="shrink-0" state={d.state} />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

// ── gallery ──────────────────────────────────────────────────────────────────

function GalleryThumb({ id }: { id: string }) {
  const asset = useAsset(id);
  return asset ? <AssetThumb asset={asset} className="aspect-square w-full" /> : <span className="block aspect-square w-full rounded-md border bg-muted" />;
}

/** Several files from the media library, in order. */
export function GalleryField({ id, label, value, onChange, max, accept, store, field, invalid, describedBy }: { id: string; label: string; value: unknown; onChange: (v: unknown) => void; max: number | null; accept?: string[]; store?: string; field?: { collection: string; path: string }; invalid?: boolean; describedBy?: string }) {
  const { t, me } = useCms();
  const ids = Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const [open, setOpen] = React.useState(false);
  const [say, setSay] = React.useState("");
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  const move = (a: number, b: number) => {
    set(moved(ids, a, b));
    setSay(t("rel_moved", { n: b + 1, total: ids.length }));
  };
  const drag = useDragOrder(ids.length, move);
  const full = max !== null && ids.length >= max;
  const listRef = React.useRef<HTMLUListElement>(null);
  const focusLast = useFocusLastWhenFull(open, listRef);
  if (!me?.media) return <p className="text-xs text-muted-foreground">{t("gallery_no_media")}</p>;
  return (
    <div className={cn("rounded-md border border-input p-2", invalid && "border-destructive")} aria-describedby={describedBy}>
      <ul ref={listRef} className="flex flex-wrap gap-2" aria-label={label}>
        {ids.map((aid, i) => (
          <li key={aid} {...drag.rowProps(i)} tabIndex={0} onKeyDown={moveKeys(i, ids.length, move)} aria-label={t("gallery_item", { n: i + 1, total: ids.length })} className="group relative w-24 shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring data-[drop-target]:ring-2 data-[drop-target]:ring-primary">
            <GalleryThumb id={aid} />
            <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[11px] tabular-nums">{i + 1}</span>
            {/* Buttons show on hover and focus; on touch screens (no hover) they are always there. */}
            <button type="button" aria-label={t("gallery_remove", { n: i + 1 })} onClick={() => set(ids.filter((x) => x !== aid))} className="absolute right-1 top-1 rounded bg-background/80 p-1 opacity-0 transition-opacity duration-150 ease-out focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
            {ids.length > 1 ? (
              <span className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                <button type="button" aria-label={t("gallery_move_left", { n: i + 1 })} disabled={i === 0} onClick={() => move(i, i - 1)} className="rounded bg-background/80 p-1 disabled:invisible">
                  <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label={t("gallery_move_right", { n: i + 1 })} disabled={i === ids.length - 1} onClick={() => move(i, i + 1)} className="rounded bg-background/80 p-1 disabled:invisible">
                  <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : null}
          </li>
        ))}
        {!full ? (
          <li className="w-24 shrink-0">
            <button type="button" id={id} onClick={() => setOpen(true)} className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground transition-colors duration-150 ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Plus aria-hidden className="h-4 w-4" />
              {t("gallery_add")}
            </button>
          </li>
        ) : null}
      </ul>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{ids.length > 1 ? t("gallery_reorder_hint") : null}</span>
        {max !== null ? <span className="tabular-nums">{t("rel_count", { n: ids.length, max })}</span> : null}
      </div>
      <span className="sr-only" aria-live="polite">
        {say}
      </span>
      <CmsMediaPicker
        open={open}
        onOpenChange={setOpen}
        onPick={(a) => !ids.includes(a.id) && set([...ids, a.id])}
        many={{
          room: max === null ? null : Math.max(0, max - ids.length),
          taken: ids,
          onPick: (list) => {
            const fresh = list.map((a) => a.id).filter((x) => !ids.includes(x));
            if (!fresh.length) return;
            set([...ids, ...fresh]);
            setSay(t("gallery_added", { n: fresh.length, total: ids.length + fresh.length }));
            if (max !== null && ids.length + fresh.length >= max) focusLast();
          },
        }}
        kinds={accept?.every((x) => x.startsWith("image/")) ? ["image"] : undefined} accept={accept} store={store} field={field} />
    </div>
  );
}

// ── rows and groups ──────────────────────────────────────────────────────────

/** A sub-field of a row or group. */
export interface SubField {
  key: string;
  label: string;
  kind: "text" | "number" | "switch" | "select" | "textarea";
  options?: string[];
  required: boolean;
}

function SubInput({ f, id, value, onChange }: { f: SubField; id: string; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useCms();
  const cls = "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring";
  if (f.kind === "switch") return <input id={id} type="checkbox" className="h-4 w-4" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (f.kind === "select")
    return (
      <select id={id} className={cls} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{t("none")}</option>
        {(f.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  if (f.kind === "textarea") return <textarea id={id} rows={2} className={cn(cls, "h-auto py-1")} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
  return <input id={id} type={f.kind === "number" ? "number" : "text"} className={cls} value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : f.kind === "number" ? Number(e.target.value) : e.target.value)} />;
}

/** A list of small objects (menu items, specs): one line each when there are four fields or fewer, else folding cards. */
export function RowsField({ id, label, fields, value, onChange, invalid, describedBy }: { id: string; label: string; fields: SubField[]; value: unknown; onChange: (v: unknown) => void; invalid?: boolean; describedBy?: string }) {
  const { t } = useCms();
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]).map((r) => (r && typeof r === "object" ? r : {})) : [];
  const [openRow, setOpenRow] = React.useState<number | null>(null);
  const [say, setSay] = React.useState("");
  const set = (next: Record<string, unknown>[]) => onChange(next.length ? next : undefined);
  const move = (a: number, b: number) => {
    set(moved(rows, a, b));
    setSay(t("rel_moved", { n: b + 1, total: rows.length }));
  };
  const drag = useDragOrder(rows.length, move);
  const inline = fields.length <= 4;
  const setCell = (i: number, k: string, v: unknown) => {
    const next = rows.map((r) => ({ ...r }));
    if (v === undefined) delete next[i][k];
    else next[i][k] = v;
    set(next);
  };
  const title = (r: Record<string, unknown>, i: number) => String(r[fields[0]?.key] ?? "") || t("rows_item", { n: i + 1 });
  return (
    <div className={cn("rounded-md border border-input", invalid && "border-destructive")} aria-describedby={describedBy}>
      {inline && rows.length ? (
        <div className="hidden gap-2 border-b px-2 py-1 text-[11px] font-medium text-muted-foreground sm:grid" style={{ gridTemplateColumns: `1rem repeat(${fields.length}, minmax(0,1fr)) 4.5rem` }} aria-hidden>
          <span />
          {fields.map((f) => (
            <span key={f.key}>{f.label}</span>
          ))}
          <span />
        </div>
      ) : null}
      <ol aria-label={label} className="divide-y">
        {rows.map((r, i) => (
          <li key={i} {...drag.rowProps(i)} onKeyDown={moveKeys(i, rows.length, move)} className="group px-2 py-1.5 data-[drop-target]:border-t-2 data-[drop-target]:border-t-primary">
            {inline ? (
              <div className="grid items-center gap-2 sm:[grid-template-columns:var(--cols)]" style={{ ["--cols" as string]: `1rem repeat(${fields.length}, minmax(0,1fr)) 4.5rem` }} role="group" aria-label={t("rows_item", { n: i + 1 })}>
                <GripVertical aria-hidden className="hidden h-4 w-4 cursor-grab text-muted-foreground sm:block" />
                {fields.map((f) => (
                  <label key={f.key} className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground sm:sr-only">{f.label}</span>
                    <SubInput f={f} id={`${id}-${i}-${f.key}`} value={r[f.key]} onChange={(v) => setCell(i, f.key, v)} />
                  </label>
                ))}
                <RowButtons i={i} n={rows.length} move={move} remove={() => set(rows.filter((_, j) => j !== i))} />
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-1">
                  <GripVertical aria-hidden className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
                  <button type="button" aria-expanded={openRow === i} onClick={() => setOpenRow(openRow === i ? null : i)} className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    {openRow === i ? <ChevronDown aria-hidden className="h-4 w-4 shrink-0" /> : <ChevronRight aria-hidden className="h-4 w-4 shrink-0" />}
                    <span className="truncate">{title(r, i)}</span>
                  </button>
                  <RowButtons i={i} n={rows.length} move={move} remove={() => set(rows.filter((_, j) => j !== i))} />
                </div>
                {openRow === i ? (
                  <div className="grid gap-2 py-2 pl-6 sm:grid-cols-2">
                    {fields.map((f) => (
                      <label key={f.key} className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">{f.label}</span>
                        <SubInput f={f} id={`${id}-${i}-${f.key}`} value={r[f.key]} onChange={(v) => setCell(i, f.key, v)} />
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className={cn("px-2 py-1.5", rows.length && "border-t")}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          id={id}
          className="h-8 gap-1.5 px-2 text-muted-foreground"
          onClick={() => {
            set([...rows, {}]);
            if (!inline) setOpenRow(rows.length);
          }}
        >
          <Plus aria-hidden className="h-4 w-4" />
          {t("rows_add")}
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {say}
      </span>
    </div>
  );
}

function RowButtons({ i, n, move, remove }: { i: number; n: number; move: (a: number, b: number) => void; remove: () => void }) {
  const { t } = useCms();
  return (
    <span className="flex shrink-0 justify-end">
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("rel_move_up")} disabled={i === 0} onClick={() => move(i, i - 1)}>
        <ArrowUp aria-hidden className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("rel_move_down")} disabled={i === n - 1} onClick={() => move(i, i + 1)}>
        <ArrowDown aria-hidden className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("rows_remove", { n: i + 1 })} onClick={remove}>
        <X aria-hidden className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

/** An object field shown as its own small fields. */
export function GroupField({ id, fields, value, onChange }: { id: string; fields: SubField[]; value: unknown; onChange: (v: unknown) => void }) {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return (
    <div className="grid gap-2 rounded-md border border-input p-2 sm:grid-cols-2">
      {fields.map((f) => (
        <label key={f.key} className={cn("flex min-w-0 flex-col gap-0.5", f.kind === "textarea" && "sm:col-span-2")}>
          <span className="text-xs text-muted-foreground">{f.label}</span>
          <SubInput
            f={f}
            id={`${id}-${f.key}`}
            value={obj[f.key]}
            onChange={(v) => {
              const next = { ...obj };
              if (v === undefined) delete next[f.key];
              else next[f.key] = v;
              onChange(Object.keys(next).length ? next : undefined);
            }}
          />
        </label>
      ))}
    </div>
  );
}
