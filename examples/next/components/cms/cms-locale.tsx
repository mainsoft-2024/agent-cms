/**
 * agent-cms — languages in the document editor (0.22.0).
 * Added by `npx @mainsoft/agent-cms add cms-doc-editor`; edit freely, it is your code now.
 *
 * The language tabs (the source and each translation with its status), the bar of a translation
 * (which source version it follows, "Show changes", "Mark as matching"), what changed in the source
 * since, the source text beside the translation, and the screen of a language not started yet.
 * Nothing here calls a model: a plugin can put its own button next to "Start translation" through
 * `slots.localeAction`.
 */
"use client";

import * as React from "react";
import { ExternalLink, Languages, Lock, RotateCw } from "lucide-react";
import { diffWords, type Hunk, type HunkLine } from "@mainsoft/agent-cms/diff";
import type { TranslationView } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { errorMessage, type MessageKey } from "./cms-messages";
import { DIALOG, EmptyState, LocaleStatus } from "./cms-parts";
import { languageName, useCms } from "./use-cms";

export type SourceDiff = { a: number; b: number; fields: { path: string; from: unknown; to: unknown }[]; hunks: Hunk[] };

const FIELD_LABEL: Record<string, MessageKey> = { title: "field_title", slug: "field_slug", summary: "field_summary", category: "field_category", keywords: "field_keywords", body: "field_body" };

// ── tabs ─────────────────────────────────────────────────────────────────────

