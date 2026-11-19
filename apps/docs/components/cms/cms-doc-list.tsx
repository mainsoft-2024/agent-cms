// agent-cms registry: cms-doc-list (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Documents of one collection: state tabs with counts, category and author
// filters, search, 7-day views, selection with bulk actions (confirm, then a
// result per document). A table on desktop, cards on phones (press and hold
// a card to start selecting).
"use client";

import * as React from "react";
import { ChevronRight, CircleAlert, CircleCheck, EyeOff, Eye, MoreHorizontal, Plus, Search, Trash2, Undo2, Upload, X, type LucideIcon } from "lucide-react";
import type { RestClient } from "@mainsoft/agent-cms/client";
import type { DocSummary } from "@mainsoft/agent-cms/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { MessageKey } from "./cms-messages";
import { errorMessage } from "./cms-messages";
import { CmsEmpty } from "./cms-empty";
import { ConfirmDialog, ModifiedMark, PageHeader, Segmented, StateBadge, StatusText, Who } from "./cms-parts";
import { relativeTime, useAsync, useCms, useDebounced, useIsMobile } from "./use-cms";

type BulkAction = Parameters<RestClient["bulk"]>[1];
type BulkResult = Awaited<ReturnType<RestClient["bulk"]>>[number];
type Tab = "all" | "draft" | "published" | "modified" | "archived";

const ACTIONS: { action: BulkAction; Icon: LucideIcon }[] = [
  { action: "publish", Icon: Upload },
  { action: "unpublish", Icon: Undo2 },
  { action: "archive", Icon: EyeOff },
  { action: "unarchive", Icon: Eye },
  { action: "delete", Icon: Trash2 },
];

export interface CmsDocListProps {
  collection: string;
  /** Open a document (row click, result dialog "Open"). */
  onOpenDocument?: (collection: string, slug: string) => void;
  /** Make titles real links (middle-click, open in new tab). */
  hrefFor?: (collection: string, slug: string) => string;
  /** "New document"; hidden when missing. */
  onNewDocument?: (collection: string) => void;
  /** Passed to the empty state's "Create an API key". */
  keysHref?: string;
  /** Page size for "Load more". Default 50. */
  pageSize?: number;
  className?: string;
}

