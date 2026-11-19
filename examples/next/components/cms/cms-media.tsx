// agent-cms registry: cms-media (0.8.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The media library: stores and folders on the left, files as a grid or a
// list, a panel with one file's details (alt text, tags, where it is used),
// uploads straight to the storage, and delete with a look at the documents
// that use the file.
"use client";

import * as React from "react";
import { Copy, Download, Folder, FolderPlus, LayoutGrid, List, Search, Trash2, X } from "lucide-react";
import type { AssetDetail, AssetView, FolderTree } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AssetGrid, AssetThumb, folderOptions, kindName, kindTabs, SELECT_CLASS, storeLabel, UploadButton, UploadPanel, useAssetList, useUploads, type KindTab } from "./cms-media-picker";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, copyText, PageHeader, Segmented, StateBadge, StatusText, Who } from "./cms-parts";
import { fileSize } from "./cms-upload";
import { forgetAsset, useAsync, useCms, useDebounced, useIsMobile, useLocalStorage } from "./use-cms";

export interface CmsMediaProps {
  /** Where the admin screens live, for links to the documents that use a file. Default "/admin". */
  basePath?: string;
  docHref?: (collection: string, slug: string) => string;
  className?: string;
}

export function CmsMedia({ basePath = "/admin", docHref, className }: CmsMediaProps) {
  const { client, t, me, locale } = useCms();
  const stores = me?.media?.stores ?? [];
  const tree = useAsync<FolderTree[]>(() => client.assetFolders(), [client]);
  const [where, setWhere] = React.useState<{ store: string | null; folder: string | null }>({ store: null, folder: null });
  const [kind, setKind] = React.useState<KindTab>("all");
  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");
  const [tag, setTag] = React.useState<string | null>(null);
  const [view, setView] = useLocalStorage<"grid" | "list">("cms-media-view", "grid");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [newFolder, setNewFolder] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const applyQ = useDebounced(setQ, 250);
  const store = where.store ?? stores[0]?.name ?? null;
  const info = stores.find((s) => s.name === store);
  const list = useAssetList({ store, folder: where.folder, kind, q, tag }, !!me?.media);
  const refresh = () => {
    list.reload();
    tree.reload();
  };
  const uploads = useUploads(refresh);
  const options = folderOptions(tree.data ?? [], t);
  const tags = React.useMemo(() => [...new Set([...(tag ? [tag] : []), ...list.assets.flatMap((a) => a.tags)])].sort(), [list.assets, tag]);
  const total = list.counts ? (kind === "all" ? list.counts.all : kind === "document" ? list.counts.document + list.counts.other : list.counts[kind]) : 0;
  const upload = (files: File[]) => uploads.add(files, { store, folder: where.folder });
  const go = (s: string, folder: string | null) => {
    setWhere({ store: s, folder });
    setOpenId(null);
  };

  if (me && !me.media) return <StatusText className="p-6">{t("media_empty")}</StatusText>;

  return (
    <div className={cn("flex min-h-full flex-col", className)}>
      <PageHeader title={t("nav_media")}>
        {info?.can.write ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setNewFolder(true)}>
              <FolderPlus aria-hidden className="h-4 w-4" />
              {t("media_new_folder")}
            </Button>
            <UploadButton size="sm" accept={info.accept} onFiles={upload} />
          </>
        ) : null}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("media_folders")} className="hidden w-52 shrink-0 border-r p-3 md:block">
          {(tree.data ?? []).map((s) => (
            <div key={s.store} className="mb-4">
              <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{storeLabel(s, t)}</h2>
              <ul className="flex flex-col gap-0.5">
                {[{ path: null as string | null, count: s.total }, ...s.folders].map((f) => {
                  const on = store === s.store && where.folder === f.path;
                  const depth = f.path ? f.path.split("/").length - 1 : 0;
                  return (
                    <li key={f.path ?? ""}>
                      <button
                        type="button"
                        aria-current={on ? "true" : undefined}
                        onClick={() => go(s.store, f.path)}
                        style={{ paddingLeft: 8 + depth * 14 }}
                        className={cn("flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", on && "bg-accent font-medium")}
                      >
                        <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{f.path ? f.path.split("/").pop() : t("all")}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{f.count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <section
          className={cn("flex min-w-0 flex-1 flex-col", dragging && "bg-accent/40")}
          onDragOver={(e) => {
            if (!info?.can.write || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false);
            if (!info?.can.write || !e.dataTransfer.files.length) return;
            e.preventDefault();
            upload(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 md:px-5">
            {options.length > 1 ? (
              <select
                aria-label={t("media_folder")}
                className={cn(SELECT_CLASS, "w-full md:hidden")}
                value={`${store ?? ""}:${where.folder ?? ""}`}
                onChange={(e) => {
                  const o = options.find((x) => x.value === e.target.value);
                  if (o) go(o.store, o.folder);
                }}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="relative min-w-[160px] flex-1 md:max-w-[260px]">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label={t("media_search")}
                placeholder={t("media_search")}
                className="pl-8"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  applyQ(e.target.value.trim());
                }}
              />
            </div>
            <Segmented label={t("media_kind")} value={kind} onChange={setKind} options={kindTabs(list.counts, t)} className="max-w-full overflow-x-auto" />
            <div className="ml-auto hidden items-center gap-2 md:flex">
            {tags.length ? (
              <select aria-label={t("media_tag")} className={cn(SELECT_CLASS, "max-w-[140px]")} value={tag ?? ""} onChange={(e) => setTag(e.target.value || null)}>
                <option value="">{t("media_tag")}</option>
                {tags.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            ) : null}
            <Segmented
              label={t("media_view")}
              value={view}
              onChange={setView}
              options={[
                { value: "grid", label: <LayoutGrid aria-label={t("media_view_grid")} className="h-4 w-4" /> },
                { value: "list", label: <List aria-label={t("media_view_list")} className="h-4 w-4" /> },
              ]}
            />
            </div>
          </div>
          <div className="flex-1 px-2.5 py-3 md:px-3.5">
            {list.error ? <StatusText tone="error">{errorMessage(list.error, t)}</StatusText> : null}
            {!list.loading && !list.assets.length && !list.error ? <p className="py-16 text-center text-sm text-muted-foreground">{t("media_empty")}</p> : null}
            {view === "list" && list.assets.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("media_col_name")}</TableHead>
                    <TableHead className="w-36">{t("media_col_kind")}</TableHead>
                    <TableHead className="w-24 text-right">{t("media_col_size")}</TableHead>
                    <TableHead className="w-32">{t("media_col_updated")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.assets.map((a) => (
                    <TableRow key={a.id} data-state={a.id === openId ? "selected" : undefined}>
                      <TableCell className="max-w-0">
                        <button type="button" aria-pressed={a.id === openId} onClick={() => setOpenId(a.id)} className="flex w-full items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <AssetThumb asset={a} className="aspect-square w-8 shrink-0 rounded [&>span]:hidden [&_svg]:h-4 [&_svg]:w-4" />
                          <span className="truncate font-medium">{a.name}</span>
                        </button>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{kindName(a, t)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fileSize(a.size)}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{new Date(a.updatedAt).toLocaleDateString(locale)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <AssetGrid assets={list.assets} selected={openId} onSelect={(a) => setOpenId(a.id === openId ? null : a.id)} className={openId ? "xl:grid-cols-3" : undefined} />
            )}
          </div>
          {list.assets.length ? (
            <footer className="flex items-center gap-3 border-t px-4 py-2.5 text-sm text-muted-foreground md:px-5">
              <span className="tabular-nums" role="status">
                {t("media_count", { total, shown: list.assets.length })}
              </span>
              {list.cursor ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void list.more()}>
                  {t("load_more")}
                </Button>
              ) : null}
            </footer>
          ) : null}
        </section>
        {openId ? (
          <AssetPanel
            key={openId}
            id={openId}
            basePath={basePath}
            docHref={docHref}
            onClose={() => setOpenId(null)}
            onChanged={(a) => list.setState((s) => ({ ...s, assets: s.assets.map((x) => (x.id === a.id ? { ...x, ...a } : x)) }))}
            onDeleted={() => {
              setOpenId(null);
              refresh();
            }}
          />
        ) : null}
      </div>
      <NewFolderDialog
        open={newFolder}
        onOpenChange={setNewFolder}
        onCreate={async (name) => {
          const path = `${where.folder ? `${where.folder}/` : ""}${name}`;
          await client.createAssetFolder(path, store);
          tree.reload();
          setWhere({ store, folder: path });
        }}
      />
      <UploadPanel items={uploads.items} onRetry={uploads.retry} onRemove={uploads.remove} onClose={uploads.clear} />
    </div>
  );
}

export function NewFolderDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (name: string) => Promise<void> }) {
  const { t } = useCms();
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) (setName(""), setError(null));
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            onCreate(name.trim()).then(
              () => (setBusy(false), onOpenChange(false)),
              (err) => (setBusy(false), setError(err))
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("media_new_folder")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cms-folder-name">{t("media_folder_name")}</Label>
            <Input id="cms-folder-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={error ? true : undefined} />
            {error ? <StatusText tone="error">{errorMessage(error, t)}</StatusText> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── one file ─────────────────────────────────────────────────────────────────

export function AssetPanel({ id, basePath, docHref, onClose, onChanged, onDeleted }: { id: string; basePath: string; docHref?: CmsMediaProps["docHref"]; onClose: () => void; onChanged: (a: AssetView) => void; onDeleted: () => void }) {
  const { client, t, me, appUrl, slots, locale } = useCms();
  const mobile = useIsMobile();
  const { data: asset, error, setData } = useAsync<AssetDetail>(() => client.asset(id), [client, id]);
  const [alt, setAlt] = React.useState<string | null>(null);
  const [tagText, setTagText] = React.useState("");
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const store = me?.media?.stores.find((s) => s.name === asset?.store);
  const can = store?.can;
  const save = async (patch: { alt?: string; tags?: string[] }) => {
    try {
      const next = await client.updateAsset(id, patch);
      forgetAsset(client, id);
      setData((d) => (d ? { ...d, ...next } : d));
      onChanged(next);
      setSaveError(null);
    } catch (e) {
      setSaveError(e);
    }
  };
  const body = !asset ? (
    <StatusText tone={error ? "error" : "muted"}>{error ? errorMessage(error, t) : t("loading")}</StatusText>
  ) : (
    <>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{asset.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {store ? storeLabel(store, t) : asset.store}
            {asset.folder ? ` / ${asset.folder}` : ""}
          </p>
        </div>
        {mobile ? null : (
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("close")} onClick={onClose}>
            <X aria-hidden className="h-4 w-4" />
          </Button>
        )}
      </div>
      {asset.kind === "video" ? (
        <video controls preload="metadata" src={client.fileUrl(asset)} poster={asset.thumbKey ? client.fileUrl(asset, { thumb: true }) : undefined} className="aspect-video w-full rounded-md border bg-black" />
      ) : asset.kind === "audio" ? (
        <audio controls preload="metadata" src={client.fileUrl(asset)} className="w-full" />
      ) : asset.kind === "image" ? (
        <img src={client.fileUrl(asset)} alt={asset.alt} className="max-h-64 w-full rounded-md border bg-muted object-contain" />
      ) : (
        <AssetThumb asset={asset} className="aspect-video w-full" />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-8 px-2.5" onClick={() => void copyText(asset.publicUrl ?? (/^https?:/.test(asset.href) ? asset.href : `${appUrl}${asset.href}`))}>
          <Copy aria-hidden className="h-3.5 w-3.5" />
          {t("media_copy_url")}
        </Button>
        <Button asChild variant="outline" size="sm" className="h-8 px-2.5">
          <a href={client.fileUrl(asset, { download: true })}>
            <Download aria-hidden className="h-3.5 w-3.5" />
            {t("media_download")}
          </a>
        </Button>
        <span className="flex-1" />
        {can?.delete ? (
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2.5 text-destructive hover:text-destructive" onClick={() => setAsking(true)}>
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            {t("action_delete")}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <div className="flex min-h-6 items-center">
          <Label htmlFor="cms-asset-alt" className="flex-1">
            {t("media_alt")}
          </Label>
          {can?.write ? slots.assetAlt?.(asset, { setAlt }) : null}
        </div>
        <Textarea
          id="cms-asset-alt"
          rows={2}
          readOnly={!can?.write}
          value={alt ?? asset.alt}
          onChange={(e) => setAlt(e.target.value)}
          onBlur={() => {
            if (alt !== null && alt.trim() !== asset.alt) void save({ alt: alt.trim() });
          }}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cms-asset-tag">{t("media_tags")}</Label>
        <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1 focus-within:ring-2 focus-within:ring-ring">
          {asset.tags.map((x) => (
            <span key={x} className="inline-flex h-6 items-center gap-1 rounded bg-muted pl-2 pr-1 text-xs">
              {x}
              {can?.write ? (
                <button type="button" aria-label={t("media_tag_remove", { tag: x })} className="rounded outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void save({ tags: asset.tags.filter((y) => y !== x) })}>
                  <X aria-hidden className="h-3 w-3 text-muted-foreground" />
                </button>
              ) : null}
            </span>
          ))}
          {can?.write ? (
            <input
              id="cms-asset-tag"
              aria-label={t("media_tag_add")}
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => {
                const v = tagText.trim().replace(/,$/, "");
                if ((e.key === "Enter" || e.key === ",") && v) {
                  e.preventDefault();
                  setTagText("");
                  if (!asset.tags.includes(v)) void save({ tags: [...asset.tags, v] });
                }
              }}
              className="h-6 min-w-[60px] flex-1 bg-transparent text-sm outline-none"
            />
          ) : null}
        </div>
      </div>
      {saveError ? <StatusText tone="error">{errorMessage(saveError, t)}</StatusText> : null}
      <dl className="grid grid-cols-[84px_1fr] gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("media_kind")}</dt>
        <dd>{kindName(asset, t)}</dd>
        <dt className="text-muted-foreground">{t("media_size")}</dt>
        <dd className="tabular-nums">{`${fileSize(asset.size)}${asset.width && asset.height ? `, ${asset.width}×${asset.height}` : ""}`}</dd>
        <dt className="text-muted-foreground">{t("media_by")}</dt>
        <dd className="min-w-0">
          <Who kind={asset.createdByKind} label={asset.createdBy} agent={asset.createdByAgent} />
        </dd>
        <dt className="text-muted-foreground">{t("media_at")}</dt>
        <dd className="tabular-nums">{new Date(asset.createdAt).toLocaleDateString(locale)}</dd>
      </dl>
      <div className="grid gap-1.5">
        <h3 className="text-sm font-medium">
          {t("media_usage")} <span className="font-normal tabular-nums text-muted-foreground">{asset.usage.length + asset.usageHidden}</span>
        </h3>
        {asset.usage.length ? <UsageList asset={asset} basePath={basePath} docHref={docHref} /> : asset.usageHidden ? null : <p className="text-sm text-muted-foreground">{t("none")}</p>}
        {asset.usageHidden ? <p className="text-xs text-muted-foreground">{t("media_usage_hidden", { n: asset.usageHidden })}</p> : null}
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t("media_delete_title", { n: 1 })}
        description={t("media_delete_gone")}
        confirmLabel={t("action_delete")}
        destructive
        busy={busy}
        error={saveError && asking ? errorMessage(saveError, t) : undefined}
        onConfirm={async () => {
          setBusy(true);
          try {
            await client.removeAsset(id, { confirm: asset.usage.length + asset.usageHidden > 0 });
            forgetAsset(client, id);
            setAsking(false);
            onDeleted();
          } catch (e) {
            setSaveError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {asset.usage.length + asset.usageHidden ? (
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">{t("media_delete_used", { n: asset.usage.length + asset.usageHidden })}</p>
            <UsageList asset={asset} basePath={basePath} docHref={docHref} />
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
  if (mobile)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto">
          <DialogTitle className="sr-only">{asset?.name ?? t("nav_media")}</DialogTitle>
          <div className="grid gap-4">{body}</div>
        </DialogContent>
      </Dialog>
    );
  return (
    <aside aria-label={asset?.name ?? t("nav_media")} className="grid w-80 shrink-0 content-start gap-4 border-l p-4">
      {body}
    </aside>
  );
}

export function UsageList({ asset, basePath, docHref }: { asset: Pick<AssetDetail, "usage">; basePath: string; docHref?: CmsMediaProps["docHref"] }) {
  const { me } = useCms();
  return (
    <ul className="divide-y rounded-md border text-sm">
      {asset.usage.map((u) => (
        <li key={`${u.collection}/${u.slug}`} className="flex h-10 items-center gap-2 px-2.5">
          <a href={docHref?.(u.collection, u.slug) ?? `${basePath}/${encodeURIComponent(u.collection)}/${encodeURIComponent(u.slug)}`} className="min-w-0 flex-1 truncate font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {u.title}
          </a>
          <span className="text-xs text-muted-foreground">{me?.collections.find((c) => c.slug === u.collection)?.label ?? u.collection}</span>
          <StateBadge state={u.status} />
        </li>
      ))}
    </ul>
  );
}
