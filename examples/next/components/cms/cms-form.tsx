// agent-cms registry: cms-form (0.22.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// A form built on the admin's Forms screen, for your public page. It loads
// the form from `GET /forms/:slug`, draws its steps (with progress), shows a
// field only while its condition holds, checks what people type with the
// same rules the server uses, uploads files with progress and sends the
// lot to `POST /forms/:slug`. Needs no <CmsProvider>.
//
//   <CmsForm slug="contact" />
//   <CmsForm slug="contact" messages={ko} onSubmitted={() => track("contact")} />
//
// Your own markup: `useCmsForm(slug)` gives the same state without the drawing.
"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  Paperclip,
  X,
} from "lucide-react";
import {
  checkSubmission,
  createRestClient,
  formAccepts,
  formFields,
  FORM_DEFAULT_ACCEPT,
  FORM_DEFAULT_MAX_SIZE,
  isCmsRemoteError,
  visibleKeys,
  visibleSteps,
  type FormField,
  type FormProblem,
  type PublicForm,
} from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createT, type CmsMessages, type T } from "./cms-messages";
import { NativeSelect } from "./cms-parts";

export interface CmsFormProps {
  /** The form's address (`contact`). */
  slug: string;
  /** Where the CMS routes are mounted. Default "/api/cms". */
  baseUrl?: string;
  /** UI text; pass `ko` for Korean. */
  messages?: Partial<CmsMessages>;
  /** A ready translator instead of `messages` (inside <CmsProvider>: `useCms().t`). */
  t?: T;
  /** Draw this definition instead of loading it (the admin's preview). */
  form?: PublicForm;
  /** Nothing is uploaded or sent; the last step says so. */
  preview?: boolean;
  /** After the server kept a submission. */
  onSubmitted?: (r: { message: string; redirectUrl: string | null }) => void;
  fetch?: typeof fetch;
  className?: string;
}

/** One file picked for a file field. */
export interface CmsFormFile {
  id: string;
  name: string;
  size: number;
  state: "uploading" | "done" | "error";
  /** 0 to 1 while uploading. */
  progress: number;
  /** The upload token the submission carries. */
  token?: string;
  error?: string;
}

type Errors = Record<
  string,
  FormProblem | { field: string; code: "text"; params: { text: string } }
>;

export interface UseCmsFormOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  form?: PublicForm;
  preview?: boolean;
  /** UI text (default: English). */
  t?: T;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** PUT a file with progress (fetch cannot report upload progress). */
