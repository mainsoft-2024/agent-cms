// agent-cms registry: cms-command (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// ⌘K / Ctrl+K: find any document (drafts too) across the collections you can
// edit, open it, publish it, see its history, or start a new document.
"use client";

import * as React from "react";
import { FileText, History, Plus, Upload } from "lucide-react";
import type { DocSummary } from "@mainsoft/agent-cms/types";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, StateBadge } from "./cms-parts";
import { useCms, useDebounced } from "./use-cms";

export interface CmsCommandProps {
  /** Controlled open state (leave out to let ⌘K / Ctrl+K handle it). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Listen for ⌘K / Ctrl+K. Default true. */
  hotkey?: boolean;
  /** The collection the user is in: its "New document" comes first. */
  collection?: string;
  onOpenDocument: (collection: string, slug: string) => void;
  onNewDocument?: (collection: string) => void;
  onOpenVersions?: (collection: string, slug: string) => void;
  /** Called after "Publish" from the menu. */
  onPublished?: (collection: string, slug: string) => void;
  /** Documents per collection. Default 8. */
  limit?: number;
}

type Hit = DocSummary & { collectionLabel: string };

function Mark({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-yellow-100 px-0 text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function CmsCommand({ open: openProp, onOpenChange, hotkey = true, collection, onOpenDocument, onNewDocument, onOpenVersions, onPublished, limit = 8 }: CmsCommandProps) {
  const { client, t, me, toast } = useCms();
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = React.useCallback(
    (o: boolean) => {
      setOpenState(o);
      onOpenChange?.(o);
    },
    [onOpenChange]
  );
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [loading, setLoading] = React.useState(false);
  const seq = React.useRef(0);

  React.useEffect(() => {
    if (!hotkey) return;
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [hotkey, open, setOpen]);

  // Everything this person may read is searched; new and publish follow what they may do.
  const readable = React.useMemo(() => me?.collections ?? [], [me]);
  const cols = React.useMemo(() => readable.filter((c) => c.canWrite), [readable]);
  // The query the hits on screen answer: actions never use hits from an older query.
  const [hitsFor, setHitsFor] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(0);
  const [publishing, setPublishing] = React.useState<Hit | null>(null);

  const search = useDebounced(async (text: string) => {
    const n = ++seq.current;
    setLoading(true);
    let bad = 0;
    const results = await Promise.all(
      readable.map((c) =>
        client.list(c.slug, { q: text || undefined, limit }).then(
          (r) => r.docs.map((d) => ({ ...d, collectionLabel: c.label })),
          () => (bad++, [] as Hit[])
        )
      )
    );
    if (n !== seq.current) return;
    setHits(results.flat());
    setHitsFor(text);
    setFailed(bad);
    setLoading(false);
  }, 200);

  React.useEffect(() => {
    if (open) search(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, readable]);

  React.useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const current = hitsFor === q;
  const first = current ? hits[0] : undefined;
  const newIn = [...cols].sort((a, b) => (a.slug === collection ? -1 : b.slug === collection ? 1 : 0));

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[12vh] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] translate-y-0 grid-cols-[minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[620px]">
        <DialogTitle className="sr-only">{t("cmd_title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("cmd_placeholder")}</DialogDescription>
        <Command shouldFilter={false} label={t("cmd_title")} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput value={q} onValueChange={setQ} placeholder={t("cmd_placeholder")} aria-label={t("cmd_placeholder")} className="h-12" />
          <CommandList className="max-h-[min(420px,60dvh)]">
            {!loading && current ? <CommandEmpty>{failed ? t("cmd_failed") : t("cmd_empty")}</CommandEmpty> : null}
            {loading && !hits.length ? (
              <div role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("loading")}
              </div>
            ) : null}
            {failed && hits.length && current ? (
              <p role="status" className="px-4 pt-2 text-xs text-amber-700 dark:text-amber-400">
                {t("cmd_partial", { n: failed })}
              </p>
            ) : null}
            {hits.length ? (
              <CommandGroup heading={t("cmd_docs")}>
                {hits.map((d) => (
                  <CommandItem key={`${d.collection}/${d.slug}`} value={`doc:${d.collection}/${d.slug}`} onSelect={() => run(() => onOpenDocument(d.collection, d.slug))} className="gap-2">
                    <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      <Mark text={d.title || d.slug} q={q} />
                    </span>
                    <StateBadge state={d.state} label={d.state === "draft" ? t("draft_version", { version: d.version }) : undefined} />
                    <span className="hidden max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground sm:inline">{d.collectionLabel}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading={t("cmd_actions")}>
              {first && q && (first.state === "draft" || first.modifiedSincePublish) && cols.find((c) => c.slug === first.collection)?.canPublish ? (
                <CommandItem
                  value={`publish:${first.collection}/${first.slug}`}
                  className="gap-2"
                  onSelect={() => run(() => setPublishing(first))}
                >
                  <Upload aria-hidden className="h-4 w-4 text-muted-foreground" />
                  {t("cmd_publish", { title: first.title || first.slug })}
                </CommandItem>
              ) : null}
              {first && q && onOpenVersions ? (
                <CommandItem value={`versions:${first.collection}/${first.slug}`} className="gap-2" onSelect={() => run(() => onOpenVersions(first.collection, first.slug))}>
                  <History aria-hidden className="h-4 w-4 text-muted-foreground" />
                  {t("cmd_versions", { title: first.title || first.slug })}
                </CommandItem>
              ) : null}
              {onNewDocument
                ? newIn.map((c) => (
                    <CommandItem key={c.slug} value={`new:${c.slug}`} className="gap-2" onSelect={() => run(() => onNewDocument(c.slug))}>
                      <Plus aria-hidden className="h-4 w-4 text-muted-foreground" />
                      {t("cmd_new_in", { collection: c.label })}
                    </CommandItem>
                  ))
                : null}
            </CommandGroup>
          </CommandList>
          <div className={cn("flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground")} aria-hidden>
            <span>
              <kbd className="rounded border border-b-2 px-1 font-mono">↑</kbd> <kbd className="rounded border border-b-2 px-1 font-mono">↓</kbd> {t("cmd_move")}
            </span>
            <span>
              <kbd className="rounded border border-b-2 px-1 font-mono">↵</kbd> {t("cmd_open")}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={!!publishing}
      onOpenChange={(o) => !o && setPublishing(null)}
      title={t("cmd_publish_title", { title: publishing?.title || publishing?.slug || "" })}
      description={t("cmd_publish_text", { version: publishing?.version ?? 0, collection: publishing?.collectionLabel ?? "" })}
      confirmLabel={t("publish")}
      onConfirm={async () => {
        const d = publishing;
        if (!d) return;
        setPublishing(null);
        try {
          await client.publish(d.collection, d.slug, { expectedVersion: d.version });
          toast(t("cmd_published", { title: d.title || d.slug }), { tone: "ok" });
          onPublished?.(d.collection, d.slug);
        } catch (e) {
          toast(errorMessage(e, t), { tone: "error" });
        }
      }}
    />
    </>
  );
}
