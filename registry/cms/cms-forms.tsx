// agent-cms registry: cms-forms (0.22.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Forms: the list (submissions, spam, open or closed, the last one) and one
// form's screen with three tabs: Fields (steps, fields, conditions; drag or
// Alt+arrows to reorder; a preview), Submissions (cms-form-submissions) and
// Settings (message after sending, who is told, how long submissions stay).
// "Embed" gives the code for a page. Needs `forms: true` in createCms and
// someone who may see forms (an admin or a role with `forms`).
"use client";

import * as React from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Calendar,
  CheckSquare,
  ChevronDown,
  ClipboardList,
  Code2,
  Download,
  Eye,
  GitBranch,
  GripVertical,
  Hash,
  ListChecks,
  Mail,
  MoreHorizontal,
  Paperclip,
  Plus,
  Trash2,
  Type,
  AlertCircle,
  X,
} from "lucide-react";
import {
  FORM_FIELD_KINDS,
  FORM_KEY_RE,
  formFields,
  isCmsRemoteError,
  nextOptionNumber,
  type FormCondition,
  type FormField,
  type FormOption,
  type FormFieldKind,
  type FormListItem,
  type FormSettings,
  type FormStep,
  type FormSubmissionStatus,
  type FormView,
  type PublicForm,
} from "@mainsoft/agent-cms/client";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, type MessageKey, type T } from "./cms-messages";
import {
  ConfirmDialog,
  CopyButton,
  DIALOG,
  EmptyState,
  NativeSelect,
  PageHeader,
  Segmented,
  StatusText,
} from "./cms-parts";
import { CmsForm } from "./cms-form";
import { BOX_STATUS, CmsFormSubmissions } from "./cms-form-submissions";
import { relativeTime, useAsync, useCms, useIsMobile } from "./use-cms";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export const KIND_ICON: Record<FormFieldKind, React.ElementType> = {
  text: Type,
  textarea: AlignLeft,
  email: Mail,
  number: Hash,
  select: ChevronDown,
  multiselect: ListChecks,
  checkbox: CheckSquare,
  date: Calendar,
  file: Paperclip,
};

/** A small on/off switch (role="switch"). */
export function FormSwitch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-150 ease-out motion-reduce:transition-none",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

const total = (c: { new: number; read: number; archived: number }) =>
  c.new + c.read + c.archived;

// ── list ─────────────────────────────────────────────────────────────────────

export interface CmsFormsProps {
  /** The link of a form's screen (for real links). */
  hrefFor?: (slug: string) => string;
  onOpenForm: (slug: string) => void;
  className?: string;
}

