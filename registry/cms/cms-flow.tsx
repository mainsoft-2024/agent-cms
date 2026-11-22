// agent-cms registry: cms-doc-editor (0.10.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The pieces of the publishing flow the editor shows: the publish button
// with its schedule panel, the schedule and review strips, the comments
// panel, and the "add to a release" dialog.
"use client";

import * as React from "react";
import { Bot, CalendarClock, Check, ChevronDown, MessageSquare, RotateCcw, Undo2, X } from "lucide-react";
import type { CommentThread } from "@mainsoft/agent-cms/client";
import { splitSections } from "@mainsoft/agent-cms/markdown";
import type { CmsComment, CmsDoc, CmsRelease } from "@mainsoft/agent-cms/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { Segmented, StatusText, DIALOG, NativeSelect } from "./cms-parts";
import { formatZoned, personColor, relativeTime, useCms, zonedParts, zonedToIso } from "./use-cms";

export const FLOW_SELECT = "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const FIELD = "h-9 rounded-md border border-input bg-background px-2.5 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ── where things are in a body ───────────────────────────────────────────────

export interface Place {
  start: number;
  end: number;
  kind: "quote" | "section" | "doc";
}

/** Every `#` / `##` heading of `body` with its anchor (the same anchors `splitSections` gives) and where its line starts. */
export function sectionStarts(body: string): { anchor: string; start: number; end: number }[] {
  const out: { anchor: string; start: number; end: number }[] = [];
  let at = 0;
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    else if (!fence && /^#{1,2}\s+\S/.test(line)) {
      const secs = splitSections(body.slice(0, at + line.length));
      out.push({ anchor: secs[secs.length - 1]?.anchor ?? "", start: at, end: at + line.length });
    }
    at += line.length + 1;
  }
  return out;
}

/** The anchor of the section the character at `offset` is in ("" before the first heading). */
export function sectionAt(body: string, offset: number): string {
  let anchor = "";
  for (const s of sectionStarts(body)) if (s.start <= offset) anchor = s.anchor;
  return anchor;
}

/** Where a comment sits in `body` now: on its quoted text, else on its section's heading, else nowhere (null). */
export function placeOf(body: string, c: Pick<CmsComment, "anchor" | "quote">): Place | null {
  if (c.quote) {
    const i = body.indexOf(c.quote);
    if (i >= 0) return { start: i, end: i + c.quote.length, kind: "quote" };
  }
  if (!c.anchor) return c.quote ? null : { start: 0, end: 0, kind: "doc" };
  const s = sectionStarts(body).find((x) => x.anchor === c.anchor);
  return s ? { start: s.start, end: s.end, kind: "section" } : null;
}

// ── marks behind the body ────────────────────────────────────────────────────

export interface BodyCursor {
  id: string;
  /** Character offset in the body. */
  at: number;
  label: string;
  color: string;
}

/** The character offset of a 1-based line and a column in `body` (clamped to what exists). */
export function offsetOf(body: string, line: number, ch: number): number {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const n = body.indexOf("\n", at);
    if (n < 0) return body.length;
    at = n + 1;
  }
  const end = body.indexOf("\n", at);
  return Math.min(at + Math.max(0, ch), end < 0 ? body.length : end);
}

/**
 * Sits behind the body's text box and draws what a text box cannot: the
 * places comments are attached to, and where other people's cursors are.
 * It copies the box's font and padding and follows its scrolling, so its
 * (invisible) text lines up with the real text.
 */
