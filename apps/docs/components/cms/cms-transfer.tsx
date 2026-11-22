// agent-cms registry: cms-transfer (0.13.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Import and export. Import: pick an export file (.json) or markdown files, see
// what each would do (new, v7 → v8, same, problems) before anything is saved,
// then import the ones you ticked as drafts. Export: every document as markdown.
"use client";

import * as React from "react";
import { CircleAlert, Download, FileText, Upload } from "lucide-react";
import type { ImportConflict, ImportItem, TransferFile } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, PageHeader, Segmented, StatusText } from "./cms-parts";
import { fileSize } from "./cms-upload";
import { useCms } from "./use-cms";

const SELECT = "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CONFLICTS: ImportConflict[] = ["db-wins", "newest", "file-wins"];

/** The files inside what a person picked: an export bundle, or markdown files as they are. */
export async function readTransferFiles(picked: File[]): Promise<TransferFile[]> {
  const out: TransferFile[] = [];
  for (const f of picked) {
    const text = await f.text();
    if (/\.json$/i.test(f.name)) {
      const data = JSON.parse(text) as { files?: TransferFile[] };
      if (!Array.isArray(data.files)) throw new Error("not an export file");
      out.push(...data.files.filter((x) => typeof x?.path === "string" && typeof x?.text === "string"));
    } else out.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, text });
  }
  return out;
}

