// agent-cms registry: cms-redirects (0.21.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Redirects (admins): old addresses and where they send people now. Made
// automatically when a published document gets a new address, or by hand
// here, to an address or to a document (then it follows the document's
// current address). Search, the kind (automatic or manual), visits over the
// last 30 days (a small bar chart; sortable), edit and delete.
// Needs `redirects: true` in createCms; the app's middleware reads them
// through `GET /redirects/_resolve`.
"use client";

import * as React from "react";
import { ArrowDown, ArrowRight, ArrowUpDown, CornerDownRight, FileText, MoreHorizontal, Plus, Search, X } from "lucide-react";
import type { RedirectView } from "@mainsoft/agent-cms/client";
import { isCmsRemoteError } from "@mainsoft/agent-cms/client";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { RelationPicker } from "./cms-fields-more";
import { ConfirmDialog, DIALOG, EmptyState, PageHeader, Segmented, StatusText } from "./cms-parts";
import { formatDate, relativeTime, useAsync, useCms, useIsMobile } from "./use-cms";

export interface CmsRedirectsProps {
  className?: string;
}

type Kind = "all" | "auto" | "manual";
type Sort = "created" | "hits30d";

export function CmsRedirects({ className }: CmsRedirectsProps) {
  const { client, t, me, locale, toast } = useCms();
  const mobile = useIsMobile();
  // Off on this server, or not an admin: nothing to load.
  const allowed = !!me?.redirects;
  const q = useAsync(() => (allowed ? client.redirects() : Promise.resolve([] as RedirectView[])), [client, allowed]);
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<Kind>("all");
  const [sort, setSort] = React.useState<Sort>("created");
  const [editing, setEditing] = React.useState<RedirectView | "new" | null>(null);
  const [removing, setRemoving] = React.useState<RedirectView | null>(null);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  const offByServer = isCmsRemoteError(q.error) && q.error.code === "redirects_off";
  const off = !!me && ((me.isAdmin && !me.redirects) || offByServer);
  const notAdmin = !!me && !me.isAdmin;
  const all = q.data ?? [];
  const needle = query.trim().toLowerCase();
  const byKind = kind === "all" ? all : all.filter((r) => r.source === kind);
  const found = needle ? byKind.filter((r) => r.from.toLowerCase().includes(needle) || r.to.toLowerCase().includes(needle) || (r.target?.title ?? "").toLowerCase().includes(needle)) : byKind;
  // Newest first (the server's order), or most visited over the last 30 days first.
  const list = sort === "hits30d" ? [...found].sort((a, b) => (b.hits30d ?? 0) - (a.hits30d ?? 0) || b.createdAt.localeCompare(a.createdAt)) : found;
  const nAuto = all.filter((r) => r.source === "auto").length;

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await client.removeRedirect(removing.id);
      toast(t("redir_deleted", { from: removing.from }), { tone: "ok" });
      setRemoving(null);
      q.reload();
    } catch (e) {
      setRemoveError(errorMessage(e, t));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("redir_title")}>
        {allowed && !off ? (
          <Button type="button" className="gap-1.5" size={mobile ? "sm" : "default"} onClick={() => setEditing("new")}>
            <Plus aria-hidden className="h-4 w-4" />
            {t("redir_new")}
          </Button>
        ) : null}
      </PageHeader>
      <div className="min-w-0 flex-1 overflow-x-auto px-4 py-4 md:px-6">
        {off ? (
          <EmptyState icon={CornerDownRight} title={t("redir_off_title")} text={t("redir_off_text")} />
        ) : notAdmin ? (
          <EmptyState icon={CornerDownRight} title={t("redir_title")} text={t("redir_admins_only")} />
        ) : (
          <>
            {q.error || (q.loading && !q.data) ? (
              <StatusText tone={q.error ? "error" : "muted"} className="mb-2 text-xs">
                {q.error ? errorMessage(q.error, t) : t("loading")}
              </StatusText>
            ) : null}
            {q.error ? (
              <Button type="button" variant="outline" size="sm" className="mb-3" onClick={q.reload}>
                {t("retry")}
              </Button>
            ) : null}
            {q.data && !all.length ? (
              <EmptyState
                icon={CornerDownRight}
                title={t("redir_empty")}
                text={t("redir_empty_text")}
                action={
                  <Button type="button" size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
                    <Plus aria-hidden className="h-4 w-4" />
                    {t("redir_new")}
                  </Button>
                }
              />
            ) : null}
            {all.length ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="relative w-full sm:w-72">
                    <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input type="search" aria-label={t("redir_search")} placeholder={t("redir_search")} value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8 pr-8" />
                    {query ? (
                      <button type="button" aria-label={t("clear_search")} onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent">
                        <X aria-hidden className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <Segmented
                    label={t("redir_source")}
                    value={kind}
                    onChange={setKind}
                    itemClassName="h-7 px-2.5 text-xs"
                    options={[
                      { value: "all", label: t("redir_tab_all", { n: all.length }) },
                      { value: "auto", label: t("redir_tab_auto", { n: nAuto }) },
                      { value: "manual", label: t("redir_tab_manual", { n: all.length - nAuto }) },
                    ]}
                  />
                </div>
                {list.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("redir_from")}</TableHead>
                        <TableHead className="w-6 px-0">
                          <span className="sr-only">→</span>
                        </TableHead>
                        <TableHead>{t("redir_to")}</TableHead>
                        <TableHead className="w-16">{t("redir_status")}</TableHead>
                        <TableHead className="hidden w-24 sm:table-cell">{t("redir_source")}</TableHead>
                        <TableHead className="hidden w-36 text-right md:table-cell" aria-sort={sort === "hits30d" ? "descending" : "none"}>
                          <button
                            type="button"
                            className="-mr-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={sort === "hits30d" ? t("redir_sort_off") : t("redir_sort_hits")}
                            onClick={() => setSort((s) => (s === "hits30d" ? "created" : "hits30d"))}
                          >
                            {t("redir_hits_30d")}
                            {sort === "hits30d" ? <ArrowDown aria-hidden className="h-3.5 w-3.5" /> : <ArrowUpDown aria-hidden className="h-3.5 w-3.5 opacity-50" />}
                          </button>
                        </TableHead>
                        <TableHead className="hidden w-32 lg:table-cell">{t("redir_last_hit")}</TableHead>
                        <TableHead className="hidden w-32 lg:table-cell">{t("redir_created_at")}</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">{t("edit")}</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="max-w-[14rem] truncate font-mono text-[12.5px]" title={r.from}>
                            {r.from}
                          </TableCell>
                          <TableCell className="px-0">
                            <ArrowRight aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                          </TableCell>
                          <TableCell className="max-w-[16rem] font-mono text-[12.5px]">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate" title={r.to}>
                                {r.to}
                              </span>
                              {r.toDocumentId ? <FileText aria-label={t("redir_follows_doc_short")} role="img" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                            </span>
                            {r.toDocumentId && r.source === "manual" ? (
                              <span className={cn("block truncate font-sans text-xs", r.target?.published ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400")}>
                                {r.target ? (r.target.published ? r.target.title || r.target.slug : t("redir_doc_hidden", { title: r.target.title || r.target.slug })) : t("redir_doc_gone")}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="tabular-nums">{r.status}</TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {r.source === "auto" ? (
                              <Badge variant="secondary" className="rounded-full px-2 py-0 text-[11.5px] font-medium">
                                {t("redir_auto")}
                              </Badge>
                            ) : (
                              <span className="text-sm text-muted-foreground">{t("redir_manual")}</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <span className="flex items-center justify-end gap-2" title={t("redir_hits_total", { n: r.hits })}>
                              <HitBars daily={r.daily ?? []} total={r.hits30d ?? 0} />
                              <span className="w-10 text-right tabular-nums">{r.hits30d ?? 0}</span>
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{r.lastHitAt ? relativeTime(r.lastHitAt, t, locale) : "—"}</TableCell>
                          <TableCell className="hidden whitespace-nowrap text-sm tabular-nums text-muted-foreground lg:table-cell">{formatDate(r.createdAt, locale, true)}</TableCell>
                          <TableCell className="py-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon", className: "h-8 w-8" })} aria-label={t("redir_actions", { from: r.from })}>
                                <MoreHorizontal aria-hidden className="h-4 w-4" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditing(r)}>{t("edit")}</DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => (setRemoveError(null), setRemoving(r))}>
                                  {t("redir_delete")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t("redir_no_match", { q: query.trim() })}</p>
                )}
                <p className="mt-3 text-xs tabular-nums text-muted-foreground">{t("redir_count", { n: list.length })}</p>
              </>
            ) : null}
          </>
        )}
      </div>
      {editing ? (
        <RedirectDialog
          key={editing === "new" ? "new" : editing.id}
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={(r, created) => {
            setEditing(null);
            toast(t(created ? "redir_created" : "redir_saved", { from: r.from }), { tone: "ok" });
            q.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && !removeBusy && setRemoving(null)}
        title={removing ? t("redir_delete_title", { from: removing.from }) : ""}
        description={removing ? t("redir_delete_text", { from: removing.from, to: removing.to }) : undefined}
        confirmLabel={t("redir_delete")}
        destructive
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
      />
    </div>
  );
}

/**
 * Visits per day over the last 30 days as small bars (own SVG; today on the right). Screen readers get
 * the numbers instead: the sum, the busiest day and today.
 */
function HitBars({ daily, total }: { daily: number[]; total: number }) {
  const { t } = useCms();
  const days = daily.length ? daily : new Array<number>(30).fill(0);
  const max = Math.max(...days);
  const W = 60;
  const H = 16;
  const step = W / days.length;
  const bar = Math.max(1, step - 0.6);
  return (
    <svg role="img" aria-label={t("redir_hits_chart", { total, max, today: days[days.length - 1] ?? 0 })} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0 text-primary/70">
      {days.map((n, i) => {
        // Days with visits are at least 2px tall so a single visit still shows; empty days are a faint line.
        const h = n > 0 && max > 0 ? Math.max(2, Math.round((n / max) * H)) : 1;
        return <rect key={i} x={i * step} y={H - h} width={bar} height={h} rx={0.5} className={n > 0 ? "fill-current" : "fill-muted-foreground/25"} />;
      })}
    </svg>
  );
}

type Target = { id: string; title: string; slug: string; collection: string };

/**
 * New or edit: the old address, where it goes (an address, or a document whose current address it
 * follows), 301 or 302. The server's refusal (a loop, an address already taken, a document without a
 * public address) shows under the form.
 */
function RedirectDialog({ target, onClose, onSaved }: { target: RedirectView | "new"; onClose: () => void; onSaved: (r: RedirectView, created: boolean) => void }) {
  const { client, t, me } = useCms();
  const cur = target === "new" ? null : target;
  const followsDoc = !!cur?.toDocumentId && cur.source === "manual";
  const [from, setFrom] = React.useState(cur?.from ?? "/");
  const [to, setTo] = React.useState(cur?.to ?? "/");
  const [mode, setMode] = React.useState<"address" | "document">(followsDoc ? "document" : "address");
  const [doc, setDoc] = React.useState<Target | null>(followsDoc && cur?.target ? { id: cur.target.id, title: cur.target.title, slug: cur.target.slug, collection: cur.target.collection } : null);
  const [picking, setPicking] = React.useState(false);
  const pickBtn = React.useRef<HTMLButtonElement>(null);
  const [status, setStatus] = React.useState<"301" | "302">(cur?.status === 302 ? "302" : "301");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ text: string; field: "from" | "to" | null } | null>(null);
  // Documents of public collections can be followed (the server checks that they have an address).
  const docCollections = (me?.collections ?? []).filter((c) => c.visibility === "public" && !c.single && !c.snippets).map((c) => c.slug);
  // Any non-empty value: "/" is a fine target (the home page). The server says what is wrong (a loop, a bad address).
  const ready = from.trim().length > 0 && (mode === "address" ? to.trim().length > 0 : !!doc);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const f = from.trim();
    const x = to.trim();
    const s = status === "302" ? 302 : 301;
    try {
      let r: RedirectView;
      if (cur) {
        // Only what changed: a redirect that follows a document keeps following it unless the target changes.
        const patch: { from?: string; to?: string; toDocumentId?: string | null; status?: 301 | 302 } = {};
        if (f !== cur.from) patch.from = f;
        if (mode === "document") {
          if (doc && (doc.id !== cur.toDocumentId || !followsDoc)) patch.toDocumentId = doc.id;
        } else if (followsDoc || x !== cur.to) {
          patch.to = x;
          patch.toDocumentId = null;
        }
        if (s !== cur.status) patch.status = s;
        r = Object.keys(patch).length ? await client.updateRedirect(cur.id, patch) : cur;
      } else r = await client.createRedirect(mode === "document" && doc ? { from: f, toDocumentId: doc.id, status: s } : { from: f, to: x, status: s });
      onSaved(r, !cur);
    } catch (err) {
      const code = isCmsRemoteError(err) ? err.code : "";
      const field = code === "redirect_taken" ? "from" : code === "redirect_loop" || code === "redirect_document" ? "to" : code === "redirect_invalid" ? (/\(to\)/.test(isCmsRemoteError(err) ? err.message : "") ? "to" : "from") : null;
      setError({ text: errorMessage(err, t), field });
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && !picking && onClose()}>
      <DialogContent className={DIALOG.md}>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{cur ? t("redir_edit") : t("redir_new")}</DialogTitle>
            <DialogDescription>{t("redir_new_help")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cms-redir-from">{t("redir_from")}</Label>
            <Input id="cms-redir-from" autoFocus className="font-mono text-[13px]" value={from} maxLength={2000} onChange={(e) => setFrom(e.target.value)} aria-invalid={error?.field === "from" || undefined} aria-describedby={error ? "cms-redir-error" : undefined} />
          </div>
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {mode === "address" ? (
                <Label id="cms-redir-to-label" htmlFor="cms-redir-to">
                  {t("redir_to")}
                </Label>
              ) : (
                <span id="cms-redir-to-label" className="text-sm font-medium">
                  {t("redir_to")}
                </span>
              )}
              <Segmented
                label={t("redir_to_kind")}
                value={mode}
                onChange={(m) => (setMode(m), setError(null))}
                itemClassName="h-7 px-2.5 text-xs"
                options={[
                  { value: "address", label: t("redir_to_address") },
                  { value: "document", label: t("redir_to_document"), disabled: !docCollections.length },
                ]}
              />
            </div>
            {mode === "address" ? (
              <>
                <Input id="cms-redir-to" className="font-mono text-[13px]" value={to} maxLength={2000} onChange={(e) => setTo(e.target.value)} aria-invalid={error?.field === "to" || undefined} aria-describedby={`cms-redir-to-help${error ? " cms-redir-error" : ""}`} />
                <p id="cms-redir-to-help" className="text-xs text-muted-foreground">
                  {t("redir_to_help")}
                </p>
              </>
            ) : (
              <>
                <button
                  ref={pickBtn}
                  type="button"
                  aria-labelledby="cms-redir-to-label cms-redir-doc"
                  aria-describedby={`cms-redir-to-help${error ? " cms-redir-error" : ""}`}
                  aria-invalid={error?.field === "to" || undefined}
                  onClick={() => setPicking(true)}
                  className={cn("flex h-9 w-full items-center gap-2 rounded-md border bg-transparent px-3 text-left text-sm transition-colors duration-150 ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", error?.field === "to" && "border-destructive")}
                >
                  <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span id="cms-redir-doc" className={cn("min-w-0 flex-1 truncate", !doc && "text-muted-foreground")}>
                    {doc ? doc.title || doc.slug : t("redir_pick_doc")}
                  </span>
                  {doc ? <span className="hidden shrink-0 truncate font-mono text-xs text-muted-foreground sm:inline">{me?.collections.find((c) => c.slug === doc.collection)?.label ?? doc.collection}</span> : null}
                </button>
                <p id="cms-redir-to-help" className="text-xs text-muted-foreground">
                  {t("redir_follows_doc")}
                </p>
              </>
            )}
          </div>
          <div className="grid gap-1.5">
            <span id="cms-redir-status" className="text-sm font-medium">
              {t("redir_status")}
            </span>
            <Segmented
              labelledBy="cms-redir-status"
              value={status}
              onChange={setStatus}
              className="w-fit"
              options={[
                { value: "301", label: t("redir_301") },
                { value: "302", label: t("redir_302") },
              ]}
            />
          </div>
          {cur?.source === "auto" ? <p className="text-xs text-muted-foreground">{t("redir_edit_auto_note")}</p> : null}
          {error ? (
            <p id="cms-redir-error" role="alert" className="text-sm text-destructive">
              {error.text}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {cur ? t("save") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {picking ? (
        <RelationPicker
          title={t("redir_to_document")}
          collections={docCollections}
          onPick={(d) => {
            setDoc({ id: d.id, title: d.title, slug: d.slug, collection: d.collection });
            setPicking(false);
            setError(null);
            // Back to the button that opened the search.
            requestAnimationFrame(() => pickBtn.current?.focus());
          }}
          onClose={() => {
            setPicking(false);
            requestAnimationFrame(() => pickBtn.current?.focus());
          }}
        />
      ) : null}
    </Dialog>
  );
}
