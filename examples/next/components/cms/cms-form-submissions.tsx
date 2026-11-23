// agent-cms registry: cms-form-submissions (0.22.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// One form's submissions: received / spam / archived, search, a table with the
// form's first fields, the whole submission beside it (files open through a
// five-minute link), mark as spam, archive, move back, delete — one at a time
// or several at once. Opening a new one marks it read. Used by the Submissions
// tab of <CmsFormEditor>; works on its own too.
"use client";

import * as React from "react";
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Paperclip,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import {
  displayValue,
  formFields,
  type FormCounts,
  type FormField,
  type FormSubmissionStatus,
  type FormSubmissionView,
  type FormView,
} from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage, type T } from "./cms-messages";
import {
  ConfirmDialog,
  DIALOG,
  EmptyState,
  Segmented,
  StatusText,
} from "./cms-parts";
import {
  formatDateTime,
  relativeTime,
  useCms,
  useDebounced,
  useMediaQuery,
} from "./use-cms";

export interface CmsFormSubmissionsProps {
  form: FormView;
  /** The number of submissions that are not spam (for a tab label). */
  onTotal?: (n: number) => void;
  className?: string;
}

type Box = "inbox" | "spam" | "archived";
const BOX_STATUS: Record<Box, FormSubmissionStatus[]> = {
  inbox: ["new", "read"],
  spam: ["spam"],
  archived: ["archived"],
};
const PAGE = 50;

function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** A value as one short line of the table. */
function cell(f: FormField, v: unknown, t: T): string {
  if (f.kind === "file")
    return Array.isArray(v) && v.length ? t("fs_files_n", { n: v.length }) : "";
  return displayValue(f, v, { yes: t("fs_yes"), no: "" });
}