export function CmsTransfer({ className }: { className?: string }) {
  const { client, t, me } = useCms();
  const [tab, setTab] = React.useState<"import" | "export">("import");
  const cols = (me?.collections ?? []).filter((c) => c.canWrite);
  const [collection, setCollection] = React.useState("");
  // Keeping what is in the CMS is the safe start; overwriting is a choice made on purpose.
  const [conflict, setConflict] = React.useState<ImportConflict>("db-wins");
  const [confirming, setConfirming] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [publish, setPublish] = React.useState(false);
  const [drafts, setDrafts] = React.useState(true);
  const [picked, setPicked] = React.useState<{ name: string; size: number; files: TransferFile[] } | null>(null);
  const [items, setItems] = React.useState<ImportItem[] | null>(null);
  const [on, setOn] = React.useState<Set<string>>(new Set());
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" | "muted" }>({ text: "", tone: "muted" });
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const itemsRef = React.useRef<ImportItem[] | null>(null);
  itemsRef.current = items;

  // Look again whenever the files or the choices change: nothing is saved by a dry run.
  React.useEffect(() => {
    if (!picked) return setItems(null);
    let live = true;
    setBusy(true);
    client.importDocs(picked.files, { dryRun: true, onConflict: conflict, collection: collection || undefined }).then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        // Choices made for files that are still importable are kept; new ones start ticked.
        setOn((prev) => {
          const ok = r.items.filter((i) => i.change === "new" || i.change === "update").map((i) => i.path);
          if (!prev.size) return new Set(ok);
          // Files that could already be imported keep their tick; ones that just became importable are ticked.
          const before = new Set((itemsRef.current ?? []).filter((i) => i.change === "new" || i.change === "update").map((i) => i.path));
          return new Set(ok.filter((p) => prev.has(p) || !before.has(p)));
        });
        setStatus({ text: "", tone: "muted" });
        setBusy(false);
      },
      (e) => live && (setStatus({ text: errorMessage(e, t), tone: "error" }), setItems(null), setBusy(false))
    );
    return () => {
      live = false;
    };
  }, [client, picked, conflict, collection, t]);

  async function pick(list: FileList | null) {
    if (!list?.length) return;
    try {
      const all = [...list];
      setPicked({ name: all.length === 1 ? all[0].name : `${all[0].name} +${all.length - 1}`, size: all.reduce((n, f) => n + f.size, 0), files: await readTransferFiles(all) });
    } catch {
      setPicked(null);
      setStatus({ text: t("transfer_bad_file"), tone: "error" });
    }
  }
  async function run(sure = false) {
    if (!picked) return;
    const overwrites = (items ?? []).filter((i) => i.change === "update" && on.has(i.path)).length;
    if (overwrites && !sure) return setConfirming(true);
    setConfirming(false);
    setBusy(true);
    try {
      const r = await client.importDocs(picked.files, { onConflict: conflict, collection: collection || undefined, publish, only: [...on] });
      setStatus({ text: t("transfer_done", { n: r.items.filter((i) => (i.change === "new" || i.change === "update") && i.toVersion).length }), tone: "ok" });
      setPicked(null);
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const can = (i: ImportItem) => i.change === "new" || i.change === "update";
  const selectable = (items ?? []).filter(can);
  const what = (i: ImportItem) => (i.change === "update" ? `v${i.fromVersion} → v${i.toVersion}` : t(`change.${i.change}` as never));

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("transfer_title")} />
      <div className="border-b px-4 py-2 md:px-6">
        <Segmented
          label={t("transfer_title")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "import", label: (<span className="inline-flex items-center gap-1.5"><Download aria-hidden className="h-3.5 w-3.5" />{t("transfer_import")}</span>) },
            { value: "export", label: (<span className="inline-flex items-center gap-1.5"><Upload aria-hidden className="h-3.5 w-3.5" />{t("transfer_export")}</span>) },
          ]}
        />
      </div>
      {tab === "export" ? (
        <div className="flex max-w-xl flex-col gap-4 px-4 py-4 md:px-6">
          <p className="text-sm text-muted-foreground">{t("transfer_export_text")}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cms-export-col">{t("transfer_collection")}</Label>
            <select id="cms-export-col" className={cn(SELECT, "max-w-xs")} value={collection} onChange={(e) => setCollection(e.target.value)}>
              <option value="">{t("transfer_all_collections")}</option>
              {(me?.collections ?? []).map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={drafts} onCheckedChange={(v) => setDrafts(v === true)} />
            {t("transfer_drafts")}
          </label>
          <a href={client.exportUrl({ collections: collection ? [collection] : undefined, drafts })} download className="inline-flex h-9 items-center gap-1.5 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring">
            <Upload aria-hidden className="h-4 w-4" />
            {t("transfer_download")}
            </a>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6">
          <div
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void pick(e.dataTransfer.files);
            }}
            className={cn("flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center", dragging && "border-primary bg-primary/5", picked && "flex-row py-3 text-left")}
          >
            <input ref={fileRef} type="file" multiple accept=".json,.md,.markdown,.mdx" className="sr-only" aria-label={t("transfer_choose")} onChange={(e) => (void pick(e.target.files), (e.target.value = ""))} />
            {picked ? (
              <>
                <FileText aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{picked.name}</span>
                  <span className="text-xs text-muted-foreground">{t("transfer_picked", { n: picked.files.length, size: fileSize(picked.size) })}</span>
                </span>
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => fileRef.current?.click()}>
                  {t("transfer_change")}
                </Button>
              </>
            ) : (
              <>
                <Download aria-hidden className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">{t("transfer_drop")}</p>
                <p className="max-w-md text-xs text-muted-foreground">{t("transfer_hint")}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  {t("transfer_choose")}
                </Button>
              </>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="cms-import-col">{t("transfer_collection")}</Label>
              <select id="cms-import-col" className={cn(SELECT, "w-full")} value={collection} onChange={(e) => setCollection(e.target.value)}>
                <option value="">{t("transfer_from_file")}</option>
                {cols.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{collection ? t("transfer_collection_one") : t("transfer_collection_file")}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="cms-import-conflict">{t("transfer_conflict")}</Label>
              <select id="cms-import-conflict" className={cn(SELECT, "w-full")} value={conflict} onChange={(e) => setConflict(e.target.value as ImportConflict)}>
                {CONFLICTS.map((c) => (
                  <option key={c} value={c}>
                    {t(`conflict.${c}` as never)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t(`conflict_hint.${conflict}` as never)}</p>
            </div>
          </div>
          <StatusText tone={status.tone} className="text-sm">
            {status.text || (picked && busy ? t("transfer_checking") : "")}
          </StatusText>
          {items?.length ? (
            <p className="text-sm">
              {t("transfer_summary", {
                fresh: items.filter((i) => i.change === "new").length,
                update: items.filter((i) => i.change === "update").length,
                same: items.filter((i) => i.change !== "new" && i.change !== "update" && i.change !== "error").length,
                bad: items.filter((i) => i.change === "error").length,
              })}
            </p>
          ) : null}
          {items?.length ? (
            <ul className={cn("flex min-w-0 flex-col divide-y rounded-md border", busy && "opacity-60")} aria-busy={busy || undefined}>
              <li className="flex items-center gap-3 bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                <Checkbox aria-label={t("transfer_select_all")} disabled={!selectable.length} checked={selectable.length > 0 && on.size === selectable.length} aria-checked={selectable.length > 0 && on.size === selectable.length ? "true" : on.size ? "mixed" : "false"} onCheckedChange={(v) => setOn(new Set(v === true ? selectable.map((i) => i.path) : []))} />
                <span className="flex-1">{t("transfer_doc_title")}</span>
                <span className="w-28 shrink-0 text-right">{t("transfer_changes")}</span>
              </li>
              {items.map((i) => {
                const bad = i.diagnostics.length > 0;
                const expanded = open === i.path;
                return (
                  <li key={i.path} className="flex min-w-0 flex-col px-3 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <Checkbox aria-label={i.title || i.path} disabled={!can(i)} checked={on.has(i.path)} onCheckedChange={(v) => setOn((s) => (v === true ? new Set(s).add(i.path) : new Set([...s].filter((p) => p !== i.path))))} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <bdi className="truncate text-sm font-medium">{i.title || i.path}</bdi>
                        <span className="truncate font-mono text-[11px] text-muted-foreground" title={i.path}>
                          {i.path}
                        </span>
                        {i.change === "error" && i.reason ? <span className="text-xs text-destructive [overflow-wrap:anywhere]">{i.reason}</span> : null}
                      </span>
                      {bad ? (
                        <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i.path)} className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-amber-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-400">
                          <CircleAlert aria-hidden className="h-3.5 w-3.5" />
                          {i.change === "error" ? t("change.error") : t("transfer_problem_n", { n: i.diagnostics.length })}
                        </button>
                      ) : null}
                      <span className={cn("w-28 shrink-0 text-right text-xs", i.change === "update" ? "font-medium text-amber-700 dark:text-amber-400" : can(i) ? "" : "text-muted-foreground")}>{what(i)}</span>
                    </div>
                    {expanded ? (
                      <ul className="ml-7 mt-1.5 flex flex-col gap-1 rounded bg-muted/50 px-3 py-2 text-xs [overflow-wrap:anywhere]">
                        {i.reason && i.change !== "error" ? <li>{i.reason}</li> : null}
                        {i.diagnostics.map((d, n) => (
                          <li key={n}>
                            <span className="font-mono text-muted-foreground">{d.path}</span> {d.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {items?.length ? (
            <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-3 border-t bg-background py-3">
              <span className="text-xs text-muted-foreground">{t("transfer_selected", { n: on.size, total: items.length })}</span>
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Checkbox checked={publish} onCheckedChange={(v) => setPublish(v === true)} />
                {t("transfer_publish")}
              </label>
              <Button type="button" disabled={busy || !on.size} onClick={() => void run()}>
                {t("transfer_run_n", { n: on.size })}
              </Button>
            </div>
          ) : null}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("transfer_overwrite_title", { n: (items ?? []).filter((i) => i.change === "update" && on.has(i.path)).length })}
            description={t("transfer_overwrite_text")}
            confirmLabel={t("transfer_overwrite_ok")}
            onConfirm={() => void run(true)}
          />
        </div>
      )}
    </div>
  );
}
