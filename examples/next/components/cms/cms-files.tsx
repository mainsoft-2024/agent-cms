// agent-cms registry: cms-files (0.9.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The file manager: a storage bucket as it is, folder by folder, also files
// nobody uploaded through the CMS. Move, download, share and delete several
// at once. Opening a file shows the media library's panel for it.
"use client";

import * as React from "react";
import { ChevronRight, Download, File as FileIcon, FileArchive, FileText, Film, Folder, FolderInput, FolderPlus, Image as ImageIcon, Link as LinkIcon, Music, Search, Trash2, FolderOpen } from "lucide-react";
import type { AssetUsage, ShareTtl, StoreFile, StoreListing } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AssetPanel, NewFolderDialog, UsageList, type CmsMediaProps } from "./cms-media";
import { kindName, SELECT_CLASS, storeLabel, UploadButton, UploadPanel, useUploads } from "./cms-media-picker";
import { errorMessage, type T } from "./cms-messages";
import { CodeBox, ConfirmDialog, PageHeader, Segmented, StatusText, DIALOG, NativeSelect } from "./cms-parts";
import { fileSize } from "./cms-upload";
import { formatUntil, useCms, useDebounced } from "./use-cms";

export type CmsFilesProps = CmsMediaProps;

const ICON = { image: ImageIcon, video: Film, audio: Music, document: FileText, other: FileIcon, folder: Folder } as const;

/** "PDF", "Word document", "PNG Image": what a file is, for the Type column. */
export function fileKind(f: Pick<StoreFile, "kind" | "name">, t: T): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1].toLowerCase();
  if (ext === "pdf") return "PDF";
  if (ext === "doc" || ext === "docx") return t("files_kind_word");
  if (ext === "zip") return t("files_kind_archive");
  return kindName(f, t);
}

