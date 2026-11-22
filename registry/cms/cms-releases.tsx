// agent-cms registry: cms-releases (0.10.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Releases: documents that go out (or come down) together. <CmsReleases> is
// the list, <CmsRelease> is one release: what is in it, which version of
// each document, what stands in the way, publish now or at a set time.
"use client";

import * as React from "react";
import { CalendarClock, CircleAlert, MoreHorizontal, Plus, RefreshCw, Search, X } from "lucide-react";
import { isCmsRemoteError, type BlockedItem, type ReleaseView } from "@mainsoft/agent-cms/client";
import type { CmsRelease as Release, DocSummary } from "@mainsoft/agent-cms/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, PageHeader, Segmented, StateBadge, StatusText, type BadgeState, DIALOG } from "./cms-parts";
import { formatZoned, toInput, useCms, useDebounced, zonedParts, zonedToIso } from "./use-cms";

const SELECT = "h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const BADGE: Record<Release["state"], BadgeState> = { open: "draft", scheduled: "scheduled", published: "published" };

function ReleaseBadge({ state }: { state: Release["state"] }) {
  const { t } = useCms();
  return <StateBadge state={BADGE[state]} label={state === "open" ? t("release_state_open") : undefined} />;
}

function NameDialog({ title, initial = "", action, onClose, onSubmit }: { title: string; initial?: string; action: string; onClose: () => void; onSubmit: (name: string) => Promise<unknown> }) {
  const { t } = useCms();
  const [name, setName] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.sm}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            onSubmit(name.trim()).then(onClose, (err) => (setBusy(false), setError(errorMessage(err, t))));
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{t("nav_releases")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cms-release-name">{t("name")}</Label>
            <Input id="cms-release-name" autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={error ? true : undefined} />
            {error ? <StatusText tone="error">{error}</StatusText> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || name.trim() === initial}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface CmsReleasesProps {
  /** Open one release (row click, and right after making one). */
  onOpenRelease?: (id: string) => void;
  /** Make names real links. */
  hrefFor?: (id: string) => string;
  className?: string;
}

export function CmsReleases({ onOpenRelease, hrefFor, className }: CmsReleasesProps) {
  const { client, t, locale, me } = useCms();
  const [list, setList] = React.useState<Release[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [tick, setTick] = React.useState(0);
  const [dialog, setDialog] = React.useState<null | { kind: "new" } | { kind: "rename" | "delete"; release: Release }>(null);
  const [busy, setBusy] = React.useState(false);
  const reload = () => setTick((n) => n + 1);

  React.useEffect(() => {
    let live = true;
    client.releases().then(
      (r) => live && (setList(r), setError(null)),
      (e) => live && setError(e)
    );
    return () => {
      live = false;
    };
  }, [client, tick]);

  const canWrite = !!me?.collections.some((c) => c.canWrite);
  const name = (r: Release) =>
    hrefFor ? (
      <a
        href={hrefFor(r.id)}
        className="font-medium hover:underline"
        onClick={(e) => {
          if (onOpenRelease && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
            e.preventDefault();
            onOpenRelease(r.id);
          }
        }}
      >
        {r.name}
      </a>
    ) : (
      <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpenRelease?.(r.id)}>
        {r.name}
      </button>
    );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("nav_releases")}>
        {canWrite ? (
          <Button type="button" className="gap-1.5" onClick={() => setDialog({ kind: "new" })}>
            <Plus aria-hidden className="h-4 w-4" />
            {t("release_new")}
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex-1 px-4 py-4 md:px-6">
        {error ? <StatusText tone="error">{errorMessage(error, t)}</StatusText> : null}
        {list && !list.length ? <p className="py-16 text-center text-sm text-muted-foreground">{t("release_empty")}</p> : null}
        {list?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead className="w-[80px] text-right">{t("release_col_docs")}</TableHead>
                <TableHead className="w-[140px] pl-6">{t("col_state")}</TableHead>
                <TableHead className="hidden w-[200px] md:table-cell">{t("sched_publish_at")}</TableHead>
                <TableHead className="hidden w-[140px] md:table-cell">{t("release_col_by")}</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">{t("col_actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const at = r.publishedAt ?? r.publishAt;
                return (
                  <TableRow key={r.id}>
                    <TableCell>{name(r)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.items.length}</TableCell>
                    <TableCell className="pl-6">
                      <ReleaseBadge state={r.state} />
                    </TableCell>
                    <TableCell className={cn("hidden tabular-nums md:table-cell", !at && "text-muted-foreground")}>{at ? formatZoned(at, locale, me?.timeZone) : t("none")}</TableCell>
                    <TableCell className="hidden max-w-0 truncate md:table-cell">{r.createdBy ?? ""}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon", className: "h-7 w-7" })} aria-label={t("row_actions", { title: r.name })}>
                          <MoreHorizontal aria-hidden className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onOpenRelease?.(r.id)}>{t("open")}</DropdownMenuItem>
                          {r.state !== "published" && canWrite ? (
                            <>
                              <DropdownMenuItem onClick={() => setDialog({ kind: "rename", release: r })}>{t("media_rename")}</DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive" onClick={() => setDialog({ kind: "delete", release: r })}>
                                {t("release_delete")}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </div>
      {dialog?.kind === "new" ? (
        <NameDialog
          title={t("release_new")}
          action={t("release_new")}
          onClose={() => setDialog(null)}
          onSubmit={async (n) => {
            const r = await client.createRelease(n);
            reload();
            onOpenRelease?.(r.id);
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? <NameDialog title={t("media_rename")} initial={dialog.release.name} action={t("save")} onClose={() => setDialog(null)} onSubmit={(n) => client.renameRelease(dialog.release.id, n).then(reload)} /> : null}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog?.kind === "delete" ? t("release_delete_title", { name: dialog.release.name }) : ""}
        description={t("release_delete_note")}
        confirmLabel={t("release_delete")}
        destructive
        busy={busy}
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          setBusy(true);
          await client.removeRelease(dialog.release.id).then(reload, setError);
          setBusy(false);
          setDialog(null);
        }}
      />
    </div>
  );
}

// ── one release ──────────────────────────────────────────────────────────────

export interface CmsReleaseProps {
  id: string;
  /** Back to the list (the breadcrumb, and after deleting). */
  onBack?: () => void;
  /** Open a document of the release. */
  onOpenDocument?: (collection: string, slug: string) => void;
  className?: string;
}

type Item = ReleaseView["items"][number];

export function CmsRelease({ id, onBack, onOpenDocument, className }: CmsReleaseProps) {
  const { client, t, locale, me } = useCms();
  const [rel, setRel] = React.useState<ReleaseView | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  // Errors per document; -1: the check itself failed (not "no problems"); undefined: still checking.
  const [problems, setProblems] = React.useState<Record<string, number>>({});
  const [checkTick, setCheckTick] = React.useState(0);
  const [blocked, setBlocked] = React.useState<BlockedItem[]>([]);
  const [dialog, setDialog] = React.useState<null | "add" | "schedule" | "publish" | "rename" | "delete">(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [tick, setTick] = React.useState(0);
  const reload = () => setTick((n) => n + 1);
  const zone = me?.timeZone;

  React.useEffect(() => {
    let live = true;
    client.release(id).then(
      (r) => live && (setRel(r), setError(null)),
      (e) => live && setError(e)
    );
    return () => {
      live = false;
    };
  }, [client, id, tick]);

  // What the checks say about each document that is to be published.
  const open = !!rel && rel.state !== "published";
  const itemsKey = rel?.items.map((i) => `${i.documentId}:${i.currentVersion}:${i.action}`).join(",") ?? "";
  React.useEffect(() => {
    if (!rel || !open) return;
    let live = true;
    setProblems({});
    void Promise.all(
      rel.items
        .filter((i) => i.action === "publish" && i.currentVersion !== null)
        .map(async (i) => {
          try {
            const d = await client.get(i.collection, i.slug, { draft: true });
            const found = await client.diagnose(i.collection, toInput(d, d.fields), d.slug);
            return [i.documentId, found.filter((x) => x.severity === "error").length] as const;
          } catch {
            return [i.documentId, -1] as const;
          }
        })
    ).then((rows) => live && setProblems(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, itemsKey, open, checkTick]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      if (done) setStatus({ text: done, tone: "ok" });
      reload();
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (error && !rel)
    return (
      <div className={cn("p-6", className)}>
        <StatusText tone="error">{errorMessage(error, t)}</StatusText>
      </div>
    );
  if (!rel)
    return (
      <div className={cn("p-6", className)}>
        <StatusText>{t("loading")}</StatusText>
      </div>
    );

  const at = rel.publishedAt ?? rel.publishAt;
  const change = (i: Item) => {
    if (i.currentVersion === null) return <span className="text-muted-foreground">{t("release_gone")}</span>;
    if (i.action === "unpublish") return t("release_unpublish");
    if (i.stale)
      return (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          v{i.version} → v{i.currentVersion}
          {open ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={`${i.title}: ${t("release_refresh_item", { version: i.currentVersion })}`}
              title={t("release_refresh_item", { version: i.currentVersion })}
              disabled={busy}
              onClick={() => void act(() => client.addToRelease(rel.id, [{ collection: i.collection, slug: i.slug, action: "publish" }]))}
            >
              <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </span>
      );
    return (
      <>
        {t(i.state === "published" ? "publish" : "release_publish_new")} <span className="tabular-nums text-muted-foreground">v{i.version}</span>
      </>
    );
  };
  const problem = (i: Item) => {
    const stop = blocked.find((b) => b.collection === i.collection && b.slug === i.slug);
    const n = problems[i.documentId];
    if (!open) return null;
    if (!stop && n === -1)
      return (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CircleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("release_check_failed")}</span>
          <button type="button" className="shrink-0 rounded text-xs underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setCheckTick((x) => x + 1)}>
            {t("retry")}
          </button>
        </span>
      );
    if (!stop && n === undefined && i.action === "publish" && i.currentVersion !== null && i.canPublish) return <span className="text-muted-foreground">{t("release_checking")}</span>;
    if (stop || (n ?? 0) > 0 || !i.canPublish || i.currentVersion === null)
      return (
        <span className="inline-flex items-center gap-1.5 text-amber-700" title={stop?.message}>
          <CircleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{stop ? stop.message : n ? t("problems_n", { n }) : i.currentVersion === null ? t("release_gone") : t("review_needed")}</span>
        </span>
      );
    return <span className="text-muted-foreground">{t("problems_none")}</span>;
  };
  const collectionLabel = (slug: string) => me?.collections.find((c) => c.slug === slug)?.label ?? slug;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader
        title={rel.name}
        crumbs={[
          onBack ? (
            <button key="b" type="button" className="rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={onBack}>
              {t("nav_releases")}
            </button>
          ) : (
            t("nav_releases")
          ),
        ]}
        after={
          <>
            <ReleaseBadge state={rel.state} />
            {at ? <span className="text-xs tabular-nums text-muted-foreground">{formatZoned(at, locale, zone)}</span> : null}
          </>
        }
      >
        {open ? (
          <>
            <Button type="button" variant="outline" className="gap-1.5" onClick={() => setDialog("add")}>
              <Plus aria-hidden className="h-4 w-4" />
              {t("release_add")}
            </Button>
            {rel.canPublish ? (
              <>
                <Button type="button" variant="outline" className="gap-1.5" disabled={busy || !rel.items.length} onClick={() => setDialog("schedule")}>
                  <CalendarClock aria-hidden className="h-4 w-4" />
                  {t("sched_go")}
                </Button>
                <Button type="button" disabled={busy || !rel.items.length} onClick={() => setDialog("publish")}>
                  {t("publish")}
                </Button>
              </>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label={t("more")}>
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDialog("rename")}>{t("media_rename")}</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => setDialog("delete")}>
                  {t("release_delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </PageHeader>
      <div className="min-w-0 flex-1 px-4 py-4 md:px-6">
        {blocked.length ? (
          <div role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 [overflow-wrap:anywhere] dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <p className="font-medium">{t("release_blocked")}</p>
            <ul className="mt-1 list-disc pl-5">
              {blocked.map((b) => (
                <li key={`${b.collection}/${b.slug}`}>
                  {b.title}: {b.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {rel.lastError && open && !blocked.length ? <StatusText tone="error" className="mb-3 [overflow-wrap:anywhere]">{rel.lastError}</StatusText> : null}
        {!rel.items.length ? <p className="mx-auto max-w-sm py-16 text-center text-sm text-muted-foreground">{t("release_items_empty")}</p> : null}
        {rel.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_title")}</TableHead>
                <TableHead className="hidden w-[120px] sm:table-cell">{t("release_col_collection")}</TableHead>
                <TableHead className="w-[200px]">{t("release_col_change")}</TableHead>
                <TableHead className="hidden w-[200px] md:table-cell">{t("release_col_problem")}</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">{t("col_actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rel.items.map((i) => (
                <TableRow key={i.documentId}>
                  <TableCell className="max-w-0">
                    <button type="button" className="block max-w-full truncate text-left font-medium enabled:hover:underline" disabled={!onOpenDocument || i.currentVersion === null} onClick={() => onOpenDocument?.(i.collection, i.slug)}>
                      {i.title || i.slug}
                    </button>
                    <div className="truncate text-xs text-muted-foreground md:hidden">{problem(i)}</div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{collectionLabel(i.collection)}</TableCell>
                  <TableCell>{change(i)}</TableCell>
                  <TableCell className="hidden max-w-0 md:table-cell">{problem(i)}</TableCell>
                  <TableCell>
                    {open ? (
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={t("release_remove_item", { title: i.title || i.slug })} disabled={busy} onClick={() => void act(() => client.removeFromRelease(rel.id, i.documentId))}>
                        <X aria-hidden className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </div>
      <div className="flex items-center gap-3 px-4 py-3 text-xs text-muted-foreground md:px-6">
        <span className="tabular-nums">{t("release_count", { n: rel.items.length })}</span>
        <span className="flex-1" />
        <StatusText className="text-xs" tone={status?.tone === "error" ? "error" : status ? "ok" : "muted"}>
          {status?.text ?? ""}
        </StatusText>
      </div>

      {dialog === "add" ? <AddDocumentsDialog release={rel} onClose={() => setDialog(null)} onAdded={() => (setBlocked([]), reload())} /> : null}
      {dialog === "schedule" ? <ScheduleDialog release={rel} zone={zone ?? "UTC"} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog === "rename" ? <NameDialog title={t("media_rename")} initial={rel.name} action={t("save")} onClose={() => setDialog(null)} onSubmit={(n) => client.renameRelease(rel.id, n).then(reload)} /> : null}
      <ConfirmDialog
        open={dialog === "publish" || dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog === "delete" ? t("release_delete_title", { name: rel.name }) : t("release_publish_title", { name: rel.name })}
        description={dialog === "delete" ? t("release_delete_note") : t("release_publish_note", { n: rel.items.length })}
        confirmLabel={dialog === "delete" ? t("release_delete") : t("publish")}
        destructive={dialog === "delete"}
        busy={busy}
        onConfirm={async () => {
          const what = dialog;
          setDialog(null);
          if (what === "delete") {
            await act(() => client.removeRelease(rel.id));
            return onBack?.();
          }
          setBusy(true);
          setStatus(null);
          try {
            await client.publishRelease(rel.id);
            setBlocked([]);
            setStatus({ text: t("release_published_done"), tone: "ok" });
          } catch (e) {
            const list = isCmsRemoteError(e) ? (e.current as { blocked?: BlockedItem[] } | undefined)?.blocked : undefined;
            setBlocked(list ?? []);
            setStatus({ text: errorMessage(e, t), tone: "error" });
          } finally {
            setBusy(false);
            reload();
          }
        }}
      />
    </div>
  );
}

function ScheduleDialog({ release, zone, onClose, onDone }: { release: ReleaseView; zone: string; onClose: () => void; onDone: () => void }) {
  const { client, t } = useCms();
  const [v, setV] = React.useState(() => (release.publishAt ? zonedParts(release.publishAt, zone) : { date: zonedParts(new Date(Date.now() + 86_400_000).toISOString(), zone).date, time: "09:00" }));
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const send = (publishAt: string | null) => {
    setBusy(true);
    client.scheduleRelease(release.id, publishAt).then(
      () => (onDone(), onClose()),
      (e) => (setBusy(false), setError(errorMessage(e, t)))
    );
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.sm}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const iso = zonedToIso(v.date, v.time || "09:00", zone);
            if (!iso || Date.parse(iso) <= Date.now()) return setError(t("sched_past"));
            send(iso);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("publish_later")}</DialogTitle>
            <DialogDescription className="sr-only">{release.name}</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 flex w-full items-center text-sm font-medium">
              <span className="flex-1">{t("sched_publish_at")}</span>
              <span className="text-xs font-normal text-muted-foreground">{zone}</span>
            </legend>
            <div className="flex gap-2">
              <input type="date" aria-label={`${t("sched_publish_at")}: ${t("sched_date")}`} className={cn(SELECT, "min-w-0 flex-1 tabular-nums")} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
              <input type="time" aria-label={`${t("sched_publish_at")}: ${t("sched_time")}`} className={cn(SELECT, "w-[112px] tabular-nums")} value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} />
            </div>
            {error ? <StatusText tone="error">{error}</StatusText> : null}
          </fieldset>
          <DialogFooter>
            {release.publishAt ? (
              <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={busy} onClick={() => send(null)}>
                {t("sched_cancel")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !v.date}>
              {t("sched_go")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Find documents by title and add them, to publish or to unpublish. */
function AddDocumentsDialog({ release, onClose, onAdded }: { release: ReleaseView; onClose: () => void; onAdded: () => void }) {
  const { client, t, me } = useCms();
  const cols = (me?.collections ?? []).filter((c) => c.canWrite);
  const [col, setCol] = React.useState(cols[0]?.slug ?? "");
  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");
  const applyQ = useDebounced(setQ, 250);
  const [docs, setDocs] = React.useState<DocSummary[] | null>(null);
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());
  const [action, setAction] = React.useState<"publish" | "unpublish">("publish");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!col) return;
    let live = true;
    setDocs(null);
    client.list(col, { q: q || undefined, limit: 30 }).then(
      (r) => live && setDocs(r.docs),
      (e) => live && setError(errorMessage(e, t))
    );
    return () => {
      live = false;
    };
  }, [client, col, q, t]);

  const inside = new Set(release.items.map((i) => `${i.collection}/${i.slug}`));
  // Unpublishing only makes sense for what is public now.
  const rows = (docs ?? []).filter((d) => !inside.has(`${col}/${d.slug}`) && (action === "publish" || d.publishedVersion !== null));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.lg}>
        <form
          className="grid gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            client.addToRelease(release.id, [...picked].map((slug) => ({ collection: col, slug, action }))).then(
              () => (onAdded(), onClose()),
              (err) => (setBusy(false), setError(errorMessage(err, t)))
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("release_add")}</DialogTitle>
            <DialogDescription className="sr-only">{release.name}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={t("release_col_collection")} className={cn(SELECT, "max-w-[160px]")} value={col} onChange={(e) => (setCol(e.target.value), setPicked(new Set()))}>
              {cols.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label={t("release_pick")}
                placeholder={t("release_pick")}
                className="pl-8"
                autoFocus
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  applyQ(e.target.value.trim());
                }}
              />
            </div>
          </div>
          <Segmented
            label={t("release_action")}
            value={action}
            onChange={(a) => (setAction(a), setPicked(new Set()))}
            options={[
              { value: "publish", label: t("publish") },
              { value: "unpublish", label: t("release_unpublish") },
            ]}
          />
          <ul aria-label={t("release_col_docs")} className="max-h-64 min-h-24 overflow-y-auto rounded-md border">
            {rows.map((d) => (
              <li key={d.slug} className="border-b last:border-b-0">
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2">
                  <Checkbox
                    checked={picked.has(d.slug)}
                    onCheckedChange={(v) =>
                      setPicked((now) => {
                        const next = new Set(now);
                        if (v === true) next.add(d.slug);
                        else next.delete(d.slug);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.title || d.slug}</span>
                  <StateBadge state={d.state} />
                  <span className="text-xs tabular-nums text-muted-foreground">v{d.version}</span>
                </label>
              </li>
            ))}
            {docs && !rows.length ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t("no_results")}</li> : null}
          </ul>
          {error ? <StatusText tone="error">{error}</StatusText> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !picked.size}>
              {t("release_add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
