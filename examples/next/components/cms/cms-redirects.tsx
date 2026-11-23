// agent-cms registry: cms-redirects (0.21.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Redirects (admins): old addresses and where they send people now. Made
// automatically when a published document gets a new address, or by hand
// here. Search, the kind (automatic or manual), visits, edit and delete.
// Needs `redirects: true` in createCms; the app's middleware reads them
// through `GET /redirects/_resolve`.
"use client";

import * as React from "react";
import { ArrowRight, CornerDownRight, FileText, MoreHorizontal, Plus, Search, X } from "lucide-react";
import type { RedirectView } from "@mainsoft/agent-cms/client";
import { isCmsRemoteError } from "@mainsoft/agent-cms/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, DIALOG, EmptyState, PageHeader, Segmented, StatusText } from "./cms-parts";
import { formatDate, relativeTime, useAsync, useCms, useIsMobile } from "./use-cms";

export interface CmsRedirectsProps {
  className?: string;
}

type Kind = "all" | "auto" | "manual";

export function CmsRedirects({ className }: CmsRedirectsProps) {
  const { client, t, me, locale, toast } = useCms();
  const mobile = useIsMobile();
  // Off on this server, or not an admin: nothing to load.
  const allowed = !!me?.redirects;
  const q = useAsync(() => (allowed ? client.redirects() : Promise.resolve([] as RedirectView[])), [client, allowed]);
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<Kind>("all");
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
  const list = needle ? byKind.filter((r) => r.from.toLowerCase().includes(needle) || r.to.toLowerCase().includes(needle)) : byKind;
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
                        <TableHead className="hidden w-20 text-right md:table-cell">{t("redir_hits")}</TableHead>
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
                              {r.toDocumentId ? <FileText aria-label={t("redir_follows_doc")} role="img" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                            </span>
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
                          <TableCell className="hidden text-right tabular-nums md:table-cell">{r.hits}</TableCell>
                          <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{r.lastHitAt ? relativeTime(r.lastHitAt, t, locale) : "—"}</TableCell>
                          <TableCell className="hidden text-sm tabular-nums text-muted-foreground lg:table-cell">{formatDate(r.createdAt, locale, true)}</TableCell>
                          <TableCell className="py-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("redir_actions", { from: r.from })}>
                                  <MoreHorizontal aria-hidden className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => setEditing(r)}>{t("edit")}</DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => (setRemoveError(null), setRemoving(r))}>
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

/** New or edit: the old address, the new one, 301 or 302. The server's refusal (a loop, an address already taken) shows under the form. */
function RedirectDialog({ target, onClose, onSaved }: { target: RedirectView | "new"; onClose: () => void; onSaved: (r: RedirectView, created: boolean) => void }) {
  const { client, t } = useCms();
  const cur = target === "new" ? null : target;
  const [from, setFrom] = React.useState(cur?.from ?? "/");
  const [to, setTo] = React.useState(cur?.to ?? "/");
  const [status, setStatus] = React.useState<"301" | "302">(cur?.status === 302 ? "302" : "301");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ text: string; field: "from" | "to" | null } | null>(null);
  const ready = from.trim().length > 1 && to.trim().length > 1;

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
        // Only what changed: a redirect that follows a document keeps following it while `to` stays.
        const patch: { from?: string; to?: string; status?: 301 | 302 } = {};
        if (f !== cur.from) patch.from = f;
        if (x !== cur.to) patch.to = x;
        if (s !== cur.status) patch.status = s;
        r = Object.keys(patch).length ? await client.updateRedirect(cur.id, patch) : cur;
      } else r = await client.createRedirect({ from: f, to: x, status: s });
      onSaved(r, !cur);
    } catch (err) {
      const code = isCmsRemoteError(err) ? err.code : "";
      const field = code === "redirect_taken" ? "from" : code === "redirect_loop" ? "to" : code === "redirect_invalid" ? (/\(to\)/.test(isCmsRemoteError(err) ? err.message : "") ? "to" : "from") : null;
      setError({ text: errorMessage(err, t), field });
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
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
            <Label htmlFor="cms-redir-to">{t("redir_to")}</Label>
            <Input id="cms-redir-to" className="font-mono text-[13px]" value={to} maxLength={2000} onChange={(e) => setTo(e.target.value)} aria-invalid={error?.field === "to" || undefined} aria-describedby={`cms-redir-to-help${error ? " cms-redir-error" : ""}`} />
            <p id="cms-redir-to-help" className="text-xs text-muted-foreground">
              {cur?.toDocumentId && to.trim() === cur.to ? t("redir_follows_doc") : t("redir_to_help")}
            </p>
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
    </Dialog>
  );
}