export function CmsDocList({ collection, onOpenDocument, hrefFor, onNewDocument, keysHref, pageSize = 50, className }: CmsDocListProps) {
  const { client, t, locale } = useCms();
  const mobile = useIsMobile();
  const schema = useAsync(() => client.schema(collection), [client, collection]);
  const counts = useAsync(() => client.counts(collection), [client, collection]);

  const [tab, setTab] = React.useState<Tab>("all");
  const [category, setCategory] = React.useState<string>("__all");
  const [by, setBy] = React.useState<"__all" | "user" | "key" | "system">("__all");
  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");
  const setQLater = useDebounced((v: string) => setQ(v), 250);
  const [searchOpen, setSearchOpen] = React.useState(false);

  const [docs, setDocs] = React.useState<DocSummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [reloadTick, setReloadTick] = React.useState(0);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ action: BulkAction; slugs: string[] } | null>(null);
  const [running, setRunning] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<{ action: BulkAction; results: BulkResult[]; titles: Record<string, string> } | null>(null);

  const query = React.useMemo(
    () => ({
      state: tab === "all" ? undefined : tab,
      q: q || undefined,
      category: category === "__all" ? undefined : category,
      by: by === "__all" ? undefined : by,
      hits: true,
      limit: pageSize,
    }),
    [tab, q, category, by, pageSize]
  );

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    client.list(collection, query).then(
      (r) => {
        if (!live) return;
        setDocs(r.docs);
        setTotal(r.total);
        setCursor(r.nextCursor);
        setLoadError(null);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setLoadError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
  }, [client, collection, query, reloadTick]);

  // A new filter clears the selection.
  React.useEffect(() => setSelected(new Set()), [collection, query]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await client.list(collection, { ...query, cursor });
      setDocs((d) => [...d, ...r.docs]);
      setCursor(r.nextCursor);
      setTotal(r.total);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (slug: string, on?: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on ?? !n.has(slug)) n.add(slug);
      else n.delete(slug);
      return n;
    });
  const allSelected = docs.length > 0 && docs.every((d) => selected.has(d.slug));
  const someSelected = docs.some((d) => selected.has(d.slug));
  const selectAll = (on: boolean) => setSelected(on ? new Set(docs.map((d) => d.slug)) : new Set());
  const clearSelection = () => {
    setSelected(new Set());
    setSelectMode(false);
  };

  const open = (slug: string) => onOpenDocument?.(collection, slug);

  const run = async () => {
    if (!confirm) return;
    setRunning(true);
    setRunError(null);
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    try {
      const res = await client.bulk(
        collection,
        confirm.action,
        confirm.slugs.map((slug) => ({ slug, expectedVersion: bySlug.get(slug)?.version }))
      );
      setResults({ action: confirm.action, results: res, titles: Object.fromEntries(confirm.slugs.map((s) => [s, bySlug.get(s)?.title ?? s])) });
      setConfirm(null);
      clearSelection();
      setReloadTick((n) => n + 1);
      counts.reload();
    } catch (e) {
      setRunError(errorMessage(e, t));
    } finally {
      setRunning(false);
    }
  };

  const c = counts.data;
  const sch = schema.data;
  const canWrite = sch?.canWrite ?? false;
  const canPublish = sch?.canPublish ?? false;
  const filtered = tab !== "all" || !!q || category !== "__all" || by !== "__all";
  const isEmpty = !loading && !loadError && c?.all === 0 && !filtered;

  const actionAllowed = (a: BulkAction) => (a === "publish" || a === "unpublish" || a === "delete" ? canPublish : canWrite);

  const tabs: { value: Tab; key: MessageKey; n: number | undefined }[] = [
    { value: "all", key: "tab_all", n: c?.all },
    { value: "draft", key: "tab_draft", n: c?.draft },
    { value: "published", key: "tab_published", n: c?.published },
    { value: "modified", key: "tab_modified", n: c?.modified },
    { value: "archived", key: "tab_archived", n: c?.archived },
  ];
  const tabControl = (
    <Segmented
      label={t("state_filter")}
      value={tab}
      onChange={setTab}
      options={tabs.map((x) => ({ value: x.value, label: t(x.key, { n: x.n ?? "" }).trim() }))}
      className={mobile ? "flex-nowrap overflow-x-auto" : undefined}
    />
  );

  const categories = sch?.categories ?? [];
  const filters = (
    <>
      {categories.length ? (
        <Select value={category} onValueChange={(v: string | null) => setCategory(v ?? "__all")}>
          <SelectTrigger className="h-8 w-auto gap-1.5 text-[13px]" aria-label={t("filter_category_label")}>
            <SelectValue>{t("filter_category", { value: category === "__all" ? t("all") : category })}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">{t("all")}</SelectItem>
            {categories.map((x) => (
              <SelectItem key={x} value={x}>
                {x}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Select value={by} onValueChange={(v: string | null) => setBy((v ?? "__all") as typeof by)}>
        <SelectTrigger className="h-8 w-auto gap-1.5 text-[13px]" aria-label={t("filter_author_label")}>
          <SelectValue>{t("filter_author", { value: by === "__all" ? t("all") : t(by === "user" ? "author_user" : by === "key" ? "author_key" : "author_system") })}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">{t("all")}</SelectItem>
          <SelectItem value="user">{t("author_user")}</SelectItem>
          <SelectItem value="key">{t("author_key")}</SelectItem>
          <SelectItem value="system">{t("author_system")}</SelectItem>
        </SelectContent>
      </Select>
    </>
  );

  const searchBox = (
    <div className={cn("relative", mobile ? "w-full" : "w-60")}>
      <label htmlFor={`cms-list-q-${collection}`} className="sr-only">
        {t("list_search_label")}
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={`cms-list-q-${collection}`}
        type="search"
        value={qInput}
        placeholder={t("list_search")}
        className="h-8 pl-8 text-[13px]"
        onChange={(e) => {
          setQInput(e.target.value);
          setQLater(e.target.value.trim());
        }}
      />
    </div>
  );

  const bulkButtons = (size: "sm" | "default") =>
    ACTIONS.filter((a) => actionAllowed(a.action)).map(({ action, Icon }) => (
      <Button
        key={action}
        type="button"
        variant="outline"
        size={size === "sm" ? "sm" : "default"}
        className={cn("gap-1.5", size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 flex-1 px-2 text-xs", action === "delete" && "text-destructive hover:text-destructive")}
        onClick={() => setConfirm({ action, slugs: [...selected] })}
      >
        <Icon aria-hidden className="h-3.5 w-3.5" />
        {t(`action_${action}` as MessageKey)}
      </Button>
    ));

  const titleLink = (d: DocSummary, className?: string) =>
    hrefFor ? (
      <a
        href={hrefFor(collection, d.slug)}
        className={cn("font-medium hover:underline", className)}
        onClick={(e) => {
          if (onOpenDocument && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
            e.preventDefault();
            open(d.slug);
          }
        }}
      >
        {d.title || d.slug}
      </a>
    ) : (
      <button type="button" className={cn("text-left font-medium hover:underline", className)} onClick={() => open(d.slug)}>
        {d.title || d.slug}
      </button>
    );

  const stateCell = (d: DocSummary) => (
    <div className="flex flex-col items-start gap-0.5">
      <StateBadge state={d.state} />
      {d.modifiedSincePublish ? <ModifiedMark /> : null}
    </div>
  );

  const rowMenu = (d: DocSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon", className: "h-7 w-7" })} aria-label={t("row_actions", { title: d.title || d.slug })}>
        <MoreHorizontal aria-hidden className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => open(d.slug)}>{t("open")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {ACTIONS.filter((a) => actionAllowed(a.action)).map(({ action }) => (
          <DropdownMenuItem key={action} className={action === "delete" ? "text-destructive" : undefined} onClick={() => setConfirm({ action, slugs: [d.slug] })}>
            {t(`action_${action}` as MessageKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // ── mobile: long press to select ──
  const press = React.useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const startPress = (slug: string) => {
    press.current.fired = false;
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = setTimeout(() => {
      press.current.fired = true;
      setSelectMode(true);
      toggle(slug, true);
    }, 500);
  };
  const endPress = () => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  };

  const header = mobile && selectMode ? (
    <PageHeader
      back={
        <Button type="button" variant="ghost" size="icon" className="-ml-2 h-8 w-8" aria-label={t("exit_selection")} onClick={clearSelection}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      }
      title={t("selected_n", { n: selected.size })}
    >
      <Button type="button" variant="ghost" size="sm" onClick={() => selectAll(!allSelected)}>
        {allSelected ? t("clear_selection") : t("select_all")}
      </Button>
    </PageHeader>
  ) : (
    <PageHeader title={sch?.label ?? collection}>
      {mobile ? (
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("search")} aria-expanded={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
          <Search aria-hidden className="h-4 w-4" />
        </Button>
      ) : null}
      {onNewDocument && canWrite ? (
        <Button type="button" size={mobile ? "sm" : "default"} className="gap-1.5" onClick={() => onNewDocument(collection)}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("new_document")}
        </Button>
      ) : null}
    </PageHeader>
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {header}
      {isEmpty ? (
        <CmsEmpty collection={collection} onNewDocument={onNewDocument} keysHref={keysHref} />
      ) : mobile ? (
        <>
          {!selectMode ? (
            <div className="flex flex-col gap-2 border-b px-4 py-2.5">
              {searchOpen ? searchBox : null}
              {tabControl}
            </div>
          ) : null}
          <ul className="flex-1" aria-label={sch?.label ?? collection}>
            {docs.map((d) => {
              const on = selected.has(d.slug);
              return (
                <li key={d.slug} className={cn("border-b", on && "bg-muted/60")}>
                  <button
                    type="button"
                    aria-pressed={selectMode ? on : undefined}
                    className="flex w-full select-none items-start gap-3 px-4 py-3 text-left outline-none focus-visible:bg-muted"
                    onPointerDown={() => startPress(d.slug)}
                    onPointerUp={endPress}
                    onPointerLeave={endPress}
                    onPointerCancel={endPress}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      endPress();
                      if (!press.current.fired) {
                        setSelectMode(true);
                        toggle(d.slug, true);
                      }
                      press.current.fired = true;
                    }}
                    onClick={() => {
                      if (press.current.fired) {
                        press.current.fired = false;
                        return;
                      }
                      if (selectMode) toggle(d.slug);
                      else open(d.slug);
                    }}
                  >
                    {selectMode ? (
                      <span aria-hidden className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-primary", on && "bg-primary text-primary-foreground")}>
                        {on ? <CircleCheck className="h-3 w-3" /> : null}
                      </span>
                    ) : null}
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="flex items-center gap-2">
                        <span className="flex-1 truncate font-medium">{d.title || d.slug}</span>
                        {!selectMode ? <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground" /> : null}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StateBadge state={d.state} />
                        {d.modifiedSincePublish ? <ModifiedMark /> : d.category ? <span className="text-xs text-muted-foreground">{d.category}</span> : null}
                      </span>
                      {!selectMode ? (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Who kind={d.updatedByKind} label={`${d.updatedBy ?? ""}, ${relativeTime(d.updatedAt, t, locale)}`} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selectMode ? (
            <div role="toolbar" aria-label={t("bulk_bar")} className="sticky bottom-0 flex gap-1.5 border-t bg-background p-2">
              {selected.size ? bulkButtons("default") : <span className="p-2 text-sm text-muted-foreground">{t("long_press_hint")}</span>}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex-1 px-6 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {searchBox}
            {tabControl}
            {filters}
          </div>
          {selected.size ? (
            <div role="toolbar" aria-label={t("bulk_bar")} className="mb-2.5 flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 py-1.5 pl-3 pr-2">
              <span className="mr-1 text-[13px] font-medium">{t("selected_n", { n: selected.size })}</span>
              {bulkButtons("sm")}
              <span className="flex-1" />
              <Button type="button" variant="ghost" size="sm" className="h-7 text-[13px]" onClick={clearSelection}>
                {t("clear_selection")}
              </Button>
            </div>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    aria-label={t("select_all")}
                    checked={allSelected}
                    aria-checked={allSelected ? true : someSelected ? "mixed" : false}
                    onCheckedChange={(v) => selectAll(v === true)}
                    disabled={!docs.length}
                  />
                </TableHead>
                <TableHead className="w-[38%]">{t("col_title")}</TableHead>
                <TableHead>{t("col_category")}</TableHead>
                <TableHead>{t("col_state")}</TableHead>
                <TableHead>{t("col_updated")}</TableHead>
                <TableHead className="text-right">{t("col_views")}</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">{t("col_actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => {
                const on = selected.has(d.slug);
                return (
                  <TableRow key={d.slug} data-state={on ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox aria-label={t("select_row", { title: d.title || d.slug })} checked={on} onCheckedChange={(v) => toggle(d.slug, v === true)} />
                    </TableCell>
                    <TableCell>
                      {titleLink(d)}
                      <div className="font-mono text-xs text-muted-foreground">{d.slug}</div>
                    </TableCell>
                    <TableCell className="text-[13.5px]">{d.category ?? ""}</TableCell>
                    <TableCell>{stateCell(d)}</TableCell>
                    <TableCell className="text-[13.5px]">
                      <Who kind={d.updatedByKind} label={d.updatedBy} />
                      <div className="text-xs text-muted-foreground">{relativeTime(d.updatedAt, t, locale)}</div>
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", !d.hits7d && "text-muted-foreground")}>{d.hits7d ?? 0}</TableCell>
                    <TableCell>{rowMenu(d)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {!isEmpty ? (
        <div className={cn("flex items-center justify-between gap-2 py-3 text-xs text-muted-foreground", mobile ? "px-4" : "px-6")}>
          <StatusText className="text-xs" tone={loadError ? "error" : "muted"}>
            {loadError ? errorMessage(loadError, t) : loading ? t("loading") : docs.length === 0 ? t("no_results") : t("shown_of", { shown: docs.length, total })}
          </StatusText>
          {cursor ? (
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
              {t("load_more")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setRunError(null);
          }
        }}
        title={confirm ? t(`confirm_${confirm.action}` as MessageKey, { n: confirm.slugs.length }) : ""}
        description={confirm?.action === "delete" ? t("confirm_delete_note") : undefined}
        confirmLabel={confirm ? t(`action_${confirm.action}` as MessageKey) : ""}
        destructive={confirm?.action === "delete"}
        busy={running}
        error={runError}
        onConfirm={run}
      >
        {confirm ? (
          <ul className="overflow-hidden rounded-md border">
            {confirm.slugs.map((s) => {
              const d = docs.find((x) => x.slug === s);
              return (
                <li key={s} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <span className="flex-1 truncate text-sm font-medium">{d?.title || s}</span>
                  {d ? <span className="text-xs text-muted-foreground">v{d.version}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </ConfirmDialog>

      <Dialog open={!!results} onOpenChange={(o) => !o && setResults(null)}>
        <DialogContent className="max-w-[500px]">
          {results ? <BulkResults {...results} onOpen={(slug) => (setResults(null), open(slug))} canOpen={!!onOpenDocument} onClose={() => setResults(null)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BulkResults({ action, results, titles, onOpen, canOpen, onClose }: { action: BulkAction; results: BulkResult[]; titles: Record<string, string>; onOpen: (slug: string) => void; canOpen: boolean; onClose: () => void }) {
  const { t } = useCms();
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const done = t(`done_${action}` as MessageKey);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{failed ? t("result_title", { ok, failed, action: done }) : t("result_all_ok", { n: ok, action: done })}</DialogTitle>
        <DialogDescription className="sr-only">{t("bulk_bar")}</DialogDescription>
      </DialogHeader>
      <ul className="overflow-hidden rounded-md border">
        {results.map((r) => (
          <li key={r.slug} className="flex flex-col gap-0.5 border-b px-3 py-2 last:border-b-0">
            <div className="flex items-center gap-2">
              {r.ok ? <CircleCheck aria-hidden className="h-4 w-4 text-green-600" /> : <CircleAlert aria-hidden className="h-4 w-4 text-destructive" />}
              <span className="flex-1 truncate text-sm font-medium">{titles[r.slug] ?? r.slug}</span>
              {r.ok ? (
                <span className="text-xs text-muted-foreground">{done}</span>
              ) : canOpen && action !== "delete" ? (
                <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => onOpen(r.slug)}>
                  {t("open")}
                </Button>
              ) : null}
            </div>
            {!r.ok && r.error ? <p className="pl-6 text-xs text-red-900">{r.error.message}</p> : null}
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t("close")}
        </Button>
      </DialogFooter>
    </>
  );
}
