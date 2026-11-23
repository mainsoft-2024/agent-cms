// agent-cms registry: cms-doc-list (0.21.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Screens of the 0.21.0 content model that sit around the list and the editor:
// the document tree (drag, or the keyboard), templates for new documents
// (pick, save, manage), the "documents point here" check before deleting, the
// one document of a single collection, the documents that use a snippet, the
// SEO panel, and the confirmation for changing a published address.
"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, FileText, GripVertical, LayoutTemplate, Link2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { DocRefView, TemplateView, TreeNodeView } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { DIALOG } from "./cms-parts";
import { useAsync, useCms, type DocContent } from "./use-cms";

// ── tree ─────────────────────────────────────────────────────────────────────

type Flat = { node: TreeNodeView; depth: number; parent: TreeNodeView | null; index: number; siblings: TreeNodeView[] };

function flatten(nodes: TreeNodeView[], open: Set<string>, depth = 0, parent: TreeNodeView | null = null, out: Flat[] = []): Flat[] {
  nodes.forEach((node, index) => {
    out.push({ node, depth, parent, index, siblings: nodes });
    if (node.children.length && open.has(node.id)) flatten(node.children, open, depth + 1, node, out);
  });
  return out;
}
function findFlat(nodes: TreeNodeView[], id: string, depth = 0, parent: TreeNodeView | null = null): Flat | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, depth, parent, index: i, siblings: nodes };
    const hit = findFlat(n.children, id, depth + 1, n);
    if (hit) return hit;
  }
  return null;
}
const contains = (n: TreeNodeView, id: string): boolean => n.id === id || n.children.some((c) => contains(c, id));

/**
 * The documents of a tree collection, nested. Drag a row onto another (above, inside, below), or
 * use the keyboard: Alt+↑ ↓ change the order, Alt+→ puts a document under the one above it, Alt+← takes it out.
 */