export function CmsForms({ hrefFor, onOpenForm, className }: CmsFormsProps) {
  const { client, t, me, locale } = useCms();
  const mobile = useIsMobile();
  const can = me?.forms ?? null;
  const q = useAsync(
    () => (can ? client.forms() : Promise.resolve([] as FormListItem[])),
    [client, !!can],
  );
  const [creating, setCreating] = React.useState(false);
  const off = isCmsRemoteError(q.error) && q.error.code === "forms_off";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("fm_title")}>
        {can?.write && !off ? (
          <Button
            type="button"
            className="gap-1.5"
            size={mobile ? "sm" : "default"}
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden className="h-4 w-4" />
            {t("fm_new")}
          </Button>
        ) : null}
      </PageHeader>
      <div className="min-w-0 flex-1 overflow-x-auto px-4 py-4 md:px-6">
        {!me ? null : !can || off ? (
          <EmptyState
            icon={ClipboardList}
            title={off || !me.forms ? t("fm_off_title") : t("fm_title")}
            text={off || !me.forms ? t("fm_off_text") : t("fm_no_access")}
          />
        ) : (
          <>
            {q.error || (q.loading && !q.data) ? (
              <StatusText
                tone={q.error ? "error" : "muted"}
                className="mb-2 text-xs"
              >
                {q.error ? errorMessage(q.error, t) : t("loading")}
              </StatusText>
            ) : null}
            {q.error ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mb-3"
                onClick={q.reload}
              >
                {t("retry")}
              </Button>
            ) : null}
            {q.data && !q.data.length ? (
              <EmptyState
                icon={ClipboardList}
                title={t("fm_empty")}
                text={t("fm_empty_text")}
                action={
                  can.write ? (
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setCreating(true)}
                    >
                      <Plus aria-hidden className="h-4 w-4" />
                      {t("fm_new")}
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
            {q.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("fm_col_name")}</TableHead>
                    <TableHead className="w-20 text-right">
                      {t("fm_col_subs")}
                    </TableHead>
                    <TableHead className="hidden w-20 text-right sm:table-cell">
                      {t("fm_col_spam")}
                    </TableHead>
                    <TableHead className="w-24">{t("fm_col_state")}</TableHead>
                    <TableHead className="hidden w-40 md:table-cell">
                      {t("fm_col_last")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.map((f) => (
                    <TableRow
                      key={f.id}
                      className="cursor-pointer"
                      onClick={() => onOpenForm(f.slug)}
                    >
                      <TableCell className="max-w-[18rem]">
                        <a
                          href={hrefFor?.(f.slug) ?? "#"}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpenForm(f.slug);
                          }}
                          className="rounded font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <bdi>{f.title}</bdi>
                        </a>{" "}
                        <span className="font-mono text-xs text-muted-foreground">
                          {f.slug}
                        </span>
                        {f.counts.new ? (
                          <span className="block text-xs font-medium text-primary sm:ml-2 sm:inline">
                            {t("fm_new_count", { n: f.counts.new })}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {total(f.counts)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                        {f.counts.spam}
                      </TableCell>
                      <TableCell>
                        <OpenBadge on={f.enabled} t={t} />
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {f.lastAt ? relativeTime(f.lastAt, t, locale) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </>
        )}
      </div>
      {creating ? (
        <NewFormDialog
          existing={(q.data ?? []).map((f) => f.slug)}
          onClose={() => setCreating(false)}
          onMade={(slug) => (setCreating(false), onOpenForm(slug))}
        />
      ) : null}
    </div>
  );
}

function OpenBadge({ on, t }: { on: boolean; t: T }) {
  return (
    <Badge
      variant="secondary"
      className="gap-1.5 rounded-full px-2 py-0 text-[11.5px] font-medium"
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          on ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
      {on ? t("fm_open") : t("fm_closed")}
    </Badge>
  );
}

/** "Contact us" → "contact-us" (letters outside a–z go). */
export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function NewFormDialog({
  existing,
  onClose,
  onMade,
}: {
  existing: string[];
  onClose: () => void;
  onMade: (slug: string) => void;
}) {
  const { client, t } = useCms();
  const [title, setTitle] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [typed, setTyped] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const shownSlug = typed ? slug : slugOf(title);
  const slugBad =
    shownSlug !== "" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(shownSlug);
  const taken = existing.includes(shownSlug);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !shownSlug || slugBad || taken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const f = await client.createForm({
        title: title.trim(),
        slug: shownSlug,
      });
      onMade(f.slug);
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className={DIALOG.sm}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("fm_new")}</DialogTitle>
            <DialogDescription>{t("fm_new_text")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cms-form-new-title">{t("fm_name")}</Label>
            <Input
              id="cms-form-new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder={t("fm_name_placeholder")}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cms-form-new-slug">{t("fm_slug")}</Label>
            <Input
              id="cms-form-new-slug"
              value={shownSlug}
              onChange={(e) => (
                setTyped(true),
                setSlug(e.target.value.toLowerCase())
              )}
              maxLength={63}
              className="font-mono text-[13px]"
              aria-invalid={slugBad || taken || undefined}
              aria-describedby="cms-form-new-slug-hint"
            />
            <p
              id="cms-form-new-slug-hint"
              className={cn(
                "text-xs",
                slugBad || taken ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {taken
                ? t("fm_slug_taken")
                : slugBad
                  ? t("fm_slug_bad")
                  : t("fm_slug_hint")}
            </p>
          </div>
          {error ? <StatusText tone="error">{error}</StatusText> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !title.trim() || !shownSlug || slugBad || taken}
            >
              {busy ? t("saving_now") : t("fm_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── one form ─────────────────────────────────────────────────────────────────

export type CmsFormTab = "fields" | "submissions" | "settings";

export interface CmsFormEditorProps {
  slug: string;
  /** The tab shown (from the address); without it the screen keeps its own. */
  tab?: CmsFormTab;
  onTab?: (tab: CmsFormTab) => void;
  onBack: () => void;
  /** The form got a new address. */
  onSlugChange?: (slug: string) => void;
  className?: string;
}

interface Draft {
  title: string;
  slug: string;
  steps: FormStep[];
  settings: FormSettings;
}
const draftOf = (f: FormView): Draft => ({
  title: f.title,
  slug: f.slug,
  steps: f.steps,
  settings: f.settings,
});
type Sel = { s: number; i: number } | null;

/**
 * Edits not saved yet stay in this tab's sessionStorage (per form, with the time of the read they are
 * based on), so going back by mistake or a reload can bring them back. `carry`: the form got a new
 * address while saving and the screen opens again; the edits made meanwhile come along without asking.
 */
interface StoredDraft {
  rev: string;
  draft: Draft;
  carry?: boolean;
}
const draftKey = (id: string) => `cms-form-draft:${id}`;
function readDraft(id: string): StoredDraft | null {
  try {
    const raw = window.sessionStorage.getItem(draftKey(id));
    const v = raw ? (JSON.parse(raw) as StoredDraft) : null;
    return v && typeof v.rev === "string" && v.draft ? v : null;
  } catch {
    return null;
  }
}
function writeDraft(id: string, v: StoredDraft | null) {
  try {
    if (v) window.sessionStorage.setItem(draftKey(id), JSON.stringify(v));
    else window.sessionStorage.removeItem(draftKey(id));
  } catch {
    /* private mode or full: nothing kept */
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the Submissions tab shows (the CSV takes the same). */
export interface CmsSubmissionsView {
  box: "inbox" | "spam" | "archived";
  status: FormSubmissionStatus[];
  q: string;
  total: number;
  /** "ready" only when the list shown matches the box and search asked for. */
  state?: "loading" | "ready" | "error";
}

export function CmsFormEditor({
  slug,
  tab: tabProp,
  onTab,
  onBack,
  onSlugChange,
  className,
}: CmsFormEditorProps) {
  const { client, t, me, toast } = useCms();
  const mobile = useIsMobile();
  const can = me?.forms ?? null;
  const q = useAsync(
    () => (can ? client.form(slug) : Promise.resolve(null)),
    [client, slug, !!can],
  );
  const [base, setBase] = React.useState<FormView | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [ownTab, setOwnTab] = React.useState<CmsFormTab>(tabProp ?? "fields");
  const tab = tabProp ?? ownTab;
  const setTab = (x: CmsFormTab) => (onTab ? onTab(x) : setOwnTab(x));
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [embed, setEmbed] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [toggling, setToggling] = React.useState(false);
  const [subsTotal, setSubsTotal] = React.useState<number | null>(null);
  const [exportBusy, setExportBusy] = React.useState(false);
  const [toggleError, setToggleError] = React.useState<string | null>(null);
  /** Unsaved edits found from an earlier visit: offered, not applied. */
  const [restore, setRestore] = React.useState<Draft | null>(null);
  const [view, setView] = React.useState<CmsSubmissionsView | null>(null);
  /** The draft as it is now (a save that returns reads it to keep edits made meanwhile). */
  const liveDraft = React.useRef<Draft | null>(null);
  liveDraft.current = draft;
  /** Set while a move the person confirmed in this screen runs: the router does not ask again. */
  const leaveConfirmed = React.useRef(false);
  const leaveNow = (go: () => void) => {
    leaveConfirmed.current = true;
    try {
      go();
    } finally {
      leaveConfirmed.current = false;
    }
  };

  React.useEffect(() => {
    if (!q.data) return;
    setBase(q.data);
    const kept = readDraft(q.data.id);
    if (
      kept &&
      kept.rev === q.data.updatedAt &&
      !same(kept.draft, draftOf(q.data))
    ) {
      if (kept.carry) {
        setDraft(kept.draft);
        writeDraft(q.data.id, { rev: kept.rev, draft: kept.draft });
      } else {
        setDraft(draftOf(q.data));
        setRestore(kept.draft);
      }
      return;
    }
    // Kept edits based on an older read (someone saved since) would only conflict: they go.
    if (kept) writeDraft(q.data.id, null);
    setRestore(null);
    setDraft(draftOf(q.data));
  }, [q.data]);

  const dirty = !!base && !!draft && !same(draftOf(base), draft);
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (leaveConfirmed.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // Keep what is not saved (while an offer is open, the kept one stays as it is).
  React.useEffect(() => {
    if (!base || !draft || restore) return;
    writeDraft(base.id, dirty ? { rev: base.updatedAt, draft } : null);
  }, [base, draft, dirty, restore]);

  const problems = React.useMemo(
    () => (draft ? draftProblems(draft.steps, t) : new Map<string, string>()),
    [draft, t],
  );
  const settingsProblem = draft ? settingsProblems(draft, t) : null;

  const save = async () => {
    if (!draft || !base || saving || !dirty) return;
    if (problems.size || settingsProblem) {
      setSaveError(
        problems.size
          ? t("fm_fix_fields", { n: problems.size })
          : settingsProblem,
      );
      if (problems.size && tab !== "fields") setTab("fields");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const sent = draft;
    try {
      const next = await client.updateForm(base.slug, {
        title: draft.title.trim(),
        slug: draft.slug,
        steps: draft.steps,
        settings: draft.settings,
        expectedUpdatedAt: base.updatedAt,
      });
      // Edits made while the save was on its way stay (and stay unsaved); the rest is the server's.
      const later =
        liveDraft.current && !same(liveDraft.current, sent)
          ? liveDraft.current
          : null;
      setBase(next);
      setDraft(later ?? draftOf(next));
      toast(later ? t("fm_saved_more") : t("fm_saved"), { tone: "ok" });
      if (next.slug !== slug) {
        // The screen opens again at the new address: what was typed meanwhile comes along.
        writeDraft(
          next.id,
          later ? { rev: next.updatedAt, draft: later, carry: true } : null,
        );
        leaveNow(() => onSlugChange?.(next.slug));
      }
    } catch (e) {
      setSaveError(
        isCmsRemoteError(e) && e.code === "form_conflict"
          ? t("fm_conflict")
          : errorMessage(e, t),
      );
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (on: boolean) => {
    if (!base || toggling) return;
    setToggling(true);
    setToggleError(null);
    try {
      const next = await client.updateForm(base.slug, { enabled: on });
      // Only the switch moved: keep the draft, and the time of the read it is based on unless nothing else changed.
      setBase((b) =>
        b
          ? {
              ...b,
              enabled: next.enabled,
              updatedAt:
                next.version === b.version &&
                JSON.stringify(next.settings) === JSON.stringify(b.settings) &&
                next.title === b.title
                  ? next.updatedAt
                  : b.updatedAt,
            }
          : b,
      );
      toast(on ? t("fm_now_open") : t("fm_now_closed"), { tone: "ok" });
    } catch (e) {
      // Said beside the switch (a toast is gone before the reason is read).
      setToggleError(errorMessage(e, t));
    } finally {
      setToggling(false);
    }
  };

  const remove = async () => {
    if (!base) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await client.removeForm(base.slug);
      toast(t("fm_deleted", { title: base.title }), { tone: "ok" });
      onBack();
    } catch (e) {
      setRemoveError(errorMessage(e, t));
      setRemoveBusy(false);
    }
  };

  const exportCsv = async () => {
    // Only what the list shows now, loaded for exactly these filters (never a stale or failed one).
    if (!base || !view || view.state === "loading" || view.state === "error")
      return;
    setExportBusy(true);
    try {
      // The CSV has what the Submissions tab shows: the same box and search.
      const r = await client.exportSubmissions(base.slug, {
        status: view.status,
        q: view.q || undefined,
      });
      const url = URL.createObjectURL(
        new Blob([r.csv], { type: "text/csv;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(errorMessage(e, t), { tone: "error" });
    } finally {
      setExportBusy(false);
    }
  };

  const back = () => (dirty ? setLeaving(true) : leaveNow(onBack));
  const notFound =
    isCmsRemoteError(q.error) && q.error.code === "form_not_found";

  if (!me) return null;
  if (!can || !q.data || !base || !draft) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <PageHeader
          title={t("fm_title")}
          crumbs={[
            <button
              key="b"
              type="button"
              onClick={onBack}
              className="hover:underline"
            >
              {t("fm_title")}
            </button>,
          ]}
        />
        <div className="px-4 py-4 md:px-6">
          {!can ? (
            <EmptyState
              icon={ClipboardList}
              title={t("fm_off_title")}
              text={t("fm_off_text")}
            />
          ) : notFound ? (
            <EmptyState
              icon={ClipboardList}
              title={t("fm_not_found")}
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onBack}
                >
                  {t("fm_back_list")}
                </Button>
              }
            />
          ) : (
            <>
              <StatusText
                tone={q.error ? "error" : "muted"}
                className="text-xs"
              >
                {q.error ? errorMessage(q.error, t) : t("loading")}
              </StatusText>
              {q.error ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={q.reload}
                >
                  {t("retry")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  const tabs: { id: CmsFormTab; label: string }[] = [
    { id: "fields", label: t("fm_tab_fields") },
    {
      id: "submissions",
      label:
        subsTotal === null
          ? t("fm_tab_subs_plain")
          : t("fm_tab_subs", { n: subsTotal }),
    },
    { id: "settings", label: t("fm_tab_settings") },
  ];
  const publicDraft: PublicForm = {
    slug: draft.slug,
    title: draft.title,
    steps: draft.steps,
    successMessage: draft.settings.successMessage,
    version: base.version,
    honeypot: "_website",
    // As the public page will show it: file fields say they cannot take files on this server.
    uploads: base.uploads !== false,
  };
  // The CSV takes the box and search of the list, and only once that list is in for them.
  const exportReady = !!view && view.state !== "loading" && view.state !== "error";
  const viewBox = t(`fs_box_${view?.box ?? "inbox"}` as MessageKey);
  const exportScope = !view
    ? t("fm_export_wait", { box: viewBox })
    : view.state === "loading"
      ? t("fm_export_wait", { box: viewBox })
      : view.state === "error"
        ? t("fm_export_failed", { box: viewBox })
        : view.total === 0
          ? t("fm_export_none", { box: viewBox })
          : t(view.q ? "fm_export_scope_q" : "fm_export_scope", {
              box: viewBox,
              q: view.q,
              n: view.total,
            });

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader
        title={<bdi>{base.title}</bdi>}
        crumbs={[
          <button
            key="b"
            type="button"
            onClick={back}
            className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("fm_title")}
          </button>,
        ]}
        back={
          mobile ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-2 h-8 w-8"
              aria-label={t("fm_back_list")}
              onClick={back}
            >
              <ArrowLeft aria-hidden className="h-4 w-4" />
            </Button>
          ) : undefined
        }
        after={
          <FormSwitch
            checked={base.enabled}
            onChange={(on) => void toggle(on)}
            label={t("fm_accepting")}
            disabled={!can.write || toggling}
          />
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setEmbed(true)}
        >
          <Code2 aria-hidden className="h-4 w-4" />
          <span className={cn(mobile && "sr-only")}>{t("fm_embed")}</span>
        </Button>
        {tab === "submissions" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void exportCsv()}
            disabled={exportBusy || !exportReady || view?.total === 0}
            aria-describedby="cms-form-export-scope"
            title={exportScope}
          >
            <Download aria-hidden className="h-4 w-4" />
            {exportBusy ? t("fm_exporting") : t("fm_export")}
          </Button>
        ) : can.write ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? t("saving_now") : t("save")}
          </Button>
        ) : null}
        {can.write && can.delete ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
                className: "h-8 w-8",
              })}
              aria-label={t("fm_more")}
            >
              <MoreHorizontal aria-hidden className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => (setRemoveError(null), setRemoving(true))}
              >
                {t("fm_delete_form")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </PageHeader>
      {toggleError ? (
        <div
          role="alert"
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive md:mx-6"
        >
          <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
          <span className="min-w-[12rem] flex-1">
            <span className="font-medium">{t("fm_toggle_failed")}</span>{" "}
            {toggleError}
          </span>
          {tab !== "fields" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setTab("fields")}
            >
              {t("fm_show_fields")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("close")}
            onClick={() => setToggleError(null)}
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={base.title} />
      {restore ? (
        <div
          role="status"
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 md:mx-6"
        >
          <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
          <span className="min-w-[12rem] flex-1">{t("fm_restore_text")}</span>
          <span className="ml-auto flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => (writeDraft(base.id, null), setRestore(null))}
            >
              {t("fm_discard")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-background"
              onClick={() => (setDraft(restore), setRestore(null))}
            >
              {t("fm_restore")}
            </Button>
          </span>
        </div>
      ) : null}
      {saveError && tab !== "submissions" ? (
        <div
          role="alert"
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive md:mx-6"
        >
          <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
          <span className="flex-1">{saveError}</span>
          {saveError === t("fm_conflict") ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => (setSaveError(null), q.reload())}
            >
              {t("fm_reload")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        role="tabpanel"
        id={`cms-form-panel-${tab}`}
        aria-labelledby={`cms-form-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "fields" ? (
          <FieldsTab
            steps={draft.steps}
            onSteps={(steps) => setDraft((d) => (d ? { ...d, steps } : d))}
            problems={problems}
            readOnly={!can.write}
            onPreview={() => setPreview(true)}
            uploads={base.uploads !== false}
          />
        ) : tab === "submissions" ? (
          <>
            <p
              id="cms-form-export-scope"
              aria-live="polite"
              className="px-4 pt-3 text-xs text-muted-foreground md:px-6"
            >
              {exportScope}
            </p>
            <CmsFormSubmissions
              form={base}
              onTotal={setSubsTotal}
              onView={setView}
            />
          </>
        ) : (
          <SettingsTab
            draft={draft}
            onDraft={setDraft}
            readOnly={!can.write}
            problem={settingsProblem}
          />
        )}
      </div>
      {tab !== "submissions" ? (
        <SubsCount slug={base.slug} onTotal={setSubsTotal} />
      ) : null}

      {embed ? (
        <EmbedDialog form={base} onClose={() => setEmbed(false)} />
      ) : null}
      {preview ? (
        <Dialog open onOpenChange={(o) => !o && setPreview(false)}>
          <DialogContent className={cn(DIALOG.lg, "overflow-y-auto")}>
            <DialogHeader>
              <DialogTitle>{t("fm_preview")}</DialogTitle>
              <DialogDescription>{t("fm_preview_text")}</DialogDescription>
            </DialogHeader>
            <CmsForm slug={draft.slug} form={publicDraft} preview t={t} />
          </DialogContent>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={t("fm_leave_title")}
        description={t("fm_leave_text")}
        confirmLabel={t("fm_leave")}
        destructive
        onConfirm={() => {
          setLeaving(false);
          writeDraft(base.id, null);
          leaveNow(onBack);
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={(o) => !removeBusy && setRemoving(o)}
        title={t("fm_delete_title", { title: base.title })}
        description={
          subsTotal
            ? t("fm_delete_text_subs", { n: subsTotal })
            : t("fm_delete_text")
        }
        confirmLabel={removeBusy ? t("fm_deleting") : t("fm_delete_form")}
        destructive
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
      />
    </div>
  );
}

/** Loads the number of submissions for the tab label while another tab is shown. */
function SubsCount({
  slug,
  onTotal,
}: {
  slug: string;
  onTotal: (n: number) => void;
}) {
  const { client } = useCms();
  React.useEffect(() => {
    let live = true;
    client
      .formSubmissions(slug, { limit: 1 })
      .then((r) => live && onTotal(total(r.counts)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, slug, onTotal]);
  return null;
}

function Tabs<V extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(tabs[to].id);
    refs.current[to]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex shrink-0 gap-4 overflow-x-auto overflow-y-hidden border-b px-4 [scrollbar-width:none] md:px-6"
    >
      {tabs.map((x, i) => (
        <button
          key={x.id}
          ref={(el) => void (refs.current[i] = el)}
          type="button"
          role="tab"
          id={`cms-form-tab-${x.id}`}
          aria-selected={value === x.id}
          aria-controls={`cms-form-panel-${x.id}`}
          tabIndex={value === x.id ? 0 : -1}
          onClick={() => onChange(x.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={cn(
            "shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-2 pt-2.5 text-sm transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === x.id
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

// ── fields ───────────────────────────────────────────────────────────────────

const pathKey = (s: number, i: number) => `${s}:${i}`;

/** Problems a person can fix before saving, by field ("step:index"). */
export function draftProblems(
  steps: readonly FormStep[],
  t: T,
): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const before = new Map<string, FormField>();
  steps.forEach((st, s) =>
    st.fields.forEach((f, i) => {
      const at = pathKey(s, i);
      if (!f.label.trim()) out.set(at, t("fm_err_label"));
      else if (!FORM_KEY_RE.test(f.key)) out.set(at, t("fm_err_key"));
      else if (seen.has(f.key)) out.set(at, t("fm_err_key_twice"));
      else if (
        (f.kind === "select" || f.kind === "multiselect") &&
        (!f.options?.length ||
          f.options.some((o) => !o.value.trim() || !o.label.trim()))
      )
        out.set(at, t("fm_err_options"));
      else if (
        (f.kind === "select" || f.kind === "multiselect") &&
        new Set(f.options!.map((o) => o.value)).size !== f.options!.length
      )
        out.set(at, t("fm_err_options_twice"));
      else if (f.showIf && !before.has(f.showIf.field))
        out.set(at, t("fm_err_cond"));
      else if (f.showIf && condProblem(f.showIf, before.get(f.showIf.field)!, t))
        out.set(at, condProblem(f.showIf, before.get(f.showIf.field)!, t)!);
      else if (f.pattern) {
        try {
          new RegExp(f.pattern, "u");
        } catch {
          out.set(at, t("fm_err_pattern"));
        }
      }
      seen.add(f.key);
      before.set(f.key, f);
    }),
  );
  if (!formFields(steps).length) out.set("form", t("fm_err_no_fields"));
  return out;
}

/** The tests a condition may make on a field of this kind. */
export function condOps(f: FormField): FormCondition["op"][] {
  return f.kind === "file"
    ? ["filled", "empty"]
    : f.kind === "checkbox"
      ? ["eq"]
      : f.kind === "multiselect"
        ? ["contains", "empty", "filled"]
        : f.kind === "select"
          ? ["eq", "neq", "in", "empty", "filled"]
          : ["eq", "neq", "contains", "empty", "filled"];
}

/**
 * A condition that no longer fits the field it looks at (its kind changed, or a choice it looks for
 * was removed), worded for the person; null when it is fine.
 */
function condProblem(c: FormCondition, target: FormField, t: T): string | null {
  const name = target.label || target.key;
  if (!condOps(target).includes(c.op))
    return t("fm_err_cond_op", { field: name });
  if (
    (target.kind === "select" || target.kind === "multiselect") &&
    c.op !== "empty" &&
    c.op !== "filled"
  ) {
    const have = new Set((target.options ?? []).map((o) => o.value));
    const wanted = Array.isArray(c.value) ? c.value : [c.value];
    if (!wanted.length || wanted.some((v) => !have.has(String(v ?? ""))))
      return t("fm_err_cond_value", { field: name });
  }
  return null;
}

function settingsProblems(d: Draft, t: T): string | null {
  if (!d.title.trim()) return t("fm_err_title");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(d.slug)) return t("fm_slug_bad");
  if (d.settings.notify.some((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)))
    return t("fm_err_notify");
  if (
    d.settings.keepDays !== null &&
    (!Number.isInteger(d.settings.keepDays) ||
      d.settings.keepDays < 1 ||
      d.settings.keepDays > 3650)
  )
    return t("fm_err_keep");
  if (
    d.settings.redirectUrl &&
    !/^(https?:\/\/\S+|\/\S*)$/.test(d.settings.redirectUrl)
  )
    return t("fm_err_redirect");
  return null;
}

/** A free key from a label: "Company size" → "company_size" (then "_2", "_3"). */
function keyFrom(label: string, taken: Set<string>): string {
  let k = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  if (!/^[a-z]/.test(k)) k = `field${k ? `_${k}` : ""}`;
  let out = k;
  for (let n = 2; taken.has(out); n++) out = `${k}_${n}`;
  return out;
}

function FieldsTab({
  steps,
  onSteps,
  problems,
  readOnly,
  onPreview,
  uploads,
}: {
  steps: FormStep[];
  onSteps: (s: FormStep[]) => void;
  problems: Map<string, string>;
  readOnly: boolean;
  onPreview: () => void;
  /** False: this server takes no files (file fields cannot be filled in). */
  uploads: boolean;
}) {
  const { t } = useCms();
  const [sel, setSel] = React.useState<Sel>(null);
  /** Removing a field others' conditions look at: asked first, with the list. */
  const [removing, setRemoving] = React.useState<{
    s: number;
    i: number;
    deps: FormField[];
  } | null>(null);
  const [drag, setDrag] = React.useState<{ s: number; i: number } | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const rowRefs = React.useRef(new Map<string, HTMLElement>());
  const panelRef = React.useRef<HTMLDivElement>(null);
  const focusAfter = React.useRef<string | null>(null);
  const many = steps.length > 1;
  const cur = sel ? steps[sel.s]?.fields[sel.i] : undefined;

  React.useEffect(() => {
    if (focusAfter.current) {
      rowRefs.current.get(focusAfter.current)?.focus();
      focusAfter.current = null;
    }
  });
  // On a narrow screen the settings sit under the list: bring them into view when a field is picked.
  React.useEffect(() => {
    if (
      !sel ||
      typeof window === "undefined" ||
      !window.matchMedia("(max-width: 767px)").matches
    )
      return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    panelRef.current?.scrollIntoView?.({
      block: "start",
      behavior: reduce ? "auto" : "smooth",
    });
  }, [sel?.s, sel?.i]); // eslint-disable-line react-hooks/exhaustive-deps
  // A selection that no longer exists (deleted) goes.
  React.useEffect(() => {
    if (sel && !steps[sel.s]?.fields[sel.i]) setSel(null);
  }, [steps, sel]);

  const keys = new Set(formFields(steps).map((f) => f.key));
  const label = (k: FormFieldKind) => t(`fm_kind_${k}` as MessageKey);

  const setField = (s: number, i: number, patch: Partial<FormField>) => {
    const old = steps[s].fields[i];
    const next = { ...old, ...patch };
    let out = steps.map((st, si) =>
      si === s
        ? { ...st, fields: st.fields.map((f, fi) => (fi === i ? next : f)) }
        : st,
    );
    // A new key: conditions that looked at the old one follow it.
    if (patch.key !== undefined && patch.key !== old.key)
      out = out.map((st) => ({
        ...st,
        fields: st.fields.map((f) =>
          f.showIf?.field === old.key
            ? { ...f, showIf: { ...f.showIf, field: patch.key! } }
            : f,
        ),
      }));
    onSteps(out);
  };

  /** Move a field to (step, index) — across steps too. */
  const moveTo = (
    from: { s: number; i: number },
    to: { s: number; i: number },
    say = true,
  ) => {
    const f = steps[from.s].fields[from.i];
    const out = steps.map((st) => ({ ...st, fields: [...st.fields] }));
    out[from.s].fields.splice(from.i, 1);
    const at = Math.max(0, Math.min(to.i, out[to.s].fields.length));
    out[to.s].fields.splice(at, 0, f);
    onSteps(out);
    if (sel && sel.s === from.s && sel.i === from.i) setSel({ s: to.s, i: at });
    focusAfter.current = pathKey(to.s, at);
    if (say)
      setAnnounce(t("fm_moved", { label: f.label, n: at + 1, step: to.s + 1 }));
  };
  const up = (s: number, i: number) =>
    i > 0
      ? moveTo({ s, i }, { s, i: i - 1 })
      : s > 0
        ? moveTo({ s, i }, { s: s - 1, i: steps[s - 1].fields.length })
        : undefined;
  const down = (s: number, i: number) =>
    i < steps[s].fields.length - 1
      ? moveTo({ s, i }, { s, i: i + 1 })
      : s < steps.length - 1
        ? moveTo({ s, i }, { s: s + 1, i: 0 })
        : undefined;
  const isFirst = (s: number, i: number) => s === 0 && i === 0;
  const isLast = (s: number, i: number) =>
    s === steps.length - 1 && i === steps[s].fields.length - 1;

  const addField = () => {
    const s = sel ? sel.s : steps.length - 1;
    const kind: FormFieldKind = "text";
    const f: FormField = {
      key: keyFrom(t("fm_new_field"), keys),
      label: t("fm_new_field"),
      kind,
    };
    const out = steps.map((st, si) =>
      si === s ? { ...st, fields: [...st.fields, f] } : st,
    );
    onSteps(out);
    setSel({ s, i: out[s].fields.length - 1 });
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLInputElement>("input")?.select(),
    );
  };
  const addStep = () => {
    onSteps([...steps, { title: "", fields: [] }]);
    setAnnounce(t("fm_step_added", { n: steps.length + 1 }));
  };
  const removeStep = (s: number) => {
    // Its fields stay: they join the step before (or after, for the first).
    const into = s > 0 ? s - 1 : 1;
    const out = steps.map((st) => ({ ...st, fields: [...st.fields] }));
    out[into].fields.push(...out[s].fields);
    out.splice(s, 1);
    onSteps(out);
    setSel(null);
    setAnnounce(t("fm_step_removed", { n: s + 1 }));
  };
  const moveStep = (s: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const out = [...steps];
    const [x] = out.splice(s, 1);
    out.splice(to, 0, x);
    onSteps(out);
    setSel(null);
  };
  const askRemove = (s: number, i: number) => {
    const f = steps[s].fields[i];
    const deps = formFields(steps).filter((x) => x.showIf?.field === f.key);
    if (deps.length) setRemoving({ s, i, deps });
    else removeField(s, i);
  };
  const removeField = (s: number, i: number) => {
    const f = steps[s].fields[i];
    // Conditions that looked at it go with it (the person agreed; otherwise the form cannot be saved).
    const out = steps.map((st, si) => ({
      ...st,
      fields: st.fields
        .filter((_, fi) => !(si === s && fi === i))
        .map((x) => (x.showIf?.field === f.key ? { ...x, showIf: null } : x)),
    }));
    onSteps(out);
    setSel(null);
    setAnnounce(t("fm_field_removed", { label: f.label }));
    const nextKey = out[s].fields[i]
      ? pathKey(s, i)
      : out[s].fields[i - 1]
        ? pathKey(s, i - 1)
        : null;
    focusAfter.current = nextKey;
  };

  const dropOn = (to: { s: number; i: number }) => {
    if (!drag) return;
    let { s, i } = to;
    if (drag.s === s && drag.i < i) i -= 1;
    if (!(drag.s === s && drag.i === i)) moveTo(drag, { s, i });
    setDrag(null);
    setOver(null);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-2 overflow-y-auto px-4 py-4 md:px-6">
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
        {problems.get("form") ? (
          <StatusText tone="error" className="text-xs">
            {problems.get("form")}
          </StatusText>
        ) : null}
        {steps.map((st, s) => (
          <section
            key={s}
            aria-label={
              st.title
                ? t("fm_step_named", { n: s + 1, title: st.title })
                : t("fm_step_n", { n: s + 1 })
            }
            className={cn("flex flex-col gap-2", s > 0 && "mt-2")}
          >
            {many ? (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md",
                  over === `step:${s}` && "ring-2 ring-primary",
                )}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  setOver(`step:${s}`);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn({ s, i: steps[s].fields.length });
                }}
              >
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t("fm_step_n", { n: s + 1 })} ·
                </span>
                <input
                  value={st.title}
                  onChange={(e) =>
                    onSteps(
                      steps.map((x, si) =>
                        si === s ? { ...x, title: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder={t("fm_step_title_placeholder")}
                  aria-label={t("fm_step_title", { n: s + 1 })}
                  maxLength={120}
                  readOnly={readOnly}
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-xs font-medium text-muted-foreground outline-none hover:border-input focus-visible:border-input focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                {readOnly ? null : (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className={buttonVariants({
                        variant: "ghost",
                        size: "icon",
                        className: "h-8 w-8",
                      })}
                      aria-label={t("fm_step_menu", { n: s + 1 })}
                    >
                      <MoreHorizontal aria-hidden className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={s === 0}
                        onClick={() => moveStep(s, s - 1)}
                      >
                        {t("fm_step_up")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={s === steps.length - 1}
                        onClick={() => moveStep(s, s + 1)}
                      >
                        {t("fm_step_down")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => removeStep(s)}
                      >
                        {t("fm_step_remove")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            ) : null}
            {st.fields.length ? (
              <ul className="flex flex-col gap-1.5">
                {st.fields.map((f, i) => {
                  const Icon = KIND_ICON[f.kind] ?? Type;
                  const picked = sel?.s === s && sel.i === i;
                  const problem = problems.get(pathKey(s, i));
                  const cond = f.showIf ? condLabel(f.showIf, steps, t) : null;
                  return (
                    <li
                      key={`${f.key}-${i}`}
                      ref={(el) =>
                        void (el
                          ? rowRefs.current.set(pathKey(s, i), el)
                          : rowRefs.current.delete(pathKey(s, i)))
                      }
                      tabIndex={0}
                      draggable={!readOnly}
                      aria-label={`${f.label} · ${label(f.kind)}${f.required ? ` · ${t("fm_required")}` : ""}${cond ? ` · ${t("fm_shown_when", { cond })}` : ""}${problem ? ` · ${problem}` : ""}`}
                      aria-current={picked ? "true" : undefined}
                      onClick={() => setSel({ s, i })}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSel({ s, i });
                          requestAnimationFrame(() =>
                            panelRef.current
                              ?.querySelector<HTMLElement>(
                                "input,select,textarea,button",
                              )
                              ?.focus(),
                          );
                        } else if (
                          !readOnly &&
                          e.altKey &&
                          e.key === "ArrowUp"
                        ) {
                          e.preventDefault();
                          up(s, i);
                        } else if (
                          !readOnly &&
                          e.altKey &&
                          e.key === "ArrowDown"
                        ) {
                          e.preventDefault();
                          down(s, i);
                        }
                      }}
                      onDragStart={(e) => {
                        setDrag({ s, i });
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", f.key);
                      }}
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        setOver(pathKey(s, i));
                      }}
                      onDragEnd={() => (setDrag(null), setOver(null))}
                      onDrop={(e) => {
                        e.preventDefault();
                        dropOn({ s, i });
                      }}
                      className={cn(
                        "group flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-shadow duration-150 ease-out hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                        picked &&
                          "ring-2 ring-ring ring-offset-2 ring-offset-background",
                        over === pathKey(s, i) &&
                          drag &&
                          "border-t-2 border-t-primary",
                        drag?.s === s && drag.i === i && "opacity-50",
                        problem && "border-destructive/60",
                      )}
                    >
                      {readOnly ? null : (
                        <GripVertical
                          aria-hidden
                          className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground"
                        />
                      )}
                      <Icon
                        aria-hidden
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {f.label || (
                          <span className="text-muted-foreground">
                            {t("fm_no_label")}
                          </span>
                        )}
                      </span>
                      {problem ? (
                        <AlertCircle
                          aria-hidden
                          className="h-4 w-4 shrink-0 text-destructive"
                        />
                      ) : f.kind === "file" && !uploads ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-800 dark:text-amber-300">
                          <AlertCircle aria-hidden className="h-3 w-3" />
                          {t("fm_file_unavailable_short")}
                        </span>
                      ) : null}
                      {cond ? (
                        <span className="hidden max-w-[12rem] items-center gap-1 truncate rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground sm:inline-flex">
                          <GitBranch aria-hidden className="h-3 w-3 shrink-0" />
                          <span className="truncate">{cond}</span>
                        </span>
                      ) : null}
                      <span className="hidden shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground sm:inline">
                        {label(f.kind)}
                      </span>
                      {f.required ? (
                        <Badge
                          variant="secondary"
                          className="shrink-0 rounded-full px-2 py-0 text-[11px] font-medium"
                        >
                          {t("fm_required")}
                        </Badge>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p
                className={cn(
                  "rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground",
                  over === `step:${s}` && "border-primary",
                )}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  setOver(`step:${s}`);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn({ s, i: 0 });
                }}
              >
                {t("fm_step_empty")}
              </p>
            )}
          </section>
        ))}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {readOnly ? null : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={addField}
                disabled={keys.size >= 100}
              >
                <Plus aria-hidden className="h-4 w-4" />
                {t("fm_add_field")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={addStep}
                disabled={steps.length >= 20}
              >
                <Plus aria-hidden className="h-4 w-4" />
                {t("fm_add_step")}
              </Button>
            </>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={onPreview}
            disabled={!keys.size}
          >
            <Eye aria-hidden className="h-4 w-4" />
            {t("fm_preview")}
          </Button>
        </div>
        {readOnly ? null : (
          <p className="text-xs text-muted-foreground">
            {t("fm_reorder_hint")}
          </p>
        )}
      </div>
      <aside
        ref={panelRef}
        aria-label={t("fm_field_settings")}
        className="flex min-w-0 flex-col gap-4 border-t px-4 py-4 md:border-l md:border-t-0 md:px-5"
      >
        {cur && sel ? (
          <FieldPanel
            key={`${sel.s}:${sel.i}`}
            field={cur}
            at={sel}
            steps={steps}
            readOnly={readOnly}
            uploads={uploads}
            problem={problems.get(pathKey(sel.s, sel.i)) ?? null}
            onChange={(p) => setField(sel.s, sel.i, p)}
            onRemove={() => askRemove(sel.s, sel.i)}
            onUp={isFirst(sel.s, sel.i) ? null : () => up(sel.s, sel.i)}
            onDown={isLast(sel.s, sel.i) ? null : () => down(sel.s, sel.i)}
            onStep={(to) => moveTo(sel, { s: to, i: steps[to].fields.length })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {steps.some((s) => s.fields.length)
              ? t("fm_pick_field")
              : t("fm_no_fields")}
          </p>
        )}
      </aside>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("fm_remove_used_title", {
          label: removing ? steps[removing.s]?.fields[removing.i]?.label ?? "" : "",
        })}
        description={t("fm_remove_used_text", { n: removing?.deps.length ?? 0 })}
        confirmLabel={t("fm_remove_used_confirm")}
        destructive
        onConfirm={() => {
          if (removing) removeField(removing.s, removing.i);
          setRemoving(null);
        }}
      >
        <ul className="list-disc pl-5 text-sm">
          {removing?.deps.map((d) => (
            <li key={d.key}>{d.label || d.key}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function condLabel(c: FormCondition, steps: readonly FormStep[], t: T): string {
  const target = formFields(steps).find((f) => f.key === c.field);
  const name = target?.label || c.field;
  const val = (v: unknown) => {
    if (typeof v === "boolean" || v === "true" || v === "false")
      return v === true || v === "true"
        ? t("fm_cond_checked")
        : t("fm_cond_unchecked");
    return (
      target?.options?.find((o) => o.value === v)?.label ?? String(v ?? "")
    );
  };
  switch (c.op) {
    case "eq":
      return `${name} = ${val(c.value)}`;
    case "neq":
      return `${name} ≠ ${val(c.value)}`;
    case "in":
      return `${name} ∈ ${(Array.isArray(c.value) ? c.value : [c.value]).map(val).join(", ")}`;
    case "contains":
      return t("fm_cond_contains_label", { field: name, value: val(c.value) });
    case "empty":
      return t("fm_cond_empty_label", { field: name });
    case "filled":
      return t("fm_cond_filled_label", { field: name });
  }
  return name;
}

const MB = 1024 * 1024;
const ACCEPT_PRESETS: { id: string; accept: string[] }[] = [
  { id: "images_pdf", accept: ["image/*", ".pdf"] },
  { id: "images", accept: ["image/*"] },
  { id: "pdf", accept: [".pdf"] },
  { id: "docs", accept: [".pdf", ".doc", ".docx", ".txt"] },
];

function FieldPanel({
  field,
  at,
  steps,
  readOnly,
  uploads,
  problem,
  onChange,
  onRemove,
  onUp,
  onDown,
  onStep,
}: {
  field: FormField;
  at: { s: number; i: number };
  steps: FormStep[];
  readOnly: boolean;
  uploads: boolean;
  problem: string | null;
  onChange: (p: Partial<FormField>) => void;
  onRemove: () => void;
  onUp: (() => void) | null;
  onDown: (() => void) | null;
  onStep: (s: number) => void;
}) {
  const { t } = useCms();
  const id = React.useId();
  const [keyTyped, setKeyTyped] = React.useState(false);
  const earlier = steps.flatMap((st, s) =>
    st.fields.filter((_, i) => s < at.s || (s === at.s && i < at.i)),
  );
  const taken = new Set(
    formFields(steps)
      .filter((f) => f !== field)
      .map((f) => f.key),
  );
  const isChoice = field.kind === "select" || field.kind === "multiselect";
  const isText =
    field.kind === "text" ||
    field.kind === "textarea" ||
    field.kind === "email";
  const num = (v: string): number | null =>
    v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  const dis = readOnly;

  const setLabel = (label: string) => {
    // A brand-new field's key follows its label until the key is typed (or the field was saved before).
    const follow = !keyTyped && field.key === keyFrom(field.label, taken);
    onChange(follow ? { label, key: keyFrom(label, taken) } : { label });
  };
  const setKind = (kind: FormFieldKind) => {
    const p: Partial<FormField> = { kind };
    if ((kind === "select" || kind === "multiselect") && !field.options?.length) {
      const first = nextOptionNumber(field);
      p.options = [0, 1].map((i) => ({
        value: `option_${first + i}`,
        label: t("fm_option_n", { n: i + 1 }),
      }));
      p.nextOption = first + 2;
    }
    if (kind !== "select" && kind !== "multiselect") p.options = undefined;
    if (kind !== "text" && kind !== "textarea") p.pattern = undefined;
    if (kind !== "file")
      ((p.accept = undefined),
        (p.maxSize = undefined),
        (p.maxFiles = undefined));
    p.min = undefined;
    p.max = undefined;
    onChange(p);
  };

  return (
    <div className="flex flex-col gap-4">
      {problem ? (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-xs font-medium text-destructive"
        >
          <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {problem}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-label`}>{t("fm_f_label")}</Label>
        <Input
          id={`${id}-label`}
          value={field.label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={dis}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-kind`}>{t("fm_f_kind")}</Label>
        <NativeSelect
          id={`${id}-kind`}
          value={field.kind}
          onChange={(e) => setKind(e.target.value as FormFieldKind)}
          className={SELECT}
          disabled={dis}
        >
          {FORM_FIELD_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "file" && !uploads
                ? t("fm_kind_file_unavailable")
                : t(`fm_kind_${k}` as MessageKey)}
            </option>
          ))}
        </NativeSelect>
        {field.kind === "file" && !uploads ? (
          <p
            role="note"
            className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
            {field.required
              ? t("fm_file_unavailable_required")
              : t("fm_file_unavailable")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-key`}>{t("fm_f_key")}</Label>
        <Input
          id={`${id}-key`}
          value={field.key}
          onChange={(e) => (
            setKeyTyped(true),
            onChange({ key: e.target.value.toLowerCase() })
          )}
          maxLength={40}
          className="font-mono text-[13px]"
          aria-describedby={`${id}-key-hint`}
          disabled={dis}
        />
        <p id={`${id}-key-hint`} className="text-xs text-muted-foreground">
          {t("fm_f_key_hint")}
        </p>
      </div>
      {isChoice ? (
        <OptionsEditor field={field} onChange={onChange} disabled={dis} />
      ) : null}
      {field.kind === "file" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-accept`}>{t("fm_f_accept")}</Label>
          <NativeSelect
            id={`${id}-accept`}
            className={SELECT}
            disabled={dis}
            value={
              ACCEPT_PRESETS.find(
                (p) =>
                  JSON.stringify(p.accept) ===
                  JSON.stringify(field.accept ?? ["image/*", ".pdf"]),
              )?.id ?? "custom"
            }
            onChange={(e) => {
              const p = ACCEPT_PRESETS.find((x) => x.id === e.target.value);
              if (p) onChange({ accept: p.accept });
            }}
          >
            {ACCEPT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {t(`fm_accept_${p.id}` as MessageKey)}
              </option>
            ))}
            {ACCEPT_PRESETS.some(
              (p) =>
                JSON.stringify(p.accept) ===
                JSON.stringify(field.accept ?? ["image/*", ".pdf"]),
            ) ? null : (
              <option value="custom">{(field.accept ?? []).join(", ")}</option>
            )}
          </NativeSelect>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor={`${id}-size`}
                className="text-xs font-normal text-muted-foreground"
              >
                {t("fm_f_max_size")}
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={`${id}-size`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  value={Math.round((field.maxSize ?? 10 * MB) / MB)}
                  onChange={(e) =>
                    onChange({
                      maxSize:
                        Math.max(
                          1,
                          Math.min(
                            100,
                            Math.round(Number(e.target.value) || 1),
                          ),
                        ) * MB,
                    })
                  }
                  disabled={dis}
                  className="h-9"
                />
                <span className="text-xs text-muted-foreground">MB</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label
                htmlFor={`${id}-files`}
                className="text-xs font-normal text-muted-foreground"
              >
                {t("fm_f_max_files")}
              </Label>
              <Input
                id={`${id}-files`}
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                value={field.maxFiles ?? 1}
                onChange={(e) =>
                  onChange({
                    maxFiles: Math.max(
                      1,
                      Math.min(10, Math.round(Number(e.target.value) || 1)),
                    ),
                  })
                }
                disabled={dis}
                className="h-9"
              />
            </div>
          </div>
        </div>
      ) : null}
      {isText || field.kind === "number" || field.kind === "multiselect" ? (
        <div className="grid grid-cols-2 gap-2">
          {(["min", "max"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <Label
                htmlFor={`${id}-${k}`}
                className="text-xs font-normal text-muted-foreground"
              >
                {t(
                  isText
                    ? k === "min"
                      ? "fm_f_min_len"
                      : "fm_f_max_len"
                    : field.kind === "multiselect"
                      ? k === "min"
                        ? "fm_f_min_picks"
                        : "fm_f_max_picks"
                      : k === "min"
                        ? "fm_f_min"
                        : "fm_f_max",
                )}
              </Label>
              <Input
                id={`${id}-${k}`}
                type="number"
                inputMode="decimal"
                value={typeof field[k] === "number" ? String(field[k]) : ""}
                onChange={(e) =>
                  onChange({ [k]: num(e.target.value) ?? undefined })
                }
                disabled={dis}
                className="h-9"
              />
            </div>
          ))}
        </div>
      ) : null}
      {field.kind === "date" ? (
        <div className="grid grid-cols-2 gap-2">
          {(["min", "max"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <Label
                htmlFor={`${id}-${k}`}
                className="text-xs font-normal text-muted-foreground"
              >
                {t(k === "min" ? "fm_f_from" : "fm_f_until")}
              </Label>
              <Input
                id={`${id}-${k}`}
                type="date"
                value={typeof field[k] === "string" ? String(field[k]) : ""}
                onChange={(e) => onChange({ [k]: e.target.value || undefined })}
                disabled={dis}
                className="h-9"
              />
            </div>
          ))}
        </div>
      ) : null}
      {field.kind === "text" || field.kind === "textarea" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-pattern`}>{t("fm_f_pattern")}</Label>
          <Input
            id={`${id}-pattern`}
            value={field.pattern ?? ""}
            onChange={(e) => onChange({ pattern: e.target.value || undefined })}
            placeholder="[0-9]{3}-[0-9]{4}"
            className="font-mono text-[13px]"
            maxLength={300}
            disabled={dis}
          />
          {field.pattern ? (
            <Input
              aria-label={t("fm_f_pattern_message")}
              value={field.patternMessage ?? ""}
              onChange={(e) =>
                onChange({ patternMessage: e.target.value || undefined })
              }
              placeholder={t("fm_f_pattern_message")}
              maxLength={200}
              disabled={dis}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-help`}>{t("fm_f_help")}</Label>
        <Input
          id={`${id}-help`}
          value={field.help ?? ""}
          onChange={(e) => onChange({ help: e.target.value || undefined })}
          maxLength={500}
          disabled={dis}
        />
      </div>
      {field.kind !== "checkbox" &&
      field.kind !== "file" &&
      field.kind !== "multiselect" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-ph`}>{t("fm_f_placeholder")}</Label>
          <Input
            id={`${id}-ph`}
            value={field.placeholder ?? ""}
            onChange={(e) =>
              onChange({ placeholder: e.target.value || undefined })
            }
            maxLength={200}
            disabled={dis}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <span id={`${id}-req`} className="flex-1 text-sm font-medium">
          {field.kind === "checkbox"
            ? t("fm_f_required_check")
            : t("fm_required")}
        </span>
        <FormSwitch
          checked={!!field.required}
          onChange={(on) => onChange({ required: on || undefined })}
          label={
            field.kind === "checkbox"
              ? t("fm_f_required_check")
              : t("fm_required")
          }
          disabled={dis}
        />
      </div>
      <ConditionEditor
        field={field}
        earlier={earlier}
        onChange={(showIf) => onChange({ showIf })}
        disabled={dis}
      />
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-8 md:w-8"
            aria-label={t("fm_move_up")}
            disabled={!onUp}
            onClick={() => onUp?.()}
          >
            <ArrowUp aria-hidden className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-8 md:w-8"
            aria-label={t("fm_move_down")}
            disabled={!onDown}
            onClick={() => onDown?.()}
          >
            <ArrowDown aria-hidden className="h-4 w-4" />
          </Button>
          {steps.length > 1 ? (
            <NativeSelect
              aria-label={t("fm_f_step")}
              value={String(at.s)}
              onChange={(e) => onStep(Number(e.target.value))}
              className="h-10 w-32 rounded-md border border-input bg-background px-2 text-sm md:h-8 md:text-xs"
            >
              {steps.map((st, s) => (
                <option key={s} value={s}>
                  {st.title
                    ? `${t("fm_step_n", { n: s + 1 })} · ${st.title}`
                    : t("fm_step_n", { n: s + 1 })}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 gap-1.5 text-destructive hover:text-destructive md:h-8"
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            {t("fm_remove_field")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A value for a new choice: option_1, option_2, … (made once, never renamed). The number only grows
 * (the field keeps it in `nextOption`), so a removed choice's value never comes back on another one.
 */
export function newOptionValue(
  opts: readonly { value: string }[],
  nextOption?: number,
): string {
  return `option_${nextOptionNumber({ options: opts as FormOption[], nextOption })}`;
}

function OptionsEditor({
  field,
  onChange,
  disabled,
}: {
  field: FormField;
  onChange: (p: Partial<FormField>) => void;
  disabled: boolean;
}) {
  const { t } = useCms();
  const opts = field.options ?? [];
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const set = (i: number, label: string) => {
    // Only the label changes: the stored value (what submissions and conditions keep) never moves,
    // so renaming a choice breaks nothing.
    onChange({
      options: opts.map((x, j) => (j === i ? { ...x, label } : x)),
    });
  };
  const add = () => {
    const n = nextOptionNumber(field);
    onChange({
      options: [
        ...opts,
        { value: `option_${n}`, label: t("fm_option_n", { n: opts.length + 1 }) },
      ],
      nextOption: n + 1,
    });
    requestAnimationFrame(() => refs.current[opts.length]?.select());
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">
        {t("fm_f_options")}
      </legend>
      <ul className="flex flex-col gap-1.5">
        {opts.map((o, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <Input
              ref={(el) => void (refs.current[i] = el)}
              value={o.label}
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                }
              }}
              aria-label={t("fm_option_label", { n: i + 1 })}
              maxLength={200}
              disabled={disabled}
              className="h-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 md:h-8 md:w-8"
              aria-label={t("fm_option_remove", {
                label: o.label || String(i + 1),
              })}
              disabled={disabled || opts.length <= 1}
              onClick={() =>
                // The counter moves past the removed value first, so it is never handed out again.
                onChange({
                  options: opts.filter((_, j) => j !== i),
                  nextOption: nextOptionNumber(field),
                })
              }
            >
              <Trash2 aria-hidden className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit gap-1.5"
          onClick={add}
          disabled={opts.length >= 100}
        >
          <Plus aria-hidden className="h-4 w-4" />
          {t("fm_option_add")}
        </Button>
      )}
    </fieldset>
  );
}

function ConditionEditor({
  field,
  earlier,
  onChange,
  disabled,
}: {
  field: FormField;
  earlier: FormField[];
  onChange: (c: FormCondition | null) => void;
  disabled: boolean;
}) {
  const { t } = useCms();
  const id = React.useId();
  const c = field.showIf ?? null;
  const target = c ? earlier.find((f) => f.key === c.field) : undefined;
  const opsFor = (f: FormField | undefined): FormCondition["op"][] =>
    f ? condOps(f) : [];
  const first = (f: FormField): FormCondition => {
    const op = opsFor(f)[0];
    return {
      field: f.key,
      op,
      value:
        f.kind === "checkbox"
          ? true
          : (f.options?.[0]?.value ??
            (op === "empty" || op === "filled" ? undefined : "")),
    };
  };
  const needsValue = c && c.op !== "empty" && c.op !== "filled";
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">
        {t("fm_f_show_if")}
      </legend>
      {!earlier.length ? (
        <p className="text-xs text-muted-foreground">
          {t("fm_cond_none_before")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <NativeSelect
              id={`${id}-field`}
              aria-label={t("fm_cond_field")}
              className={cn(SELECT, "min-w-0 flex-1")}
              value={c?.field ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const f = earlier.find((x) => x.key === e.target.value);
                onChange(f ? first(f) : null);
              }}
            >
              <option value="">{t("fm_cond_always")}</option>
              {earlier.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label || f.key}
                </option>
              ))}
            </NativeSelect>
            {c && target ? (
              <NativeSelect
                aria-label={t("fm_cond_op")}
                className={cn(SELECT, "w-auto")}
                value={c.op}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    ...c,
                    op: e.target.value as FormCondition["op"],
                    value:
                      e.target.value === "in"
                        ? target.options?.[0]
                          ? [target.options[0].value]
                          : []
                        : e.target.value === "empty" ||
                            e.target.value === "filled"
                          ? undefined
                          : Array.isArray(c.value)
                            ? c.value[0]
                            : c.value,
                  })
                }
              >
                {opsFor(target).includes(c.op) ? null : (
                  <option value={c.op} disabled>
                    {t("fm_cond_pick")}
                  </option>
                )}
                {opsFor(target).map((op) => (
                  <option key={op} value={op}>
                    {t(`fm_op_${op}` as MessageKey)}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </div>
          {c && target && needsValue ? (
            target.kind === "checkbox" ? (
              <NativeSelect
                aria-label={t("fm_cond_value")}
                className={SELECT}
                value={String(c.value === true || c.value === "true")}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...c, value: e.target.value === "true" })
                }
              >
                <option value="true">{t("fm_cond_checked")}</option>
                <option value="false">{t("fm_cond_unchecked")}</option>
              </NativeSelect>
            ) : target.options?.length && c.op === "in" ? (
              <div
                role="group"
                aria-label={t("fm_cond_value")}
                className="flex flex-col gap-1"
              >
                {target.options.map((o) => {
                  const list = Array.isArray(c.value) ? c.value : [];
                  return (
                    <label
                      key={o.value}
                      className="flex min-h-8 items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        disabled={disabled}
                        checked={list.includes(o.value)}
                        onChange={(e) =>
                          onChange({
                            ...c,
                            value: e.target.checked
                              ? [...list, o.value]
                              : list.filter((x) => x !== o.value),
                          })
                        }
                      />
                      {o.label}
                    </label>
                  );
                })}
              </div>
            ) : target.options?.length ? (
              <NativeSelect
                aria-label={t("fm_cond_value")}
                className={SELECT}
                value={
                  target.options.some((o) => o.value === String(c.value ?? ""))
                    ? String(c.value ?? "")
                    : ""
                }
                disabled={disabled}
                onChange={(e) => onChange({ ...c, value: e.target.value })}
              >
                {target.options.some(
                  (o) => o.value === String(c.value ?? ""),
                ) ? null : (
                  <option value="" disabled>
                    {t("fm_cond_pick")}
                  </option>
                )}
                {target.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                aria-label={t("fm_cond_value")}
                value={String(c.value ?? "")}
                disabled={disabled}
                onChange={(e) => onChange({ ...c, value: e.target.value })}
                className="h-9"
              />
            )
          ) : null}
          <p className="text-xs text-muted-foreground">{t("fm_cond_hint")}</p>
        </>
      )}
    </fieldset>
  );
}

// ── settings ─────────────────────────────────────────────────────────────────

function SettingsTab({
  draft,
  onDraft,
  readOnly,
  problem,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  readOnly: boolean;
  problem: string | null;
}) {
  const { t } = useCms();
  const id = React.useId();
  const [notify, setNotify] = React.useState(draft.settings.notify.join(", "));
  React.useEffect(() => {
    // Saved or reloaded elsewhere: show the stored list.
    if (
      draft.settings.notify.join(", ") !==
      notify
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .join(", ")
    )
      setNotify(draft.settings.notify.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.settings.notify]);
  const set = (p: Partial<FormSettings>) =>
    onDraft({ ...draft, settings: { ...draft.settings, ...p } });
  return (
    <div className="flex max-w-2xl flex-col gap-5 overflow-y-auto px-4 py-5 md:px-6">
      {problem ? (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-sm text-destructive"
        >
          <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
          {problem}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-title`}>{t("fm_name")}</Label>
          <Input
            id={`${id}-title`}
            value={draft.title}
            onChange={(e) => onDraft({ ...draft, title: e.target.value })}
            maxLength={120}
            disabled={readOnly}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-slug`}>{t("fm_slug")}</Label>
          <Input
            id={`${id}-slug`}
            value={draft.slug}
            onChange={(e) =>
              onDraft({ ...draft, slug: e.target.value.toLowerCase() })
            }
            maxLength={63}
            className="font-mono text-[13px]"
            aria-describedby={`${id}-slug-hint`}
            disabled={readOnly}
          />
          <p id={`${id}-slug-hint`} className="text-xs text-muted-foreground">
            {t("fm_slug_change_hint")}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-msg`}>{t("fm_s_message")}</Label>
        <Textarea
          id={`${id}-msg`}
          value={draft.settings.successMessage}
          onChange={(e) => set({ successMessage: e.target.value })}
          rows={3}
          maxLength={1000}
          placeholder={t("cf_sent")}
          disabled={readOnly}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-notify`}>{t("fm_s_notify")}</Label>
        <Input
          id={`${id}-notify`}
          type="text"
          inputMode="email"
          value={notify}
          onChange={(e) => {
            setNotify(e.target.value);
            set({
              notify: [
                ...new Set(
                  e.target.value
                    .split(/[,\s]+/)
                    .map((x) => x.trim())
                    .filter(Boolean),
                ),
              ],
            });
          }}
          placeholder="support@example.com"
          aria-describedby={`${id}-notify-hint`}
          disabled={readOnly}
        />
        <p id={`${id}-notify-hint`} className="text-xs text-muted-foreground">
          {t("fm_s_notify_hint")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-keep`}>{t("fm_s_keep")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-keep`}
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            value={draft.settings.keepDays ?? ""}
            placeholder="365"
            onChange={(e) =>
              set({
                keepDays:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value)),
              })
            }
            className="h-9 w-28"
            aria-describedby={`${id}-keep-hint`}
            disabled={readOnly}
          />
          <span className="text-sm">{t("fm_s_days")}</span>
        </div>
        <p id={`${id}-keep-hint`} className="text-xs text-muted-foreground">
          {t("fm_s_keep_hint")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-redirect`}>{t("fm_s_redirect")}</Label>
        <Input
          id={`${id}-redirect`}
          value={draft.settings.redirectUrl ?? ""}
          onChange={(e) => set({ redirectUrl: e.target.value.trim() || null })}
          placeholder="/thanks"
          className="font-mono text-[13px]"
          aria-describedby={`${id}-redirect-hint`}
          disabled={readOnly}
        />
        <p id={`${id}-redirect-hint`} className="text-xs text-muted-foreground">
          {t("fm_s_redirect_hint")}
        </p>
      </div>
      <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
        <p className="text-sm font-medium">{t("fm_s_spam")}</p>
        <p className="text-xs text-muted-foreground">{t("fm_s_spam_text")}</p>
      </div>
    </div>
  );
}

// ── embed ────────────────────────────────────────────────────────────────────

type EmbedKind = "react" | "html" | "rest";

/**
 * A plain HTML form (no script). Only for forms without file fields and conditions: those need
 * `<CmsForm>` (see `htmlEmbedLimits`).
 */
export function htmlSnippet(
  form: FormView,
  action: string,
  honeypot = "_website",
  sendLabel = "Send",
): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const lines: string[] = [`<form method="post" action="${esc(action)}">`];
  for (const f of formFields(form.steps)) {
    if (f.kind === "file") continue;
    const req = f.required ? " required" : "";
    const name = esc(f.key);
    if (f.kind === "textarea")
      lines.push(
        `  <label>${esc(f.label)}<textarea name="${name}"${req}></textarea></label>`,
      );
    else if (f.kind === "select")
      lines.push(
        `  <label>${esc(f.label)}<select name="${name}"${req}>${(f.options ?? []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select></label>`,
      );
    else if (f.kind === "multiselect")
      lines.push(
        `  <fieldset><legend>${esc(f.label)}</legend>${(f.options ?? []).map((o) => `<label><input type="checkbox" name="${name}" value="${esc(o.value)}">${esc(o.label)}</label>`).join("")}</fieldset>`,
      );
    else if (f.kind === "checkbox")
      lines.push(
        `  <label><input type="checkbox" name="${name}" value="true"${req}>${esc(f.label)}</label>`,
      );
    else
      lines.push(
        `  <label>${esc(f.label)}<input type="${f.kind === "email" ? "email" : f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}" name="${name}"${req}></label>`,
      );
  }
  lines.push(
    `  <div aria-hidden="true" style="position:absolute;left:-10000px"><input name="${honeypot}" tabindex="-1" autocomplete="off"></div>`,
  );
  lines.push(`  <button type="submit">${esc(sendLabel)}</button>`, `</form>`);
  return lines.join("\n");
}

/** What a plain HTML form cannot do for this form: file fields, fields shown on a condition. */
export function htmlEmbedLimits(form: Pick<FormView, "steps">): {
  files: boolean;
  conditions: boolean;
} {
  const all = formFields(form.steps);
  return {
    files: all.some((f) => f.kind === "file"),
    conditions: all.some((f) => !!f.showIf),
  };
}

function EmbedDialog({
  form,
  onClose,
}: {
  form: FormView;
  onClose: () => void;
}) {
  const { t, baseUrl } = useCms();
  const [kind, setKind] = React.useState<EmbedKind>("react");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const api = /^https?:\/\//.test(baseUrl) ? baseUrl : `${origin}${baseUrl}`;
  const url = `${api}/forms/${form.slug}`;
  const sample = Object.fromEntries(
    formFields(form.steps)
      .filter((f) => f.kind !== "file" && !f.showIf)
      .slice(0, 4)
      .map((f) => [
        f.key,
        f.kind === "checkbox"
          ? true
          : f.kind === "number"
            ? 1
            : f.kind === "multiselect"
              ? [f.options?.[0]?.value ?? ""]
              : f.kind === "select"
                ? (f.options?.[0]?.value ?? "")
                : f.kind === "email"
                  ? "you@example.com"
                  : f.kind === "date"
                    ? "2026-01-31"
                    : "…",
      ]),
  );
  const limits = htmlEmbedLimits(form);
  // Plain HTML cannot upload files or show fields on a condition: no code to copy that would not work.
  const htmlBlocked = kind === "html" && (limits.files || limits.conditions);
  const code =
    kind === "react"
      ? `npx @mainsoft/agent-cms add cms-form\n\nimport { CmsForm } from "@/components/cms/cms-form";\n\n<CmsForm slug="${form.slug}"${baseUrl !== "/api/cms" ? ` baseUrl="${baseUrl}"` : ""} />`
      : kind === "html"
        ? htmlBlocked
          ? ""
          : htmlSnippet(form, url, "_website", t("cf_send"))
        : `curl -X POST ${url} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(sample).replace(/'/g, "'\\''")}'`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.lg}>
        <DialogHeader>
          <DialogTitle>{t("fm_embed")}</DialogTitle>
          <DialogDescription>{t("fm_embed_text")}</DialogDescription>
        </DialogHeader>
        <Segmented
          label={t("fm_embed_kind")}
          value={kind}
          onChange={setKind}
          itemClassName="h-7 px-2.5 text-xs"
          options={[
            { value: "react", label: "React" },
            { value: "html", label: "HTML" },
            { value: "rest", label: "REST" },
          ]}
        />
        {htmlBlocked ? (
          <div
            role="note"
            className="flex flex-col items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <p className="font-medium">{t("fm_embed_html_no")}</p>
            <ul className="list-disc pl-5 text-xs">
              {limits.files ? <li>{t("fm_embed_html_files")}</li> : null}
              {limits.conditions ? <li>{t("fm_embed_html_conditions")}</li> : null}
            </ul>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-background"
              onClick={() => setKind("react")}
            >
              {t("fm_embed_use_react")}
            </Button>
          </div>
        ) : (
          <pre
            className="max-h-72 overflow-auto whitespace-pre rounded-md border bg-muted/40 p-3 font-mono text-[12.5px] leading-relaxed"
            tabIndex={0}
            aria-label={t("fm_embed_code")}
          >
            {code}
          </pre>
        )}
        {!form.enabled ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("fm_embed_closed")}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
          {htmlBlocked ? null : (
            <CopyButton
              value={code}
              label={t("fm_embed_code")}
              className="h-9 gap-1.5 px-4 text-sm"
            />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
