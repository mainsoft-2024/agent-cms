// agent-cms registry: cms-lib (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Small pieces the admin screens share: state badges, avatars, copy
// buttons, the confirm dialog, the page header and the markdown preview.
"use client";

import * as React from "react";
import { Bot, Check, ChevronDown, Copy, Download, FileText, ImageOff, Lightbulb, Link as LinkIcon, Menu, Paperclip, Pencil, TriangleAlert, Info, X } from "lucide-react";
import { inspectHtml, parseMarkdown, type Block, type Inline } from "@mainsoft/agent-cms/markdown";
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
      {/* <bdi>: a name in another script does not move the punctuation around it. */}
      <span>{agent ? (<><bdi>{agent}</bdi>, <bdi>{label ?? ""}</bdi></>) : <bdi>{label}</bdi>}</span>
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

/** A person's initials on their own colour (the same colour everywhere they appear). */
export function PersonMark({ id, label, className }: { id: string; label: string; className?: string }) {
  const words = label.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  return (
    <span aria-hidden style={{ background: personColor(id) }} className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white", className)}>
      {initials}
    </span>
  );
}

export interface PersonOption {
  id: string;
  label: string;
  email?: string | null;
  lastSeenAt?: string | null;
}

const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

/**
 * Find a person by name or email and pick them: a combobox with arrow keys,
 * people shown with their initials, email and when they were last active.
 * With `onEmail`, a typed email nobody matches can be added anyway (they
 * join when they first sign in, or get an invitation).
 */
