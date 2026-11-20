// agent-cms registry: cms-lib (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Small pieces the admin screens share: state badges, avatars, copy
// buttons, the confirm dialog, the page header and the markdown preview.
"use client";

import * as React from "react";
import { Bot, Check, Copy, Download, FileText, ImageOff, Lightbulb, Link as LinkIcon, Menu, Paperclip, Pencil, TriangleAlert, Info } from "lucide-react";
import { parseMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { personColor, useAsset, useCms, useShellNav } from "./use-cms";

// ── state ────────────────────────────────────────────────────────────────────

const DOT: Record<string, string> = { published: "bg-green-600", draft: "bg-amber-500", archived: "bg-neutral-400", scheduled: "bg-blue-600", review: "bg-amber-600", changes: "bg-red-600" };
const STATE_KEY = { draft: "state_draft", published: "state_published", archived: "state_archived", scheduled: "state_scheduled", review: "state_review", changes: "state_changes" } as const;

export type BadgeState = keyof typeof STATE_KEY;

/** What a list row says about a document: waiting for review and scheduled come before its plain state. */
export function flowState(d: { state: "draft" | "published" | "archived"; schedule?: { publishAt: string | null } | null; review?: { state: string } | null }): BadgeState {
  if (d.review?.state === "requested") return "review";
  if (d.review?.state === "changes_requested") return "changes";
  if (d.schedule?.publishAt) return "scheduled";
  return d.state;
}

export function StateBadge({ state, label, className }: { state: BadgeState; label?: string; className?: string }) {
  const { t } = useCms();
  return (
    <Badge variant="outline" className={cn("gap-1.5 whitespace-nowrap rounded-full px-2 py-0 text-[11.5px] font-medium", className)}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT[state])} />
      {label ?? t(STATE_KEY[state])}
    </Badge>
  );
}

export function ModifiedMark({ className }: { className?: string }) {
  const { t } = useCms();
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-amber-700", className)}>
      <Pencil aria-hidden className="h-3 w-3" />
      {t("state_modified")}
    </span>
  );
}

// ── people ───────────────────────────────────────────────────────────────────