export function BodyBackdrop({ box, text, marks, cursors }: { box: React.RefObject<HTMLTextAreaElement | null>; text: string; marks: { start: number; end: number; tone?: "select" }[]; cursors: BodyCursor[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // An effect, not a layout effect: the text box is a later sibling, and its ref is not set yet when layout effects of this one run.
  React.useEffect(() => {
    const el = box.current;
    const back = ref.current;
    if (!el || !back) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const bar = el.offsetWidth - el.clientWidth;
      Object.assign(back.style, { font: cs.font, letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft, paddingRight: `${(parseFloat(cs.paddingRight) || 0) + Math.max(0, bar)}px`, tabSize: cs.tabSize });
      back.scrollTop = el.scrollTop;
    };
    fit();
    const follow = () => (back.scrollTop = el.scrollTop);
    el.addEventListener("scroll", follow);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", follow);
      ro?.disconnect();
    };
  }, [box, text]);

  // Cut the text at every mark edge and cursor, in order.
  const cuts = new Set<number>([0, text.length]);
  for (const m of marks) (cuts.add(Math.min(m.start, text.length)), cuts.add(Math.min(m.end, text.length)));
  for (const c of cursors) cuts.add(Math.min(c.at, text.length));
  const points = [...cuts].sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  points.forEach((from, i) => {
    for (const c of cursors.filter((x) => Math.min(x.at, text.length) === from))
      out.push(
        <span key={`c${c.id}`} data-cms-cursor={c.label} className="relative -mr-0.5 inline-block h-[1.15em] w-0.5 align-text-bottom" style={{ background: c.color }}>
          <span className="absolute -top-3.5 left-0 whitespace-nowrap rounded-[3px] rounded-bl-none px-1 font-sans text-[10px] font-semibold leading-[15px] text-white" style={{ background: c.color }}>
            {c.label}
          </span>
        </span>
      );
    const to = points[i + 1];
    if (to === undefined) return;
    const piece = text.slice(from, to);
    const over = marks.filter((m) => m.start <= from && m.end >= to && m.end > m.start);
    out.push(
      over.length ? (
        <mark key={from} className={cn("rounded-sm text-transparent", over.some((m) => !m.tone) ? "bg-amber-200/70" : "bg-neutral-500/20")}>
          {piece}
        </mark>
      ) : (
        piece
      )
    );
  });
  return (
    <div ref={ref} aria-hidden data-cms-backdrop="" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent">
      {out}
      {"\n"}
    </div>
  );
}

// ── publish button with the schedule panel ───────────────────────────────────

export interface PublishButtonProps {
  disabled?: boolean;
  busy?: boolean;
  /** False for a document that was never saved: there is no version to schedule yet. */
  canSchedule: boolean;
  schedule: CmsDoc["schedule"];
  /** Open the panel upwards (a bar at the bottom of the screen). */
  up?: boolean;
  className?: string;
  onPublish: () => void;
  onSchedule: (when: { publishAt: string | null; unpublishAt: string | null }) => Promise<void>;
  onUnschedule: () => Promise<void>;
}

