// agent-cms registry: cms-media-picker (0.11.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The "choose media" dialog the editor opens, and the pieces it shares with
// the media library screen: tiles, the upload panel, the file list.
"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronUp, CircleAlert, CircleCheck, File as FileIcon, FileText, Film, Lock, Music, Search, Upload, X } from "lucide-react";
import type { AssetCounts, AssetView, FolderTree, MediaStoreInfo } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorMessage, type T } from "./cms-messages";
import { Segmented, StatusText } from "./cms-parts";
import { createUploader, fileSize, type UploadItem, type UploadTarget } from "./cms-upload";
import { useCms, useDebounced } from "./use-cms";

export type KindTab = "all" | "image" | "video" | "audio" | "document";
/** What each tab asks the server for ("document" also holds files of no particular kind). */
export const KIND_QUERY: Record<KindTab, string | undefined> = { all: undefined, image: "image", video: "video", audio: "audio", document: "document,other" };

export function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "1200×630, 58KB" */
export function assetMeta(a: AssetView): string {
  return `${a.width && a.height ? `${a.width}×${a.height}, ` : ""}${fileSize(a.size)}`;
}

export function kindName(a: Pick<AssetView, "kind" | "name">, t: T): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(a.name)?.[1].toUpperCase().replace("JPG", "JPEG");
  const kind = a.kind === "folder" ? "other" : a.kind;
  return `${ext ? `${ext} ` : ""}${t(`media_kind_name_${kind}`)}`;
}

const KIND_ICON = { video: Film, audio: Music, document: FileText, other: FileIcon, image: FileIcon, folder: FileIcon } as const;

