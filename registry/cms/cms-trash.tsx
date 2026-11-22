// agent-cms registry: cms-trash (0.10.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The trash: deleted documents and files wait here for `trash.days` days.
// Restore brings them back as they were (a published document goes public
// again); deleting forever is for admins.
"use client";

import * as React from "react";
import { CircleAlert, Search, Trash2, Undo2, X } from "lucide-react";
import type { TrashItem } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, PageHeader, Segmented, StatusText, EmptyState } from "./cms-parts";
import { trashChanged, useCms } from "./use-cms";

export interface CmsTrashProps {
  className?: string;
}

type Kind = TrashItem["kind"];

/** Whole days until `iso` (at least 0). */
export function daysLeft(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 86_400_000));
}

export function CmsTrash({ className }: CmsTrashProps) {
  const { client, t, locale, me } = useCms();
  const [data, setData] = React.useState<{ items: TrashItem[]; days: number; canPurge: boolean } | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [kind, setKind] = React.useState<Kind>("document");
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = React.useState<null | { what: "restore" | "purge"; ids: string[] } | { what: "empty" }>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const [q, setQ] = React.useState("");
  // What could not be restored stays on screen, each with its reason, until it is dismissed.
  const [failures, setFailures] = React.useState<{ id: string; title: string; where: string; message: string }[]>([]);

  React.useEffect(() => {
    let live = true;
    client.trash().then(
      (r) => live && (setData(r), setError(null), setPicked(new Set())),
      (e) => live && setError(e)
    );
    return () => {
      live = false;
    };
  }, [client, tick]);

  const all = data?.items ?? [];
  const docs = all.filter((i) => i.kind === "document");
  const files = all.filter((i) => i.kind === "asset");
  const hasFiles = !!me?.media || files.length > 0;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (i: TrashItem) => !words.length || words.every((w) => `${i.title} ${i.where} ${i.deletedBy ?? ""}`.toLowerCase().includes(w));
  const rows = (kind === "document" ? docs : files).filter(matches);
  const fullTime = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggle = (id: string, on: boolean) =>
    setPicked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const refs = (ids: string[]) => ids.map((id) => ({ kind, id }));
  const restorable = rows.filter((r) => picked.has(r.id) && r.canRestore).map((r) => r.id);

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    setProblem(null);
    try {
      // Only what the dialog showed: something trashed while it was open stays.
      if (confirm.what === "empty") setStatus(t("trash_purged", { n: (await client.purgeTrash(all.map((i) => ({ kind: i.kind, id: i.id })))).purged }));
      else if (confirm.what === "purge") setStatus(t("trash_purged", { n: (await client.purgeTrash(refs(confirm.ids))).purged }));
      else {
        const r = await client.restoreTrash(refs(confirm.ids));
        const failed = (r.results ?? []).filter((x) => !x.ok);
        setStatus(t("trash_restored", { n: r.restored }));
        setFailures(
          failed.length
            ? failed.map((x) => {
                const row = all.find((i) => i.id === x.id);
                return { id: x.id, title: row?.title ?? x.id, where: row?.where ?? "", message: x.error?.message ?? t("trash_slug_taken") };
              })
            : r.restored < confirm.ids.length
              ? [{ id: "?", title: t("trash_some_left", { n: confirm.ids.length - r.restored }), where: "", message: t("trash_slug_taken") }]
              : []
        );
      }
      setConfirm(null);
      setTick((n) => n + 1);
      trashChanged();
    } catch (e) {
      setProblem(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const bulk = "h-7 gap-1.5 px-2 text-[13px]";
  const n = confirm && confirm.what !== "empty" ? confirm.ids.length : all.length;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("nav_trash")}>
        {data?.canPurge && all.length ? (
          <Button type="button" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setConfirm({ what: "empty" })}>
            <Trash2 aria-hidden className="h-4 w-4" />
            {t("trash_empty_all")}
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex-1 px-4 py-4 md:px-6">
        {hasFiles ? (
          <div className="mb-3 flex items-center gap-2">
            <Segmented
              label={t("trash_kind")}
              value={kind}
              onChange={(k) => (setKind(k), setPicked(new Set()))}
              options={[
                { value: "document", label: t("trash_docs", { n: docs.length }) },
                { value: "asset", label: t("trash_files", { n: files.length }) },
              ]}
            />
          </div>
        ) : null}
        {all.length ? (
          <div className="relative mb-3 max-w-sm">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={q} onChange={(e) => (setQ(e.target.value), setPicked(new Set()))} placeholder={t("trash_search")} aria-label={t("trash_search")} className="h-9 pl-8" />
          </div>
        ) : null}
        {failures.length ? (
          <div role="alert" className="mb-3 flex min-w-0 flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm">
            <div className="flex items-center gap-2">
              <CircleAlert aria-hidden className="h-4 w-4 shrink-0 text-destructive" />
              <span className="flex-1 font-medium">{t("trash_not_restored", { n: failures.length })}</span>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("close")} onClick={() => setFailures([])}>
                <X aria-hidden className="h-4 w-4" />
              </Button>
            </div>
            <ul className="ml-6 flex flex-col gap-1 text-[13px]">
              {failures.map((f) => (
                <li key={f.id} className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="font-medium">{f.title}</span>
                  {f.where ? <span className="text-muted-foreground"> · {f.where}</span> : null}
                  <span className="block text-muted-foreground">{f.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {picked.size ? (
          <div role="toolbar" aria-label={t("bulk_bar")} className="mb-2.5 flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 py-1.5 pl-3 pr-2">
            <span className="mr-1 text-[13px] font-medium" role="status">
              {t("selected_n", { n: picked.size })}
            </span>
            <Button type="button" variant="outline" size="sm" className={bulk} disabled={!restorable.length} onClick={() => setConfirm({ what: "restore", ids: restorable })}>
              <Undo2 aria-hidden className="h-3.5 w-3.5" />
              {t("trash_restore")}
            </Button>
            {data?.canPurge ? (
              <Button type="button" variant="outline" size="sm" className={cn(bulk, "text-destructive hover:text-destructive")} onClick={() => setConfirm({ what: "purge", ids: [...picked] })}>
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
                {t("trash_purge")}
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" className={bulk} onClick={() => setPicked(new Set())}>
              {t("clear_selection")}
            </Button>
          </div>
        ) : null}
        {kind === "asset" && files.length ? <p className="mb-2.5 text-xs text-muted-foreground">{t("trash_file_note")}</p> : null}
        {error ? <StatusText tone="error">{errorMessage(error, t)}</StatusText> : null}
        {data && !rows.length && words.length && (kind === "document" ? docs : files).length ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("trash_no_match", { q })}{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => setQ("")}>
              {t("clear_search")}
            </button>
          </p>
        ) : data && !rows.length ? (
          <EmptyState icon={Trash2} title={t("trash_none")} text={t("trash_none_text", { days: data.days ?? 30 })} />
        ) : null}
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-9">
                  <Checkbox aria-label={t("select_all")} checked={allPicked} aria-checked={allPicked ? "true" : rows.some((r) => picked.has(r.id)) ? "mixed" : "false"} onCheckedChange={(v) => setPicked(v === true ? new Set(rows.map((r) => r.id)) : new Set())} />
                </TableHead>
                <TableHead>{t("name")}</TableHead>
                <TableHead className="hidden w-[160px] md:table-cell">{t("trash_col_where")}</TableHead>
                <TableHead className="hidden w-[150px] md:table-cell">{t("trash_col_by")}</TableHead>
                <TableHead className="hidden w-[130px] sm:table-cell">{t("trash_col_at")}</TableHead>
                <TableHead className="w-[110px] text-right">{t("trash_col_left")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} data-state={picked.has(r.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox aria-label={t("select_row", { title: r.title })} checked={picked.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                  </TableCell>
                  <TableCell className="max-w-0">
                    <div className="break-words font-medium md:truncate" title={r.title}>
                      {r.title}
                    </div>
                    <div className="break-all text-xs text-muted-foreground md:hidden">{r.where}</div>
                    {/* On a phone the dates are below the name, exact. */}
                    <div className="text-xs text-muted-foreground sm:hidden">
                      {t("trash_deleted_at", { at: fullTime(r.deletedAt) })}
                      {r.deletedBy ? ` · ${r.deletedBy}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-0 truncate text-[13.5px] md:table-cell">{r.where}</TableCell>
                  <TableCell className="hidden max-w-0 truncate text-[13.5px] md:table-cell">{r.deletedBy ?? ""}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">
                    <time dateTime={r.deletedAt} title={fullTime(r.deletedAt)}>
                      {new Date(r.deletedAt).toLocaleDateString(locale)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.purgeAt ? (
                      // Days for a glance; the exact moment on hover and for screen readers.
                      <time dateTime={r.purgeAt} title={t("trash_purge_at", { at: fullTime(r.purgeAt) })} aria-label={t("trash_purge_at", { at: fullTime(r.purgeAt) })} className={cn(daysLeft(r.purgeAt) <= 1 && "font-medium text-destructive")}>
                        {daysLeft(r.purgeAt) <= 1 ? t("trash_purge_soon", { at: new Date(r.purgeAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }) : t("days_n", { n: daysLeft(r.purgeAt) })}
                      </time>
                    ) : (
                      ""
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </div>
      <div className="flex items-center gap-3 px-4 py-3 text-xs text-muted-foreground md:px-6">
        <StatusText className="text-xs">{status ?? (data ? (rows.length ? t("shown_of", { shown: rows.length, total: (kind === "document" ? docs : files).length }) : "") : t("loading"))}</StatusText>
      </div>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setProblem(null);
          }
        }}
        title={!confirm ? "" : confirm.what === "empty" ? t("trash_purge_all") : confirm.what === "purge" ? t("trash_purge_title", { n }) : t(kind === "document" ? "trash_restore_docs" : "trash_restore_files", { n })}
        description={
          !confirm
            ? undefined
            : confirm.what === "restore"
              ? kind === "document"
                ? [t("trash_restore_note"), rows.filter((r) => confirm.ids.includes(r.id) && r.state === "published").length ? t("trash_restore_public", { n: rows.filter((r) => confirm.ids.includes(r.id) && r.state === "published").length }) : ""].filter(Boolean).join(" ")
                : undefined
              : t("trash_purge_note")
        }
        confirmLabel={confirm?.what === "restore" ? t("trash_restore") : confirm?.what === "empty" ? t("trash_empty_all") : t("trash_purge")}
        destructive={confirm?.what !== "restore"}
        busy={busy}
        error={problem}
        onConfirm={run}
      >
        {confirm && confirm.what !== "empty" ? (
          <ul className="max-h-60 overflow-y-auto rounded-md border">
            {rows
              .filter((r) => confirm.ids.includes(r.id))
              .map((r) => (
                <li key={r.id} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <span className="flex-1 truncate text-sm font-medium">{r.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{r.where}</span>
                </li>
              ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