export function Avatar({ kind, label, className }: { kind: string | null | undefined; label: string | null | undefined; className?: string }) {
  const bot = kind === "key" || kind === "system";
  return (
    <span aria-hidden className={cn("inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold", bot ? "bg-blue-100 text-blue-700" : "bg-muted text-foreground", className)}>
      {bot ? <Bot className="h-3 w-3" /> : (label ?? "?").trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * Who did it. With `agent` (an agent that acted for the person in `label`)
 * it shows the agent's mark and both names: "docs-bot, Kim".
 */
export function Who({ kind, label, agent, className }: { kind: string | null | undefined; label: string | null | undefined; agent?: string | null; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Avatar kind={agent ? "key" : kind} label={label} />
      <span>{agent ? `${agent}, ${label ?? ""}` : label}</span>
    </span>
  );
}

/** The people (and agents) who have something open, as overlapping coloured circles. */
export function People({ people, max = 4, className }: { people: { actorId: string; label: string; kind: string; agent?: string | null }[]; max?: number; className?: string }) {
  const { t } = useCms();
  if (!people.length) return null;
  const names = people.map((p) => p.agent ?? p.label);
  return (
    <span role="img" aria-label={t("people_here", { names: names.join(", ") })} title={names.join(", ")} className={cn("inline-flex items-center", className)}>
      {people.slice(0, max).map((p, i) => {
        const bot = p.kind !== "user" || !!p.agent;
        return (
          <span key={p.actorId} aria-hidden style={{ background: personColor(p.actorId, bot) }} className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-background text-[11px] font-semibold text-white", i > 0 && "-ml-2")}>
            {bot ? <Bot className="h-3 w-3" /> : (p.label || "?").trim().charAt(0).toUpperCase()}
          </span>
        );
      })}
      {people.length > max ? <span className="ml-1 text-xs tabular-nums text-muted-foreground">+{people.length - max}</span> : null}
    </span>
  );
}

// ── copy ─────────────────────────────────────────────────────────────────────

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** A copy button; `label` names what is copied for screen readers. */
export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const { t } = useCms();
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn("h-7 shrink-0 gap-1 px-2 font-sans text-xs", className)}
        aria-label={label ? `${t("copy")}: ${label}` : undefined}
        onClick={async () => setDone(await copyText(value))}
      >
        {done ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
        {done ? t("copied") : t("copy")}
      </Button>
      <span role="status" className="sr-only">
        {done ? t("copied") : ""}
      </span>
    </>
  );
}

/** Monospace value with a copy button (key secrets, URLs, commands). */
export function CodeBox({ value, label, className, multiline }: { value: string; label?: string; className?: string; multiline?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2", className)}>
      <code className={cn("min-w-0 flex-1 font-mono text-xs leading-5", multiline ? "whitespace-pre-wrap break-all" : "truncate")}>
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

// ── segmented choice ─────────────────────────────────────────────────────────

export interface SegmentedProps<V extends string> {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: React.ReactNode; disabled?: boolean }[];
  /** Accessible name (or use `labelledBy`). */
  label?: string;
  labelledBy?: string;
  className?: string;
  itemClassName?: string;
}

/**
 * One-of-many buttons (tabs that filter, ttl, view mode): a radio group of
 * plain buttons, so it works with either shadcn base (Radix or Base UI).
 * Arrow keys move and select; only the selected button is in the tab order.
 */
export function Segmented<V extends string>({ value, onChange, options, label, labelledBy, className, itemClassName }: SegmentedProps<V>) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);
  const focusable = current >= 0 && !options[current]?.disabled ? current : enabled[0];
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const edge = e.key === "Home" ? enabled[0] : e.key === "End" ? enabled[enabled.length - 1] : undefined;
    if (!step && edge === undefined) return;
    e.preventDefault();
    const pos = enabled.indexOf(i);
    const next = edge ?? enabled[(pos + step + enabled.length) % enabled.length];
    if (next === undefined) return;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn("inline-flex w-fit flex-wrap justify-start gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            data-state={on ? "on" : "off"}
            disabled={o.disabled}
            tabIndex={i === focusable ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex h-7 items-center justify-center whitespace-nowrap rounded-sm px-2.5 text-[13px] font-normal text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-sm",
              itemClassName
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── status and errors ────────────────────────────────────────────────────────

/** A live region for status lines (saved, failed, counts). */
export function StatusText({ children, className, tone }: { children?: React.ReactNode; className?: string; tone?: "muted" | "error" | "ok" }) {
  return (
    <div role="status" className={cn("text-sm", tone === "error" ? "text-destructive" : tone === "ok" ? "text-green-700" : "text-muted-foreground", className)}>
      {children}
    </div>
  );
}

// ── confirm ──────────────────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: React.ReactNode;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  error?: React.ReactNode;
}

export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel, destructive, busy, onConfirm, error }: ConfirmDialogProps) {
  const { t } = useCms();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        {error ? <StatusText tone="error">{error}</StatusText> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} disabled={busy} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── page header ──────────────────────────────────────────────────────────────

/** The bar on top of each screen. On phones it shows the menu button of <CmsShell>. */
export function PageHeader({ title, crumbs, children, after, className, back }: { title: React.ReactNode; crumbs?: React.ReactNode[]; children?: React.ReactNode; after?: React.ReactNode; className?: string; back?: React.ReactNode }) {
  const nav = useShellNav();
  const { t } = useCms();
  return (
    <header className={cn("flex min-h-14 flex-wrap items-center gap-2.5 border-b px-4 py-2.5 md:px-6", className)}>
      {back ??
        (nav ? (
          <Button type="button" variant="ghost" size="icon" className="-ml-2 h-8 w-8 md:hidden" aria-label={t("menu")} onClick={nav.openNav}>
            <Menu aria-hidden className="h-4 w-4" />
          </Button>
        ) : null)}
      {crumbs?.length ? (
        <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-sm text-muted-foreground md:flex">
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {c}
              <span aria-hidden>/</span>
            </span>
          ))}
        </nav>
      ) : null}
      <h1 className="min-w-0 truncate text-base font-semibold md:text-lg">{title}</h1>
      {after}
      <span className="flex-1" />
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </header>
  );
}

// ── markdown preview ─────────────────────────────────────────────────────────

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((i, n) => {
        if (i.t === "strong") return <strong key={n}>{i.v}</strong>;
        if (i.t === "code") return <code key={n} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{i.v}</code>;
        if (i.t === "link")
          return (
            <a key={n} href={i.href} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              {i.v}
            </a>
          );
        if (i.t === "applink") return <AppLinkChip key={n} label={i.v} linkKey={i.key} />;
        if (i.t === "image") return <MediaImage key={n} asset={i.asset} name={i.name} src={i.src} alt={i.alt} className="mx-0.5 inline-block max-h-40 align-middle" />;
        if (i.t === "file") return <FileLink key={n} asset={i.asset} name={i.name} label={i.v} />;
        return <React.Fragment key={n}>{i.v}</React.Fragment>;
      })}
    </>
  );
}

function AppLinkChip({ label, linkKey }: { label: string; linkKey: string }) {
  return (
    <span title={linkKey} className="mx-0.5 inline-flex items-center gap-1 rounded-md border bg-muted/60 px-1.5 py-px text-[0.92em] font-medium">
      <LinkIcon aria-hidden className="h-3 w-3" />
      {label}
    </span>
  );
}