/** The small picture of a file: its thumbnail, the image itself, or an icon. */
export function AssetThumb({ asset, className }: { asset: AssetView; className?: string }) {
  const { client } = useCms();
  const src = asset.thumbKey ? client.fileUrl(asset, { thumb: true }) : asset.kind === "image" ? client.fileUrl(asset) : null;
  // Broken for this address only: a new thumbnail (after a replace) gets its own try.
  const [brokenSrc, setBrokenSrc] = React.useState<string | null>(null);
  const broken = !!src && brokenSrc === src;
  const setBroken = () => setBrokenSrc(src);
  const Icon = KIND_ICON[asset.kind];
  return (
    <span className={cn("relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border bg-muted", className)}>
      {src && !broken ? <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={setBroken} /> : <Icon aria-hidden className="h-7 w-7 text-muted-foreground" />}
      {asset.duration ? <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[11px] tabular-nums text-white">{clock(asset.duration)}</span> : null}
      {asset.visibility === "private" ? (
        <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded bg-background/90">
          <Lock aria-hidden className="h-3 w-3" />
        </span>
      ) : null}
    </span>
  );
}

export function AssetGrid({
  assets,
  selected,
  onSelect,
  className,
  picking,
  checked,
  onCheck,
}: {
  assets: AssetView[];
  selected?: string | null;
  onSelect: (a: AssetView) => void;
  className?: string;
  picking?: boolean;
  /** Files ticked for a bulk action; with `onCheck` each tile gets a checkbox. */
  checked?: ReadonlySet<string>;
  /** `range`: shift was held (tick everything from the last ticked one). */
  onCheck?: (a: AssetView, range: boolean) => void;
}) {
  const { t } = useCms();
  return (
    <ul className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4", className)}>
      {assets.map((a) => {
        const on = a.id === selected;
        return (
          <li key={a.id} className="group/tile relative min-w-0">
            {onCheck ? (
              <input
                type="checkbox"
                aria-label={t("media_check", { name: a.name })}
                checked={!!checked?.has(a.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  onCheck(a, e.shiftKey);
                }}
                onChange={() => undefined}
                className={cn(
                  "absolute left-3 top-3 z-10 h-4 w-4 cursor-pointer accent-primary opacity-0 shadow focus-visible:opacity-100 group-hover/tile:opacity-100",
                  (checked?.size ?? 0) > 0 && "opacity-100"
                )}
              />
            ) : null}
            <button
              type="button"
              aria-pressed={on}
              aria-label={`${a.name}${a.visibility === "private" ? `, ${t("media_private")}` : ""}`}
              onClick={(e) => (onCheck && (checked?.size || e.shiftKey || e.metaKey || e.ctrlKey) ? onCheck(a, e.shiftKey) : onSelect(a))}
              className={cn("group block w-full rounded-lg p-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", on && "bg-accent ring-2 ring-ring", checked?.has(a.id) && "bg-primary/10 ring-2 ring-primary")}
            >
              <span className="relative block">
                <AssetThumb asset={a} />
                {picking && on ? (
                  <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check aria-hidden className="h-3 w-3" />
                  </span>
                ) : null}
              </span>
              <span className="mt-1.5 block truncate text-sm font-medium">{a.name}</span>
              <span className="block truncate text-xs tabular-nums text-muted-foreground">{assetMeta(a)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── the list ─────────────────────────────────────────────────────────────────

export interface AssetQueryState {
  store: string | null;
  folder: string | null;
  kind: KindTab;
  q: string;
  tag: string | null;
  /** "new" (default), "old", "name", "size". */
  sort?: "new" | "old" | "name" | "size";
  /** Only files no document uses. */
  unused?: boolean;
  /** Only images without alt text. */
  missingAlt?: boolean;
}

/** Files that match, newest first, with "load more". */
export function useAssetList(query: AssetQueryState, enabled = true) {
  const { client } = useCms();
  const [state, setState] = React.useState<{ assets: AssetView[]; cursor: string | null; counts: AssetCounts | null }>({ assets: [], cursor: null, counts: null });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [tick, setTick] = React.useState(0);
  const run = React.useRef(0);
  const { store, folder, kind, q, tag, sort, unused, missingAlt } = query;
  const fetchPage = React.useCallback(
    (cursor: string | null) =>
      client.assets({ store, folder, kind: KIND_QUERY[kind], q: q || undefined, tag: tag ?? undefined, sort: sort && sort !== "new" ? sort : undefined, unused: unused || undefined, missingAlt: missingAlt || undefined, cursor, limit: 24 }),
    [client, store, folder, kind, q, tag, sort, unused, missingAlt]
  );
  const loadingMore = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const mine = ++run.current;
    setLoading(true);
    fetchPage(null).then(
      (r) => mine === run.current && (setState(r), setError(null), setLoading(false)),
      (e) => mine === run.current && (setError(e), setLoading(false))
    );
  }, [fetchPage, tick, enabled]);
  const more = async () => {
    // One request per cursor; a page or an error for an older query is dropped.
    if (!state.cursor || loadingMore.current === state.cursor) return;
    const mine = run.current;
    loadingMore.current = state.cursor;
    const r = await fetchPage(state.cursor).catch((e: unknown) => (mine === run.current && setError(e), null));
    loadingMore.current = null;
    if (r && mine === run.current) setState((s) => ({ assets: [...s.assets, ...r.assets.filter((a) => !s.assets.some((x) => x.id === a.id))], cursor: r.cursor, counts: r.counts }));
  };
  return { ...state, loading, error, more, reload: () => setTick((n) => n + 1), setState };
}

export function kindTabs(counts: AssetCounts | null, t: T): { value: KindTab; label: string }[] {
  const c = counts ?? { all: 0, image: 0, video: 0, audio: 0, document: 0, other: 0 };
  return [
    { value: "all" as const, label: t("media_kind_all", { n: c.all }) },
    { value: "image" as const, label: t("media_kind_image", { n: c.image }) },
    { value: "video" as const, label: t("media_kind_video", { n: c.video }) },
    ...(c.audio ? [{ value: "audio" as const, label: t("media_kind_audio", { n: c.audio }) }] : []),
    { value: "document" as const, label: t("media_kind_document", { n: c.document + c.other }) },
  ];
}

/** A store's name on screen: its `label`, or "Public" / "Private" when the app gave none. */
export function storeLabel(s: { label: string; visibility: "public" | "private"; store?: string; name?: string }, t: T): string {
  return s.label !== (s.store ?? s.name) ? s.label : t(s.visibility === "private" ? "media_private" : "media_public");
}

/** "Public / blog" options for a folder select. */
export function folderOptions(stores: FolderTree[], t: T): { value: string; label: string; store: string; folder: string | null }[] {
  return stores.flatMap((s) => [
    { value: `${s.store}:`, label: `${storeLabel(s, t)} / ${t("all")}`, store: s.store, folder: null },
    ...s.folders.map((f) => ({ value: `${s.store}:${f.path}`, label: `${storeLabel(s, t)} / ${f.path}`, store: s.store, folder: f.path })),
  ]);
}

export const SELECT_CLASS = "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ── uploads ──────────────────────────────────────────────────────────────────

/** One uploader for a screen. `onDone` runs for each file that reaches the library. */
export function useUploads(onDone?: (asset: AssetView) => void) {
  const { client, me } = useCms();
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const done = React.useRef(onDone);
  done.current = onDone;
  // Read when a file is sent, not when the screen opens: `me` may arrive later.
  const strip = React.useRef(false);
  strip.current = !!me?.media?.stripMetadata;
  const uploader = React.useMemo(() => createUploader({ client, onChange: setItems, onDone: (a) => done.current?.(a), stripMetadata: () => strip.current }), [client]);
  // Leaving with uploads on the way loses them: ask first.
  const busy = items.some((i) => i.state === "sending" || i.state === "waiting");
  React.useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  return { items, busy, add: (files: Iterable<File>, target?: UploadTarget) => uploader.add(files, target), retry: uploader.retry, remove: uploader.remove, clear: uploader.clear };
}

/** The file chooser behind an "Upload" button. */
export function UploadButton({ onFiles, accept, children, ...rest }: { onFiles: (files: File[]) => void; accept?: readonly string[] } & Omit<React.ComponentProps<typeof Button>, "onClick" | "type">) {
  const input = React.useRef<HTMLInputElement>(null);
  const { t } = useCms();
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={t("media_upload")}
        accept={accept?.includes("*/*") ? undefined : accept?.join(",")}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <Button type="button" {...rest} onClick={() => input.current?.click()}>
        {children ?? (
          <>
            <Upload aria-hidden className="h-4 w-4" />
            {t("media_upload")}
          </>
        )}
      </Button>
    </>
  );
}

/** The panel in the corner that shows uploads on the way. */
export function UploadPanel({ items, onRetry, onRemove, onClose, className }: { items: UploadItem[]; onRetry: (key: string) => void; onRemove: (key: string) => void; onClose: () => void; className?: string }) {
  const { t } = useCms();
  const [folded, setFolded] = React.useState(false);
  if (!items.length) return null;
  const busy = items.some((i) => i.state === "sending" || i.state === "waiting");
  const Fold = folded ? ChevronUp : ChevronDown;
  return (
    <section aria-label={t("media_upload")} className={cn("fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-[360px] overflow-hidden rounded-lg border bg-background shadow-lg", className)}>
      <header className="flex h-11 items-center gap-1 border-b px-3 text-sm font-medium">
        <span className="flex-1" role="status">
          {t(busy ? "media_uploading" : "media_uploaded", { n: busy ? items.filter((i) => i.state !== "done").length : items.filter((i) => i.state === "done").length })}
        </span>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-expanded={!folded} aria-label={t("media_upload")} onClick={() => setFolded(!folded)}>
          <Fold aria-hidden className="h-4 w-4" />
        </Button>
        {busy ? null : (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("close")} onClick={onClose}>
            <X aria-hidden className="h-4 w-4" />
          </Button>
        )}
      </header>
      {folded ? null : (
        <ul className="max-h-64 overflow-y-auto">
          {items.map((i) => (
            <li key={i.key} className="border-b px-3 py-2.5 text-sm last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                {i.state === "done" ? (
                  <CircleCheck aria-label={t("media_upload_done")} className="h-4 w-4 text-green-600" />
                ) : i.state === "failed" ? (
                  <CircleAlert aria-hidden className="h-4 w-4 text-destructive" />
                ) : (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {i.resumed ? `${t("media_upload_resumed")} · ` : ""}
                    {t("media_upload_progress", { sent: fileSize(i.sent), total: fileSize(i.size) })}
                  </span>
                )}
                {i.state === "done" ? null : (
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={t("media_upload_remove", { name: i.name })} onClick={() => onRemove(i.key)}>
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {i.state === "failed" ? (
                <div className="mt-1 flex items-center gap-2">
                  <span role="alert" className="flex-1 text-xs text-destructive">
                    {i.error ?? t("media_upload_failed")}
                  </span>
                  {i.error ? null : (
                    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onRetry(i.key)}>
                      {t("retry")}
                    </Button>
                  )}
                </div>
              ) : i.state !== "done" ? (
                <div role="progressbar" aria-label={i.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((i.sent / Math.max(1, i.size)) * 100)} className="mt-2 h-1 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${(i.sent / Math.max(1, i.size)) * 100}%` }} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── the dialog ───────────────────────────────────────────────────────────────

export interface CmsMediaPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (asset: AssetView) => void;
  /** Only these kinds can be chosen (an image field: ["image"]). */
  kinds?: KindTab[];
  /** File types the target takes (a field's `accept`): narrows what the upload button offers. */
  accept?: readonly string[];
  /** Only this store (a field's `store`). */
  store?: string;
  /** The field the file is for: the server applies its rules to uploads. */
  field?: { collection: string; path: string };
}

export function CmsMediaPicker({ open, onOpenChange, onPick, kinds, accept, store, field }: CmsMediaPickerProps) {
  const { client, t, me } = useCms();
  const stores: MediaStoreInfo[] = (me?.media?.stores ?? []).filter((s) => !store || s.name === store);
  const [tree, setTree] = React.useState<FolderTree[]>([]);
  const [where, setWhere] = React.useState<{ store: string | null; folder: string | null }>({ store: store ?? null, folder: null });
  const [kind, setKind] = React.useState<KindTab>(kinds?.length === 1 ? kinds[0] : "all");
  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");
  const [picked, setPicked] = React.useState<AssetView | null>(null);
  const applyQ = useDebounced(setQ, 250);
  const activeStore = where.store ?? stores[0]?.name ?? null;
  const list = useAssetList({ store: activeStore, folder: where.folder, kind, q, tag: null }, open);
  const uploads = useUploads((a) => {
    list.reload();
    setPicked(a);
  });
  React.useEffect(() => {
    if (!open) return;
    setPicked(null);
    client.assetFolders().then((s) => setTree(s.filter((x) => !store || x.store === store)), () => {});
  }, [open, client, store]);
  const tabs = kindTabs(list.counts, t).filter((x) => !kinds?.length || kinds.includes(x.value) || (x.value === "all" && kinds.length > 1));
  const options = folderOptions(tree, t);
  const canWrite = stores.find((s) => s.name === activeStore)?.can.write;
  const choose = (a: AssetView | null) => {
    if (!a) return;
    onPick(a);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(92dvh,720px)] max-w-[820px] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("media_pick_title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <div className="relative min-w-[180px] flex-1">
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
          {tabs.length > 1 ? <Segmented label={t("media_kind")} value={kind} onChange={setKind} options={tabs} /> : null}
          {options.length > 1 ? (
            <select
              aria-label={t("media_folder")}
              className={cn(SELECT_CLASS, "max-w-[200px]")}
              value={`${activeStore ?? ""}:${where.folder ?? ""}`}
              onChange={(e) => {
                const o = options.find((x) => x.value === e.target.value);
                if (o) setWhere({ store: o.store, folder: o.folder });
              }}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="min-h-[240px] flex-1 overflow-y-auto px-3.5 py-3">
          {list.error ? <StatusText tone="error">{errorMessage(list.error, t)}</StatusText> : null}
          {!list.loading && !list.assets.length && !list.error ? <p className="px-1.5 py-8 text-center text-sm text-muted-foreground">{t("media_empty")}</p> : null}
          <AssetGrid assets={list.assets} selected={picked?.id} onSelect={setPicked} picking className="md:grid-cols-4 xl:grid-cols-4" />
          {list.cursor ? (
            <div className="pt-3 text-center">
              <Button type="button" variant="outline" size="sm" onClick={() => void list.more()}>
                {t("load_more")}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 border-t px-5 py-3">
          {canWrite ? <UploadButton variant="outline" accept={accept ?? stores.find((s) => s.name === activeStore)?.accept} onFiles={(files) => uploads.add(files, { store: activeStore, folder: where.folder, field })} /> : null}
          <span className="flex-1" />
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" disabled={!picked} onClick={() => choose(picked)}>
            {t("media_insert")}
          </Button>
        </div>
        <UploadPanel items={uploads.items} onRetry={uploads.retry} onRemove={uploads.remove} onClose={uploads.clear} />
      </DialogContent>
    </Dialog>
  );
}

/** The markdown that puts a file into a body. */
export function assetMarkdown(a: AssetView): string {
  const ref = `asset:${a.id}/${encodeURIComponent(a.name)}`;
  return a.kind === "image" || a.kind === "video" || a.kind === "audio" ? `![${a.alt.replace(/[\[\]]/g, "")}](${ref})` : `[${a.name.replace(/[\[\]]/g, "")}](${ref})`;
}