export function CmsFormSubmissions({
  form,
  onTotal,
  className,
}: CmsFormSubmissionsProps) {
  const { client, t, me, locale, toast } = useCms();
  const wide = !useMediaQuery("(max-width: 1023px)");
  const canDelete = !!me?.forms?.delete;
  const [box, setBox] = React.useState<Box>("inbox");
  const [query, setQuery] = React.useState("");
  const [q, setQ] = React.useState("");
  const typed = useDebounced((v: string) => (setQ(v), setOffset(0)), 300);
  const [offset, setOffset] = React.useState(0);
  const [items, setItems] = React.useState<FormSubmissionView[] | null>(null);
  const [totalN, setTotalN] = React.useState(0);
  const [counts, setCounts] = React.useState<FormCounts | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [tick, setTick] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<string[] | null>(null);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    client
      .formSubmissions(form.slug, {
        status: BOX_STATUS[box],
        q: q || undefined,
        limit: PAGE,
        offset,
      })
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        setTotalN(r.total);
        setCounts(r.counts);
        onTotal?.(r.counts.new + r.counts.read + r.counts.archived);
        // What was picked but is not on this page any more is let go.
        setPicked(
          (cur) =>
            new Set([...cur].filter((id) => r.items.some((x) => x.id === id))),
        );
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [client, form.slug, box, q, offset, tick, onTotal]);

  const fields = formFields(form.steps);
  // The table shows the first fields that read well in a column.
  const cols = fields
    .filter(
      (f) =>
        f.kind !== "textarea" && f.kind !== "file" && f.kind !== "checkbox",
    )
    .slice(0, wide ? 3 : 1);
  const longCol = fields.find((f) => f.kind === "textarea");
  const open = items?.find((x) => x.id === openId) ?? null;

  const reload = () => setTick((n) => n + 1);

  const openOne = async (s: FormSubmissionView) => {
    setOpenId(s.id);
    if (s.status === "new") {
      // Opening marks it read (quietly; the list updates in place).
      setItems(
        (cur) =>
          cur?.map((x) => (x.id === s.id ? { ...x, status: "read" } : x)) ??
          cur,
      );
      setCounts((c) =>
        c ? { ...c, new: Math.max(0, c.new - 1), read: c.read + 1 } : c,
      );
      client.markSubmission(form.slug, s.id, "read").catch(() => undefined);
    }
  };

  const act = async (
    ids: string[],
    action: FormSubmissionStatus | "delete",
  ) => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      await client.bulkSubmissions(form.slug, ids, action);
      const n = ids.length;
      const msg =
        action === "delete"
          ? t("fs_done_deleted", { n })
          : action === "spam"
            ? t("fs_done_spam", { n })
            : action === "archived"
              ? t("fs_done_archived", { n })
              : t("fs_done_back", { n });
      const undo =
        action === "delete"
          ? undefined
          : {
              label: t("undo"),
              run: async () => (
                await client.bulkSubmissions(
                  form.slug,
                  ids,
                  box === "spam"
                    ? "spam"
                    : box === "archived"
                      ? "archived"
                      : "read",
                ),
                reload()
              ),
            };
      toast(msg, { tone: "ok", action: undo });
      if (openId && ids.includes(openId)) setOpenId(null);
      setPicked(new Set());
      setConfirm(null);
      // The last one on a later page went: step back a page.
      if (items && ids.length >= items.length && offset > 0)
        setOffset(Math.max(0, offset - PAGE));
      else reload();
    } catch (e) {
      if (action === "delete") setConfirmError(errorMessage(e, t));
      else toast(errorMessage(e, t), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const ids = [...picked];
  const allOn = !!items?.length && items.every((x) => picked.has(x.id));
  const someOn = picked.size > 0 && !allOn;

  const actions = (list: string[], small = false) => (
    <>
      {box !== "spam" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy}
          onClick={() => void act(list, "spam")}
        >
          <ShieldAlert aria-hidden className="h-4 w-4" />
          {t("fs_mark_spam")}
        </Button>
      ) : null}
      {box === "inbox" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy}
          onClick={() => void act(list, "archived")}
        >
          <Archive aria-hidden className="h-4 w-4" />
          {t("fs_archive")}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy}
          onClick={() => void act(list, "read")}
        >
          <Inbox aria-hidden className="h-4 w-4" />
          {box === "spam" ? t("fs_not_spam") : t("fs_unarchive")}
        </Button>
      )}
      {canDelete ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "gap-1.5 text-destructive hover:text-destructive",
            small && "ml-auto",
          )}
          disabled={busy}
          onClick={() => (setConfirmError(null), setConfirm(list))}
        >
          <Trash2 aria-hidden className="h-4 w-4" />
          {t("fm_delete")}
        </Button>
      ) : null}
    </>
  );

  const detail = open ? (
    <Detail
      s={open}
      form={form}
      fields={fields}
      t={t}
      locale={locale}
      actions={actions([open.id], true)}
    />
  ) : null;
  const n = (x: number) => (counts ? x : 0);

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-cols-1",
        wide && open && "grid-cols-[minmax(0,1fr)_380px]",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 overflow-y-auto px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={t("fs_box")}
            value={box}
            onChange={(b) => (
              setBox(b),
              setOffset(0),
              setOpenId(null),
              setPicked(new Set())
            )}
            itemClassName="h-7 px-2.5 text-xs"
            options={[
              {
                value: "inbox",
                label: t("fs_inbox", {
                  n: n((counts?.new ?? 0) + (counts?.read ?? 0)),
                }),
              },
              {
                value: "spam",
                label: t("fs_spam", { n: n(counts?.spam ?? 0) }),
              },
              {
                value: "archived",
                label: t("fs_archived", { n: n(counts?.archived ?? 0) }),
              },
            ]}
          />
          <div className="relative w-full sm:w-64">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label={t("fs_search")}
              placeholder={t("fs_search")}
              value={query}
              onChange={(e) => (
                setQuery(e.target.value),
                typed(e.target.value)
              )}
              className="h-8 pl-8 pr-8 text-sm"
            />
            {query ? (
              <button
                type="button"
                aria-label={t("clear_search")}
                onClick={() => (setQuery(""), setQ(""), setOffset(0))}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <span className="flex-1" />
          {form.version > 1 ? (
            <span className="hidden text-xs text-muted-foreground xl:inline">
              {t("fs_version_note", { v: form.version })}
            </span>
          ) : null}
        </div>

        {picked.size ? (
          <div
            role="toolbar"
            aria-label={t("fs_bulk", { n: picked.size })}
            className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5"
          >
            <span className="text-sm font-medium">
              {t("fs_picked", { n: picked.size })}
            </span>
            <span className="flex-1" />
            {actions(ids)}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPicked(new Set())}
            >
              {t("cancel")}
            </Button>
          </div>
        ) : null}

        {error ? (
          <div className="flex flex-col items-start gap-2">
            <StatusText tone="error" className="text-xs">
              {errorMessage(error, t)}
            </StatusText>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              {t("retry")}
            </Button>
          </div>
        ) : loading && !items ? (
          <StatusText tone="muted" className="text-xs">
            {t("loading")}
          </StatusText>
        ) : null}

        {items && !items.length && !error ? (
          <EmptyState
            icon={
              box === "spam"
                ? ShieldAlert
                : box === "archived"
                  ? Archive
                  : Inbox
            }
            title={
              q
                ? t("fs_none_found")
                : box === "spam"
                  ? t("fs_empty_spam")
                  : box === "archived"
                    ? t("fs_empty_archived")
                    : t("fs_empty")
            }
            text={
              q
                ? undefined
                : box === "inbox"
                  ? form.enabled
                    ? t("fs_empty_text")
                    : t("fs_empty_closed")
                  : undefined
            }
          />
        ) : null}

        {items?.length ? (
          <div
            className={cn(
              "transition-opacity duration-150 ease-out",
              loading && "opacity-60",
            )}
            aria-busy={loading}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 px-2">
                    <Checkbox
                      aria-label={t("fs_pick_all")}
                      checked={allOn ? true : someOn ? "indeterminate" : false}
                      onCheckedChange={(on) =>
                        setPicked(
                          on === true
                            ? new Set(items.map((x) => x.id))
                            : new Set(),
                        )
                      }
                    />
                  </TableHead>
                  {cols.map((f) => (
                    <TableHead key={f.key}>{f.label}</TableHead>
                  ))}
                  {longCol && wide && !open ? (
                    <TableHead>{longCol.label}</TableHead>
                  ) : null}
                  <TableHead className="w-28 text-right">
                    {t("fs_received")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => {
                  const on = openId === s.id;
                  const first = cols[0]
                    ? cell(cols[0], s.data[cols[0].key], t)
                    : "";
                  return (
                    <TableRow
                      key={s.id}
                      data-state={on ? "selected" : undefined}
                      className={cn("cursor-pointer", on && "bg-muted")}
                      onClick={() => void openOne(s)}
                    >
                      <TableCell
                        className="w-10 px-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          aria-label={t("fs_pick", {
                            who: first || formatDateTime(s.createdAt, locale),
                          })}
                          checked={picked.has(s.id)}
                          onCheckedChange={(v) =>
                            setPicked((cur) => {
                              const next = new Set(cur);
                              if (v === true) next.add(s.id);
                              else next.delete(s.id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                      {cols.map((f, i) => (
                        <TableCell
                          key={f.key}
                          className={cn(
                            "max-w-[14rem] truncate",
                            f.kind === "email" && "font-mono text-[13px]",
                            s.status === "new" && i === 0 && "font-semibold",
                          )}
                        >
                          {i === 0 ? (
                            <button
                              type="button"
                              className="max-w-full truncate rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                              aria-current={on ? "true" : undefined}
                              onClick={(e) => (
                                e.stopPropagation(),
                                void openOne(s)
                              )}
                            >
                              {s.status === "new" ? (
                                <span
                                  aria-hidden
                                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                                />
                              ) : null}
                              {s.status === "new" ? (
                                <span className="sr-only">{t("fs_new")} </span>
                              ) : null}
                              {cell(f, s.data[f.key], t) || (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </button>
                          ) : (
                            cell(f, s.data[f.key], t) || (
                              <span className="text-muted-foreground">—</span>
                            )
                          )}
                        </TableCell>
                      ))}
                      {!cols.length ? (
                        <TableCell>
                          <button
                            type="button"
                            className="rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={(e) => (
                              e.stopPropagation(),
                              void openOne(s)
                            )}
                          >
                            {t("fs_open_one")}
                          </button>
                        </TableCell>
                      ) : null}
                      {longCol && wide && !open ? (
                        <TableCell className="max-w-[20rem] truncate text-muted-foreground">
                          {cell(longCol, s.data[longCol.key], t)}
                        </TableCell>
                      ) : null}
                      <TableCell
                        className="w-28 whitespace-nowrap text-right text-muted-foreground"
                        title={formatDateTime(s.createdAt, locale)}
                      >
                        {s.files.length ? (
                          <Paperclip
                            aria-label={t("fs_has_files")}
                            role="img"
                            className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]"
                          />
                        ) : null}
                        {relativeTime(s.createdAt, t, locale)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {totalN > PAGE ? (
              <nav
                aria-label={t("fs_pages")}
                className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground"
              >
                <span>
                  {t("fs_range", {
                    from: offset + 1,
                    to: Math.min(offset + PAGE, totalN),
                    total: totalN,
                  })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t("fs_prev")}
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  <ChevronLeft aria-hidden className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t("fs_next")}
                  disabled={offset + PAGE >= totalN || loading}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  <ChevronRight aria-hidden className="h-4 w-4" />
                </Button>
              </nav>
            ) : null}
          </div>
        ) : null}
      </div>

      {open && wide ? (
        <aside
          aria-label={t("fs_detail")}
          className="flex min-w-0 flex-col overflow-y-auto border-l px-5 py-4"
        >
          {open ? (
            <Detail
              s={open}
              form={form}
              fields={fields}
              t={t}
              locale={locale}
              actions={actions([open.id], true)}
              onClose={() => setOpenId(null)}
            />
          ) : null}
        </aside>
      ) : null}
      {open && !wide ? (
        <Dialog open onOpenChange={(o) => !o && setOpenId(null)}>
          <DialogContent className={DIALOG.md}>
            <DialogHeader className="sr-only">
              <DialogTitle>{t("fs_detail")}</DialogTitle>
              <DialogDescription>
                {formatDateTime(open.createdAt, locale)}
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 w-fit gap-1.5"
              onClick={() => setOpenId(null)}
            >
              <ArrowLeft aria-hidden className="h-4 w-4" />
              {t("fs_back")}
            </Button>
            {detail}
          </DialogContent>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !busy && !o && setConfirm(null)}
        title={t("fs_delete_title", { n: confirm?.length ?? 0 })}
        description={t("fs_delete_text")}
        confirmLabel={busy ? t("fm_deleting") : t("fm_delete")}
        destructive
        busy={busy}
        error={confirmError}
        onConfirm={() => void act(confirm ?? [], "delete")}
      />
    </div>
  );
}

function Detail({
  s,
  form,
  fields,
  t,
  locale,
  actions,
  onClose,
}: {
  s: FormSubmissionView;
  form: FormView;
  fields: FormField[];
  t: T;
  locale: string;
  actions: React.ReactNode;
  onClose?: () => void;
}) {
  const { client, toast } = useCms();
  const [opening, setOpening] = React.useState<string | null>(null);
  const known = new Set(fields.map((f) => f.key));
  // Keys of fields removed since: still shown, by their key.
  const extra = Object.keys(s.data).filter((k) => !known.has(k));
  const title = fields.find(
    (f) => f.kind === "text" && typeof s.data[f.key] === "string",
  )?.key;
  const openFile = async (fileId: string) => {
    setOpening(fileId);
    try {
      const r = await client.submissionFileLink(form.slug, s.id, fileId);
      window.open(r.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast(errorMessage(e, t), { tone: "error" });
    } finally {
      setOpening(null);
    }
  };
  const value = (f: FormField | undefined, key: string) => {
    const v = s.data[key];
    if (f?.kind === "file") {
      const files = s.files.filter((x) => x.field === key);
      if (!files.length)
        return <span className="text-muted-foreground">—</span>;
      return (
        <span className="flex flex-wrap gap-1.5">
          {files.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => void openFile(x.id)}
              disabled={opening === x.id}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              aria-label={t("fs_file_open", { name: x.name })}
            >
              <Paperclip aria-hidden className="h-3 w-3 shrink-0" />
              <span className="truncate">{x.name}</span>
              <span className="shrink-0 text-muted-foreground">
                · {fileSize(x.size)}
              </span>
            </button>
          ))}
        </span>
      );
    }
    const text = displayValue(f, v, { yes: t("fs_yes"), no: t("fs_no") });
    return text ? (
      <span
        className={cn(
          "whitespace-pre-wrap break-words",
          f?.kind === "email" && "font-mono text-[13px]",
        )}
      >
        {text}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <b className="min-w-0 truncate text-base">
          {title ? String(s.data[title]) : t("fs_submission")}
        </b>
        <span className="flex-1" />
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-2 h-8 w-8 shrink-0"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
        <span className="w-full text-xs text-muted-foreground">
          {formatDateTime(s.createdAt, locale)} · v{s.formVersion}
          {s.status === "spam"
            ? ` · ${t("fs_status_spam")}`
            : s.status === "archived"
              ? ` · ${t("fs_status_archived")}`
              : ""}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
        {fields
          .filter(
            (f) =>
              s.data[f.key] !== undefined ||
              s.files.some((x) => x.field === f.key),
          )
          .map((f) => (
            <React.Fragment key={f.key}>
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0">{value(f, f.key)}</dd>
            </React.Fragment>
          ))}
        {extra.map((k) => (
          <React.Fragment key={k}>
            <dt
              className="font-mono text-xs text-muted-foreground"
              title={t("fs_old_field")}
            >
              {k}
            </dt>
            <dd className="min-w-0">{value(undefined, k)}</dd>
          </React.Fragment>
        ))}
      </dl>
      {s.formVersion !== form.version ? (
        <p className="text-xs text-muted-foreground">
          {t("fs_old_version", { v: s.formVersion })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        {actions}
      </div>
    </div>
  );
}