function putFile(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (p: number) => void,
  sameOrigin: boolean,
): { done: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.withCredentials = sameOrigin;
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error("network"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

/** The form's state and actions without any markup. */
export function useCmsForm(slug: string, o: UseCmsFormOptions) {
  const t = React.useMemo(() => o.t ?? createT(), [o.t]);
  const baseUrl = o.baseUrl ?? "/api/cms";
  const client = React.useMemo(
    () => createRestClient({ url: baseUrl, fetch: o.fetch }),
    [baseUrl, o.fetch],
  );
  const [form, setForm] = React.useState<PublicForm | null>(o.form ?? null);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(!o.form);
  const [tick, setTick] = React.useState(0);
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [files, setFiles] = React.useState<Record<string, CmsFormFile[]>>({});
  const [errors, setErrors] = React.useState<Errors>({});
  const [at, setAt] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<{
    message: string;
    redirectUrl: string | null;
  } | null>(null);
  const [trap, setTrap] = React.useState("");
  const aborts = React.useRef(new Map<string, () => void>());

  React.useEffect(() => {
    if (o.form) {
      setForm(o.form);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setLoadError(null);
    client
      .publicForm(slug)
      .then((f) => live && setForm(f))
      .catch((e) => live && setLoadError(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [client, slug, o.form, tick]);

  React.useEffect(() => () => aborts.current.forEach((a) => a()), []);

  const steps = form?.steps ?? [];
  // A file field's value is the tokens of its finished uploads (in a preview: the names).
  const all = React.useMemo(() => {
    const v = { ...values };
    for (const f of formFields(steps))
      if (f.kind === "file")
        v[f.key] = (files[f.key] ?? [])
          .filter((x) => x.state === "done")
          .map((x) => x.token ?? x.name);
    return v;
  }, [values, files, steps]);
  const shown = React.useMemo(() => visibleKeys(steps, all), [steps, all]);
  const order = React.useMemo(() => visibleSteps(steps, all), [steps, all]);
  const pos = Math.min(at, Math.max(0, order.length - 1));
  const stepIndex = order[pos] ?? 0;
  const last = pos >= order.length - 1;

  const setValue = React.useCallback((key: string, v: unknown) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    setErrors((cur) => {
      if (!cur[key]) return cur;
      const { [key]: _gone, ...rest } = cur;
      return rest;
    });
  }, []);

  const problemsOf = (only?: number[]): Errors => {
    const out: Errors = {};
    for (const p of checkSubmission(steps, all, only ? { steps: only } : {})
      .problems)
      out[p.field] = p;
    for (const f of formFields(steps)) {
      if (f.kind !== "file" || !shown.has(f.key)) continue;
      const i = steps.findIndex((s) => s.fields.includes(f));
      if (only && !only.includes(i)) continue;
      const list = files[f.key] ?? [];
      if (list.some((x) => x.state === "uploading"))
        out[f.key] = {
          field: f.key,
          code: "text",
          params: { text: t("cf_file_wait") },
        };
      else if (list.some((x) => x.state === "error"))
        out[f.key] = {
          field: f.key,
          code: "text",
          params: { text: t("cf_file_remove_failed") },
        };
    }
    return out;
  };

  /** Check this step; move on when it is fine. Returns the problems (empty when it moved). */
  const next = (): string[] => {
    const p = problemsOf([stepIndex]);
    setErrors(p);
    if (Object.keys(p).length) return Object.keys(p);
    setSendError(null);
    setAt(pos + 1);
    return [];
  };
  const back = () => {
    setSendError(null);
    setAt(Math.max(0, pos - 1));
  };

  /** Send. Returns the keys of fields with problems (the caller moves focus to the first). */
  const submit = async (): Promise<string[]> => {
    if (!form || sending) return [];
    const p = problemsOf();
    if (Object.keys(p).length) {
      setErrors(p);
      const first = formFields(steps).find((f) => p[f.key]);
      const s = first ? steps.findIndex((x) => x.fields.includes(first)) : -1;
      if (s >= 0 && order.includes(s)) setAt(order.indexOf(s));
      return Object.keys(p);
    }
    setSending(true);
    setSendError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const f of formFields(steps))
        if (shown.has(f.key) && all[f.key] !== undefined)
          body[f.key] = all[f.key];
      if (trap) body[form.honeypot] = trap;
      const r = o.preview
        ? { message: t("cf_preview_sent"), redirectUrl: null }
        : await client.submitForm(slug, body);
      setSent({ message: r.message, redirectUrl: r.redirectUrl });
      return [];
    } catch (e) {
      if (
        isCmsRemoteError(e) &&
        e.code === "form_rejected" &&
        e.extra.diagnostics?.length
      ) {
        const out: Errors = {};
        for (const d of e.extra.diagnostics)
          out[d.path] = {
            field: d.path,
            code: "text",
            params: {
              text: problemText(
                {
                  field: d.path,
                  code: d.code as FormProblem["code"],
                  params: (d.params ?? {}) as FormProblem["params"],
                },
                t,
                d.message,
              ),
            },
          };
        setErrors(out);
        const first = formFields(steps).find((f) => out[f.key]);
        const s = first ? steps.findIndex((x) => x.fields.includes(first)) : -1;
        if (s >= 0 && order.includes(s)) setAt(order.indexOf(s));
        return Object.keys(out);
      }
      if (isCmsRemoteError(e) && e.status === 429)
        setSendError(t("cf_rate_limited", { s: e.retryAfter ?? 60 }));
      else if (isCmsRemoteError(e) && e.code === "form_not_found")
        setSendError(t("cf_closed"));
      else if (isCmsRemoteError(e) && e.code !== "network" && e.code !== "http")
        setSendError(e.message);
      else setSendError(t("cf_send_failed"));
      return [];
    } finally {
      setSending(false);
    }
  };

  const addFiles = (field: FormField, picked: FileList | File[]) => {
    const list = [...picked];
    const max = field.maxFiles ?? 1;
    const have = (files[field.key] ?? []).filter(
      (x) => x.state !== "error",
    ).length;
    const accept = field.accept ?? FORM_DEFAULT_ACCEPT;
    const most = field.maxSize ?? FORM_DEFAULT_MAX_SIZE;
    const room = Math.max(0, max - have);
    if (list.length > room) {
      setErrors((cur) => ({
        ...cur,
        [field.key]: {
          field: field.key,
          code: "text",
          params: { text: t("cf_files_max", { n: max }) },
        },
      }));
      list.splice(room);
    } else setErrors(({ [field.key]: _gone, ...rest }) => rest);
    for (const file of list) {
      const id = uid();
      const bad = !formAccepts(accept, { name: file.name, mime: file.type })
        ? t("cf_file_type", { types: acceptText(accept, t) })
        : file.size > most
          ? t("cf_file_big", { size: fileSize(most) })
          : file.size === 0
            ? t("cf_file_empty")
            : null;
      const entry: CmsFormFile = {
        id,
        name: file.name,
        size: file.size,
        state: bad ? "error" : o.preview ? "done" : "uploading",
        progress: 0,
        error: bad ?? undefined,
      };
      setFiles((cur) => ({
        ...cur,
        [field.key]: [...(cur[field.key] ?? []), entry],
      }));
      if (bad || o.preview) continue;
      const patch = (p: Partial<CmsFormFile>) =>
        setFiles((cur) => ({
          ...cur,
          [field.key]: (cur[field.key] ?? []).map((x) =>
            x.id === id ? { ...x, ...p } : x,
          ),
        }));
      void (async () => {
        try {
          const g = await client.formUploadGrant(slug, {
            field: field.key,
            name: file.name,
            size: file.size,
            mime: file.type || undefined,
          });
          const sameOrigin = !g.put;
          const url = g.put
            ? g.put.url
            : `${baseUrl}/forms/${encodeURIComponent(slug)}/uploads/${encodeURIComponent(g.token)}`;
          const up = putFile(
            url,
            g.put
              ? g.put.headers
              : { "content-type": "application/octet-stream" },
            file,
            (progress) => patch({ progress }),
            sameOrigin,
          );
          aborts.current.set(id, up.abort);
          await up.done;
          aborts.current.delete(id);
          patch({ state: "done", progress: 1, token: g.token });
        } catch (e) {
          aborts.current.delete(id);
          if (e instanceof Error && e.message === "aborted") return;
          patch({
            state: "error",
            error:
              isCmsRemoteError(e) && e.status === 429
                ? t("cf_rate_limited", { s: e.retryAfter ?? 60 })
                : isCmsRemoteError(e) &&
                    e.code !== "network" &&
                    e.code !== "http"
                  ? e.message
                  : t("cf_file_failed"),
          });
        }
      })();
    }
  };
  const removeFile = (field: string, id: string) => {
    aborts.current.get(id)?.();
    aborts.current.delete(id);
    setFiles((cur) => ({
      ...cur,
      [field]: (cur[field] ?? []).filter((x) => x.id !== id),
    }));
    setErrors(({ [field]: _gone, ...rest }) => rest);
  };

  const reset = () => {
    setValues({});
    setFiles({});
    setErrors({});
    setAt(0);
    setSent(null);
    setSendError(null);
    setTrap("");
  };

  return {
    form,
    loading,
    loadError,
    reload: () => setTick((n) => n + 1),
    values,
    setValue,
    files,
    addFiles,
    removeFile,
    errors,
    shown,
    /** Indexes (into `form.steps`) of the steps shown now, and where we are among them. */
    order,
    pos,
    stepIndex,
    last,
    next,
    back,
    submit,
    sending,
    sendError,
    sent,
    reset,
    /** Bind to the hidden field (people never fill it; bots do). */
    trap: {
      name: form?.honeypot ?? "_website",
      value: trap,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setTrap(e.target.value),
    },
  };
}

/** "image/*, .pdf" as people read it: "Images, PDF". */
export function acceptText(accept: readonly string[], t: T): string {
  return accept
    .map((a) =>
      a === "image/*"
        ? t("cf_type_images")
        : a === "video/*"
          ? t("cf_type_videos")
          : a === "audio/*"
            ? t("cf_type_audio")
            : a.startsWith(".")
              ? a.slice(1).toUpperCase()
              : a.split("/").pop()!.toUpperCase(),
    )
    .join(", ");
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, "")} MB`;
}

/** A problem as a sentence. */
export function problemText(
  p: FormProblem | { code: "text"; params: { text: string } },
  t: T,
  fallback?: string,
): string {
  if (p.code === "text") return String(p.params.text);
  const q = p.params as Record<string, string | number>;
  switch (p.code) {
    case "form_required":
      return t("cf_err_required");
    case "form_length":
      return Number(q.min) > 0
        ? t("cf_err_length", { min: q.min, max: q.max })
        : t("cf_err_length_max", { max: q.max });
    case "form_email":
      return t("cf_err_email");
    case "form_number":
      return q.min !== "" && q.min != null && q.max !== "" && q.max != null
        ? t("cf_err_number_between", { min: q.min, max: q.max })
        : q.min !== "" && q.min != null
          ? t("cf_err_number_min", { min: q.min })
          : q.max !== "" && q.max != null
            ? t("cf_err_number_max", { max: q.max })
            : t("cf_err_number");
    case "form_option":
      return q.min || q.max
        ? t("cf_err_picks", { min: q.min || 0, max: q.max || "∞" })
        : t("cf_err_option");
    case "form_date":
      return q.min || q.max
        ? t("cf_err_date_range", { min: q.min || "…", max: q.max || "…" })
        : t("cf_err_date");
    case "form_pattern":
      return q.message ? String(q.message) : t("cf_err_pattern");
    case "form_file":
      return t("cf_files_max", { n: q.max });
  }
  return fallback ?? t("cf_err_invalid");
}

/** Fades and slides in once when it mounts (a field whose condition just started to hold). Skipped with reduced motion. */
function Reveal({ children, on }: { children: React.ReactNode; on: boolean }) {
  const [shown, setShown] = React.useState(!on);
  React.useEffect(() => {
    if (!on) return;
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [on]);
  return (
    <div
      className={cn(
        "transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
      )}
    >
      {children}
    </div>
  );
}

const CONTROL =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive";

/** The form, drawn: steps with progress, fields, errors, files, the result. */
export function CmsForm({
  slug,
  baseUrl,
  messages,
  t: given_t,
  form: given,
  preview,
  onSubmitted,
  fetch: f,
  className,
}: CmsFormProps) {
  const t = React.useMemo(
    () => given_t ?? createT(messages),
    [given_t, messages],
  );
  const s = useCmsForm(slug, { baseUrl, fetch: f, form: given, preview, t });
  const id = React.useId();
  const fid = (key: string) => `${id}-${key}`;
  const headingRef = React.useRef<HTMLElement | null>(null);
  const doneRef = React.useRef<HTMLDivElement>(null);
  const alertRef = React.useRef<HTMLDivElement>(null);
  const moved = React.useRef(false);
  // Fields that were there when this step was first drawn do not animate; fields that appear later do.
  const seen = React.useRef<Set<string>>(new Set());
  const firstPaint = React.useRef(true);

  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    headingRef.current?.focus();
  }, [s.pos]);
  React.useEffect(() => {
    if (s.sent) {
      doneRef.current?.focus();
      onSubmitted?.(s.sent);
    }
    // onSubmitted is the caller's; only a new result calls it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sent]);
  React.useEffect(() => {
    if (s.sendError) alertRef.current?.focus();
  }, [s.sendError]);
  React.useEffect(() => {
    if (s.form) firstPaint.current = false;
    for (const k of s.shown) seen.current.add(k);
  });

  const focusField = (keys: string[]) => {
    if (!keys.length || !s.form) return;
    const first = formFields(s.form.steps).find((x) => keys.includes(x.key));
    if (!first) return;
    // The step may change first: wait for it to draw.
    requestAnimationFrame(() =>
      document.getElementById(fid(first.key))?.focus(),
    );
  };

  if (s.loading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 py-8 text-sm text-muted-foreground",
          className,
        )}
        role="status"
      >
        <Loader2
          aria-hidden
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
        />
        {t("loading")}
      </div>
    );
  }
  if (!s.form) {
    const gone =
      isCmsRemoteError(s.loadError) && s.loadError.code === "form_not_found";
    return (
      <div
        className={cn(
          "flex flex-col items-start gap-3 rounded-lg border p-5 text-sm",
          className,
        )}
        role="alert"
      >
        <p className="font-medium">
          {gone ? t("cf_closed") : t("cf_load_failed")}
        </p>
        {gone ? null : (
          <Button type="button" variant="outline" size="sm" onClick={s.reload}>
            {t("retry")}
          </Button>
        )}
      </div>
    );
  }
  const form = s.form;
  if (s.sent) {
    return (
      <div
        ref={doneRef}
        tabIndex={-1}
        role="status"
        className={cn(
          "flex flex-col items-start gap-3 rounded-lg border p-6 outline-none",
          className,
        )}
      >
        <CheckCircle2
          aria-hidden
          className="h-6 w-6 text-emerald-600 dark:text-emerald-400"
        />
        <p className="text-base font-medium">
          {s.sent.message || t("cf_sent")}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={s.reset}>
          {t("cf_send_another")}
        </Button>
      </div>
    );
  }

  const step = form.steps[s.stepIndex];
  const many = s.order.length > 1;
  const fields = (step?.fields ?? []).filter((x) => s.shown.has(x.key));
  const errorOf = (key: string) =>
    s.errors[key] ? problemText(s.errors[key] as FormProblem, t) : null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s.last) {
      const bad = s.next();
      if (bad.length) focusField(bad);
      else moved.current = true;
      return;
    }
    focusField(await s.submit());
  };

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-labelledby={`${id}-title`}
      className={cn("relative flex flex-col gap-5", className)}
    >
      <div className="flex flex-col gap-2">
        {/* The honeypot: off screen, out of the tab order, hidden from screen readers, never filled by a browser. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "-10000px",
            top: "auto",
            width: 1,
            height: 1,
            overflow: "hidden",
          }}
        >
          <label>
            {t("cf_honeypot")}
            <input
              type="text"
              name={s.trap.name}
              value={s.trap.value}
              onChange={s.trap.onChange}
              tabIndex={-1}
              autoComplete="off"
            />
          </label>
        </div>
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {form.title}
        </h2>
        {many ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {t("cf_step_of", { n: s.pos + 1, total: s.order.length })}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={t("cf_progress")}
              aria-valuemin={1}
              aria-valuemax={s.order.length}
              aria-valuenow={s.pos + 1}
              aria-valuetext={t("cf_step_of", {
                n: s.pos + 1,
                total: s.order.length,
              })}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
                style={{ width: `${((s.pos + 1) / s.order.length) * 100}%` }}
              />
            </div>
          </div>
        ) : null}
        {many && step?.title ? (
          <h3
            ref={(el) => void (headingRef.current = el)}
            tabIndex={-1}
            className="text-base font-medium outline-none"
          >
            {step.title}
          </h3>
        ) : (
          <span
            ref={(el) => void (headingRef.current = el)}
            tabIndex={-1}
            className="sr-only"
          >
            {many
              ? t("cf_step_of", { n: s.pos + 1, total: s.order.length })
              : form.title}
          </span>
        )}
      </div>

      {form.enabled === false && !preview ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {t("cf_closed_admin")}
        </p>
      ) : null}

      {fields.map((field) => {
        const err = errorOf(field.key);
        const fresh =
          !firstPaint.current && !seen.current.has(field.key) && !!field.showIf;
        return (
          <Reveal key={field.key} on={fresh}>
            <FieldInput
              field={field}
              id={fid(field.key)}
              value={s.values[field.key]}
              onChange={(v) => s.setValue(field.key, v)}
              error={err}
              t={t}
              files={s.files[field.key] ?? []}
              onFiles={(l) => s.addFiles(field, l)}
              onRemoveFile={(fileId) => s.removeFile(field.key, fileId)}
              disabled={s.sending}
              uploads={form.uploads || !!preview}
            />
          </Reveal>
        );
      })}

      {s.sendError ? (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive outline-none"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{s.sendError}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {s.pos > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={s.sending}
            onClick={() => {
              moved.current = true;
              s.back();
            }}
          >
            {t("cf_back")}
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={s.sending}
          aria-busy={s.sending || undefined}
          className="min-w-24 gap-1.5"
        >
          {s.sending ? (
            <Loader2
              aria-hidden
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {s.last ? (s.sending ? t("cf_sending") : t("cf_send")) : t("cf_next")}
        </Button>
        {preview ? (
          <span className="text-xs text-muted-foreground">
            {t("cf_preview_note")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function FieldInput({
  field,
  id,
  value,
  onChange,
  error,
  t,
  files,
  onFiles,
  onRemoveFile,
  disabled,
  uploads,
}: {
  field: FormField;
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  error: string | null;
  t: T;
  files: CmsFormFile[];
  onFiles: (l: FileList) => void;
  onRemoveFile: (id: string) => void;
  disabled: boolean;
  uploads: boolean;
}) {
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const described =
    [field.help ? helpId : null, error ? errId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": described,
    "aria-required": field.required || undefined,
    disabled,
  } as const;
  const label = (
    <>
      {field.label}
      {field.required ? (
        <span aria-hidden className="ml-0.5 text-destructive">
          *
        </span>
      ) : (
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          {t("cf_optional")}
        </span>
      )}
    </>
  );
  const foot = (
    <>
      {field.help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {field.help}
        </p>
      ) : null}
      {error ? (
        <p
          id={errId}
          className="flex items-center gap-1 text-xs font-medium text-destructive"
        >
          <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </>
  );
  const str =
    typeof value === "string" || typeof value === "number" ? String(value) : "";

  if (field.kind === "checkbox") {
    return (
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={id}
          className="flex min-h-10 cursor-pointer items-start gap-2.5 text-sm"
        >
          <input
            type="checkbox"
            {...common}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          />
          <span>{label}</span>
        </label>
        {foot}
      </div>
    );
  }
  if (field.kind === "multiselect") {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="flex flex-col gap-1.5" aria-describedby={described}>
        <legend className="mb-1 text-sm font-medium">{label}</legend>
        <div className="flex flex-col gap-1">
          {(field.options ?? []).map((o, i) => (
            <label
              key={o.value}
              className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm"
            >
              <input
                type="checkbox"
                id={i === 0 ? id : undefined}
                disabled={disabled}
                checked={picked.includes(o.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...picked, o.value]
                      : picked.filter((x) => x !== o.value),
                  )
                }
                className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
              />
              {o.label}
            </label>
          ))}
        </div>
        {foot}
      </fieldset>
    );
  }
  if (field.kind === "file") {
    const room =
      (field.maxFiles ?? 1) - files.filter((x) => x.state !== "error").length;
    const accept = field.accept ?? FORM_DEFAULT_ACCEPT;
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {uploads ? (
          <>
            <label
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground focus-within:ring-2 focus-within:ring-ring hover:bg-accent/50",
                (room <= 0 || disabled) && "cursor-not-allowed opacity-60",
                error && "border-destructive",
              )}
            >
              <Paperclip aria-hidden className="h-4 w-4 shrink-0" />
              <span className="flex-1">
                {room <= 0
                  ? t("cf_files_full", { n: field.maxFiles ?? 1 })
                  : t("cf_file_pick")}
              </span>
              <span className="text-xs">
                {t("cf_file_limits", {
                  types: acceptText(accept, t),
                  size: fileSize(field.maxSize ?? FORM_DEFAULT_MAX_SIZE),
                })}
              </span>
              <input
                type="file"
                {...common}
                disabled={disabled || room <= 0}
                multiple={(field.maxFiles ?? 1) > 1}
                accept={accept.join(",")}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) onFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            {files.length ? (
              <ul
                className="flex flex-col gap-1.5"
                aria-label={t("cf_files_list", { label: field.label })}
              >
                {files.map((x) => (
                  <li
                    key={x.id}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border px-3 py-2 text-sm",
                      x.state === "error" && "border-destructive/50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <FileText
                        aria-hidden
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate" title={x.name}>
                        {x.name}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {x.state === "uploading"
                          ? `${Math.round(x.progress * 100)}%`
                          : fileSize(x.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemoveFile(x.id)}
                        disabled={disabled}
                        aria-label={t("cf_file_remove", { name: x.name })}
                        className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X aria-hidden className="h-4 w-4" />
                      </button>
                    </div>
                    {x.state === "uploading" ? (
                      <div
                        className="h-1 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-label={t("cf_file_uploading", { name: x.name })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(x.progress * 100)}
                      >
                        <div
                          className="h-full bg-primary transition-[width] duration-150 ease-out motion-reduce:transition-none"
                          style={{ width: `${Math.round(x.progress * 100)}%` }}
                        />
                      </div>
                    ) : null}
                    {x.state === "error" ? (
                      <p className="text-xs text-destructive">{x.error}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p id={id} className="text-sm text-muted-foreground">
            {t("cf_uploads_off")}
          </p>
        )}
        {foot}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {field.kind === "textarea" ? (
        <Textarea
          {...common}
          className={cn(
            error && "border-destructive focus-visible:ring-destructive/40",
          )}
          value={str}
          placeholder={field.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value)}
          rows={5}
          maxLength={typeof field.max === "number" ? field.max : 10_000}
        />
      ) : field.kind === "select" ? (
        <NativeSelect
          {...common}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            CONTROL,
            error && "border-destructive focus-visible:ring-destructive/40",
          )}
        >
          <option value="">{field.placeholder || t("cf_choose")}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          {...common}
          type={
            field.kind === "email"
              ? "email"
              : field.kind === "number"
                ? "number"
                : field.kind === "date"
                  ? "date"
                  : "text"
          }
          inputMode={
            field.kind === "number"
              ? "decimal"
              : field.kind === "email"
                ? "email"
                : undefined
          }
          autoComplete={
            field.kind === "email"
              ? "email"
              : field.key === "name"
                ? "name"
                : field.key === "phone" || field.key === "tel"
                  ? "tel"
                  : undefined
          }
          value={str}
          placeholder={field.placeholder ?? undefined}
          min={
            field.kind === "number" || field.kind === "date"
              ? (field.min ?? undefined)
              : undefined
          }
          max={
            field.kind === "number" || field.kind === "date"
              ? (field.max ?? undefined)
              : undefined
          }
          maxLength={
            field.kind === "text" || field.kind === "email"
              ? typeof field.max === "number"
                ? field.max
                : 500
              : undefined
          }
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-10",
            error && "border-destructive focus-visible:ring-destructive/40",
          )}
        />
      )}
      {foot}
    </div>
  );
}
