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
 * one gets 429. `verify(req)` is where an app checks a captcha. The body is at most 64 KB.
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
  definitionProblems,
  displayValue,
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
   * it (403 `form_verify_failed`). `req` is null when the CMS is called directly, not over HTTP.
   */
  verify?: (
    req: Request | null,
    ctx: { form: FormView; values: Record<string, unknown> },
  ) => boolean | Promise<boolean>;
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
    if (!Array.isArray(steps))
      throw fail("form_invalid", { reason: "steps must be a list" });
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
    const problems = definitionProblems(out);
    if (problems.length)
      throw fail("form_invalid", { reason: problems.slice(0, 3).join("; ") });
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
        throw fail("form_invalid", {
          reason: "the message after sending is at most 1000 characters",
        });
      next.successMessage = s.successMessage.trim();
    }
    if (s.notify !== undefined) {
      const list = (Array.isArray(s.notify) ? s.notify : [])
        .map((x) => String(x).trim())
        .filter(Boolean);
      const bad = list.find((x) => !EMAIL_RE.test(x) || x.length > 254);
      if (bad || list.length > 20)
        throw fail("form_invalid", {
          reason: bad
            ? `not an e-mail address: ${bad}`
            : "at most 20 addresses",
        });
      next.notify = [...new Set(list)];
    }
    if (s.keepDays !== undefined) {
      if (
        s.keepDays !== null &&
        (!Number.isInteger(s.keepDays) || s.keepDays < 1 || s.keepDays > 3650)
      )
        throw fail("form_invalid", { reason: "keep 1 to 3650 days" });
      next.keepDays = s.keepDays;
    }
    if (s.redirectUrl !== undefined) {
      const u = s.redirectUrl === null ? "" : String(s.redirectUrl).trim();
      if (u && !/^(https?:\/\/[^\s]+|\/[^\s/][^\s]*|\/)$/.test(u))
        throw fail("form_invalid", {
          reason: "the address after sending starts with https:// or /",
        });
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
  const subView = (s: FormSubmission, slug: string): FormSubmissionView => {
    const { ipHash: _ip, files, ...rest } = s;
    return {
      ...rest,
      formSlug: slug,
      files: files.map(({ key: _k, ...f }) => f),
    };
  };

  // ── upload grants ───────────────────────────────────────────────────────────

  interface Grant {
    f: string; // form id
    k: string; // field key
    key: string; // storage key
    s: number;
    m: string;
    n: string;
    e: number; // expires (ms)
  }
  async function sign(g: Grant): Promise<string> {
    const body = base64url(JSON.stringify(g));
    return `${body}.${base64url(hmacSha256(await key(), body))}`;
  }
  async function opened(token: unknown, form: FormView): Promise<Grant> {
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
    if (g.f !== form.id) throw bad("token");
    if (g.e < ctx.now().getTime()) throw bad("expired");
    return g;
  }

  /** Uploads made for a form but never sent with it go after a day. */
  async function sweepUploads(): Promise<number> {
    const st = storage();
    if (!st) return 0;
    let n = 0;
    let cursor: string | null = null;
    const cut = ctx.now().getTime() - DAY;
    for (let page = 0; page < 20; page++) {
      const list = await st.adapter.list({ prefix: TMP, cursor, limit: 500 });
      for (const o of list.objects) {
        const at = o.lastModified ? Date.parse(o.lastModified) : 0;
        if (at && at < cut) {
          await st.adapter
            .delete(o.key)
            .catch((e) => ctx.report(e, "forms: old upload"));
          n++;
        }
      }
      cursor = list.cursor;
      if (!cursor) break;
    }
    return n;
  }
  async function dropFiles(rows: readonly FormSubmission[]) {
    const st = storage() ?? ctx.storage();
    if (!st) return;
    for (const r of rows)
      for (const f of r.files)
        await st.adapter
          .delete(f.key)
          .catch((e) => ctx.report(e, "forms: delete file"));
  }

  const api = {
    enabled: on,
    honeypot: FORM_HONEYPOT,
    can: (actor: Actor) =>
      on() && can.read(actor)
        ? { read: true, write: can.write(actor), delete: can.delete(actor) }
        : null,
    uploadsReady: () => !!storage(),

    // ── admin ──
    async list(actor: Actor): Promise<FormListItem[]> {
      must(actor, "read");
      await ready();
      const [rows, c] = await Promise.all([
        repo.listRecords({ kind: KIND, order: "asc", limit: 500 }),
        counts(),
      ]);
      return rows.map((r) => {
        const v = view(r);
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
      return found(slug);
    },
    async create(actor: Actor, input: FormInput): Promise<FormView> {
      must(actor, "write");
      await ready();
      const slug = String(input.slug ?? "")
        .trim()
        .toLowerCase();
      if (!SLUG_RE.test(slug))
        throw fail("form_invalid", {
          reason: "the address is lowercase letters, digits and -",
        });
      const title = String(input.title ?? "").trim();
      if (!title || title.length > 120)
        throw fail("form_invalid", { reason: "a name of 1 to 120 characters" });
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
      return view(r);
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
      if (input.expectedUpdatedAt && input.expectedUpdatedAt !== cur.updatedAt)
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
        if (!SLUG_RE.test(s))
          throw fail("form_invalid", {
            reason: "the address is lowercase letters, digits and -",
          });
        if (await find(s)) throw fail("form_slug_taken", { slug: s });
        next.slug = s;
      }
      if (input.title !== undefined) {
        const t = String(input.title).trim();
        if (!t || t.length > 120)
          throw fail("form_invalid", {
            reason: "a name of 1 to 120 characters",
          });
        next.title = t;
      }
      if (input.enabled !== undefined) next.enabled = input.enabled === true;
      if (input.steps !== undefined) {
        next.steps = cleanSteps(input.steps);
        if (JSON.stringify(next.steps) !== JSON.stringify(cur.steps))
          next.version = cur.version + 1;
      }
      next.settings = cleanSettings(input.settings, cur.settings);
      const r = await repo.updateRecord(KIND, rec.id, {
        data: next as unknown as Record<string, unknown>,
        key: next.slug,
        at: iso(),
      });
      if (!r) throw fail("form_not_found", { slug });
      ctx.audit(actor, "form.update", {
        form: next.slug,
        ...(next.slug !== cur.slug ? { from: cur.slug } : {}),
        ...(next.enabled !== cur.enabled ? { enabled: next.enabled } : {}),
        ...(next.version !== cur.version ? { version: next.version } : {}),
      });
      return view(r);
    },
    /** Deletes the form with its submissions and their files. */
    async remove(actor: Actor, slug: string): Promise<{ submissions: number }> {
      must(actor, "write");
      if (!can.delete(actor)) throw fail("forbidden_forms");
      await ready();
      const f = await found(slug);
      const gone = (await repo.deleteFormSubmissions?.({ formId: f.id })) ?? [];
      await dropFiles(gone);
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
      const storeKey = `${TMP}${f.id}/${hex(randomBytes(12))}/${name}`;
      const e = ctx.now().getTime() + GRANT_SECONDS * 1000;
      const token = await sign({
        f: f.id,
        k: field.key,
        key: storeKey,
        s: size,
        m: mime,
        n: name,
        e,
      });
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
      const g = await opened(token, f);
      const st = storage();
      if (!st) throw fail("form_uploads_off");
      if (await st.adapter.head(g.key))
        throw fail("form_upload_invalid", { reason: "used" });
      // Read no more than the grant allows.
      const bytes = typeof body === "function" ? await body(g.s) : body;
      if (bytes.byteLength !== g.s)
        throw fail("form_upload_invalid", { reason: "size" });
      await st.adapter.put(g.key, bytes, {
        mime: g.m,
        disposition: "attachment",
      });
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
          });
        } catch (e) {
          ctx.report(e, "forms.verify");
          ok = false;
        }
        if (!ok) throw fail("form_verify_failed");
      }
      // Files: every token must be this form's and this field's, uploaded, the size granted, and what it says it is.
      const files: FormSubmission["files"] = [];
      const moves: { from: string; to: string }[] = [];
      for (const fl of formFields(f.steps)) {
        if (fl.kind !== "file" || values[fl.key] === undefined) continue;
        const st = storage();
        if (!st) throw fail("form_uploads_off");
        const out: FormFileValue[] = [];
        for (const t of values[fl.key] as unknown[]) {
          const g = await opened(t, f);
          if (g.k !== fl.key)
            throw fail("form_upload_invalid", { reason: "field" });
          const head = await st.adapter.head(g.key);
          if (!head) throw fail("form_upload_invalid", { reason: "missing" });
          if (
            head.size !== g.s ||
            head.size > (fl.maxSize ?? FORM_DEFAULT_MAX_SIZE)
          )
            throw fail("form_upload_invalid", { reason: "size" });
          const start =
            (await st.adapter.readStart(g.key, 64)) ?? new Uint8Array();
          if (!contentMatches(g.m, start))
            throw fail("form_file_type", {
              types: (fl.accept ?? FORM_DEFAULT_ACCEPT).join(", "),
            });
          const id = hex(randomBytes(8));
          const to = `_cms/forms/${f.id}/${id}/${g.n}`;
          moves.push({ from: g.key, to });
          files.push({
            field: fl.key,
            id,
            key: to,
            name: g.n,
            size: head.size,
            mime: g.m,
          });
          out.push({ id, name: g.n, size: head.size, mime: g.m });
        }
        values[fl.key] = out;
      }
      const st = storage();
      for (const m of moves) {
        await st!.adapter.copy(m.from, m.to);
        // One time only: the upload's own key goes, so the token cannot be sent again.
        await st!.adapter
          .delete(m.from)
          .catch((e) => ctx.report(e, "forms: upload"));
      }
      const row = await repo.insertFormSubmission!({
        formId: f.id,
        formVersion: f.version,
        data: values,
        files,
        status: "new",
        ipHash,
        userAgent,
        createdAt: at,
      });
      const sub = subView(row, f.slug);
      ctx.emit({
        form: f.slug,
        formId: f.id,
        submissionId: row.id,
        fields: Object.keys(values),
        files: files.map((x) => ({
          field: x.field,
          name: x.name,
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
        throw fail("form_invalid", { reason: "status" });
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
      const gone = mine.length
        ? await repo.deleteFormSubmissions!({ ids: mine })
        : [];
      await dropFiles(gone);
      if (gone.length)
        ctx.audit(actor, "form.submission_delete", {
          form: f.slug,
          count: gone.length,
        });
      return { deleted: gone.length };
    },
    /** Every submission with these statuses (default: not spam) as CSV, newest first. */
    async exportCsv(
      actor: Actor,
      slug: string,
      o: { status?: readonly FormSubmissionStatus[] | null } = {},
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
      ctx.audit(actor, "form.export", { form: f.slug, rows: rows.length });
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
        file: file.name,
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
      if (!repo.deleteFormSubmissions) return 0;
      let n = 0;
      for (let i = 0; i < 100; i++) {
        const gone = await repo.deleteFormSubmissions({ before, limit: 500 });
        await dropFiles(gone);
        n += gone.length;
        if (gone.length < 500) break;
      }
      return n;
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
        await dropFiles(
          await repo.deleteFormSubmissions({
            formId: f.id,
            before,
            limit: 2000,
          }),
        );
      }
      await sweepUploads();
    },
  };
  return api;
}

export type CmsForms = ReturnType<typeof createForms>;