/** "Publish", and beside it the choice between now and a set time. Times are entered on the CMS's clock. */
export function PublishButton({ disabled, busy, canSchedule, schedule, up, className, onPublish, onSchedule, onUnschedule }: PublishButtonProps) {
  const { t, me } = useCms();
  const zone = me?.timeZone ?? "UTC";
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"now" | "later">("later");
  const [pub, setPub] = React.useState({ date: "", time: "" });
  const [down, setDown] = React.useState({ date: "", time: "" });
  const [error, setError] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);
  const toggle = React.useRef<HTMLButtonElement>(null);
  const id = React.useId();

  const show = () => {
    // Tomorrow at nine, unless something is already set.
    const tomorrow = zonedParts(new Date(Date.now() + 86_400_000).toISOString(), zone).date;
    setPub(schedule?.publishAt ? zonedParts(schedule.publishAt, zone) : schedule ? { date: "", time: "" } : { date: tomorrow, time: "09:00" });
    setDown(schedule?.unpublishAt ? zonedParts(schedule.unpublishAt, zone) : { date: "", time: "" });
    setMode("later");
    setError(null);
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) toggle.current?.focus();
  };

  React.useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const submit = async () => {
    if (mode === "now") {
      close();
      return onPublish();
    }
    const publishAt = pub.date ? zonedToIso(pub.date, pub.time || "09:00", zone) : null;
    const unpublishAt = down.date ? zonedToIso(down.date, down.time || "09:00", zone) : null;
    // A time the clocks skip (daylight saving) does not exist: say so instead of dropping it.
    if ((pub.date && !publishAt) || (down.date && !unpublishAt)) return setError(t("sched_no_such_time", { zone }));
    const now = Date.now();
    if ((publishAt && Date.parse(publishAt) <= now) || (unpublishAt && Date.parse(unpublishAt) <= now)) return setError(t("sched_past"));
    if (publishAt && unpublishAt && Date.parse(unpublishAt) <= Date.parse(publishAt)) return setError(t("sched_order"));
    setWorking(true);
    setError(null);
    try {
      await onSchedule({ publishAt, unpublishAt });
      close();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setWorking(false);
    }
  };

  const when = (label: string, v: { date: string; time: string }, set: (x: { date: string; time: string }) => void, withZone: boolean) => (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 flex w-full items-center text-xs font-medium">
        <span className="flex-1">{label}</span>
        {withZone ? <span className="font-normal text-muted-foreground">{zone}</span> : null}
      </legend>
      <div className="flex gap-2">
        <input type="date" aria-label={`${label}: ${t("sched_date")}`} className={cn(FIELD, "min-w-0 flex-1")} value={v.date} onChange={(e) => set({ ...v, date: e.target.value })} />
        <input type="time" aria-label={`${label}: ${t("sched_time")}`} className={cn(FIELD, "w-[112px]")} value={v.time} onChange={(e) => set({ ...v, time: e.target.value })} />
      </div>
    </fieldset>
  );

  return (
    <div ref={wrap} className={cn("relative inline-flex", className)}>
      <Button type="button" className="flex-1 rounded-r-none" disabled={disabled || busy} onClick={onPublish}>
        {t("publish")}
      </Button>
      <Button
        ref={toggle}
        type="button"
        className="rounded-l-none border-l border-primary-foreground/25 px-2"
        aria-label={t("publish_options")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy || !canSchedule}
        onClick={() => (open ? close() : show())}
      >
        <ChevronDown aria-hidden className="h-3.5 w-3.5" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("publish_later")}
          className={cn("absolute right-0 z-50 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-3 rounded-lg border bg-background p-3.5 text-sm shadow-lg", up ? "bottom-full mb-1.5" : "top-full mt-1.5")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <div role="radiogroup" aria-label={t("publish_options")} className="grid gap-2.5">
            {(["now", "later"] as const).map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-2">
                <input type="radio" name={`${id}-mode`} className="h-4 w-4 accent-primary" checked={mode === m} disabled={m === "now" && !!disabled} onChange={() => setMode(m)} autoFocus={m === "later"} />
                {t(m === "now" ? "publish_now" : "publish_later")}
              </label>
            ))}
          </div>
          {mode === "later" ? (
            <>
              {when(t("sched_publish_at"), pub, setPub, true)}
              {when(t("sched_unpublish_at"), down, setDown, false)}
            </>
          ) : null}
          {error ? <StatusText tone="error" className="text-xs">{error}</StatusText> : null}
          <div className="flex items-center justify-end gap-2">
            {schedule ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto h-8 px-2 text-destructive hover:text-destructive"
                disabled={working}
                onClick={() => {
                  setWorking(true);
                  onUnschedule().then(
                    () => (setWorking(false), close()),
                    (e) => (setWorking(false), setError(errorMessage(e, t)))
                  );
                }}
              >
                {t("sched_cancel")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => close()}>
              {t("cancel")}
            </Button>
            <Button type="button" size="sm" className="h-8" disabled={working || (mode === "later" && !pub.date && !down.date)} onClick={() => void submit()}>
              {mode === "now" ? t("publish") : t("sched_go")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── strips under the header ──────────────────────────────────────────────────

const STRIP = "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b bg-muted/50 px-4 py-2 text-[13.5px] md:px-6";

/** What is scheduled, and a warning when the document changed after that. */
export function ScheduleStrip({ doc, canPublish, busy, onAgain, onUnschedule }: { doc: CmsDoc; canPublish: boolean; busy?: boolean; onAgain: () => void; onUnschedule: () => void }) {
  const { t, locale, me } = useCms();
  const s = doc.schedule;
  if (!s) return null;
  const zone = me?.timeZone;
  const stale = !!s.publishAt && s.version !== doc.version;
  return (
    <div role="status" className={STRIP}>
      <CalendarClock aria-hidden className="h-4 w-4 shrink-0" />
      {s.publishAt ? <span>{t("sched_banner", { version: s.version, time: formatZoned(s.publishAt, locale, zone) })}</span> : null}
      {s.unpublishAt ? <span>{t("sched_banner_down", { time: formatZoned(s.unpublishAt, locale, zone) })}</span> : null}
      <span className="text-xs text-muted-foreground">{s.byAgent ?? s.by}</span>
      {stale ? <span className="font-medium text-amber-700">{t("sched_stale")}</span> : null}
      <span className="flex-1" />
      {canPublish ? (
        <>
          {stale ? (
            <Button type="button" variant="outline" size="sm" className="h-7 bg-background" disabled={busy} onClick={onAgain}>
              {t("sched_again")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy} onClick={onUnschedule}>
            {t("sched_cancel")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** "docs-bot asked for a review of v2", with the answer buttons for people who may publish. */
export function ReviewStrip({ doc, canAnswer, canWrite, busy, onApprove, onReject, onRequest }: { doc: CmsDoc; canAnswer: boolean; canWrite: boolean; busy?: boolean; onApprove: () => void; onReject: (note: string) => Promise<void>; onRequest: () => void }) {
  const { t, locale } = useCms();
  const [rejecting, setRejecting] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);
  const r = doc.review;
  if (!r) return null;
  const asked = r.state === "requested";
  const bot = r.byKind !== "user" || !!r.byAgent;
  return (
    <div role="status" className={STRIP}>
      {!asked ? <Undo2 aria-hidden className="h-4 w-4 shrink-0" /> : bot ? <Bot aria-hidden className="h-4 w-4 shrink-0" /> : null}
      <span>{asked ? t("review_requested_by", { who: r.byAgent ?? r.by ?? "", version: r.version }) : t("review_changes_by", { who: r.answeredBy ?? "", version: r.version })}</span>
      <span className="text-xs text-muted-foreground">{relativeTime(asked ? r.at : (r.answeredAt ?? r.at), t, locale)}</span>
      {r.note ? <span className="min-w-0 basis-full text-[13px] text-muted-foreground md:basis-auto md:truncate">{r.note}</span> : null}
      <span className="flex-1" />
      {asked && canAnswer ? (
        <>
          <Button type="button" variant="outline" size="sm" className="h-7 bg-background" disabled={busy} onClick={() => (setNote(""), setError(null), setRejecting(true))}>
            {t("review_reject")}
          </Button>
          <Button type="button" size="sm" className="h-7" disabled={busy} onClick={onApprove}>
            {t("review_approve_publish")}
          </Button>
        </>
      ) : null}
      {!asked && canWrite ? (
        <Button type="button" variant="outline" size="sm" className="h-7 bg-background" disabled={busy} onClick={onRequest}>
          {t("review_request")}
        </Button>
      ) : null}
      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent className={DIALOG.md}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setWorking(true);
              onReject(note.trim()).then(
                () => (setWorking(false), setRejecting(false)),
                (err) => (setWorking(false), setError(errorMessage(err, t)))
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("review_reject")}</DialogTitle>
              <DialogDescription className="sr-only">{t("review_requested_by", { who: r.byAgent ?? r.by ?? "", version: r.version })}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="cms-review-note">{t("review_note")}</Label>
              <Textarea id="cms-review-note" autoFocus rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
              {error ? <StatusText tone="error">{error}</StatusText> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRejecting(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={working}>
                {t("review_reject")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── comments ─────────────────────────────────────────────────────────────────

function Author({ c }: { c: CmsComment }) {
  const { t, locale } = useCms();
  const bot = c.authorKind === "key" || c.authorKind === "system" || !!c.authorAgent;
  const name = c.authorAgent ?? c.authorLabel ?? "";
  return (
    <>
      <span aria-hidden style={{ background: personColor(c.authorId ?? name, bot) }} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white">
        {bot ? <Bot className="h-3 w-3" /> : (name || "?").trim().charAt(0).toUpperCase()}
      </span>
      <span className="truncate font-medium">{name}</span>
      {c.authorKind === "guest" ? <span className="shrink-0 rounded border px-1 text-[11px] text-muted-foreground">{t("comment_guest")}</span> : null}
      <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(c.createdAt, t, locale)}</span>
    </>
  );
}

export interface CommentsPanelProps {
  collection: string;
  slug: string;
  /** The body as it is in the editor now (comments follow the text as it is typed). */
  body: string;
  canWrite: boolean;
  threads: CommentThread[];
  onChanged: () => void;
  /** The selection in the body, to hang a new comment on. */
  getSelection?: () => [number, number] | null;
  /** Show this part of the body (a comment's quote or heading was pressed). */
  onGo?: (start: number, end: number) => void;
  onClose?: () => void;
  className?: string;
}

/** Comments on sections and quoted text, with one level of replies. */
export function CommentsPanel({ collection, slug, body, canWrite, threads, onChanged, getSelection, onGo, onClose, className }: CommentsPanelProps) {
  const { client, t } = useCms();
  const [tab, setTab] = React.useState<"open" | "resolved">("open");
  const [text, setText] = React.useState("");
  const [replies, setReplies] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [target, setTarget] = React.useState<{ kind: Place["kind"]; quote: string; anchor: string }>({ kind: "doc", quote: "", anchor: "" });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  /** Read where the cursor is when the person starts writing: the selection, else the section, else the whole document. */
  const aim = () => {
    const sel = getSelection?.() ?? null;
    if (!sel) return setTarget({ kind: "doc", quote: "", anchor: "" });
    const anchor = sectionAt(body, sel[0]);
    const quote = body.slice(sel[0], sel[1]).trim();
    setTarget(quote && !quote.includes("\n") && quote.length <= 300 ? { kind: "quote", quote, anchor } : { kind: anchor ? "section" : "doc", quote: "", anchor });
  };

  const open = threads.filter((x) => !x.resolvedAt);
  const done = threads.filter((x) => x.resolvedAt);
  const placed = (tab === "open" ? open : done).map((th) => ({ th, at: placeOf(body, th) }));
  const here = placed.filter((x) => x.at).sort((a, b) => a.at!.start - b.at!.start);
  const lost = placed.filter((x) => !x.at);

  const thread = ({ th, at }: { th: CommentThread; at: Place | null }) => (
    <li key={th.id} className="flex flex-col gap-2 border-b p-3 text-[13.5px]">
      <div className="flex items-center gap-1.5">
        <Author c={th} />
        <span className="flex-1" />
        {canWrite ? (
          <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" disabled={busy} onClick={() => void act(() => client.resolveComment(collection, slug, th.id, !th.resolvedAt))}>
            {th.resolvedAt ? <RotateCcw aria-hidden className="h-3.5 w-3.5" /> : <Check aria-hidden className="h-3.5 w-3.5" />}
            {t(th.resolvedAt ? "comment_reopen" : "comment_resolve")}
          </Button>
        ) : null}
      </div>
      {th.quote || (at && at.kind === "section") ? (
        <button
          type="button"
          disabled={!at || !onGo}
          onClick={() => at && onGo?.(at.start, at.end)}
          className="truncate border-l-2 pl-2 text-left font-mono text-[12.5px] text-muted-foreground outline-none enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {at?.kind === "section" || !th.quote ? body.slice(at!.start, at!.end) : th.quote}
        </button>
      ) : null}
      <p className="whitespace-pre-wrap break-words">{th.body}</p>
      {th.replies.length ? (
        <ul className="ml-3.5 flex flex-col gap-2 border-l pl-3">
          {th.replies.map((r) => (
            <li key={r.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Author c={r} />
              </div>
              <p className="whitespace-pre-wrap break-words">{r.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {canWrite && !th.resolvedAt ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const b = (replies[th.id] ?? "").trim();
            if (b) void act(() => client.addComment(collection, slug, { body: b, threadId: th.id }).then(() => setReplies((r) => ({ ...r, [th.id]: "" }))));
          }}
        >
          <Input aria-label={`${t("comment_reply")}: ${th.authorAgent ?? th.authorLabel ?? ""}`} placeholder={t("comment_reply")} className="h-8 text-[13px]" maxLength={4000} value={replies[th.id] ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [th.id]: e.target.value }))} />
        </form>
      ) : null}
    </li>
  );

  return (
    <aside aria-label={t("comments")} className={cn("flex min-h-0 w-full shrink-0 flex-col md:w-80 md:border-l", className)}>
      <div className="flex items-center gap-1.5 border-b px-3 py-1 text-xs text-muted-foreground">
        <MessageSquare aria-hidden className="h-3.5 w-3.5" />
        <span className="font-medium">{t("comments")}</span>
        <span className="flex-1" />
        <Segmented
          label={t("comments_filter")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "open", label: t("comments_open", { n: open.length }) },
            { value: "resolved", label: t("comments_resolved", { n: done.length }) },
          ]}
          itemClassName="h-6 px-2 text-xs"
        />
        {onClose ? (
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={t("close")} onClick={onClose}>
            <X aria-hidden className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      {canWrite && tab === "open" ? (
        <form
          className="flex flex-col gap-2 border-b p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const b = text.trim();
            if (b) void act(() => client.addComment(collection, slug, { body: b, anchor: target.anchor, quote: target.quote }).then(() => setText("")));
          }}
        >
          <Textarea aria-label={t("comment_write")} placeholder={t("comment_write")} rows={2} maxLength={4000} className="min-h-[60px] resize-none text-[13px]" value={text} onFocus={aim} onChange={(e) => setText(e.target.value)} />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {t(target.kind === "quote" ? "comment_on_selection" : target.kind === "section" ? "comment_on_section" : "comment_on_doc")}
              {target.quote ? <span className="font-mono">: {target.quote}</span> : null}
            </span>
            <Button type="submit" size="sm" className="h-7" disabled={busy || !text.trim()}>
              {t("comment_add")}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <StatusText tone="error" className="px-3 py-2 text-xs">{error}</StatusText> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!placed.length ? <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">{t("comment_empty")}</p> : null}
        <ul>{here.map(thread)}</ul>
        {lost.length ? (
          <>
            <h3 className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">{t("comment_lost")}</h3>
            <ul>{lost.map(thread)}</ul>
          </>
        ) : null}
      </div>
    </aside>
  );
}

// ── releases ─────────────────────────────────────────────────────────────────

/** Put this document in an open release (or a new one), to publish or to unpublish with the rest of it. */
export function AddToReleaseDialog({ open, onOpenChange, collection, slug, published, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; collection: string; slug: string; published: boolean; onAdded: (r: { id: string; name: string }) => void }) {
  const { client, t } = useCms();
  const [list, setList] = React.useState<CmsRelease[] | null>(null);
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [action, setAction] = React.useState<"publish" | "unpublish">("publish");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setName("");
    setAction("publish");
    client.releases().then(
      (all) => {
        if (!live) return;
        const openOnes = all.filter((r) => r.state !== "published");
        setList(openOnes);
        setId(openOnes[0]?.id ?? "");
      },
      (e) => live && setError(errorMessage(e, t))
    );
    return () => {
      live = false;
    };
  }, [open, client, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG.sm}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            (async () => {
              const target = id ? (list ?? []).find((r) => r.id === id)! : await client.createRelease(name.trim());
              await client.addToRelease(target.id, [{ collection, slug, action }]);
              return target;
            })().then(
              (r) => (setBusy(false), onAdded({ id: r.id, name: r.name }), onOpenChange(false)),
              (err) => (setBusy(false), setError(errorMessage(err, t)))
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("release_add_to")}</DialogTitle>
            <DialogDescription className="sr-only">{t("nav_releases")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cms-rel-pick">{t("nav_releases")}</Label>
            <NativeSelect id="cms-rel-pick" className={FLOW_SELECT} value={id} onChange={(e) => setId(e.target.value)}>
              {(list ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              <option value="">{t("release_new")}</option>
            </NativeSelect>
          </div>
          {!id ? (
            <div className="grid gap-1.5">
              <Label htmlFor="cms-rel-name">{t("name")}</Label>
              <Input id="cms-rel-name" autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          ) : null}
          {published ? (
            <div className="grid gap-1.5">
              <span id="cms-rel-action" className="text-sm font-medium">
                {t("release_action")}
              </span>
              <Segmented
                labelledBy="cms-rel-action"
                value={action}
                onChange={setAction}
                options={[
                  { value: "publish", label: t("publish") },
                  { value: "unpublish", label: t("release_unpublish") },
                ]}
              />
            </div>
          ) : null}
          {error ? <StatusText tone="error">{error}</StatusText> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !list || (!id && !name.trim())}>
              {t("release_add_to")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