export interface LocaleTabsProps {
  /** Every language of the CMS in order, the source's status `source`. Null while loading. */
  languages: TranslationView[] | null;
  /** The language on screen. */
  current: string;
  onPick: (locale: string) => void;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

/**
 * One tab per language: its own name and how it stands (원문 / 없음 / 번역 필요 / 최신). Each opens that
 * language's document (or the screen to start it). Arrow keys move between them, Home and End jump.
 */
/** The language just picked from the keyboard or a click: its tab takes focus again once the new screen is drawn. */
let focusAfterSwitch: string | null = null;

export function LocaleTabs({ languages, current, onPick, error, onRetry, className }: LocaleTabsProps) {
  const { t } = useCms();
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  // On a narrow screen the strip scrolls: the language on screen is always in view.
  React.useEffect(() => {
    const el = languages ? refs.current[languages.findIndex((l) => l.locale === current)] : null;
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [languages, current]);
  React.useEffect(() => {
    if (!languages || focusAfterSwitch !== current) return;
    focusAfterSwitch = null;
    refs.current[languages.findIndex((l) => l.locale === current)]?.focus();
  }, [languages, current]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (!languages) return;
    const n = languages.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  return (
    <nav aria-label={t("locale_tabs")} className={cn("flex min-h-10 shrink-0 items-stretch gap-1 overflow-x-auto overscroll-x-contain border-b px-4 [scrollbar-width:none] after:w-4 after:shrink-0 after:content-[''] md:px-6 [&::-webkit-scrollbar]:hidden", className)}>
      {languages ? (
        languages.map((l, i) => {
          const on = l.locale === current;
          const name = languageName(l.locale);
          return (
            <button
              key={l.locale}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              aria-current={on ? "page" : undefined}
              aria-label={t("locale_tab_label", { language: name, status: t(`locale_status_${l.status}` as MessageKey) })}
              onKeyDown={(e) => onKey(e, i)}
              onClick={() => {
                if (on) return;
                focusAfterSwitch = l.locale;
                onPick(l.locale);
              }}
              className={cn(
                "relative inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-2 text-sm outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                on ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <span aria-hidden lang={l.locale}>
                {name}
              </span>
              {/* On a phone only the tab on screen spells its status; the others keep a dot (the name says it all). */}
              <LocaleStatus status={l.status} className={cn(!on && "max-sm:hidden")} />
              {!on && l.status !== "source" ? (
                <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full sm:hidden", l.status === "outdated" ? "bg-amber-500" : l.status === "current" ? "bg-green-600" : "bg-neutral-400")} />
              ) : null}
            </button>
          );
        })
      ) : error ? (
        <span role="alert" className="flex items-center gap-2 py-2 text-xs text-destructive">
          {t("locale_load_failed", { error: errorMessage(error, t) })}
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={onRetry}>
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              {t("retry")}
            </Button>
          ) : null}
        </span>
      ) : (
        <span className="flex items-center gap-3 py-2" aria-busy>
          <span className="sr-only">{t("loading")}</span>
          {[0, 1, 2].map((i) => (
            <span key={i} aria-hidden className="h-5 w-20 animate-pulse rounded bg-muted" />
          ))}
        </span>
      )}
    </nav>
  );
}

// ── the bar of a translation ─────────────────────────────────────────────────

export interface TranslationBarProps {
  info: TranslationView;
  /** The source version translations are compared with (published, else latest). */
  sourceVersion: number;
  defaultLocale: string;
  changesOpen: boolean;
  onToggleChanges: () => void;
  onAlign: () => void;
  aligning: boolean;
  canWrite: boolean;
  /** The translation is published (else readers of a site that falls back see the source). */
  published: boolean;
  onOpenSource: () => void;
  /** Where the site shows this language (absolute or from the app's root). */
  url?: string | null;
  /** `slots.localeAction` for this translation. */
  action?: React.ReactNode;
}

/** "원문 v7, 이 번역은 v5 기준" with "바뀐 곳 보기" and "v7 기준으로 맞춤"; under it what follows the source. */
export function TranslationBar({ info, sourceVersion, defaultLocale, changesOpen, onToggleChanges, onAlign, aligning, canWrite, published, onOpenSource, url, action }: TranslationBarProps) {
  const { t } = useCms();
  const outdated = info.status === "outdated";
  const source = languageName(defaultLocale);
  return (
    <div className={cn("shrink-0 border-b px-4 py-2 md:px-6", outdated ? "bg-amber-500/[0.06]" : "bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Languages aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p id="cms-locale-status" tabIndex={-1} className="min-w-0 flex-1 text-[13.5px] outline-none">{outdated ? t("locale_versions", { source: sourceVersion, own: info.sourceVersion ?? 1 }) : t("locale_aligned", { source: info.sourceVersion ?? sourceVersion })}</p>
        {outdated || action ? (
          <span className="flex w-full flex-wrap items-center gap-1.5 pl-7 sm:w-auto sm:pl-0">
            {action}
            {outdated ? (
              <>
                <Button type="button" variant="outline" size="sm" className="h-8" aria-expanded={changesOpen} aria-controls="cms-locale-changes" onClick={onToggleChanges}>
                  {changesOpen ? t("locale_hide_changes") : t("locale_show_changes")}
                </Button>
                {canWrite ? (
                  <Button type="button" size="sm" className="h-8" disabled={aligning} aria-busy={aligning || undefined} onClick={onAlign}>
                    {t("locale_mark_aligned", { version: sourceVersion })}
                  </Button>
                ) : null}
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground md:pl-7">
        <span className="inline-flex items-center gap-1">
          <Lock aria-hidden className="h-3 w-3 shrink-0" />
          {t("locale_shared_note", { source })}
        </span>
        <button type="button" className="inline-flex min-h-6 items-center rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpenSource}>
          {t("locale_open_source")}
        </button>
        {!published ? <span className="text-amber-700 dark:text-amber-400">{t("locale_unpublished_fallback", { language: languageName(info.locale), source })}</span> : null}
        {url && published ? (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 max-w-full items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">
            <span className="truncate font-mono">{t("locale_public_address", { url: url.replace(/^https?:\/\/[^/]+/, "") })}</span>
            <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
          </a>
        ) : url ? (
          <span className="min-w-0 truncate font-mono">{t("locale_public_address", { url: url.replace(/^https?:\/\/[^/]+/, "") })}</span>
        ) : null}
      </p>
    </div>
  );
}

// ── what changed in the source ───────────────────────────────────────────────

function Words({ a, b, side }: { a: string; b: string; side: "a" | "b" }) {
  return (
    <>
      {diffWords(a, b).map((p, i) =>
        p.t === "eq" ? (
          <React.Fragment key={i}>{p.v}</React.Fragment>
        ) : p.t === "del" && side === "a" ? (
          <del key={i} className="bg-red-200 no-underline dark:bg-red-900/60">
            {p.v}
          </del>
        ) : p.t === "ins" && side === "b" ? (
          <ins key={i} className="bg-green-200 no-underline dark:bg-green-900/60">
            {p.v}
          </ins>
        ) : null
      )}
    </>
  );
}

const show = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Removed and added lines of a hunk paired in order (for the word highlight). */
function pairLines(h: Hunk): Map<HunkLine, string> {
  const out = new Map<HunkLine, string>();
  let dels: HunkLine[] = [];
  let adds: HunkLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      out.set(dels[i], adds[i].v);
      out.set(adds[i], dels[i].v);
    }
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.t === "-") dels.push(l);
    else if (l.t === "+") adds.push(l);
    else flush();
  }
  flush();
  return out;
}

/** The source's changes between the version the translation follows and now: changed fields, then the body's lines. */
export function SourceChanges({ diff, loading, error, onRetry, className }: { diff: SourceDiff | null; loading: boolean; error: unknown; onRetry: () => void; className?: string }) {
  const { t } = useCms();
  const name = (path: string) => (FIELD_LABEL[path] ? t(FIELD_LABEL[path]) : path.replace(/^fields\./, ""));
  return (
    <section id="cms-locale-changes" aria-label={diff ? t("locale_changes_title", { from: diff.a }) : t("locale_show_changes")} aria-busy={loading || undefined} className={cn("max-h-[45vh] shrink-0 overflow-auto border-b bg-background px-4 py-3 md:px-6", className)}>
      {loading && !diff ? (
        <div className="grid gap-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : error && !diff ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{t("locale_changes_failed", { error: errorMessage(error, t) })}</span>
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={onRetry}>
            {t("retry")}
          </Button>
        </div>
      ) : diff ? (
        <div className="grid gap-2">
          <h2 className="text-sm font-medium">{t("locale_changes_title", { from: diff.a })}</h2>
          {!diff.fields.length && !diff.hunks.length ? <p className="text-sm text-muted-foreground">{t("locale_changes_none")}</p> : null}
          {diff.fields.length ? (
            <ul className="grid gap-1 text-[13px]">
              {diff.fields.map((f) => (
                <li key={f.path} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="shrink-0 font-medium">{name(f.path)}</span>
                  <del className="min-w-0 break-words bg-red-50 px-1 no-underline dark:bg-red-950/40">
                    <span className="sr-only">- </span>
                    {show(f.from) || "—"}
                  </del>
                  <span aria-hidden className="text-muted-foreground">
                    →
                  </span>
                  <ins className="min-w-0 break-words bg-green-50 px-1 no-underline dark:bg-green-950/40">
                    <span className="sr-only">+ </span>
                    {show(f.to) || "—"}
                  </ins>
                </li>
              ))}
            </ul>
          ) : null}
          {diff.hunks.length ? (
            <div className="overflow-hidden rounded-md border">
              {diff.hunks.map((h, hi) => {
                const pairs = pairLines(h);
                return (
                  <div key={hi} className="border-b last:border-b-0">
                    {h.lines.map((l, i) => {
                      const other = pairs.get(l);
                      return (
                        <div key={i} className={cn("flex min-w-0 gap-2 px-2 font-mono text-xs leading-6", l.t === "-" && "bg-red-50 dark:bg-red-950/40", l.t === "+" && "bg-green-50 dark:bg-green-950/40")}>
                          <span aria-hidden className="w-3 shrink-0 select-none text-muted-foreground">
                            {l.t === "-" ? "−" : l.t === "+" ? "+" : " "}
                          </span>
                          <span className="min-w-0 whitespace-pre-wrap break-words">
                            {l.t !== " " ? <span className="sr-only">{l.t} </span> : null}
                            {other !== undefined ? l.t === "-" ? <Words a={l.v} b={other} side="a" /> : <Words a={other} b={l.v} side="b" /> : l.v}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Lines of the newer source that are new or changed (1-based), from a source diff. */
export function changedSourceLines(diff: SourceDiff | null | undefined): Set<number> {
  const out = new Set<number>();
  // Blank lines are left unmarked: a marked empty line says nothing.
  for (const h of diff?.hunks ?? []) for (const l of h.lines) if (l.t === "+" && l.b && l.v.trim()) out.add(l.b);
  return out;
}

// ── the source beside the translation ────────────────────────────────────────

export interface SourcePaneProps {
  locale: string;
  version: number | null;
  source: { title: string; summary: string; body: string } | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Lines (1-based) changed since the version the translation follows. */
  marked: Set<number>;
  className?: string;
}

/** The source as translations compare with it, read only, with the changed lines marked. */
export function SourcePane({ locale, version, source, loading, error, onRetry, marked, className }: SourcePaneProps) {
  const { t } = useCms();
  const name = languageName(locale);
  const lines = React.useMemo(() => (source?.body ?? "").split("\n"), [source?.body]);
  return (
    <div aria-busy={loading || undefined} className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-muted/20", className)}>
      <div className="flex min-h-8 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <span className="font-medium" lang={locale}>
          {name}
        </span>
        <span className="flex-1" />
        {marked.size ? <span className="text-amber-700 dark:text-amber-400">{t("locale_changed_lines", { n: marked.size })}</span> : null}
        {version ? <span className="tabular-nums">v{version}</span> : null}
      </div>
      {/* Focusable so it scrolls from the keyboard; it is read only. */}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" lang={locale} tabIndex={0} role="region" aria-label={t("locale_source_pane", { language: name })}>
        {loading && !source ? (
          <div className="grid gap-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${90 - i * 15}%` }} />
            ))}
          </div>
        ) : error && !source ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            <span>{errorMessage(error, t)}</span>
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={onRetry}>
              {t("retry")}
            </Button>
          </div>
        ) : source ? (
          <>
            <p className="mb-1 text-[15px] font-semibold">{source.title}</p>
            {source.summary ? <p className="mb-3 text-[13px] text-muted-foreground">{source.summary}</p> : null}
            <div className="font-mono text-[13px] leading-6">
              {lines.map((l, i) =>
                marked.has(i + 1) ? (
                  <mark key={i} className="block whitespace-pre-wrap break-words bg-amber-200/60 text-foreground dark:bg-amber-500/25">
                    <span className="sr-only">+ </span>
                    {l || " "}
                  </mark>
                ) : (
                  <div key={i} className="whitespace-pre-wrap break-words">
                    {l || " "}
                  </div>
                )
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── a language not started ───────────────────────────────────────────────────

export function MissingTranslation({ locale, defaultLocale, canWrite, busy, error, onStart, action }: { locale: string; defaultLocale: string; canWrite: boolean; busy: boolean; error: string | null; onStart: () => void; action?: React.ReactNode }) {
  const { t } = useCms();
  const name = languageName(locale);
  const source = languageName(defaultLocale);
  return (
    <EmptyState
      icon={Languages}
      title={t("locale_missing_title", { language: name })}
      text={
        <>
          {t("locale_missing_text", { language: name, source })}
          {canWrite ? <span className="mt-1 block">{t("locale_start_help", { source })}</span> : null}
        </>
      }
      action={
        <div className="flex flex-col items-center gap-2">
          {canWrite || action ? (
            <div className="flex flex-wrap justify-center gap-2">
              {canWrite ? (
                <Button type="button" disabled={busy} aria-busy={busy || undefined} onClick={onStart}>
                  {t("locale_start")}
                </Button>
              ) : null}
              {action}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

// ── leaving with unsaved edits ───────────────────────────────────────────────

export function LocaleLeaveDialog({ locale, busy, onSave, onDiscard, onCancel }: { locale: string | null; busy: boolean; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const { t } = useCms();
  return (
    <Dialog open={!!locale} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent className={DIALOG.sm}>
        <DialogHeader>
          <DialogTitle>{t("locale_leave_title")}</DialogTitle>
          <DialogDescription>{locale ? t("locale_leave_text", { language: languageName(locale) }) : null}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onDiscard}>
            {t("locale_leave_discard")}
          </Button>
          <Button type="button" autoFocus disabled={busy} aria-busy={busy || undefined} onClick={onSave}>
            {t("locale_leave_save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