export function PersonPicker({ search, onPick, onEmail, emailLabel, exclude = [], label, placeholder, disabled, className }: {
  search: (q: string) => Promise<PersonOption[]>;
  onPick: (p: PersonOption) => void | Promise<void>;
  onEmail?: (email: string) => void | Promise<void>;
  /** "Add {email}" / "Invite {email}". */
  emailLabel?: (email: string) => string;
  exclude?: string[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t, locale } = useCms();
  const id = React.useId();
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [found, setFound] = React.useState<PersonOption[]>([]);
  const [state, setState] = React.useState<"idle" | "busy" | "failed">("idle");
  const [active, setActive] = React.useState(0);
  // The query the options on screen answer: nothing older can be picked.
  const [answered, setAnswered] = React.useState<string | null>(null);
  const excludeKey = exclude.join("\n");
  React.useEffect(() => {
    if (open) document.getElementById(`${id}-o${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, id]);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setState("busy");
    const timer = setTimeout(
      () =>
        search(q).then(
          (list) => {
            if (!live) return;
            const skip = new Set(excludeKey.split("\n"));
            setFound(list.filter((p) => !skip.has(p.id)));
            setAnswered(q);
            setState("idle");
            setActive(0);
          },
          () => live && setState("failed")
        ),
      q ? 180 : 0
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, open, search, excludeKey]);

  const email = q.trim().toLowerCase();
  const fresh = answered === q && state !== "busy";
  const emailOption = fresh && !!onEmail && EMAIL_RE.test(email) && !found.some((p) => p.email?.toLowerCase() === email);
  const options: ({ kind: "person"; p: PersonOption } | { kind: "email"; email: string })[] = fresh ? [...found.map((p) => ({ kind: "person" as const, p })), ...(emailOption ? [{ kind: "email" as const, email }] : [])] : [];

  async function choose(i: number) {
    const o = options[i];
    if (!o) return;
    setQ("");
    setOpen(false);
    if (o.kind === "person") await onPick(o.p);
    else await onEmail?.(o.email);
  }

  return (
    <div className={cn("relative w-full max-w-md", className)}>
      <input
        id={`${id}-input`}
        role="combobox"
        aria-label={label}
        aria-expanded={open && options.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${id}-o${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder ?? label}
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setOpen(true), setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0))));
          else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && open && options.length) (e.preventDefault(), void choose(active));
          else if (e.key === "Escape" && open) (e.preventDefault(), e.stopPropagation(), setOpen(false));
        }}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      {open ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <ul id={`${id}-list`} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto p-1">
            {options.map((o, i) => (
              <li
                key={o.kind === "person" ? o.p.id : `email:${o.email}`}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => void choose(i)}
                className={cn("flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm", i === active && "bg-accent")}
              >
                {o.kind === "person" ? (
                  <>
                    <PersonMark id={o.p.id} label={o.p.label} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <bdi className="truncate font-medium">{o.p.label}</bdi>
                      {o.p.email && o.p.email !== o.p.label ? <span className="truncate text-xs text-muted-foreground">{o.p.email}</span> : null}
                    </span>
                    {o.p.lastSeenAt ? (
                      <span className="shrink-0 text-xs text-muted-foreground" title={new Date(o.p.lastSeenAt).toLocaleString(locale)}>
                        {t("person_seen", { time: relativeTimeShort(o.p.lastSeenAt, locale) })}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">@</span>
                    <span className="min-w-0 flex-1 truncate">{emailLabel ? emailLabel(o.email) : o.email}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {!options.length ? (
            <p role="status" className={cn("px-3 py-2.5 text-sm", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
              {state === "busy" ? t("loading") : state === "failed" ? t("role_search_failed") : q ? (onEmail ? t("person_none_email") : t("role_search_none")) : t("person_none_yet")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "3 min", "2 days": short, for tight places. */
export function relativeTimeShort(iso: string, locale: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const f = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const a = Math.abs(s);
  if (a < 60) return f.format(0, "second");
  if (a < 3600) return f.format(Math.round(s / 60), "minute");
  if (a < 86400) return f.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return f.format(Math.round(s / 86400), "day");
  if (a < 86400 * 365) return f.format(Math.round(s / (86400 * 30)), "month");
  return f.format(Math.round(s / (86400 * 365)), "year");
}

// ── dialogs ──────────────────────────────────────────────────────────────────

/**
 * Sizes for `<DialogContent className={DIALOG.md}>`. Written out (Tailwind reads class names from
 * the source). Each one also lets the column shrink below its content
 * (`minmax(0,1fr)`), so a long link or name wraps or truncates instead of
 * pushing the dialog wider than the screen, and scrolls when it is taller.
 */
export const DIALOG = {
  sm: "grid-cols-[minmax(0,1fr)] max-h-[min(92dvh,900px)] overflow-y-auto w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] sm:max-w-[400px]",
  md: "grid-cols-[minmax(0,1fr)] max-h-[min(92dvh,900px)] overflow-y-auto w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] sm:max-w-[500px]",
  lg: "grid-cols-[minmax(0,1fr)] max-h-[min(92dvh,900px)] overflow-y-auto w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] sm:max-w-[600px]",
  xl: "grid-cols-[minmax(0,1fr)] max-h-[min(92dvh,900px)] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] sm:max-w-[820px]",
} as const;

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
export function CodeBox({ value, label, className, multiline, secret, revealed, focusOnShow }: { value: string; label?: string; className?: string; multiline?: boolean; /** Hidden on screen (and from screen readers) until Show is pressed; Copy still copies it. */ secret?: string; /** Start with the secret shown (it was just asked for). */ revealed?: boolean; /** Move focus to the Hide button when it appears (the control that revealed it went away). */ focusOnShow?: boolean }) {
  const { t } = useCms();
  const [shown, setShown] = React.useState(!!revealed);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (focusOnShow) toggleRef.current?.focus();
  }, [focusOnShow]);
  const masked = secret && !shown ? value.split(secret).join(`${secret.slice(0, 4)}${"•".repeat(12)}${secret.slice(-4)}`) : value;
  return (
    <div className={cn("flex w-full min-w-0 max-w-full items-start gap-2 rounded-md border bg-muted/50 px-3 py-2", className)}>
      <code dir="ltr" title={multiline || secret ? undefined : value} className={cn("min-w-0 flex-1 font-mono text-xs leading-5", multiline ? "whitespace-pre-wrap break-all" : "truncate")}>
        {masked}
      </code>
      {secret ? (
        <Button ref={toggleRef} type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 font-sans text-xs" aria-pressed={shown} onClick={() => setShown((v) => !v)}>
          {shown ? t("hide") : t("show")}
        </Button>
      ) : null}
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
      // max-w-full: never wider than what holds it. Without it `w-fit` lets a long row push the page sideways on a phone.
      className={cn("inline-flex w-fit max-w-full flex-wrap justify-start gap-0.5 rounded-md bg-muted p-0.5", className)}
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
            onClick={(e) => {
              // In a row that scrolls sideways, bring a half-hidden choice fully into view.
              e.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
              onChange(o.value);
            }}
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
export function StatusText({ children, className, tone, id }: { children?: React.ReactNode; className?: string; tone?: "muted" | "error" | "ok"; id?: string }) {
  return (
    <div id={id} role="status" className={cn("text-sm", tone === "error" ? "text-destructive" : tone === "ok" ? "text-green-700 dark:text-green-400" : "text-muted-foreground", className)}>
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
      <DialogContent className={DIALOG.md}>
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
        if (i.t === "strong") return <strong key={n}>{i.kids ? <Inlines items={i.kids} /> : i.v}</strong>;
        if (i.t === "em") return <em key={n}>{i.kids ? <Inlines items={i.kids} /> : i.v}</em>;
        if (i.t === "del") return <del key={n}>{i.kids ? <Inlines items={i.kids} /> : i.v}</del>;
        if (i.t === "br") return <br key={n} />;
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

/**
 * Your own drawing of a kind of block. `children` is what the admin would
 * have drawn, for wrapping or for kinds you leave alone.
 *
 *   renderBlocks(blocks, { code: ({ block }) => <Highlight lang={block.lang}>{block.v}</Highlight> })
 */
export type BlockComponents = { [K in Block["t"]]?: (props: { block: Extract<Block, { t: K }>; children: React.ReactNode }) => React.ReactNode };

/** Draws parsed blocks (`parseMarkdown`), with your components where you give them. */
export function renderBlocks(blocks: Block[], components?: BlockComponents): React.ReactNode {
  return <Blocks blocks={blocks} components={components} />;
}

function Blocks({ blocks, components, lines }: { blocks: Block[]; components?: BlockComponents; lines?: boolean }) {
  return (
    <>
      {blocks.map((b, n) => {
        let el = <Block1 b={b} components={components} />;
        const own = components?.[b.t] as ((p: { block: Block; children: React.ReactNode }) => React.ReactNode) | undefined;
        if (own) el = <>{own({ block: b, children: el })}</>;
        // Top-level blocks say which source lines they came from, so the editor can find them.
        return lines && b.line ? (
          <div key={n} data-line={b.line} data-end-line={b.endLine ?? b.line}>
            {el}
          </div>
        ) : (
          <React.Fragment key={n}>{el}</React.Fragment>
        );
      })}
    </>
  );
}

function Block1({ b, components }: { b: Block; components?: BlockComponents }) {
  switch (b.t) {
    case "heading":
      return b.level === 2 ? (
        <h2 id={b.id} className="mb-2 mt-6 text-lg font-semibold">
          <Inlines items={b.inline} />
        </h2>
      ) : (
        <h3 id={b.id} className="mb-1.5 mt-4 font-semibold">
          <Inlines items={b.inline} />
        </h3>
      );
    case "p":
      return (
        <p className="my-2 leading-7">
          <Inlines items={b.inline} />
        </p>
      );
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L className={cn("my-2 space-y-1 pl-6 leading-7", b.ordered ? "list-decimal" : "list-disc")}>
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
          <div className={cn("my-3 flex gap-2 rounded-md border px-3 py-2.5 text-sm", b.callout === "warning" ? "border-amber-200 bg-amber-50" : "border-blue-200 bg-blue-50")}>
            <Icon aria-hidden className="mt-1 h-4 w-4 shrink-0" />
            <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <Blocks blocks={b.blocks} components={components} />
            </div>
          </div>
        );
      }
      return (
        <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground">
          <Blocks blocks={b.blocks} components={components} />
        </blockquote>
      );
    }
    case "code":
      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
          <code>{b.v}</code>
        </pre>
      );
    case "hr":
      return <hr className="my-5" />;
    case "media":
      return <MediaBlock asset={b.asset} name={b.name} src={b.src} alt={b.alt} caption={b.caption} />;
    case "links":
      return (
        <div className="my-3 flex flex-wrap gap-2">
          {b.items.map((l, k) => (
            <AppLinkChip key={k} label={l.v} linkKey={l.key} />
          ))}
        </div>
      );
    case "todo":
      return (
        <ul className="my-2 space-y-1 leading-7">
          {b.items.map((it, k) => (
            <li key={k} className="flex items-start gap-2">
              <input type="checkbox" checked={it.checked} readOnly disabled className="mt-1.5 h-4 w-4 shrink-0 accent-foreground" aria-label={it.checked ? "done" : "to do"} />
              <span className={cn("min-w-0", it.checked && "text-muted-foreground line-through")}>
                <Inlines items={it.inline} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="my-3 overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/60">
              <tr>
                {b.head.map((c, k) => (
                  <th key={k} scope="col" className="border-b px-3 py-1.5 font-semibold" style={{ textAlign: b.align[k] ?? "left" }}>
                    <Inlines items={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0">
                  {r.map((c, k) => (
                    <td key={k} className="px-3 py-1.5 align-top" style={{ textAlign: b.align[k] ?? "left" }}>
                      <Inlines items={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "toggle":
      return (
        <details className="group my-2 rounded-md border px-3 py-1.5 [&[open]]:pb-2">
          <summary className="cursor-pointer select-none font-medium marker:text-muted-foreground">
            <Inlines items={b.title} />
          </summary>
          <div className="mt-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <Blocks blocks={b.blocks} components={components} />
          </div>
        </details>
      );
    case "columns":
      return (
        <div className="my-3 grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 14rem), 1fr))` }}>
          {b.cols.map((c, k) => (
            <div key={k} className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <Blocks blocks={c} components={components} />
            </div>
          ))}
        </div>
      );
    case "html":
      return <HtmlBlock html={b.v} isolated={!!b.isolated} />;
    case "raw":
      return (
        <pre className="my-3 overflow-x-auto rounded-md border border-dashed p-3 font-mono text-xs text-muted-foreground" title="raw">
          {b.v}
        </pre>
      );
    default:
      return null;
  }
}