export function CmsTreeView({ collection, canWrite, maxDepth, onOpen, hrefFor }: { collection: string; canWrite: boolean; maxDepth: number; onOpen?: (slug: string) => void; hrefFor?: (slug: string) => string }) {
  const { client, t, toast } = useCms();
  const q = useAsync(() => client.tree(collection, { draft: true }), [client, collection]);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [say, setSay] = React.useState("");
  const [drag, setDrag] = React.useState<{ id: string; over: string | null; where: "before" | "inside" | "after" } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const tree = q.data ?? [];
  // Everything open the first time.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !q.data) return;
    seeded.current = true;
    const all = new Set<string>();
    const walk = (ns: TreeNodeView[]) => ns.forEach((n) => (n.children.length && all.add(n.id), walk(n.children)));
    walk(q.data);
    setOpen(all);
  }, [q.data]);
  const rows = flatten(tree, open);
  const refs = React.useRef(new Map<string, HTMLDivElement>());
  React.useEffect(() => {
    if (focusId) refs.current.get(focusId)?.focus();
  }, [focusId, q.data]);

  const move = async (id: string, parentId: string | null, before: string | null, label: string) => {
    if (busy) return;
    setBusy(true);
    const f = findFlat(tree, id);
    try {
      await client.move(collection, f!.node.slug, { parentId, before });
      if (parentId) setOpen((o) => new Set(o).add(parentId));
      q.reload();
      setFocusId(id);
      setSay(label);
    } catch (e) {
      toast(errorMessage(e, t), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  /** Place `id` relative to `target`. */
  const dropAt = (id: string, target: string, where: "before" | "inside" | "after") => {
    const tf = findFlat(tree, target);
    const me = findFlat(tree, id);
    if (!tf || !me || id === target || contains(me.node, target)) return;
    if (where === "inside") return void move(id, tf.node.id, null, t("tree_moved_inside", { title: me.node.title, parent: tf.node.title }));
    const sibs = tf.siblings.filter((s) => s.id !== id);
    const at = sibs.findIndex((s) => s.id === target);
    const before = where === "before" ? target : (sibs[at + 1]?.id ?? null);
    void move(id, tf.parent?.id ?? null, before, t("tree_moved", { title: me.node.title, n: (where === "before" ? at : at + 1) + 1, total: sibs.length + 1 }));
  };

  /** The four moves of a row (Alt+arrows and the row menu): null when not possible from where it is. */
  const movesOf = (r: Flat) => {
    const n = r.node;
    return {
      up: r.index > 0 ? () => void move(n.id, r.parent?.id ?? null, r.siblings[r.index - 1].id, t("tree_moved", { title: n.title, n: r.index, total: r.siblings.length })) : null,
      down: r.index < r.siblings.length - 1 ? () => void move(n.id, r.parent?.id ?? null, r.siblings[r.index + 2]?.id ?? null, t("tree_moved", { title: n.title, n: r.index + 2, total: r.siblings.length })) : null,
      in:
        r.index > 0 && r.depth + 1 < maxDepth
          ? () => {
              const p = r.siblings[r.index - 1];
              void move(n.id, p.id, null, t("tree_moved_inside", { title: n.title, parent: p.title }));
            }
          : null,
      out: r.parent
        ? () => {
            const up = findFlat(tree, r.parent!.id)!;
            void move(n.id, up.parent?.id ?? null, up.siblings[up.index + 1]?.id ?? null, t("tree_moved_out", { title: n.title }));
          }
        : null,
    };
  };

  const onKey = (e: React.KeyboardEvent, r: Flat, i: number) => {
    const n = r.node;
    if (e.altKey && canWrite) {
      const m = movesOf(r);
      if (e.key === "ArrowUp" && m.up) return e.preventDefault(), m.up();
      if (e.key === "ArrowDown" && m.down) return e.preventDefault(), m.down();
      if (e.key === "ArrowRight" && r.index > 0) {
        e.preventDefault();
        if (!m.in) return void setSay(t("tree_too_deep", { max: maxDepth }));
        return m.in();
      }
      if (e.key === "ArrowLeft" && m.out) return e.preventDefault(), m.out();
    }
    if (e.key === "ArrowDown") (e.preventDefault(), rows[i + 1] && setFocusId(rows[i + 1].node.id));
    else if (e.key === "ArrowUp") (e.preventDefault(), rows[i - 1] && setFocusId(rows[i - 1].node.id));
    else if (e.key === "ArrowRight" && n.children.length) {
      e.preventDefault();
      if (!open.has(n.id)) setOpen((o) => new Set(o).add(n.id));
      else setFocusId(n.children[0].id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (n.children.length && open.has(n.id)) setOpen((o) => (o.delete(n.id), new Set(o)));
      else if (r.parent) setFocusId(r.parent.id);
    } else if (e.key === "Enter") (e.preventDefault(), onOpen?.(n.slug));
    else if (e.key === "Home") (e.preventDefault(), rows[0] && setFocusId(rows[0].node.id));
    else if (e.key === "End") (e.preventDefault(), rows.length && setFocusId(rows[rows.length - 1].node.id));
  };

  if (q.error) return <p className="p-6 text-sm text-destructive">{errorMessage(q.error, t)}</p>;
  if (!q.data) return <p className="p-6 text-sm text-muted-foreground">{t("loading")}</p>;
  if (!tree.length) return <p className="p-6 text-sm text-muted-foreground">{t("tree_empty")}</p>;
  const current = focusId ?? rows[0]?.node.id;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canWrite ? <p className="border-b px-4 py-1.5 text-xs text-muted-foreground md:px-6">{t("tree_hint")}</p> : null}
      <div role="tree" aria-label={t("tree_label")} aria-busy={busy || undefined} className="flex-1 py-1">
        {rows.map((r, i) => {
          const n = r.node;
          const over = drag?.over === n.id ? drag.where : null;
          return (
            <div
              key={n.id}
              ref={(el) => void (el ? refs.current.set(n.id, el) : refs.current.delete(n.id))}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-setsize={r.siblings.length}
              aria-posinset={r.index + 1}
              aria-expanded={n.children.length ? open.has(n.id) : undefined}
              aria-selected={current === n.id}
              tabIndex={current === n.id ? 0 : -1}
              draggable={canWrite}
              onFocus={() => setFocusId(n.id)}
              onKeyDown={(e) => onKey(e, r, i)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", n.slug);
                setDrag({ id: n.id, over: null, where: "after" });
              }}
              onDragOver={(e) => {
                if (!drag || drag.id === n.id) return;
                const me = findFlat(tree, drag.id);
                if (me && contains(me.node, n.id)) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                const y = (e.clientY - box.top) / box.height;
                const where = y < 0.28 ? "before" : y > 0.72 ? "after" : r.depth + 1 < maxDepth ? "inside" : y < 0.5 ? "before" : "after";
                if (drag.over !== n.id || drag.where !== where) setDrag({ ...drag, over: n.id, where });
              }}
              onDragLeave={() => drag?.over === n.id && setDrag({ ...drag, over: null })}
              onDrop={(e) => {
                e.preventDefault();
                if (drag?.over) dropAt(drag.id, drag.over, drag.where);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
              className={cn(
                "group relative flex h-9 items-center gap-1 pr-3 text-sm outline-none focus-visible:bg-accent",
                over === "inside" && "bg-primary/10 ring-1 ring-inset ring-primary",
                drag?.id === n.id && "opacity-50"
              )}
              style={{ paddingLeft: `${12 + r.depth * 20}px` }}
            >
              {over === "before" ? <span aria-hidden className="absolute inset-x-2 top-0 h-0.5 bg-primary" /> : null}
              {over === "after" ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 bg-primary" /> : null}
              {canWrite ? <GripVertical aria-hidden className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100" /> : null}
              {n.children.length ? (
                <button type="button" tabIndex={-1} aria-hidden className="rounded p-0.5 text-muted-foreground hover:bg-accent" onClick={() => setOpen((o) => (o.has(n.id) ? (o.delete(n.id), new Set(o)) : new Set(o).add(n.id)))}>
                  {open.has(n.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              ) : (
                <span className="w-[18px] shrink-0" />
              )}
              <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <a
                href={hrefFor?.(n.slug)}
                tabIndex={-1}
                onClick={(e) => {
                  if (!onOpen || e.metaKey || e.ctrlKey || e.button !== 0) return;
                  e.preventDefault();
                  onOpen(n.slug);
                }}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {n.title || n.slug}
              </a>
              {n.children.length ? <span className="text-xs tabular-nums text-muted-foreground">{n.children.length}</span> : null}
              <span className={cn("ml-2 shrink-0 rounded px-1.5 py-0.5 text-[11px]", n.published ? "text-green-700 dark:text-green-400" : "bg-muted text-muted-foreground")}>{n.published ? t("state_published") : t(`state_${n.status}` as never)}</span>
              {canWrite ? <TreeRowMenu title={n.title || n.slug} moves={movesOf(r)} disabled={busy} /> : null}
            </div>
          );
        })}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {say}
      </span>
    </div>
  );
}

/**
 * The moves of a tree row as a menu, for touch screens (no Alt key, dragging is unreliable) and for mouse users.
 * Always shown without hover; on hover/focus otherwise. Keys inside it stay inside it (the row's arrows would move focus).
 */
function TreeRowMenu({ title, moves, disabled }: { title: string; moves: Record<"up" | "down" | "in" | "out", (() => void) | null>; disabled?: boolean }) {
  const { t } = useCms();
  const items: [keyof typeof moves, string][] = [
    ["up", t("tree_move_up")],
    ["down", t("tree_move_down")],
    ["in", t("tree_move_in")],
    ["out", t("tree_move_out")],
  ];
  return (
    <span className="ml-1 shrink-0" onKeyDown={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            draggable={false}
            aria-label={t("tree_row_menu", { title })}
            disabled={disabled}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontal aria-hidden className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map(([k, label]) => (
            <DropdownMenuItem key={k} disabled={!moves[k]} onClick={() => moves[k]?.()}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

// ── templates ────────────────────────────────────────────────────────────────

const TEMPLATE_KEY = (c: string) => `agent-cms:template:${c}`;
/** The template picked for the next new document of a collection (the editor takes it once). */
export function chooseTemplate(collection: string, t: TemplateView | null) {
  try {
    if (t) window.sessionStorage.setItem(TEMPLATE_KEY(collection), JSON.stringify(t));
    else window.sessionStorage.removeItem(TEMPLATE_KEY(collection));
  } catch {
    /* private mode */
  }
}
export function takeTemplate(collection: string): TemplateView | null {
  try {
    const key = TEMPLATE_KEY(collection);
    const raw = window.sessionStorage.getItem(key);
    // Forgotten a moment later, not now: React's StrictMode runs the editor's effect twice in a row,
    // and the second run (after the first one's content was reset) must still find the template.
    if (raw)
      setTimeout(() => {
        try {
          if (window.sessionStorage.getItem(key) === raw) window.sessionStorage.removeItem(key);
        } catch {
          /* private mode */
        }
      }, 0);
    return raw ? (JSON.parse(raw) as TemplateView) : null;
  } catch {
    return null;
  }
}
/** A new document's content from a template (the editor leaves out values the schema no longer takes, see `fitsSchema`). */
export function contentFromTemplate(tpl: TemplateView): Partial<DocContent> {
  return { title: tpl.title ?? "", summary: tpl.summary ?? "", body: tpl.body ?? "", fields: { ...(tpl.fields ?? {}) } };
}

/**
 * Whether a template value still fits a field of the collection's JSON Schema: the field exists, the basic
 * JSON type matches and, with an `enum`, the value is one of them. Anything more involved (`anyOf`, `$ref`,
 * formats, lengths) is left to the server's check on save.
 */
export function fitsSchema(prop: unknown, value: unknown, exists = prop !== undefined): boolean {
  if (!exists) return false;
  if (!prop || typeof prop !== "object") return true;
  const p = prop as { type?: string | string[]; enum?: unknown[] };
  if (Array.isArray(p.enum) && !p.enum.some((x) => x === value)) return false;
  if (p.type === undefined) return true;
  const kind = (t: string) =>
    t === "null" ? value === null : t === "string" ? typeof value === "string" : t === "boolean" ? typeof value === "boolean" : t === "integer" ? Number.isInteger(value) : t === "number" ? typeof value === "number" && Number.isFinite(value) : t === "array" ? Array.isArray(value) : t === "object" ? !!value && typeof value === "object" && !Array.isArray(value) : true;
  return (Array.isArray(p.type) ? p.type : [p.type]).some(kind);
}

/** "New document": start empty or from a template. Templates made in the admin can be renamed and deleted here. */
export function TemplatePicker({ collection, onPick, onClose }: { collection: string; onPick: (t: TemplateView | null) => void; onClose: () => void }) {
  const { client, t, me, toast } = useCms();
  const q = useAsync(() => client.templates(collection), [client, collection]);
  const [manage, setManage] = React.useState(false);
  const [rename, setRename] = React.useState<{ id: string; label: string } | null>(null);
  const list = q.data ?? [];
  const code = list.filter((x) => x.source !== "admin");
  const mine = list.filter((x) => x.source === "admin");
  const card = (tpl: TemplateView | null) => (
    <li key={tpl?.key ?? "__blank"}>
      <button type="button" onClick={() => onPick(tpl)} className="flex h-full w-full flex-col gap-1 rounded-md border p-3 text-left transition-colors duration-150 ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex items-center gap-2 text-sm font-medium">
          {tpl ? <LayoutTemplate aria-hidden className="h-4 w-4 text-muted-foreground" /> : <FileText aria-hidden className="h-4 w-4 text-muted-foreground" />}
          {tpl ? tpl.label : t("tpl_blank")}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{tpl ? (tpl.description ?? tpl.summary ?? (tpl.source === "admin" && tpl.createdBy ? t("tpl_by", { name: tpl.createdBy }) : "")) : t("tpl_blank_help")}</span>
      </button>
    </li>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.lg}>
        <DialogHeader>
          <DialogTitle>{manage ? t("tpl_manage") : t("tpl_new_title")}</DialogTitle>
          <DialogDescription>{manage ? t("tpl_manage_help") : t("tpl_new_help")}</DialogDescription>
        </DialogHeader>
        {q.error ? <p className="text-sm text-destructive">{errorMessage(q.error, t)}</p> : null}
        {!manage ? (
          <div className="grid gap-4">
            <section aria-labelledby="tpl-code">
              <h3 id="tpl-code" className="mb-2 text-xs font-medium text-muted-foreground">
                {t("tpl_group_code")}
              </h3>
              <ul className="grid gap-2 sm:grid-cols-2">{[card(null), ...code.map(card)]}</ul>
            </section>
            {mine.length ? (
              <section aria-labelledby="tpl-admin">
                <h3 id="tpl-admin" className="mb-2 text-xs font-medium text-muted-foreground">
                  {t("tpl_group_admin")}
                </h3>
                <ul className="grid gap-2 sm:grid-cols-2">{mine.map(card)}</ul>
              </section>
            ) : null}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 font-medium">{t("tpl_name")}</th>
                <th className="py-1.5 font-medium">{t("tpl_maker")}</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {mine.map((x) => {
                const may = me?.isAdmin || x.createdBy === me?.actor.label;
                return (
                  <tr key={x.key} className="border-b last:border-0">
                    <td className="py-1.5">{rename?.id === x.id ? <Input aria-label={t("tpl_name")} autoFocus className="h-8" value={rename?.label ?? ""} onChange={(e) => setRename({ id: x.id!, label: e.target.value })} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.currentTarget.nextSibling as HTMLElement | null)?.click?.())} /> : x.label}</td>
                    <td className="py-1.5 text-muted-foreground">{x.createdBy ?? ""}</td>
                    <td className="py-1.5 text-right">
                      {may ? (
                        rename?.id === x.id ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() =>
                              client.updateTemplate(collection, x.id!, { label: rename?.label ?? x.label }).then(
                                () => (setRename(null), q.reload()),
                                (e) => toast(errorMessage(e, t), { tone: "error" })
                              )
                            }
                          >
                            {t("save")}
                          </Button>
                        ) : (
                          <>
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("tpl_rename", { name: x.label })} onClick={() => setRename({ id: x.id!, label: x.label })}>
                              <Pencil aria-hidden className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive"
                              aria-label={t("tpl_delete", { name: x.label })}
                              onClick={() =>
                                client.removeTemplate(collection, x.id!).then(
                                  () => (toast(t("tpl_deleted", { name: x.label }), { tone: "ok" }), q.reload()),
                                  (e) => toast(errorMessage(e, t), { tone: "error" })
                                )
                              }
                            >
                              <Trash2 aria-hidden className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {!mine.length ? (
                <tr>
                  <td colSpan={3} className="py-3 text-muted-foreground">
                    {t("tpl_none_admin")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setManage((v) => !v)}>
            {manage ? t("back") : t("tpl_manage")}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Save as template" from the editor: the body as it is or only its headings, the field values, the summary. */
export function SaveTemplateDialog({ collection, content, onClose }: { collection: string; content: DocContent; onClose: () => void }) {
  const { client, t, toast } = useCms();
  const [label, setLabel] = React.useState(content.title ? t("tpl_default_name", { title: content.title }) : "");
  const [description, setDescription] = React.useState("");
  const [bodyMode, setBodyMode] = React.useState<"full" | "headings">("headings");
  const [withFields, setWithFields] = React.useState(true);
  const [withSummary, setWithSummary] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const headings = content.body
    .split("\n")
    .filter((l) => /^#{2,3}\s/.test(l))
    .join("\n\n");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.md}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            client
              .saveTemplate(collection, { label: label.trim(), description: description.trim() || undefined, body: bodyMode === "full" ? content.body : headings, fields: withFields ? content.fields : undefined, summary: withSummary ? content.summary : undefined })
              .then(
                (tpl) => (toast(t("tpl_saved", { name: tpl.label }), { tone: "ok" }), onClose()),
                (err) => (setBusy(false), setError(errorMessage(err, t)))
              );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("tpl_save_title")}</DialogTitle>
            <DialogDescription>{t("tpl_save_help")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="tpl-name">{t("tpl_name")}</Label>
            <Input id="tpl-name" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tpl-desc">{t("tpl_description")}</Label>
            <Textarea id="tpl-desc" rows={2} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("tpl_keep")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="tpl-body" checked={bodyMode === "headings"} onChange={() => setBodyMode("headings")} />
              {t("tpl_body_headings")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="tpl-body" checked={bodyMode === "full"} onChange={() => setBodyMode("full")} />
              {t("tpl_body_full")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withFields} onChange={(e) => setWithFields(e.target.checked)} />
              {t("tpl_with_fields")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withSummary} onChange={(e) => setWithSummary(e.target.checked)} />
              {t("tpl_with_summary")}
            </label>
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !label.trim()}>
              {t("tpl_save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── documents that point here ────────────────────────────────────────────────

/** Before deleting a document others point at: the list, and "delete anyway". */
export function ReferencedDialog({ collection, slug, title, onDone, onClose }: { collection: string; slug: string; title: string; onDone: () => void; onClose: () => void }) {
  const { client, t, me } = useCms();
  const q = useAsync(() => client.referencedBy(collection, slug), [client, collection, slug]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const refs: DocRefView[] = q.data ?? [];
  const hidden = refs.filter((r) => !r.id).length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.md} role="alertdialog">
        <DialogHeader>
          <DialogTitle>{t("refs_title", { title })}</DialogTitle>
          <DialogDescription>{t("refs_help", { n: refs.length })}</DialogDescription>
        </DialogHeader>
        <ul className="grid max-h-64 gap-1 overflow-y-auto" aria-label={t("refs_list")}>
          {refs
            .filter((r) => r.id)
            .map((r) => (
              <li key={`${r.collection}/${r.slug}`} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <Link2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.title || r.slug}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {me?.collections.find((c) => c.slug === r.collection)?.label ?? r.collection} · {r.fields.join(", ")}
                  </span>
                </span>
              </li>
            ))}
          {hidden ? <li className="px-3 py-1 text-xs text-muted-foreground">{t("refs_hidden", { n: hidden })}</li> : null}
        </ul>
        <p className="text-xs text-muted-foreground">{t("refs_after")}</p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              client.remove(collection, slug, undefined, { force: true }).then(
                () => onDone(),
                (e) => (setBusy(false), setError(errorMessage(e, t)))
              );
            }}
          >
            {t("refs_delete_anyway")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── snippets ─────────────────────────────────────────────────────────────────

/** Beside a snippet in the editor: the documents that show it. */
export function SnippetUses({ collection, slug, onOpen }: { collection: string; slug: string; onOpen?: (collection: string, slug: string) => void }) {
  const { client, t, me } = useCms();
  const q = useAsync(() => client.snippetUses(collection, slug), [client, collection, slug]);
  // The count only once the list arrived: "Used in 0 documents" while loading or after a failure would be wrong.
  const ok = !q.loading && !q.error && !!q.data;
  const docs = ok ? q.data! : [];
  return (
    <section aria-labelledby="snippet-uses" aria-busy={q.loading || undefined} className="rounded-md border p-3">
      <h3 id="snippet-uses" className="mb-1 text-sm font-medium">
        {ok ? t("snip_uses_title", { n: docs.length }) : t("snip_uses_title_plain")}
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("snip_token")} <code className="rounded bg-muted px-1 font-mono">{`[[snippet:${slug}]]`}</code>
      </p>
      {q.loading ? <p className="text-xs text-muted-foreground">{t("loading")}</p> : null}
      {!q.loading && q.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{t("snip_uses_failed", { error: errorMessage(q.error, t) })}</span>
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={q.reload}>
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {ok && !docs.length ? <p className="text-xs text-muted-foreground">{t("snip_uses_none")}</p> : null}
      <ul className="grid gap-1">
        {docs.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onOpen?.(d.collection, d.slug)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{d.title || d.slug}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{me?.collections.find((c) => c.slug === d.collection)?.label ?? d.collection}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{t("snip_uses_note")}</p>
    </section>
  );
}

// ── SEO ──────────────────────────────────────────────────────────────────────

export type SeoValue = { title?: string | null; description?: string | null; image?: string | null; canonical?: string | null; noindex?: boolean };

/** Search title, description, share image, canonical and noindex, with a search result and a share card preview. */
export function SeoPanel({ value, onChange, fallback, limits, url, disabled, idPrefix = "cms-seo", descriptionAddon }: { value: SeoValue | null | undefined; onChange: (v: SeoValue | null) => void; fallback: { title: string; description: string; image: string | null }; limits: { titleMax: number; descriptionMax: number }; url: string | null; disabled?: boolean; idPrefix?: string; descriptionAddon?: React.ReactNode }) {
  const { t, client } = useCms();
  const v = value ?? {};
  const set = (k: keyof SeoValue, x: unknown) => {
    const next = { ...v, [k]: x === "" ? undefined : x };
    for (const key of Object.keys(next) as (keyof SeoValue)[]) if (next[key] === undefined || next[key] === false) delete next[key];
    onChange(Object.keys(next).length ? next : null);
  };
  const title = v.title || fallback.title;
  const desc = v.description || fallback.description;
  const image = v.image || fallback.image;
  const imgSrc = image ? (/^asset:([a-z0-9]{12})(?:\/(.*))?$/.exec(image) ? (() => { const m = /^asset:([a-z0-9]{12})(?:\/(.*))?$/.exec(image)!; return client.fileUrl({ id: m[1], name: m[2] ? decodeURIComponent(m[2]) : "file" }); })() : image) : null;
  const counter = (n: number, max: number) => <span className={cn("tabular-nums", n > max ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{t("seo_count", { n, max })}</span>;
  return (
    <section aria-labelledby={`${idPrefix}-h`} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <h3 id={`${idPrefix}-h`} className="sr-only">
        {t("seo_title")}
      </h3>
      <fieldset disabled={disabled} className="grid min-w-0 gap-3">
        <div className="grid gap-1">
          <div className="flex items-center justify-between text-xs">
            <Label htmlFor={`${idPrefix}-title`} className="text-xs font-medium text-muted-foreground">
              {t("seo_field_title")}
            </Label>
            {counter(title.length, limits.titleMax)}
          </div>
          <Input id={`${idPrefix}-title`} placeholder={fallback.title} value={v.title ?? ""} onChange={(e) => set("title", e.target.value)} />
        </div>
        <div className="grid gap-1">
          <div className="flex items-center justify-between text-xs">
            <Label htmlFor={`${idPrefix}-desc`} className="text-xs font-medium text-muted-foreground">
              {t("seo_field_description")}
            </Label>
            {counter(desc.length, limits.descriptionMax)}
          </div>
          <Textarea id={`${idPrefix}-desc`} rows={3} placeholder={fallback.description || t("seo_description_empty")} value={v.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          {descriptionAddon ? <div className="flex flex-wrap gap-2">{descriptionAddon}</div> : null}
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-image`} className="text-xs font-medium text-muted-foreground">
            {t("seo_field_image")}
          </Label>
          <Input id={`${idPrefix}-image`} placeholder={fallback.image ?? "asset:… / https://…"} value={v.image ?? ""} onChange={(e) => set("image", e.target.value)} className="font-mono text-xs" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-canonical`} className="text-xs font-medium text-muted-foreground">
            {t("seo_field_canonical")}
          </Label>
          <Input id={`${idPrefix}-canonical`} placeholder="https://…" value={v.canonical ?? ""} onChange={(e) => set("canonical", e.target.value)} className="font-mono text-xs" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!v.noindex} onChange={(e) => set("noindex", e.target.checked)} />
          {t("seo_noindex")}
        </label>
      </fieldset>
      <div className="grid min-w-0 content-start gap-3">
        <figure className="rounded-md border p-3">
          <figcaption className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("seo_preview_search")}</figcaption>
          <p className="truncate text-xs text-muted-foreground">{url ?? "/"}</p>
          <p className="line-clamp-1 text-base text-blue-700 dark:text-blue-400">{title || t("untitled")}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{desc || t("seo_description_empty")}</p>
        </figure>
        <figure className="overflow-hidden rounded-md border">
          <figcaption className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">{t("seo_preview_share")}</figcaption>
          <div className="mt-2 aspect-[1200/630] w-full bg-muted">{imgSrc ? <img src={imgSrc} alt="" className="h-full w-full object-cover" /> : null}</div>
          <div className="p-3">
            <p className="line-clamp-1 text-sm font-medium">{title || t("untitled")}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">{desc}</p>
          </div>
        </figure>
      </div>
    </section>
  );
}

// ── changing a published address ─────────────────────────────────────────────

/**
 * Asked when a published document is saved or published under a new address: the address changes only
 * when publishing, and the old one will redirect. The button publishes; without the right to publish it is off.
 */
export function SlugChangeDialog({ from, to, canPublish = true, onConfirm, onClose }: { from: string; to: string; canPublish?: boolean; onConfirm: () => void; onClose: () => void }) {
  const { t } = useCms();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.md} role="alertdialog">
        <DialogHeader>
          <DialogTitle>{t("slug_change_title")}</DialogTitle>
          <DialogDescription>{t("slug_change_help")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 rounded-md border p-3 font-mono text-xs">
          <span className="text-muted-foreground line-through">{from}</span>
          <span>→ {to}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t("slug_change_note")}</p>
        {canPublish ? null : (
          <p id="cms-slug-change-cannot" className="text-xs text-amber-700 dark:text-amber-400">
            {t("slug_change_cannot_publish")}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus={!canPublish} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="button" autoFocus={canPublish} disabled={!canPublish} aria-describedby={canPublish ? undefined : "cms-slug-change-cannot"} onClick={onConfirm}>
            {t("slug_change_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