export function CmsFiles({ basePath = "/admin", docHref, className }: CmsFilesProps) {
  const { client, t, me, locale } = useCms();
  const stores = (me?.media?.stores ?? []).filter((s) => s.can.browse);
  const [storeName, setStoreName] = React.useState<string | null>(null);
  const store = stores.find((s) => s.name === storeName) ?? stores[0];
  const [prefix, setPrefix] = React.useState("");
  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");
  const [listing, setListing] = React.useState<StoreListing | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [tick, setTick] = React.useState(0);
  // "f:<path>" for a folder, "k:<key>" for a file.
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<null | "move" | "delete" | "share" | "folder">(null);
  const applyQ = useDebounced(setQ, 250);
  const name = store?.name;
  const reload = () => setTick((n) => n + 1);
  const uploads = useUploads(reload);

  // Which folder the rows on screen belong to: a page for another folder is dropped,
  // and the old rows are not offered (or acted on) while the new folder loads.
  const view = `${name}\n${prefix}\n${q}`;
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const [shownView, setShownView] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!name) return;
    let live = true;
    setPicked(new Set());
    client.storeFiles(name, { prefix, q: q || undefined }).then(
      (r) => live && (setListing(r), setShownView(view), setError(null)),
      (e) => live && setError(e)
    );
    return () => {
      live = false;
    };
  }, [client, name, prefix, q, tick]);

  if (me && !store) return <StatusText className="p-6">{t("media_empty")}</StatusText>;
  if (!store) return null;

  const go = (s: string, p: string) => {
    setStoreName(s);
    setPrefix(p);
    setText("");
    setQ("");
    setOpenId(null);
  };
  const stale = shownView !== view;
  const rows = [...(listing?.folders ?? []).map((f) => `f:${f.path}`), ...(listing?.files ?? []).map((f) => `k:${f.key}`)];
  const all = rows.length > 0 && rows.every((r) => picked.has(r));
  const toggle = (id: string, on: boolean) =>
    setPicked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const sel = { keys: [...picked].filter((p) => p.startsWith("k:")).map((p) => p.slice(2)), folders: [...picked].filter((p) => p.startsWith("f:")).map((p) => p.slice(2)) };
  const selFiles = (listing?.files ?? []).filter((f) => picked.has(`k:${f.key}`));
  const open = async (f: StoreFile) => {
    if (f.asset) return setOpenId(f.asset.id);
    // A file the CMS has no row for gets one when someone opens it.
    if (!store.can.write) return void window.open(client.storeFileUrl(store.name, f.key), "_blank", "noopener,noreferrer");
    try {
      const a = await client.registerFile(store.name, f.key);
      setListing((l) => (l ? { ...l, files: l.files.map((x) => (x.key === f.key ? { ...x, asset: a } : x)) } : l));
      setOpenId(a.id);
    } catch (e) {
      setError(e);
    }
  };
  const download = () => {
    for (const f of selFiles) {
      const a = document.createElement("a");
      a.href = client.storeFileUrl(store.name, f.key, { download: true });
      a.download = f.name;
      a.click();
    }
  };
  const more = async () => {
    if (!listing?.cursor || stale) return;
    const asked = view;
    const r = await client.storeFiles(store.name, { prefix, q: q || undefined, cursor: listing.cursor }).catch((e: unknown) => (asked === viewRef.current && setError(e), null));
    if (r && asked === viewRef.current) setListing((l) => (l ? { ...r, folders: [...l.folders, ...r.folders.filter((f) => !l.folders.some((x) => x.path === f.path))], files: [...l.files, ...r.files] } : r));
  };
  const parts = prefix ? prefix.split("/") : [];
  const bulk = "h-7 gap-1.5 px-2 text-[13px]";

  return (
    <div className={cn("flex min-h-full flex-col", className)}>
      <PageHeader title={t("nav_files")}>
        {store.can.write ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setDialog("folder")}>
              <FolderPlus aria-hidden className="h-4 w-4" />
              {t("media_new_folder")}
            </Button>
            <UploadButton size="sm" accept={store.accept} onFiles={(files) => uploads.add(files, { store: store.name, folder: prefix })} />
          </>
        ) : null}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 md:px-5">
            {/* One store: its name is the path's first step. Several: the select names it, and the path starts at a folder icon. */}
            {stores.length > 1 ? (
              <NativeSelect aria-label={t("files_store")} className={cn(SELECT_CLASS, "max-w-[180px]")} value={store.name} onChange={(e) => go(e.target.value, "")}>
                {stores.map((s) => (
                  <option key={s.name} value={s.name}>
                    {storeLabel(s, t)}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            <nav aria-label={t("files_path")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
              {[storeLabel(store, t), ...parts].map((p, i) => {
                const last = i === parts.length;
                const icon = i === 0 && stores.length > 1;
                const label = icon ? <FolderOpen aria-hidden className="h-4 w-4" /> : p;
                return (
                  <React.Fragment key={i}>
                    {i ? <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                    {last ? (
                      <span aria-current="page" aria-label={icon ? p : undefined} className="inline-flex items-center whitespace-nowrap font-medium">
                        {label}
                      </span>
                    ) : (
                      <button type="button" aria-label={icon ? p : undefined} className="inline-flex items-center whitespace-nowrap rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => go(store.name, parts.slice(0, i).join("/"))}>
                        {label}
                      </button>
                    )}
                  </React.Fragment>
                );
              })}
            </nav>
            <div className="relative w-full md:w-[220px]">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label={t("files_search")}
                placeholder={t("files_search")}
                className="pl-8"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  applyQ(e.target.value.trim());
                }}
              />
            </div>
          </div>
          {picked.size ? (
            <div role="toolbar" aria-label={t("bulk_bar")} className="flex flex-wrap items-center gap-1.5 border-b bg-muted/50 px-4 py-2 md:px-5">
              <span className="mr-1 text-[13px] font-medium" role="status">
                {t("selected_n", { n: picked.size })}
              </span>
              {store.can.delete ? (
                <Button type="button" variant="outline" size="sm" className={bulk} onClick={() => setDialog("move")}>
                  <FolderInput aria-hidden className="h-3.5 w-3.5" />
                  {t("files_move")}
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" className={bulk} disabled={!selFiles.length} onClick={download}>
                <Download aria-hidden className="h-3.5 w-3.5" />
                {t("media_download")}
              </Button>
              {store.can.delete ? (
                <>
                  <Button type="button" variant="outline" size="sm" className={bulk} disabled={!selFiles.length || sel.folders.length > 0} onClick={() => setDialog("share")}>
                    <LinkIcon aria-hidden className="h-3.5 w-3.5" />
                    {t("files_share")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className={cn(bulk, "text-destructive hover:text-destructive")} onClick={() => setDialog("delete")}>
                    <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    {t("action_delete")}
                  </Button>
                </>
              ) : null}
              <span className="flex-1" />
              <Button type="button" variant="ghost" size="sm" className={bulk} onClick={() => setPicked(new Set())}>
                {t("clear_selection")}
              </Button>
            </div>
          ) : null}
          <div className="min-w-0 flex-1" aria-busy={stale || undefined}>
            {error ? (
              <div className="flex items-center gap-3 px-5 py-3">
                <StatusText tone="error">{errorMessage(error, t)}</StatusText>
                <Button type="button" variant="outline" size="sm" onClick={reload}>
                  {t("retry")}
                </Button>
              </div>
            ) : null}
            {stale && !error ? (
              <ul aria-label={t("loading")} className="flex flex-col gap-2 px-5 py-4">
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i} className="h-8 animate-pulse rounded bg-muted" />
                ))}
              </ul>
            ) : null}
            {!stale && listing && !rows.length && !error ? <p className="py-16 text-center text-sm text-muted-foreground">{q ? t("no_results") : t("files_folder_empty")}</p> : null}
            {!stale && rows.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 pl-4 md:pl-5">
                      <Checkbox aria-label={t("select_all")} checked={all} onCheckedChange={(v) => setPicked(v === true ? new Set(rows) : new Set())} />
                    </TableHead>
                    <TableHead>{t("media_col_name")}</TableHead>
                    <TableHead className="hidden w-[150px] md:table-cell">{t("media_col_kind")}</TableHead>
                    <TableHead className="w-[90px] text-right">{t("media_col_size")}</TableHead>
                    <TableHead className="hidden w-[130px] md:table-cell">{t("media_col_updated")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(listing?.folders ?? []).map((f) => (
                    <TableRow key={`f:${f.path}`} data-state={picked.has(`f:${f.path}`) ? "selected" : undefined}>
                      <TableCell className="pl-4 md:pl-5">
                        <Checkbox aria-label={t("select_row", { title: f.name })} checked={picked.has(`f:${f.path}`)} onCheckedChange={(v) => toggle(`f:${f.path}`, v === true)} />
                      </TableCell>
                      <TableCell className="max-w-0">
                        <button type="button" onClick={() => go(store.name, f.path)} className="flex w-full items-center gap-2.5 rounded text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{f.name}</span>
                        </button>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{t("files_kind_folder")}</TableCell>
                      <TableCell />
                      <TableCell className="hidden md:table-cell" />
                    </TableRow>
                  ))}
                  {(listing?.files ?? []).map((f) => {
                    const Icon = f.name.toLowerCase().endsWith(".zip") ? FileArchive : ICON[f.kind];
                    return (
                      <TableRow key={`k:${f.key}`} data-state={picked.has(`k:${f.key}`) || (f.asset && f.asset.id === openId) ? "selected" : undefined}>
                        <TableCell className="pl-4 md:pl-5">
                          <Checkbox aria-label={t("select_row", { title: f.name })} checked={picked.has(`k:${f.key}`)} onCheckedChange={(v) => toggle(`k:${f.key}`, v === true)} />
                        </TableCell>
                        <TableCell className="max-w-0">
                          <button type="button" onClick={() => void open(f)} className="flex w-full items-center gap-2.5 rounded text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{f.name}</span>
                          </button>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">{fileKind(f, t)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fileSize(f.size)}</TableCell>
                        <TableCell className="hidden tabular-nums md:table-cell">{f.updatedAt ? new Date(f.updatedAt).toLocaleDateString(locale) : ""}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : null}
          </div>
          {listing ? (
            <footer className="flex items-center gap-3 border-t px-4 py-2.5 text-sm text-muted-foreground md:px-5">
              <span className="tabular-nums">{t("files_count", { folders: listing.folders.length, files: listing.files.length })}</span>
              {listing.cursor ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void more()}>
                  {t("load_more")}
                </Button>
              ) : null}
            </footer>
          ) : null}
        </section>
        {openId ? <AssetPanel key={openId} id={openId} basePath={basePath} docHref={docHref} onClose={() => setOpenId(null)} onChanged={() => {}} onDeleted={() => (setOpenId(null), reload())} /> : null}
      </div>
      <NewFolderDialog
        open={dialog === "folder"}
        onOpenChange={(o) => setDialog(o ? "folder" : null)}
        onCreate={async (folder) => {
          await client.createAssetFolder(`${prefix ? `${prefix}/` : ""}${folder}`, store.name);
          reload();
        }}
      />
      {dialog === "move" ? <MoveDialog store={store.name} from={prefix} sel={sel} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog === "delete" ? <DeleteDialog store={store.name} sel={sel} basePath={basePath} docHref={docHref} onClose={() => setDialog(null)} onDone={() => (setOpenId(null), reload())} /> : null}
      {dialog === "share" ? <ShareDialog store={store.name} isPrivate={store.visibility === "private"} canRegister={store.can.write} files={selFiles} onClose={() => setDialog(null)} /> : null}
      <UploadPanel items={uploads.items} onRetry={uploads.retry} onRemove={uploads.remove} onClose={uploads.clear} />
    </div>
  );
}

type Sel = { keys: string[]; folders: string[] };

function MoveDialog({ store, from, sel, onClose, onDone }: { store: string; from: string; sel: Sel; onClose: () => void; onDone: () => void }) {
  const { client, t } = useCms();
  const [to, setTo] = React.useState(from);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.sm}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            client.moveFiles(store, { ...sel, to: to.trim().replace(/^\/+|\/+$/g, "") }).then(
              (r) => {
                setBusy(false);
                onDone();
                if (r.failed.length) setProblem(`${t("files_move_failed", { n: r.failed.length })} ${r.failed[0].message}`);
                else onClose();
              },
              (err) => (setBusy(false), setProblem(errorMessage(err, t)))
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("files_move")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cms-move-to">{t("media_folder")}</Label>
            <Input id="cms-move-to" autoFocus value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={problem ? true : undefined} />
            {problem ? <StatusText tone="error">{problem}</StatusText> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || to.trim().replace(/^\/+|\/+$/g, "") === from}>
              {t("files_move")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ store, sel, basePath, docHref, onClose, onDone }: { store: string; sel: Sel; basePath: string; docHref?: CmsMediaProps["docHref"]; onClose: () => void; onDone: () => void }) {
  const { client, t } = useCms();
  // Count first: a folder may hold many files, and some may be in use.
  const [found, setFound] = React.useState<{ files: number; used: number; documents: AssetUsage[]; hidden: number } | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    client.removeFiles(store, { ...sel, check: true }).then(setFound, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const docs = found ? found.documents.length + found.hidden : 0;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("media_delete_title", { n: found?.files ?? sel.keys.length })}
      description={t("media_delete_gone")}
      confirmLabel={t("action_delete")}
      destructive
      busy={busy || (!found && !error)}
      error={error ? errorMessage(error, t) : undefined}
      onConfirm={async () => {
        setBusy(true);
        try {
          await client.removeFiles(store, { ...sel, confirm: true });
          onDone();
          onClose();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {found && docs ? (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{t("media_delete_used", { n: docs })}</p>
          <UsageList asset={{ usage: found.documents }} basePath={basePath} docHref={docHref} />
          {found.hidden ? <p className="text-xs text-muted-foreground">{t("media_usage_hidden", { n: found.hidden })}</p> : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/** One address per chosen file. Private files: for the chosen time. Public files: their public address. */
function ShareDialog({ store, isPrivate, canRegister, files, onClose }: { store: string; isPrivate: boolean; canRegister: boolean; files: StoreFile[]; onClose: () => void }) {
  const { client, t, locale } = useCms();
  const [ttl, setTtl] = React.useState<ShareTtl>("24h");
  const [links, setLinks] = React.useState<{ name: string; url: string; expiresAt: string | null }[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    let live = true;
    setLinks(null);
    (async () => {
      const out = [];
      for (const f of files) {
        // A link belongs to a file the CMS knows, so the audit log can name it.
        const id = f.asset?.id ?? (canRegister ? (await client.registerFile(store, f.key)).id : null);
        if (id) out.push({ name: f.name, ...(await client.shareAsset(id, ttl)) });
      }
      return out;
    })().then(
      (l) => live && (setLinks(l), setError(null)),
      (e) => live && setError(e)
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttl]);
  const until = links?.find((l) => l.expiresAt)?.expiresAt;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.md}>
        <DialogHeader>
          <DialogTitle>{t("files_share")}</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3.5">
          {isPrivate ? (
            <div className="flex flex-col gap-1.5">
              <span id="cms-share-ttl" className="text-xs font-medium text-muted-foreground">
                {t("pl_expiry")}
              </span>
              <Segmented
                labelledBy="cms-share-ttl"
                value={ttl}
                onChange={setTtl}
                options={[
                  { value: "1h", label: t("ttl_1h") },
                  { value: "24h", label: t("ttl_24h") },
                  { value: "7d", label: t("ttl_7d") },
                ]}
              />
            </div>
          ) : null}
          <div className="flex max-h-72 flex-col gap-2.5 overflow-y-auto">
            {(links ?? []).map((l) => (
              <div key={l.name} className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-xs font-medium text-muted-foreground">{l.name}</span>
                <CodeBox value={l.url} label={`${t("pl_link")}: ${l.name}`} />
              </div>
            ))}
          </div>
          <StatusText className="text-xs" tone={error ? "error" : "muted"}>
            {error ? errorMessage(error, t) : !links ? t("pl_making") : until ? t("pl_until", { time: formatUntil(until, locale) }) : ""}
          </StatusText>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
