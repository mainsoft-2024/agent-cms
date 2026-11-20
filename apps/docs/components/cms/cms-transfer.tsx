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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { PageHeader, Segmented, StatusText } from "./cms-parts";
import { useCms } from "./use-cms";

const SELECT = "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CONFLICTS: ImportConflict[] = ["file-wins", "db-wins", "newest"];

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
  const [conflict, setConflict] = React.useState<ImportConflict>("file-wins");
  const [publish, setPublish] = React.useState(false);
  const [drafts, setDrafts] = React.useState(true);
  const [picked, setPicked] = React.useState<{ name: string; size: number; files: TransferFile[] } | null>(null);
  const [items, setItems] = React.useState<ImportItem[] | null>(null);
  const [on, setOn] = React.useState<Set<string>>(new Set());
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" | "muted" }>({ text: "", tone: "muted" });
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Look again whenever the files or the choices change: nothing is saved by a dry run.
  React.useEffect(() => {
    if (!picked) return setItems(null);
    let live = true;
    setBusy(true);
    client.importDocs(picked.files, { dryRun: true, onConflict: conflict, collection: collection || undefined }).then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        setOn(new Set(r.items.filter((i) => i.change === "new" || i.change === "update").map((i) => i.path)));
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
  async function run() {
    if (!picked) return;
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cms-import-col">{t("transfer_collection")}</Label>
              <select id="cms-import-col" className={cn(SELECT, "w-48")} value={collection} onChange={(e) => setCollection(e.target.value)}>
                <option value="">{t("transfer_from_file")}</option>
                {cols.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cms-import-conflict">{t("transfer_conflict")}</Label>
              <select id="cms-import-conflict" className={cn(SELECT, "w-56")} value={conflict} onChange={(e) => setConflict(e.target.value as ImportConflict)}>
                {CONFLICTS.map((c) => (
                  <option key={c} value={c}>
                    {t(`conflict.${c}` as never)}
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
              {picked ? (
                <>
                  <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{picked.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{Math.max(1, Math.round(picked.size / 1024))}KB</span>
                </>
              ) : null}
              <input ref={fileRef} type="file" multiple accept=".json,.md,.markdown" className="sr-only" aria-label={t("transfer_choose")} onChange={(e) => (void pick(e.target.files), (e.target.value = ""))} />
              <Button type="button" variant={picked ? "ghost" : "outline"} size="sm" onClick={() => fileRef.current?.click()}>
                {picked ? t("transfer_change") : t("transfer_choose")}
              </Button>
            </div>
          </div>
          <StatusText tone={status.tone} className="text-xs">
            {status.text || (!picked ? t("transfer_hint") : busy && !items ? t("loading") : "")}
          </StatusText>
          {items?.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox aria-label={t("transfer_select_all")} checked={selectable.length > 0 && on.size === selectable.length} onCheckedChange={(v) => setOn(new Set(v === true ? selectable.map((i) => i.path) : []))} />
                    </TableHead>
                    <TableHead>{t("transfer_file")}</TableHead>
                    <TableHead>{t("transfer_doc_title")}</TableHead>
                    <TableHead>{t("transfer_changes")}</TableHead>
                    <TableHead>{t("transfer_problems")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((i) => (
                    <TableRow key={i.path}>
                      <TableCell>
                        <Checkbox aria-label={i.path} disabled={!can(i)} checked={on.has(i.path)} onCheckedChange={(v) => setOn((s) => (v === true ? new Set(s).add(i.path) : new Set([...s].filter((p) => p !== i.path))))} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{i.path}</TableCell>
                      <TableCell className="max-w-[16rem] truncate">{i.title}</TableCell>
                      <TableCell className={cn("whitespace-nowrap", can(i) ? "" : "text-muted-foreground")}>{what(i)}</TableCell>
                      <TableCell className="text-sm">
                        {i.change === "error" || i.diagnostics.length ? (
                          <span className="inline-flex items-center gap-1.5 text-amber-700" title={i.reason ?? i.diagnostics.map((d) => d.message).join("\n")}>
                            <CircleAlert aria-hidden className="h-4 w-4 shrink-0" />
                            {i.change === "error" ? (i.reason ?? t("change.error")) : t("transfer_problem_n", { n: i.diagnostics.length })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t("transfer_no_problems")}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {items?.length ? (
            <div className="mt-auto flex flex-wrap items-center gap-3 border-t pt-3">
              <span className="text-xs text-muted-foreground">{t("transfer_selected", { n: on.size, total: items.length })}</span>
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Checkbox checked={publish} onCheckedChange={(v) => setPublish(v === true)} />
                {t("transfer_publish")}
              </label>
              <Button type="button" disabled={busy || !on.size} onClick={run}>
                {t("transfer_run")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
