/**
 * Forms (0.22.0): a contact form, a sign-up, a bug report. Admins build them on a screen (fields,
 * steps, conditions); the app shows them with the copied `cms-form` component or from
 * `GET /forms/:slug`; people send them to `POST /forms/:slug`.
 *
 *   createCms({ forms: true, media: { stores: { private: { visibility: "private", adapter } } } })
 *   createCms({ forms: { perMinute: 5, verify: (req) => checkCaptcha(req), notify: (e) => sendMail(e) } })
 *
 * Where things live: a form is a record (`cms_records`, kind `form`, key = its address), a
 * submission a row of `cms_form_submissions`. Files go to the first private media store under
 * `_cms/forms/`; the browser asks for a one-time upload grant per file first. The sender's
 * address is kept as a keyed hash only, to count and to tell repeat senders apart.
 *
 * Spam: a hidden field (the honeypot) that people never see; a submission that fills it is kept
 * as spam and answered like any other. One address may send `perMinute` (5) a minute; the next
 * one gets 429. `verify(req, { values, raw })` is where an app checks a captcha: `raw` holds every
 * field sent (a captcha token too), `req` is a fresh copy of the request. The body is at most 64 KB.
 * Which address is "one address" comes from `clientIp` (see `FormsOptions.clientIp`).
 *
 * Submissions are personal data: agents get no tools for them, events carry no values unless
 * `eventValues: true`, and `retention.submissionsDays` (default 365) deletes old ones.
 */
import type {
  CmsErrorCode,
  CmsErrorOptions,
  Diagnostic,
  ErrorParams,
} from "./errors";
import type { CmsRepo } from "./repo";
import type { StorageAdapter } from "./storage";
import { cleanName, contentMatches, declaredMatches, mimeOf } from "./storage";
import {
  base64url,
  fromBase64url,
  fromUtf8,
  hex,
  hmacSha256,
  randomBytes,
  timingSafeEqual,
  utf8,
} from "./crypto";
import {
  checkSubmission,
  definitionIssues,
  displayValue,
  formIssueText,
  type FormDefinitionIssue,
  FORM_DEFAULT_ACCEPT,
  FORM_DEFAULT_MAX_SIZE,
  formAccepts,
  formFields,
  type FormField,
  type FormFileValue,
  type FormProblem,
  type FormStep,
} from "./form-rules";
import type {
  Actor,
  AuditAction,
  CmsRecord,
  FormSubmission,
  FormSubmissionStatus,
} from "./types";

export const FORM_STATUSES: readonly FormSubmissionStatus[] = [
  "new",
  "read",
  "spam",
  "archived",
];
/** The hidden field: a name no form field can have (field keys start with a letter). */
export const FORM_HONEYPOT = "_website";
/** Largest body of a submission. */
export const FORM_MAX_BODY = 64 * 1024;
const KIND = "form";
const SECRET_META = "forms_secret";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GRANT_SECONDS = 600;
/** One record per upload grant (`cms_records`, kind `form_upload`, key = the grant id, scope = the form id). */
const UPLOAD_KIND = "form_upload";
const TMP = "_cms/forms/_tmp/";
const LINK_SECONDS = 300;
const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

export interface FormsOptions {
  /** The private media store files go to. Default: the first private store. Without one, file fields are refused. */
  store?: string;
  /** Submissions one address may send a minute (to all forms together). Default 5. */
  perMinute?: number;
  /**
   * Called for every submission before it is kept (a captcha, a blocklist). Return false to refuse
   * it (403 `form_verify_failed`).
   *
   * - `ctx.raw`: everything that was sent, parsed (JSON, urlencoded or multipart), fields the form
   *   does not declare included: read a captcha token here (`ctx.raw["cf-turnstile-response"]`).
   * - `ctx.values`: the declared fields, checked.
   * - `req`: a copy of the request whose body can still be read (at most 64 KB); null when the CMS
   *   is called directly, not over HTTP.
   */
  verify?: (
    req: Request | null,
    ctx: {
      form: FormView;
      values: Record<string, unknown>;
      raw: Record<string, unknown>;
    },
  ) => boolean | Promise<boolean>;
  /**
   * The sender's address for the per-minute limit and the repeat-sender hash. Default: the
   * handler's `clientIp`, else the first `X-Forwarded-For` entry. Behind a proxy that APPENDS to
   * `X-Forwarded-For` (most load balancers) the first entry is whatever the sender wrote: use
   * `clientIpBehind(1)` (one proxy) or your own function. The Node adapter without `trustProxy`
   * already puts the socket's address there.
   */
  clientIp?: (req: Request) => string | null;
  /** Called after a submission is kept (not for spam): send an e-mail, post to a chat. Errors are reported, never shown to the sender. */
  notify?: (e: FormNotice) => void | Promise<void>;
  /** Put the submitted values into the `form.submitted` event (webhooks, automations, the change log). Default false: ids only. */
  eventValues?: boolean;
}

export interface FormSettings {
  /** Shown after sending. */
  successMessage: string;
  /** Who `notify` should tell (e-mail addresses; the app does the sending). */
  notify: string[];
  /** Keep this form's submissions fewer days than `retention.submissionsDays`. Null: that rule. */
  keepDays: number | null;
  /** A plain HTML form (no script) is sent here after it is kept. Null: a short page with `successMessage`. */
  redirectUrl: string | null;
}

export interface FormView {
  id: string;
  slug: string;
  title: string;
  /** Off: the public address answers 404 and nothing can be sent. */
  enabled: boolean;
  steps: FormStep[];
  settings: FormSettings;
  /** Goes up when the fields change. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Admin answers only (list, definition, create, update): can file fields take files on this
   * server (a private media store is set)? When false, a form with a required file field cannot be
   * turned on (`form_uploads_unavailable`).
   */
  uploads?: boolean;
}

export interface FormCounts {
  new: number;
  read: number;
  spam: number;
  archived: number;
}

export interface FormListItem extends FormView {
  counts: FormCounts;
  /** The newest submission that is not spam. */
  lastAt: string | null;
}

/** What a page needs to draw the form (`GET /forms/:slug`). */
export interface PublicForm {
  slug: string;
  title: string;
  steps: FormStep[];
  successMessage: string;
  version: number;
  /** The hidden field's name: leave it empty. */
  honeypot: string;
  /** False when file fields cannot take files on this server (no private store). */
  uploads: boolean;
  /** Only when an admin looks at a form that is off. */
  enabled?: boolean;
}