/**
 * An HTML block in the admin: drawn inside a frame with no access to the admin
 * (no scripts unless the block runs isolated), with what will not work listed under it.
 */
export function HtmlBlock({ html, isolated }: { html: string; isolated: boolean }) {
  const { client, t } = useCms();
  const inert = React.useMemo(() => (isolated ? [] : inspectHtml(html)), [html, isolated]);
  const [height, setHeight] = React.useState(80);
  const ref = React.useRef<HTMLIFrameElement>(null);
  const doc = React.useMemo(() => {
    const body = html.replace(/(["'(\s=])asset:([a-z0-9]{12})(?:\/([^\s"'<>)]*))?/g, (_m, pre: string, id: string, name?: string) => `${pre}${client.fileUrl({ id, name: name ?? "" })}`);
    // Safe blocks: a policy turns off the block's own scripts and event handlers, as the site does.
    const csp = isolated ? "" : `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-cmsh'; object-src 'none'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com">`;
    const report = `<script nonce="cmsh">(function(){function s(){parent.postMessage({type:"agent-cms:height",height:Math.ceil(document.documentElement.scrollHeight)},"*")}addEventListener("load",s);new ResizeObserver(s).observe(document.documentElement)})()</script>`;
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<base target="_blank"><style>html,body{margin:0}body{font:14px/1.6 system-ui,sans-serif}img,video{max-width:100%;height:auto}</style></head><body>${body}${report}</body></html>`;
  }, [html, client, isolated]);
  React.useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data?.type === "agent-cms:height") setHeight(Math.min(2000, Math.max(40, Number(e.data.height) || 80)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  return (
    <div className="my-3" data-html-block>
      <iframe
        ref={ref}
        title="HTML"
        // The height report needs scripts; without allow-same-origin the frame cannot reach the admin.
        sandbox="allow-scripts allow-popups"
        srcDoc={doc}
        style={{ height }}
        className="block w-full rounded-md border bg-white"
      />
      {inert.length ? (
        <p className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground" aria-label={t("html_inert_title")}>
          {inert.map((x, k) => (
            <span key={k} className="rounded border border-amber-300 bg-amber-50 px-1.5 py-px font-mono text-amber-900">
              {x.detail} · {t(`html_inert_${x.kind}` as never)}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

export interface MarkdownPreviewProps {
  title?: string;
  summary?: string;
  body: string;
  className?: string;
  /** Your own components for some kinds of block (see `renderBlocks`). */
  components?: BlockComponents;
  /**
   * Called with the source lines (1-based) of the block someone clicks.
   * With it every top-level block carries `data-line` / `data-end-line`.
   */
  onPickLines?: (line: number, endLine: number) => void;
}

/** Draws a document the way `./markdown` parses it. Swap in your own public components with `components`. */
export function MarkdownPreview({ title, summary, body, className, components, onPickLines }: MarkdownPreviewProps) {
  const lines = !!onPickLines;
  const blocks = React.useMemo(() => parseMarkdown(body, { lines }), [body, lines]);
  const pick = (e: React.MouseEvent<HTMLElement>) => {
    if (!onPickLines) return;
    const at = e.target as HTMLElement;
    // Links, players and buttons keep their own click; so does someone selecting text to copy.
    if (at.closest("a, button, video, audio, input, summary") || (typeof window !== "undefined" && window.getSelection()?.toString())) return;
    const block = at.closest<HTMLElement>("[data-line]");
    if (block) onPickLines(Number(block.dataset.line), Number(block.dataset.endLine));
  };
  return (
    // The click is a pointer shortcut: the same text is reachable in the editor with the keyboard.
    <article className={cn("text-[15px]", lines && "[&>[data-line]]:-mx-1.5 [&>[data-line]]:cursor-pointer [&>[data-line]]:rounded-sm [&>[data-line]]:px-1.5 [&>[data-line]:hover]:bg-muted/60", className)} onClick={onPickLines ? pick : undefined}>
      {title ? <h1 className="mb-1 text-2xl font-bold">{title}</h1> : null}
      {summary ? <p className="mb-4 mt-0 text-muted-foreground">{summary}</p> : null}
      <Blocks blocks={blocks} components={components} lines={lines} />
    </article>
  );
}


/** Classes that size or place a select in its row: they go on the wrapper, the rest on the select. */
const LAYOUT_CLASS = /^(?:[a-z0-9]+:)*(?:w-|max-w-|min-w-|flex-|basis-|grow|shrink|self-|col-|row-|order-|m[trblxy]?-|-m[trblxy]?-)/;

/**
 * A native `<select>` with our own arrow. Browsers draw their own arrow from the page's
 * color scheme (iOS Safari drew it white on a light page): this one follows the text color.
 * Width classes in `className` go on the wrapper, so it sits in a row like a plain select.
 */
export function NativeSelect({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const tokens = cn(className).split(/\s+/).filter(Boolean);
  const outer = tokens.filter((c) => LAYOUT_CLASS.test(c));
  const inner = tokens.filter((c) => !LAYOUT_CLASS.test(c));
  return (
    <span className={cn("relative inline-flex min-w-0 max-w-full", outer)}>
      <select {...props} className={cn(inner, "w-full min-w-0 cursor-pointer appearance-none truncate pr-8 text-foreground disabled:cursor-not-allowed [&>option]:bg-background [&>option]:text-foreground")}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}


/** A screen with nothing in it yet: what goes here, why it matters, and the one thing to do next. */
export function EmptyState({ icon: Icon, title, text, action, className }: { icon?: React.ElementType; title: React.ReactNode; text?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto my-8 flex w-full max-w-md flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center", className)}>
      {Icon ? (
        <span className="mb-1 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden className="h-5 w-5" />
        </span>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {text ? <p className="text-sm text-muted-foreground">{text}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface DocOption {
  collection: string;
  slug: string;
  title: string;
  /** A short second line: the collection's name, a status. */
  sub?: string;
}

/**
 * Find a document by its title (or slug) and pick it: a combobox, so nobody has to know
 * or type a slug. Arrow keys move, Enter picks (not while a Korean/Japanese word is still
 * being composed), Escape closes. An answer to an older query is never shown.
 */
export function DocPicker({ search, value, onPick, label, placeholder, disabled, className }: {
  search: (q: string) => Promise<DocOption[]>;
  value: DocOption | null;
  onPick: (d: DocOption | null) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useCms();
  const id = React.useId();
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [found, setFound] = React.useState<DocOption[]>([]);
  /** The query and source the shown options answer: an option is picked only while both still hold. */
  const answered = React.useRef<{ q: string; search: unknown } | null>(null);
  const [state, setState] = React.useState<"idle" | "busy" | "failed">("idle");
  const [active, setActive] = React.useState(0);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setState("busy");
    const timer = setTimeout(
      () =>
        search(q).then(
          (list) => {
            if (!live) return;
            answered.current = { q, search };
            setFound(list);
            setState("idle");
            setActive(0);
          },
          () => live && setState("failed")
        ),
      q ? 180 : 0
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, open, search, tick]);
  // A new source (another collection) starts empty: options from the old one are never offered.
  React.useEffect(() => setFound([]), [search]);
  const choose = (d: DocOption | undefined) => {
    // While a new answer is on its way the old options stay visible but cannot be picked.
    if (!d || state !== "idle" || answered.current?.q !== q || answered.current?.search !== search) return;
    onPick(d);
    setQ("");
    setOpen(false);
  };
  if (value)
    return (
      <div className={cn("flex h-9 w-full max-w-md min-w-0 items-center gap-2 rounded-md border px-3 text-sm", className)}>
        <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {value.title || value.slug}
          {value.sub ? <span className="ml-1.5 text-xs text-muted-foreground">{value.sub}</span> : null}
        </span>
        <button type="button" disabled={disabled} className="rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("doc_pick_other")} onClick={() => onPick(null)}>
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
    );
  return (
    <div className={cn("relative w-full max-w-md", className)}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && found.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && found[active] ? `${id}-o${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder ?? label}
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setOpen(true), setActive((a) => Math.min(a + 1, Math.max(found.length - 1, 0))));
          else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && open && found.length) (e.preventDefault(), choose(found[active]));
          else if (e.key === "Escape" && open) (e.preventDefault(), e.stopPropagation(), setOpen(false));
        }}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      {open ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <ul id={`${id}-list`} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto p-1">
            {found.map((d, i) => (
              <li
                key={`${d.collection}/${d.slug}`}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                aria-disabled={state !== "idle" || undefined}
                onClick={() => choose(d)}
                className={cn("flex cursor-pointer flex-col rounded px-2 py-1.5 text-sm", i === active && "bg-accent", state !== "idle" && "cursor-default opacity-50")}
              >
                <span className="truncate">{d.title || d.slug}</span>
                <span className="truncate text-xs text-muted-foreground">{[d.sub, d.slug].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
          <div aria-live="polite" className="px-3 py-2 text-xs text-muted-foreground empty:hidden">
            {state === "busy" && !found.length ? t("loading") : null}
            {state === "failed" ? (
              <span className="flex items-center gap-2">
                {t("doc_pick_failed")}
                <button type="button" className="underline underline-offset-2" onMouseDown={(e) => e.preventDefault()} onClick={() => setTick((n) => n + 1)}>
                  {t("retry")}
                </button>
              </span>
            ) : null}
            {state === "idle" && !found.length ? t("doc_pick_none") : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