const sizeText = (n: number) => (n >= 1024 ** 3 ? `${Math.round((n / 1024 ** 3) * 10) / 10}GB` : n >= 1024 ** 2 ? `${Math.round((n / 1024 ** 2) * 10) / 10}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

function FileLink({ asset, name, label }: { asset: string; name: string; label: string }) {
  const { client } = useCms();
  return (
    <a href={client.fileUrl({ id: asset, name })} className="inline-flex items-center gap-1 underline underline-offset-2" target="_blank" rel="noreferrer">
      <Paperclip aria-hidden className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

function Missing({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-sm text-muted-foreground", className)}>
      <ImageOff aria-hidden className="h-4 w-4" />
      {name}
    </span>
  );
}

/** An image from the media library (by id) or from elsewhere (`src`). The file's own alt text fills in for an empty one. */
function MediaImage({ asset, name, src, alt, className }: { asset?: string | null; name?: string; src?: string | null; alt: string; className?: string }) {
  const { client } = useCms();
  const info = useAsset(asset);
  if (asset && info === null) return <Missing name={name ?? asset} />;
  if (asset && info === undefined) return <span className={cn("inline-block h-24 w-40 animate-pulse rounded-md bg-muted", className)} />;
  return <img src={info ? client.fileUrl(info) : (src ?? "")} alt={alt || info?.alt || ""} width={info?.width ?? undefined} height={info?.height ?? undefined} className={cn("h-auto max-w-full rounded-md", className)} />;
}

/** A media line of a document: a picture, a player or a download card, by the file's type. */
function MediaBlock({ asset, name, src, alt, caption }: { asset?: string | null; name?: string; src?: string | null; alt: string; caption?: string | null }) {
  const { client } = useCms();
  const info = useAsset(asset);
  const inner =
    asset && info === null ? (
      <Missing name={name ?? asset} className="flex" />
    ) : info?.kind === "video" ? (
      <video controls preload="metadata" src={client.fileUrl(info)} poster={info.thumbKey ? client.fileUrl(info, { thumb: true }) : undefined} aria-label={alt || info.alt || info.name} className="w-full rounded-md bg-black" />
    ) : info?.kind === "audio" ? (
      <audio controls preload="metadata" src={client.fileUrl(info)} aria-label={alt || info.alt || info.name} className="w-full" />
    ) : info && info.kind !== "image" ? (
      <a href={client.fileUrl(info, { download: true })} className="flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm no-underline hover:bg-accent">
        <FileText aria-hidden className="h-5 w-5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{alt || info.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{sizeText(info.size)}</span>
        <Download aria-hidden className="h-4 w-4 text-muted-foreground" />
      </a>
    ) : (
      <MediaImage asset={asset} name={name} src={src} alt={alt} className="block w-full" />
    );
  return (
    <figure className="my-4">
      {inner}
      {caption ? <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

const CALLOUT_ICON = { note: Info, tip: Lightbulb, warning: TriangleAlert } as const;

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, n) => {
        switch (b.t) {
          case "heading":
            return b.level === 2 ? (
              <h2 key={n} id={b.id} className="mb-2 mt-6 text-lg font-semibold">
                <Inlines items={b.inline} />
              </h2>
            ) : (
              <h3 key={n} id={b.id} className="mb-1.5 mt-4 font-semibold">
                <Inlines items={b.inline} />
              </h3>
            );
          case "p":
            return (
              <p key={n} className="my-2 leading-7">
                <Inlines items={b.inline} />
              </p>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={n} className={cn("my-2 space-y-1 pl-6 leading-7", b.ordered ? "list-decimal" : "list-disc")}>
                {b.items.map((it, k) => (
                  <li key={k}>
                    <Inlines items={it} />
                  </li>
                ))}
              </L>
            );
          }
          case "quote": {
            if (b.callout) {
              const Icon = CALLOUT_ICON[b.callout];
              return (
                <div key={n} className={cn("my-3 flex gap-2 rounded-md border px-3 py-2.5 text-sm", b.callout === "warning" ? "border-amber-200 bg-amber-50" : "border-blue-200 bg-blue-50")}>
                  <Icon aria-hidden className="mt-1 h-4 w-4 shrink-0" />
                  <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    <Blocks blocks={b.blocks} />
                  </div>
                </div>
              );
            }
            return (
              <blockquote key={n} className="my-3 border-l-2 pl-3 text-muted-foreground">
                <Blocks blocks={b.blocks} />
              </blockquote>
            );
          }
          case "code":
            return (
              <pre key={n} className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                <code>{b.v}</code>
              </pre>
            );
          case "hr":
            return <hr key={n} className="my-5" />;
          case "media":
            return <MediaBlock key={n} asset={b.asset} name={b.name} src={b.src} alt={b.alt} caption={b.caption} />;
          case "links":
            return (
              <div key={n} className="my-3 flex flex-wrap gap-2">
                {b.items.map((l, k) => (
                  <AppLinkChip key={k} label={l.v} linkKey={l.key} />
                ))}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** Draws a document the way `./markdown` parses it. Swap in your own public components here. */
export function MarkdownPreview({ title, summary, body, className }: { title?: string; summary?: string; body: string; className?: string }) {
  const blocks = React.useMemo(() => parseMarkdown(body), [body]);
  return (
    <article className={cn("text-[15px]", className)}>
      {title ? <h1 className="mb-1 text-2xl font-bold">{title}</h1> : null}
      {summary ? <p className="mb-4 mt-0 text-muted-foreground">{summary}</p> : null}
      <Blocks blocks={blocks} />
    </article>
  );
}