export interface FormInput {
  slug?: string;
  title?: string;
  enabled?: boolean;
  steps?: FormStep[];
  settings?: Partial<FormSettings>;
}

export type FormSubmissionView = Omit<FormSubmission, "files" | "ipHash"> & {
  files: (FormFileValue & { field: string })[];
  formSlug: string;
};

export interface FormNotice {
  form: FormView;
  submission: FormSubmissionView;
  /** `settings.notify` of the form. */
  to: string[];
  /** Field label → value as people read it, in the form's order. */
  lines: { key: string; label: string; value: string }[];
}

export interface UploadGrant {
  /** Put it in the field's value when sending the form. */
  token: string;
  /** Upload straight to storage (PUT with these headers). Null: PUT the bytes to `/forms/:slug/uploads/:token`. */
  put: { url: string; headers: Record<string, string> } | null;
  expiresAt: string;
}

export interface SubmitMeta {
  ip?: string | null;
  userAgent?: string | null;
  /** A copy of the request with its body still unread (what `verify` gets). */
  request?: Request | null;
}

export interface FormsContext {
  repo: CmsRepo;
  now: () => Date;
  fail: (
    code: CmsErrorCode,
    params?: ErrorParams,
    o?: CmsErrorOptions,
  ) => Error;
  audit: (
    actor: Actor,
    action: AuditAction,
    detail: Record<string, unknown>,
  ) => void;
  isAdmin: (actor: Actor) => boolean;
  /** A role's word on the `forms` target. */
  allows: (
    actor: Actor,
    op: "read" | "write" | "delete",
  ) => boolean | undefined;
  ready: () => Promise<void> | void;
  report: (err: unknown, where: string) => void;
  /** Null: forms are off. */
  options: FormsOptions | null;
  storage: () => { name: string; adapter: StorageAdapter } | null;
  limit: (
    bucket: string,
    perMinute: number,
  ) => Promise<{ ok: boolean; retryAfter: number; limit: number }>;
  emit: (detail: Record<string, unknown>) => void;
  message: (code: CmsErrorCode, params?: ErrorParams) => string;
}

type FormData0 = Omit<FormView, "id" | "createdAt" | "updatedAt">;

/** CSV text: quoted where needed, and cells a spreadsheet would run as a formula start with `'`. */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || s !== s.trim()
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function createForms(ctx: FormsContext) {
  const { repo, fail } = ctx;
  const on = () => ctx.options !== null;
  const iso = () => ctx.now().toISOString();
  let secret: Uint8Array | null = null;

  function need() {
    if (!on()) throw fail("forms_off");
  }
  /**
   * `form_invalid` with the first problem as a code (`issue`, `field`, `step`, `value`) so each
   * language words it; `reason` is the English text (kept for older clients), `more` how many
   * other problems there are. Every problem is also a diagnostic.
   */
  function invalid(list: FormDefinitionIssue | FormDefinitionIssue[]): Error {
    const all = Array.isArray(list) ? list : [list];
    const [first] = all;
    const params: ErrorParams = {
      reason: formIssueText(first),
      issue: first.issue,
      ...(first.field !== undefined ? { field: first.field } : {}),
      ...(first.step !== undefined ? { step: first.step } : {}),
      ...(first.value !== undefined ? { value: first.value } : {}),
      ...(all.length > 1 ? { more: all.length - 1 } : {}),
    };
    const diagnostics: Diagnostic[] = all.map((i) => {
      const p: ErrorParams = {
        reason: formIssueText(i),
        issue: i.issue,
        ...(i.field !== undefined ? { field: i.field } : {}),
        ...(i.step !== undefined ? { step: i.step } : {}),
        ...(i.value !== undefined ? { value: i.value } : {}),
      };
      return {
        path: i.field ?? (i.step !== undefined ? `step ${i.step}` : ""),
        code: "form_invalid",
        params: p,
        message: ctx.message("form_invalid", p),
        severity: "error",
      };
    });
    return fail("form_invalid", params, { diagnostics });
  }
  /** A form that is on cannot have a required file field when this server takes no files. */
  function needUploads(enabled: boolean, steps: readonly FormStep[]) {
    if (!enabled || storage()) return;
    const f = formFields(steps).find((x) => x.kind === "file" && x.required);
    if (f) throw fail("form_uploads_unavailable", { field: f.key });
  }
  /** An instant later than `prev`, so a compare-and-swap on `updatedAt` always sees a change. */
  function after(prev: string): string {
    const t = Math.max(ctx.now().getTime(), Date.parse(prev) + 1);
    return new Date(t).toISOString();
  }
  async function ready() {
    need();
    await ctx.ready();
  }
  async function key(): Promise<Uint8Array> {
    if (secret) return secret;
    const got = await repo.getMeta(SECRET_META);
    if (typeof got === "string" && got.length >= 32)
      return (secret = utf8(got));
    const fresh = hex(randomBytes(32));
    await repo.setMeta(SECRET_META, fresh);
    // Two servers starting at once: whoever wrote last wins, and both read that one back.
    const now = await repo.getMeta(SECRET_META);
    return (secret = utf8(typeof now === "string" ? now : fresh));
  }

  const can = {
    read: (a: Actor) =>
      ctx.isAdmin(a) ||
      ctx.allows(a, "read") === true ||
      ctx.allows(a, "write") === true,
    write: (a: Actor) => ctx.isAdmin(a) || ctx.allows(a, "write") === true,
    delete: (a: Actor) => ctx.isAdmin(a) || ctx.allows(a, "delete") === true,
  };
  function must(actor: Actor, op: "read" | "write" | "delete") {
    need();
    if (!can[op](actor))
      throw fail(
        actor.kind === "anonymous" ? "unauthorized" : "forbidden_forms",
      );
  }

  const view = (r: CmsRecord): FormView => {
    const d = r.data as unknown as FormData0;
    return {
      id: r.id,
      slug: d.slug,
      title: d.title,
      enabled: !!d.enabled,
      steps: d.steps ?? [],
      settings: {
        ...{
          successMessage: "",
          notify: [] as string[],
          keepDays: null as number | null,
          redirectUrl: null as string | null,
        },
        ...(d.settings ?? {}),
      },
      version: d.version ?? 1,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  };
  async function find(slug: string): Promise<FormView | null> {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
    const r = await repo.findRecordByKey(KIND, slug);
    return r ? view(r) : null;
  }
  async function found(slug: string): Promise<FormView> {
    const f = await find(slug);
    if (!f) throw fail("form_not_found", { slug });
    return f;
  }

  /** Keep only what a definition may hold (unknown keys go), then check it. */
  function cleanSteps(steps: unknown): FormStep[] {
    if (!Array.isArray(steps)) throw invalid({ issue: "steps_list" });
    const str = (v: unknown, max: number) =>
      typeof v === "string" ? v.slice(0, max) : undefined;
    const out: FormStep[] = steps.map((s0) => {
      const s = (s0 ?? {}) as Record<string, unknown>;
      const fields = Array.isArray(s.fields) ? s.fields : [];
      return {
        title: str(s.title, 200) ?? "",
        fields: fields.map((f0) => {
          const f = (f0 ?? {}) as Record<string, unknown>;
          const field: FormField = {
            key: String(f.key ?? ""),
            label: String(f.label ?? ""),
            kind: f.kind as FormField["kind"],
          };
          if (f.required === true) field.required = true;
          const help = str(f.help, 600);
          if (help) field.help = help;
          const ph = str(f.placeholder, 200);
          if (ph) field.placeholder = ph;
          if (field.kind === "select" || field.kind === "multiselect")
            field.options = Array.isArray(f.options)
              ? (f.options as { value?: unknown; label?: unknown }[]).map(
                  (o) => ({
                    value: String(o?.value ?? "").trim(),
                    label: String(o?.label ?? "").trim(),
                  }),
                )
              : [];
          for (const k of ["min", "max"] as const) {
            const v = f[k];
            if (typeof v === "number" && Number.isFinite(v)) field[k] = v;
            else if (typeof v === "string" && v.trim())
              field[k] = /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
                ? v.trim()
                : Number.isFinite(Number(v))
                  ? Number(v)
                  : undefined;
          }
          const pattern = str(f.pattern, 400);
          if (pattern) field.pattern = pattern;
          const pm = str(f.patternMessage, 200);
          if (pm && pattern) field.patternMessage = pm;
          if (field.kind === "file") {
            if (Array.isArray(f.accept))
              field.accept = (f.accept as unknown[])
                .map((a) => String(a).trim())
                .filter(Boolean);
            if (typeof f.maxSize === "number") field.maxSize = f.maxSize;
            if (typeof f.maxFiles === "number") field.maxFiles = f.maxFiles;
          }
          const c = f.showIf as Record<string, unknown> | null | undefined;
          if (
            c &&
            typeof c === "object" &&
            typeof c.field === "string" &&
            c.field
          ) {
            const v = c.value;
            field.showIf = {
              field: c.field,
              op: c.op as NonNullable<FormField["showIf"]>["op"],
              ...(v === undefined || v === null
                ? {}
                : {
                    value: Array.isArray(v)
                      ? v.map(String)
                      : typeof v === "number" || typeof v === "boolean"
                        ? v
                        : String(v),
                  }),
            };
          }
          return field;
        }),
      };
    });
    const problems = definitionIssues(out);
    if (problems.length) throw invalid(problems);
    return out;
  }
  function cleanSettings(
    s: Partial<FormSettings> | undefined,
    cur: FormSettings,
  ): FormSettings {
    const next = { ...cur };
    if (!s) return next;
    if (s.successMessage !== undefined) {
      if (
        typeof s.successMessage !== "string" ||
        s.successMessage.length > 1000
      )
        throw invalid({ issue: "success_message" });
      next.successMessage = s.successMessage.trim();
    }
    if (s.notify !== undefined) {
      const list = (Array.isArray(s.notify) ? s.notify : [])
        .map((x) => String(x).trim())
        .filter(Boolean);
      const bad = list.find((x) => !EMAIL_RE.test(x) || x.length > 254);
      if (bad || list.length > 20)
        throw invalid(
          bad
            ? { issue: "notify_email", value: bad }
            : { issue: "notify_count" },
        );
      next.notify = [...new Set(list)];
    }
    if (s.keepDays !== undefined) {
      if (
        s.keepDays !== null &&
        (!Number.isInteger(s.keepDays) || s.keepDays < 1 || s.keepDays > 3650)
      )
        throw invalid({ issue: "keep_days" });
      next.keepDays = s.keepDays;
    }
    if (s.redirectUrl !== undefined) {
      const u = s.redirectUrl === null ? "" : String(s.redirectUrl).trim();
      if (u && !/^(https?:\/\/[^\s]+|\/[^\s/][^\s]*|\/)$/.test(u))
        throw invalid({ issue: "redirect" });
      next.redirectUrl = u || null;
    }
    return next;
  }

  async function counts(): Promise<
    Map<string, { counts: FormCounts; lastAt: string | null }>
  > {
    const out = new Map<
      string,
      { counts: FormCounts; lastAt: string | null }
    >();
    for (const r of (await repo.formSubmissionCounts?.()) ?? []) {
      const cur = out.get(r.formId) ?? {
        counts: { new: 0, read: 0, spam: 0, archived: 0 },
        lastAt: null,
      };
      if (r.status in cur.counts) cur.counts[r.status] += r.n;
      if (r.status !== "spam" && (!cur.lastAt || r.last > cur.lastAt))
        cur.lastAt = r.last;
      out.set(r.formId, cur);
    }
    return out;
  }

  function storage() {
    return on() ? ctx.storage() : null;
  }
  /** What people who manage forms see: the form and whether it can take files here. */
  const adminView = (r: CmsRecord): FormView => ({
    ...view(r),
    uploads: !!storage(),
  });
  const subView = (s: FormSubmission, slug: string): FormSubmissionView => {
    const { ipHash: _ip, files, ...rest } = s;
    return {
      ...rest,
      formSlug: slug,
      files: files.map(({ key: _k, ...f }) => f),
    };
  };

  // ── upload grants ───────────────────────────────────────────────────────────
  //
  // Each grant is a record (kind `form_upload`): issued → (uploaded through the CMS) → claimed by a
  // submission (one compare-and-swap, so of two submissions with one token exactly one gets it) →
  // done. A direct (presigned) PUT goes to the record's own temporary key; only that key is ever
  // read back, and only while the record is not claimed. A failed submission gives its claims back
  // (the token works again until it expires); anything left over goes with the daily sweep.

  interface Grant {
    f: string; // form id
    g: string; // grant record key
    e: number; // expires (ms)
  }
  type GrantStatus = "issued" | "uploaded" | "claimed" | "done";
  interface GrantData {
    status: GrantStatus;
    field: string;
    tmp: string;
    size: number;
    mime: string;
    name: string;
    expires: number;
    /** While claimed or done: where the file went, and its id in the submission. */
    to?: string;
    fileId?: string;
    /** Status before the claim (given back when the submission fails). */
    prev?: GrantStatus;
    /** Permanent copies a failed submission could not delete: the sweep deletes them. */
    orphans?: string[];
  }
  async function sign(g: Grant): Promise<string> {
    const body = base64url(JSON.stringify(g));
    return `${body}.${base64url(hmacSha256(await key(), body))}`;
  }
  async function opened(
    token: unknown,
    form: FormView,
  ): Promise<{ rec: CmsRecord; d: GrantData }> {
    const bad = (reason: string) => fail("form_upload_invalid", { reason });
    if (typeof token !== "string" || token.length > 2000) throw bad("token");
    const [body, mac] = token.split(".");
    if (
      !body ||
      !mac ||
      !timingSafeEqual(base64url(hmacSha256(await key(), body)), mac)
    )
      throw bad("token");
    let g: Grant;
    try {
      g = JSON.parse(fromUtf8(fromBase64url(body))) as Grant;
    } catch {
      throw bad("token");
    }
    if (g.f !== form.id || typeof g.g !== "string") throw bad("token");
    if (g.e < ctx.now().getTime()) throw bad("expired");
    const rec = await repo.findRecordByKey(UPLOAD_KIND, g.g);
    if (!rec || rec.scope !== form.id) throw bad("token");
    const d = rec.data as unknown as GrantData;
    if (d.status === "claimed" || d.status === "done") throw bad("used");
    return { rec, d };
  }
  /** Compare and swap a grant record; null when someone else changed it first. */
  async function swapGrant(
    rec: CmsRecord,
    d: GrantData,
  ): Promise<CmsRecord | null> {
    return repo.updateRecord(UPLOAD_KIND, rec.id, {
      data: d as unknown as Record<string, unknown>,
      at: after(rec.updatedAt),
      ifUpdatedAt: rec.updatedAt,
    });
  }

  /**
   * The daily sweep: uploads never sent, permanent copies a failed submission left, and grant
   * records older than a day. A claimed grant whose submission never got saved (the server
   * stopped in between) has its copy deleted unless a submission holds that file.
   */
  async function sweepUploads(): Promise<number> {
    const st = storage();
    if (!st) return 0;
    let n = 0;
    const cut = ctx.now().getTime() - DAY;
    const del = (k: string) =>
      st.adapter.delete(k).then(
        () => true,
        (e) => (ctx.report(e, "forms: old upload"), false),
      );
    for (let page = 0; page < 20; page++) {
      const recs = await repo.listRecords({
        kind: UPLOAD_KIND,
        before: new Date(cut).toISOString(),
        order: "asc",
        limit: 200,
      });
      let kept = 0;
      for (const r of recs) {
        const d = r.data as unknown as GrantData;
        let ok = true;
        if (d.tmp) ok = (await del(d.tmp)) && ok;
        for (const k of d.orphans ?? []) ok = (await del(k)) && ok;
        if (d.status === "claimed" && d.to && d.fileId && repo.listFormSubmissions) {
          const held = await repo.listFormSubmissions({
            formId: r.scope,
            statuses: FORM_STATUSES,
            q: d.fileId,
            limit: 1,
          });
          if (!held.total) ok = (await del(d.to)) && ok;
        }
        if (ok) {
          await repo.deleteRecords({ kind: UPLOAD_KIND, id: r.id });
          n++;
        } else kept++;
      }
      if (recs.length < 200 || kept === recs.length) break;
    }
    // Objects under the temporary prefix with no record (older versions, lost records).
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const list = await st.adapter.list({ prefix: TMP, cursor, limit: 500 });
      for (const o of list.objects) {
        const at = o.lastModified ? Date.parse(o.lastModified) : 0;
        if (at && at < cut) {
          await del(o.key);
          n++;
        }
      }
      cursor = list.cursor;
      if (!cursor) break;
    }
    return n;
  }
  /**
   * Delete the files of these submissions. Returns the ids whose files are all gone: only those
   * rows may go, the others are tried again on the next run.
   */
  async function dropFiles(rows: readonly FormSubmission[]): Promise<string[]> {
    const st = storage() ?? ctx.storage();
    const ok: string[] = [];
    for (const r of rows) {
      if (!r.files.length) {
        ok.push(r.id);
        continue;
      }
      // No store any more: nothing can be deleted there; the row (personal data) still goes.
      if (!st) {
        ctx.report(
          new Error("forms: submission files with no private store to delete them from"),
          "forms: delete file",
        );
        ok.push(r.id);
        continue;
      }
      let all = true;
      for (const f of r.files)
        await st.adapter.delete(f.key).catch((e) => {
          all = false;
          ctx.report(e, "forms: delete file");
        });
      if (all) ok.push(r.id);
    }
    return ok;
  }
  /**
   * Delete submissions and their files: files first, then the rows whose files are gone. A row
   * whose file could not be deleted stays (and is tried again by the next retention run).
   */
  async function purge(q: {
    ids?: readonly string[];
    formId?: string;
    before?: string;
  }): Promise<FormSubmission[]> {
    if (!repo.deleteFormSubmissions) return [];
    const out: FormSubmission[] = [];
    if (!repo.selectFormSubmissions) {
      // A repo written before 0.22.0's select: rows first, as before.
      for (let i = 0; i < 100; i++) {
        const gone = await repo.deleteFormSubmissions({ ...q, limit: 500 });
        await dropFiles(gone);
        out.push(...gone);
        if (gone.length < 500) break;
      }
      return out;
    }
    let stuck = 0;
    for (let i = 0; i < 100; i++) {
      const rows = await repo.selectFormSubmissions({
        ...q,
        limit: 500,
        offset: stuck,
      });
      const ok = await dropFiles(rows);
      stuck += rows.length - ok.length;
      if (ok.length)
        out.push(...(await repo.deleteFormSubmissions({ ids: ok })));
      if (rows.length < 500) break;
    }
    return out;
  }

  const api = {
    enabled: on,
    honeypot: FORM_HONEYPOT,
    can: (actor: Actor) =>
      on() && can.read(actor)
        ? {
            read: true,
            write: can.write(actor),
            delete: can.delete(actor),
            /** File fields can take files on this server (a private media store is set). */
            uploads: !!storage(),
          }
        : null,
    uploadsReady: () => !!storage(),
    /** `FormsOptions.clientIp`, when the app gave one. */
    clientIp: (req: Request): string | null | undefined =>
      ctx.options?.clientIp ? ctx.options.clientIp(req) : undefined,

    // ── admin ──
    async list(actor: Actor): Promise<FormListItem[]> {
      must(actor, "read");
      await ready();
      const [rows, c] = await Promise.all([
        repo.listRecords({ kind: KIND, order: "asc", limit: 500 }),
        counts(),
      ]);
      return rows.map((r) => {
        const v = adminView(r);
        const x = c.get(v.id);
        return {
          ...v,
          counts: x?.counts ?? { new: 0, read: 0, spam: 0, archived: 0 },
          lastAt: x?.lastAt ?? null,
        };
      });
    },
    async get(actor: Actor, slug: string): Promise<FormView> {
      must(actor, "read");
      await ready();
      return { ...(await found(slug)), uploads: !!storage() };
    },
    async create(actor: Actor, input: FormInput): Promise<FormView> {
      must(actor, "write");
      await ready();
      const slug = String(input.slug ?? "")
        .trim()
        .toLowerCase();
      if (!SLUG_RE.test(slug)) throw invalid({ issue: "slug" });
      const title = String(input.title ?? "").trim();
      if (!title || title.length > 120) throw invalid({ issue: "title" });
      if (await find(slug)) throw fail("form_slug_taken", { slug });
      const steps = cleanSteps(
        input.steps ?? [
          {
            title: "",
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "email", label: "Email", kind: "email", required: true },
              {
                key: "message",
                label: "Message",
                kind: "textarea",
                required: true,
              },
            ],
          },
        ],
      );
      const data: FormData0 = {
        slug,
        title,
        enabled: input.enabled === true,
        steps,
        settings: cleanSettings(input.settings, {
          successMessage: "",
          notify: [],
          keepDays: null,
          redirectUrl: null,
        }),
        version: 1,
      };
      needUploads(data.enabled, steps);
      let r: CmsRecord;
      try {
        r = await repo.insertRecord({
          kind: KIND,
          key: slug,
          data: data as unknown as Record<string, unknown>,
          at: iso(),
        });
      } catch {
        throw fail("form_slug_taken", { slug });
      }
      ctx.audit(actor, "form.create", { form: slug });
      return adminView(r);
    },
    async update(
      actor: Actor,
      slug: string,
      input: FormInput & {
        expectedVersion?: number;
        expectedUpdatedAt?: string;
      },
    ): Promise<FormView> {
      must(actor, "write");
      await ready();
      const rec = await repo.findRecordByKey(KIND, slug);
      if (!rec) throw fail("form_not_found", { slug });
      const cur = view(rec);
      // Two people editing one form: the second save is refused instead of silently undoing the first.
      if (
        input.expectedUpdatedAt &&
        Date.parse(input.expectedUpdatedAt) !== Date.parse(cur.updatedAt)
      )
        throw fail("form_conflict", { slug });
      const next: FormData0 = {
        slug: cur.slug,
        title: cur.title,
        enabled: cur.enabled,
        steps: cur.steps,
        settings: cur.settings,
        version: cur.version,
      };
      if (input.slug !== undefined && input.slug !== cur.slug) {
        const s = String(input.slug).trim().toLowerCase();
        if (!SLUG_RE.test(s)) throw invalid({ issue: "slug" });
        if (await find(s)) throw fail("form_slug_taken", { slug: s });
        next.slug = s;
      }
      if (input.title !== undefined) {
        const t = String(input.title).trim();
        if (!t || t.length > 120) throw invalid({ issue: "title" });
        next.title = t;
      }
      if (input.enabled !== undefined) next.enabled = input.enabled === true;
      if (input.steps !== undefined) {
        next.steps = cleanSteps(input.steps);
        if (JSON.stringify(next.steps) !== JSON.stringify(cur.steps))
          next.version = cur.version + 1;
      }
      next.settings = cleanSettings(input.settings, cur.settings);
      needUploads(next.enabled, next.steps);
      // Compare and swap on the row's updatedAt: of two saves that read the same form, one wins
      // and the other gets form_conflict (no lost edit, no version number used twice).
      let r: CmsRecord | null;
      try {
        r = await repo.updateRecord(KIND, rec.id, {
          data: next as unknown as Record<string, unknown>,
          key: next.slug,
          at: after(rec.updatedAt),
          ifUpdatedAt: rec.updatedAt,
        });
      } catch (e) {
        // The unique (kind, key) index: another form took the new address meanwhile.
        if (next.slug !== cur.slug && (await find(next.slug)))
          throw fail("form_slug_taken", { slug: next.slug });
        throw e;
      }
      if (!r) {
        if (!(await repo.findRecord(KIND, rec.id)))
          throw fail("form_not_found", { slug });
        throw fail("form_conflict", { slug });
      }
      ctx.audit(actor, "form.update", {
        form: next.slug,
        ...(next.slug !== cur.slug ? { from: cur.slug } : {}),
        ...(next.enabled !== cur.enabled ? { enabled: next.enabled } : {}),
        ...(next.version !== cur.version ? { version: next.version } : {}),
      });
      return adminView(r);
    },
    /** Deletes the form with its submissions and their files. */
    async remove(actor: Actor, slug: string): Promise<{ submissions: number }> {
      must(actor, "write");
      if (!can.delete(actor)) throw fail("forbidden_forms");
      await ready();
      const f = await found(slug);
      const gone = await purge({ formId: f.id });
      const left = repo.selectFormSubmissions
        ? (await repo.selectFormSubmissions({ formId: f.id, limit: 1 })).length
        : 0;
      // A file that could not be deleted keeps its submission, and the form with it: try again.
      if (left) throw fail("internal", {}, { status: 503 });
      await repo.deleteRecords({ kind: KIND, id: f.id });
      ctx.audit(actor, "form.delete", { form: slug, submissions: gone.length });
      return { submissions: gone.length };
    },

    // ── public ──
    /** The definition a page draws. Forms that are off are found by those who manage forms only. */
    async public(
      slug: string,
      actor: Actor = { kind: "anonymous" },
    ): Promise<PublicForm> {
      await ready();
      const f = await find(slug);
      if (!f || (!f.enabled && !can.read(actor)))
        throw fail("form_not_found", { slug });
      return {
        slug: f.slug,
        title: f.title,
        steps: f.steps,
        successMessage: f.settings.successMessage,
        version: f.version,
        honeypot: FORM_HONEYPOT,
        uploads: !!storage(),
        ...(f.enabled ? {} : { enabled: false }),
      };
    },
    /** A one-time grant to upload one file for a file field (10 minutes). */
    async grant(
      slug: string,
      input: {
        field?: unknown;
        name?: unknown;
        size?: unknown;
        mime?: unknown;
      },
      meta: SubmitMeta = {},
    ): Promise<UploadGrant> {
      await ready();
      const f = await find(slug);
      if (!f || !f.enabled) throw fail("form_not_found", { slug });
      const field = formFields(f.steps).find(
        (x) => x.key === input.field && x.kind === "file",
      );
      if (!field) throw fail("form_upload_invalid", { reason: "field" });
      const st = storage();
      if (!st) throw fail("form_uploads_off");
      const v = await ctx.limit(
        `formup:${meta.ip ?? "unknown"}`,
        Math.max(10, (ctx.options?.perMinute ?? 5) * 6),
      );
      if (!v.ok)
        throw fail(
          "rate_limited",
          { retryAfter: v.retryAfter, limit: v.limit },
          { status: 429 },
        );
      const name = cleanName(String(input.name ?? "file"));
      const declared = typeof input.mime === "string" ? input.mime : "";
      const mime = mimeOf(name, declared);
      const size = Number(input.size);
      const max = field.maxSize ?? FORM_DEFAULT_MAX_SIZE;
      if (!Number.isInteger(size) || size < 1)
        throw fail("form_upload_invalid", { reason: "size" });
      if (size > max)
        throw fail("form_file_too_large", {
          max: Math.round(max / 1024 / 1024) || 1,
        });
      if (
        !declaredMatches(name, declared) ||
        !formAccepts(field.accept ?? FORM_DEFAULT_ACCEPT, { name, mime })
      )
        throw fail("form_file_type", {
          types: (field.accept ?? FORM_DEFAULT_ACCEPT).join(", "),
        });
      const gid = hex(randomBytes(16));
      // The temporary key holds no file name: it shows up in storage logs and the PUT address.
      const storeKey = `${TMP}${f.id}/${gid}`;
      const e = ctx.now().getTime() + GRANT_SECONDS * 1000;
      const grantData: GrantData = {
        status: "issued",
        field: field.key,
        tmp: storeKey,
        size,
        mime,
        name,
        expires: e,
      };
      await repo.insertRecord({
        kind: UPLOAD_KIND,
        scope: f.id,
        key: gid,
        data: grantData as unknown as Record<string, unknown>,
        at: iso(),
      });
      const token = await sign({ f: f.id, g: gid, e });
      const signed = await st.adapter.presignPut(storeKey, {
        mime,
        expires: GRANT_SECONDS,
        size,
        disposition: "attachment",
      });
      return {
        token,
        put: /^https?:\/\//.test(signed.url)
          ? { url: signed.url, headers: signed.headers }
          : null,
        expiresAt: new Date(e).toISOString(),
      };
    },
    /** The bytes of a granted upload, through the CMS (storage without browser uploads). */
    async upload(
      slug: string,
      token: string,
      body: Uint8Array | ((max: number) => Promise<Uint8Array>),
    ): Promise<{ ok: true }> {
      await ready();
      const f = await find(slug);
      if (!f || !f.enabled) throw fail("form_not_found", { slug });
      const { rec, d } = await opened(token, f);
      const st = storage();
      if (!st) throw fail("form_uploads_off");
      if (d.status !== "issued")
        throw fail("form_upload_invalid", { reason: "used" });
      // Read no more than the grant allows.
      const bytes = typeof body === "function" ? await body(d.size) : body;
      if (bytes.byteLength !== d.size)
        throw fail("form_upload_invalid", { reason: "size" });
      // One upload per grant: whoever moves it from issued to uploaded first writes the bytes.
      const mine = await swapGrant(rec, { ...d, status: "uploaded" });
      if (!mine) throw fail("form_upload_invalid", { reason: "used" });
      try {
        await st.adapter.put(d.tmp, bytes, {
          mime: d.mime,
          disposition: "attachment",
        });
      } catch (e) {
        await swapGrant(mine, d).catch(() => null);
        throw e;
      }
      return { ok: true };
    },
    /** Keep a submission. Answers the same for spam (the sender is not told). */
    async submit(
      slug: string,
      input: Record<string, unknown>,
      meta: SubmitMeta = {},
    ): Promise<{ ok: true; message: string; redirectUrl: string | null }> {
      await ready();
      const f = await find(slug);
      if (!f || !f.enabled) throw fail("form_not_found", { slug });
      const v = await ctx.limit(
        `form:${meta.ip ?? "unknown"}`,
        ctx.options?.perMinute ?? 5,
      );
      if (!v.ok)
        throw fail(
          "rate_limited",
          { retryAfter: v.retryAfter, limit: v.limit },
          { status: 429 },
        );
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw fail("form_rejected", { count: 0 });
      const done = {
        ok: true as const,
        message: f.settings.successMessage,
        redirectUrl: f.settings.redirectUrl,
      };
      const ipHash = meta.ip
        ? hex(hmacSha256(await key(), `ip:${meta.ip}`)).slice(0, 32)
        : null;
      const userAgent =
        typeof meta.userAgent === "string"
          ? meta.userAgent.slice(0, 300)
          : null;
      const at = iso();
      const hp = input[FORM_HONEYPOT];
      const { values, problems } = checkSubmission(f.steps, input);
      if (
        typeof hp === "string"
          ? hp.trim() !== ""
          : hp !== undefined && hp !== null && hp !== false
      ) {
        // Kept for a person to look at, without files and without telling anyone.
        for (const fl of formFields(f.steps))
          if (fl.kind === "file") delete values[fl.key];
        await repo.insertFormSubmission!({
          formId: f.id,
          formVersion: f.version,
          data: values,
          files: [],
          status: "spam",
          ipHash,
          userAgent,
          createdAt: at,
        });
        return done;
      }
      if (problems.length) {
        const diagnostics: Diagnostic[] = problems.map((p: FormProblem) => ({
          path: p.field,
          code: p.code,
          params: p.params,
          message: ctx.message(p.code, p.params),
          severity: "error",
        }));
        throw fail(
          "form_rejected",
          { count: problems.length },
          { diagnostics },
        );
      }
      if (ctx.options?.verify) {
        let ok = false;
        try {
          ok = await ctx.options.verify(meta.request ?? null, {
            form: f,
            values,
            // Everything sent (a captcha token the form does not declare too), as parsed.
            raw: structuredClone(input),
          });
        } catch (e) {
          ctx.report(e, "forms.verify");
          ok = false;
        }
        if (!ok) throw fail("form_verify_failed");
      }
      // Files: every token must be this form's and this field's, uploaded, the size granted, and what it says it is.
      const files: FormSubmission["files"] = [];
      const picked: { rec: CmsRecord; d: GrantData; to: string; id: string }[] =
        [];
      for (const fl of formFields(f.steps)) {
        if (fl.kind !== "file" || values[fl.key] === undefined) continue;
        const st = storage();
        if (!st) throw fail("form_uploads_off");
        const out: FormFileValue[] = [];
        for (const t of values[fl.key] as unknown[]) {
          const { rec, d } = await opened(t, f);
          if (picked.some((x) => x.rec.id === rec.id))
            throw fail("form_upload_invalid", { reason: "used" });
          if (d.field !== fl.key)
            throw fail("form_upload_invalid", { reason: "field" });
          const head = await st.adapter.head(d.tmp);
          if (!head) throw fail("form_upload_invalid", { reason: "missing" });
          if (
            head.size !== d.size ||
            head.size > (fl.maxSize ?? FORM_DEFAULT_MAX_SIZE)
          )
            throw fail("form_upload_invalid", { reason: "size" });
          const start =
            (await st.adapter.readStart(d.tmp, 64)) ?? new Uint8Array();
          if (!contentMatches(d.mime, start))
            throw fail("form_file_type", {
              types: (fl.accept ?? FORM_DEFAULT_ACCEPT).join(", "),
            });
          const id = hex(randomBytes(8));
          const to = `_cms/forms/${f.id}/${id}/${d.name}`;
          picked.push({ rec, d, to, id });
          files.push({
            field: fl.key,
            id,
            key: to,
            name: d.name,
            size: head.size,
            mime: d.mime,
          });
          out.push({ id, name: d.name, size: head.size, mime: d.mime });
        }
        values[fl.key] = out;
      }
      const st = storage();
      // Claim every grant (issued/uploaded → claimed, one compare-and-swap each): of two
      // submissions sending one token, exactly one gets it. On any failure below, the claims are
      // given back (the token works again until it expires) and the copies made so far go.
      const claimed: { rec: CmsRecord; prev: GrantData }[] = [];
      const copied: string[] = [];
      const undo = async () => {
        const orphans: string[] = [];
        for (const k of copied)
          await st!.adapter.delete(k).catch((e) => {
            orphans.push(k);
            ctx.report(e, "forms: undo upload");
          });
        for (const c of claimed) {
          const back: GrantData = {
            ...c.prev,
            ...(orphans.length ? { orphans: [...(c.prev.orphans ?? []), ...orphans] } : {}),
          };
          orphans.length = 0;
          await swapGrant(c.rec, back).catch((e) =>
            ctx.report(e, "forms: release upload"),
          );
        }
      };
      let row: FormSubmission;
      try {
        for (const p of picked) {
          const next = await swapGrant(p.rec, {
            ...p.d,
            status: "claimed",
            prev: p.d.status,
            to: p.to,
            fileId: p.id,
          });
          if (!next) throw fail("form_upload_invalid", { reason: "used" });
          claimed.push({ rec: next, prev: p.d });
        }
        for (const p of picked) {
          await st!.adapter.copy(p.d.tmp, p.to);
          copied.push(p.to);
        }
        row = await repo.insertFormSubmission!({
          formId: f.id,
          formVersion: f.version,
          data: values,
          files,
          status: "new",
          ipHash,
          userAgent,
          createdAt: at,
        });
      } catch (e) {
        await undo();
        throw e;
      }
      // Saved: the uploads' own keys go, and the grants are done (a retry of the same delete
      // is harmless; the sweep finishes what fails here).
      for (const c of claimed) {
        const d = c.rec.data as unknown as GrantData;
        const gone = await st!.adapter.delete(d.tmp).then(
          () => true,
          (e) => (ctx.report(e, "forms: upload"), false),
        );
        await swapGrant(c.rec, {
          ...d,
          status: "done",
          tmp: gone ? "" : d.tmp,
        }).catch((e) => ctx.report(e, "forms: upload"));
      }
      const sub = subView(row, f.slug);
      ctx.emit({
        form: f.slug,
        formId: f.id,
        submissionId: row.id,
        fields: Object.keys(values),
        // File names are personal data too: an opaque id unless eventValues is on.
        files: files.map((x) => ({
          field: x.field,
          id: x.id,
          ...(ctx.options?.eventValues ? { name: x.name } : {}),
          size: x.size,
          mime: x.mime,
        })),
        ...(ctx.options?.eventValues
          ? {
              values: Object.fromEntries(
                Object.entries(values).filter(
                  ([k]) => !files.some((x) => x.field === k),
                ),
              ),
            }
          : {}),
      });
      const notify = ctx.options?.notify;
      if (notify) {
        const lines = formFields(f.steps)
          .filter((x) => values[x.key] !== undefined)
          .map((x) => ({
            key: x.key,
            label: x.label,
            value: displayValue(x, values[x.key], { yes: "✓", no: "" }),
          }));
        void Promise.resolve()
          .then(() =>
            notify({ form: f, submission: sub, to: f.settings.notify, lines }),
          )
          .catch((e) => ctx.report(e, "forms.notify"));
      }
      return done;
    },

    // ── submissions (people who manage forms) ──
    async submissions(
      actor: Actor,
      slug: string,
      o: {
        status?: readonly FormSubmissionStatus[] | null;
        q?: string;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<{
      items: FormSubmissionView[];
      total: number;
      counts: FormCounts;
    }> {
      must(actor, "read");
      await ready();
      const f = await found(slug);
      const statuses = (o.status ?? []).filter((s) =>
        FORM_STATUSES.includes(s),
      );
      const [page, c] = await Promise.all([
        repo.listFormSubmissions!({
          formId: f.id,
          statuses: statuses.length ? statuses : ["new", "read"],
          q: o.q?.slice(0, 200),
          limit: Math.min(Math.max(o.limit ?? 50, 1), 200),
          offset: Math.max(0, o.offset ?? 0),
        }),
        counts(),
      ]);
      return {
        items: page.items.map((s) => subView(s, f.slug)),
        total: page.total,
        counts: c.get(f.id)?.counts ?? {
          new: 0,
          read: 0,
          spam: 0,
          archived: 0,
        },
      };
    },
    async submission(
      actor: Actor,
      slug: string,
      id: string,
    ): Promise<FormSubmissionView> {
      must(actor, "read");
      await ready();
      const f = await found(slug);
      const s = await repo.findFormSubmission!(id);
      if (!s || s.formId !== f.id) throw fail("submission_not_found");
      return subView(s, f.slug);
    },
    async setStatus(
      actor: Actor,
      slug: string,
      ids: readonly string[],
      status: FormSubmissionStatus,
    ): Promise<{ changed: number }> {
      must(actor, "read");
      if (!FORM_STATUSES.includes(status))
        throw invalid({ issue: "status" });
      await ready();
      const f = await found(slug);
      const mine: string[] = [];
      for (const id of ids.slice(0, 500)) {
        const s = await repo.findFormSubmission!(id);
        if (s && s.formId === f.id && s.status !== status) mine.push(id);
      }
      const changed = mine.length
        ? await repo.setFormSubmissionStatus!(mine, status, iso())
        : 0;
      // Opening one marks it read: not worth an audit line each time.
      if (changed && status !== "read")
        ctx.audit(actor, "form.submission_update", {
          form: f.slug,
          status,
          count: changed,
        });
      return { changed };
    },
    async removeSubmissions(
      actor: Actor,
      slug: string,
      ids: readonly string[],
    ): Promise<{ deleted: number }> {
      must(actor, "delete");
      await ready();
      const f = await found(slug);
      const mine: string[] = [];
      for (const id of ids.slice(0, 500)) {
        const s = await repo.findFormSubmission!(id);
        if (s && s.formId === f.id) mine.push(id);
      }
      const gone = mine.length ? await purge({ ids: mine }) : [];
      if (gone.length)
        ctx.audit(actor, "form.submission_delete", {
          form: f.slug,
          count: gone.length,
        });
      return { deleted: gone.length };
    },
    /**
     * Every submission with these statuses (default: everything but spam) as CSV, newest first.
     * `q` searches the values like the list does, so the admin can export the view it shows.
     */
    async exportCsv(
      actor: Actor,
      slug: string,
      o: { status?: readonly FormSubmissionStatus[] | null; q?: string } = {},
    ): Promise<{ filename: string; csv: string; rows: number }> {
      must(actor, "read");
      await ready();
      const f = await found(slug);
      const statuses = (o.status ?? []).filter((s) =>
        FORM_STATUSES.includes(s),
      );
      const fields = formFields(f.steps);
      const items: FormSubmission[] = [];
      for (let offset = 0; offset < 50_000; offset += 1000) {
        const page = await repo.listFormSubmissions!({
          formId: f.id,
          statuses: statuses.length ? statuses : ["new", "read", "archived"],
          q: o.q?.trim() ? o.q.slice(0, 200) : undefined,
          limit: 1000,
          offset,
        });
        items.push(...page.items);
        if (page.items.length < 1000) break;
      }
      // Fields that were removed since still have values in older submissions.
      const extra = [
        ...new Set(items.flatMap((s) => Object.keys(s.data))),
      ].filter((k) => !fields.some((x) => x.key === k));
      const head = [
        "submitted_at",
        "status",
        ...fields.map((x) => x.label || x.key),
        ...extra,
      ];
      const rows = items.map((s) => [
        s.createdAt,
        s.status,
        ...fields.map((x) =>
          displayValue(x, s.data[x.key], { yes: "yes", no: "" }),
        ),
        ...extra.map((k) => displayValue(undefined, s.data[k])),
      ]);
      ctx.audit(actor, "form.export", {
        form: f.slug,
        rows: rows.length,
        ...(statuses.length ? { status: statuses.join(",") } : {}),
        ...(o.q?.trim() ? { filtered: true } : {}),
      });
      return {
        filename: `${f.slug}-${iso().slice(0, 10)}.csv`,
        csv: `\ufeff${toCsv([head, ...rows])}`,
        rows: rows.length,
      };
    },
    /** A five-minute link to download a file of a submission. */
    async fileLink(
      actor: Actor,
      slug: string,
      id: string,
      fileId: string,
    ): Promise<{ url: string; name: string; expiresAt: string }> {
      must(actor, "read");
      await ready();
      const f = await found(slug);
      const s = await repo.findFormSubmission!(id);
      if (!s || s.formId !== f.id) throw fail("submission_not_found");
      const file = s.files.find((x) => x.id === fileId);
      const st = ctx.storage();
      if (!file || !st) throw fail("submission_not_found");
      const url = await st.adapter.presignGet(file.key, {
        expires: LINK_SECONDS,
        download: file.name,
      });
      ctx.audit(actor, "form.file_open", {
        form: f.slug,
        submission: id,
        // The file's id, not its name (names can be personal data), unless eventValues is on.
        file: ctx.options?.eventValues ? file.name : file.id,
      });
      return {
        url,
        name: file.name,
        expiresAt: new Date(
          ctx.now().getTime() + LINK_SECONDS * 1000,
        ).toISOString(),
      };
    },

    // ── housekeeping ──
    /** Retention: delete submissions (and their files) sent before `before`. */
    async purgeBefore(before: string): Promise<number> {
      // Files first; a row whose file could not be deleted stays for the next run.
      return (await purge({ before })).length;
    },
    /** The cron call: a form's own shorter `keepDays`, and uploads never sent. */
    async tick(): Promise<void> {
      if (!on() || !repo.deleteFormSubmissions) return;
      await ctx.ready();
      for (const r of await repo.listRecords({ kind: KIND, limit: 500 })) {
        const f = view(r);
        if (!f.settings.keepDays) continue;
        const before = new Date(
          ctx.now().getTime() - f.settings.keepDays * DAY,
        ).toISOString();
        await purge({ formId: f.id, before });
      }
      await sweepUploads();
    },
  };
  return api;
}

export type CmsForms = ReturnType<typeof createForms>;
