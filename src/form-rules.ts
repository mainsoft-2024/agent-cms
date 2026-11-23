/**
 * Form rules shared by the server and the browser (0.22.0): the field kinds, the `showIf`
 * conditions and the checks of a submitted value. The server runs `checkSubmission` again on
 * every submission, so what a browser skips never gets in; the copied `cms-form` component runs
 * the same code to show the same errors before sending.
 *
 * No dependencies: this file is re-exported from `@mainsoft/agent-cms/client`.
 */

/** The nine kinds of field. */
export const FORM_FIELD_KINDS = [
  "text",
  "textarea",
  "email",
  "number",
  "select",
  "multiselect",
  "checkbox",
  "date",
  "file",
] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

/** `eq` / `neq`: equal or not; `in`: one of `value` (an array); `contains`: a multi-select holds `value`; `empty` / `filled`: no value or any. */
export const FORM_CONDITION_OPS = [
  "eq",
  "neq",
  "in",
  "contains",
  "empty",
  "filled",
] as const;
export type FormConditionOp = (typeof FORM_CONDITION_OPS)[number];

export interface FormCondition {
  /** The key of an earlier field. */
  field: string;
  op: FormConditionOp;
  value?: string | number | boolean | string[] | null;
}

export interface FormOption {
  value: string;
  label: string;
}

export interface FormField {
  /** Stable name of the value (`email`, `company_size`): lowercase letters, digits and `_`, starting with a letter. */
  key: string;
  label: string;
  kind: FormFieldKind;
  required?: boolean;
  /** A line under the field. */
  help?: string | null;
  placeholder?: string | null;
  /** For `select` and `multiselect`. */
  options?: FormOption[];
  /** Text: fewest / most characters. Number: smallest / largest value. Multi-select: fewest / most picks. Date: earliest / latest (`YYYY-MM-DD`). */
  min?: number | string | null;
  max?: number | string | null;
  /** Text: a regular expression the whole value must match. */
  pattern?: string | null;
  /** Shown when `pattern` does not match (else a generic line). */
  patternMessage?: string | null;
  /** File: types taken (`image/*`, `.pdf`, `application/pdf`). Default: images and PDF. */
  accept?: string[];
  /** File: largest file in bytes. Default 10 MB. */
  maxSize?: number;
  /** File: how many files. Default 1. */
  maxFiles?: number;
  /** Shown (and taken) only when this holds. */
  showIf?: FormCondition | null;
}

export interface FormStep {
  title: string;
  fields: FormField[];
}

/** One uploaded file in a submission (the bytes stay in private storage). */
export interface FormFileValue {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export const FORM_DEFAULT_ACCEPT: readonly string[] = ["image/*", ".pdf"];
export const FORM_DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
/** The largest a file field may allow. */
export const FORM_MAX_FILE_SIZE = 100 * 1024 * 1024;
export const FORM_TEXT_MAX = 500;
export const FORM_TEXTAREA_MAX = 10_000;
export const FORM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every field of every step, in order. */
export function formFields(steps: readonly FormStep[]): FormField[] {
  return steps.flatMap((s) => s.fields);
}

/** True when the value counts as given (a checkbox must be ticked; a list must hold something). */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean")
    return (a === true || a === "true") === (b === true || b === "true");
  return String(a ?? "") === String(b ?? "");
}

/** Does a condition hold for these values? */
export function conditionHolds(
  c: FormCondition,
  values: Record<string, unknown>,
): boolean {
  const v = values[c.field];
  switch (c.op) {
    case "eq":
      return Array.isArray(v)
        ? v.some((x) => same(x, c.value))
        : same(v, c.value);
    case "neq":
      return Array.isArray(v)
        ? !v.some((x) => same(x, c.value))
        : !same(v, c.value);
    case "in": {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      return Array.isArray(v)
        ? v.some((x) => list.some((y) => same(x, y)))
        : list.some((y) => same(v, y));
    }
    case "contains":
      return Array.isArray(v)
        ? v.some((x) => same(x, c.value))
        : typeof v === "string" && typeof c.value === "string" && c.value !== ""
          ? v.includes(c.value)
          : false;
    case "empty":
      return !hasValue(v);
    case "filled":
      return hasValue(v);
  }
  return false;
}

/**
 * The keys of the fields shown for these values. A field is shown when its condition holds and
 * the field the condition looks at is itself shown (a hidden field's value never counts).
 */
export function visibleKeys(
  steps: readonly FormStep[],
  values: Record<string, unknown>,
): Set<string> {
  const shown = new Set<string>();
  const seen: Record<string, unknown> = {};
  for (const f of formFields(steps)) {
    const c = f.showIf;
    const ok = !c || (shown.has(c.field) && conditionHolds(c, seen));
    if (ok) {
      shown.add(f.key);
      seen[f.key] = values[f.key];
    }
  }
  return shown;
}

/** Steps that have at least one field shown for these values (an empty step is skipped). */
export function visibleSteps(
  steps: readonly FormStep[],
  values: Record<string, unknown>,
): number[] {
  const shown = visibleKeys(steps, values);
  return steps
    .map((s, i) => (s.fields.some((f) => shown.has(f.key)) ? i : -1))
    .filter((i) => i >= 0);
}

/** A problem with one field. `code` names the message (`form_required`, …), `params` fill it in. */
export interface FormProblem {
  field: string;
  code:
    | "form_required"
    | "form_length"
    | "form_email"
    | "form_number"
    | "form_option"
    | "form_date"
    | "form_pattern"
    | "form_file";
  params: Record<string, string | number>;
}

const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x)
    ? x
    : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))
      ? Number(x)
      : null;
const optionValues = (f: FormField) =>
  new Set((f.options ?? []).map((o) => o.value));

/** Turn what a browser sent for one field into its stored form, or a problem. No `value` means no value. */
export function normalizeValue(
  f: FormField,
  raw: unknown,
): {
  value?: unknown;
  problem?: FormProblem["code"];
  params?: FormProblem["params"];
} {
  const min = num(f.min);
  const max = num(f.max);
  switch (f.kind) {
    case "text":
    case "textarea":
    case "email": {
      const hard = f.kind === "textarea" ? FORM_TEXTAREA_MAX : FORM_TEXT_MAX;
      const lo = Math.max(0, min ?? 0);
      const hi = Math.min(max ?? hard, hard);
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== "string" && typeof raw !== "number")
        return { problem: "form_length", params: { min: lo, max: hi } };
      const s = String(raw).replace(/\r\n?/g, "\n");
      const v =
        f.kind === "textarea" ? s.trim() : s.replace(/\s+/g, " ").trim();
      if (!v) return {};
      const n = [...v].length;
      if (n < lo || n > hi)
        return { problem: "form_length", params: { min: lo, max: hi } };
      if (f.kind === "email" && !EMAIL_RE.test(v))
        return { problem: "form_email", params: {} };
      if (f.pattern) {
        let re: RegExp | null = null;
        try {
          re = new RegExp(`^(?:${f.pattern})$`, "u");
        } catch {
          re = null;
        }
        if (re && !re.test(v))
          return {
            problem: "form_pattern",
            params: { message: f.patternMessage ?? "" },
          };
      }
      return { value: v };
    }
    case "number": {
      if (raw === undefined || raw === null || raw === "") return {};
      const n = num(raw);
      if (n === null || (min !== null && n < min) || (max !== null && n > max))
        return {
          problem: "form_number",
          params: { min: min ?? "", max: max ?? "" },
        };
      return { value: n };
    }
    case "select": {
      if (raw === undefined || raw === null || raw === "") return {};
      if (typeof raw !== "string" || !optionValues(f).has(raw))
        return { problem: "form_option", params: {} };
      return { value: raw };
    }
    case "multiselect": {
      if (raw === undefined || raw === null) return {};
      const list = Array.isArray(raw) ? raw : [raw];
      if (!list.every((x) => typeof x === "string" && optionValues(f).has(x)))
        return { problem: "form_option", params: {} };
      const v = [...new Set(list as string[])];
      if (!v.length) return {};
      if ((min !== null && v.length < min) || (max !== null && v.length > max))
        return {
          problem: "form_option",
          params: { min: min ?? "", max: max ?? "" },
        };
      return { value: v };
    }
    case "checkbox": {
      if (raw === true || raw === "true" || raw === "on" || raw === "1")
        return { value: true };
      if (
        raw === undefined ||
        raw === null ||
        raw === false ||
        raw === "false" ||
        raw === ""
      )
        return {};
      return { problem: "form_option", params: {} };
    }
    case "date": {
      if (raw === undefined || raw === null || raw === "") return {};
      const lo = typeof f.min === "string" && DATE_RE.test(f.min) ? f.min : "";
      const hi = typeof f.max === "string" && DATE_RE.test(f.max) ? f.max : "";
      if (
        typeof raw !== "string" ||
        !DATE_RE.test(raw) ||
        Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ||
        new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw
      )
        return { problem: "form_date", params: { min: lo, max: hi } };
      if ((lo && raw < lo) || (hi && raw > hi))
        return { problem: "form_date", params: { min: lo, max: hi } };
      return { value: raw };
    }
    case "file":
      // The browser sends upload tokens; the server swaps them for the stored files.
      if (raw === undefined || raw === null) return {};
      if (!Array.isArray(raw))
        return { problem: "form_file", params: { max: f.maxFiles ?? 1 } };
      if (!raw.length) return {};
      if (raw.length > (f.maxFiles ?? 1))
        return { problem: "form_file", params: { max: f.maxFiles ?? 1 } };
      return { value: raw };
  }
  return {};
}

/**
 * Check what was sent: values of hidden fields are dropped, every shown field is checked and
 * kept in its own form. `steps` limits the problems to some steps (the browser checks one step
 * before moving on); the server always checks them all.
 */
export function checkSubmission(
  steps: readonly FormStep[],
  input: Record<string, unknown>,
  o: { steps?: number[] } = {},
): { values: Record<string, unknown>; problems: FormProblem[] } {
  const shown = visibleKeys(steps, input);
  const values: Record<string, unknown> = {};
  const problems: FormProblem[] = [];
  steps.forEach((s, i) => {
    for (const f of s.fields) {
      if (!shown.has(f.key)) continue;
      const r = normalizeValue(f, input[f.key]);
      if (r.value !== undefined) values[f.key] = r.value;
      if (o.steps && !o.steps.includes(i)) continue;
      if (r.problem)
        problems.push({
          field: f.key,
          code: r.problem,
          params: r.params ?? {},
        });
      else if (f.required && r.value === undefined)
        problems.push({ field: f.key, code: "form_required", params: {} });
    }
  });
  return { values, problems };
}

/**
 * Why a form cannot be saved, as a code (0.22.0): the server's `form_invalid` error carries it as
 * `params.issue` (with `field`, `step`, `value`), so each language words it itself.
 */
export type FormInvalidReason =
  | "steps_list"
  | "no_steps"
  | "too_many_steps"
  | "no_fields"
  | "too_many_fields"
  | "step_title"
  | "key"
  | "key_twice"
  | "kind"
  | "label"
  | "help"
  | "options_count"
  | "option_incomplete"
  | "option_twice"
  | "pattern_kind"
  | "pattern_long"
  | "pattern_bad"
  | "max_size"
  | "max_files"
  | "accept"
  | "condition_field"
  | "condition_op"
  | "condition_file"
  | "slug"
  | "title"
  | "success_message"
  | "notify_email"
  | "notify_count"
  | "keep_days"
  | "redirect"
  | "status";

export interface FormDefinitionIssue {
  issue: FormInvalidReason;
  /** The field's key. */
  field?: string;
  /** 1-based step number. */
  step?: number;
  /** The offending value (an unknown kind, a repeated option, an address). */
  value?: string;
}

/** English wording of an issue (the `reason` of `form_invalid`). */
export function formIssueText(i: FormDefinitionIssue): string {
  const at = `field "${i.field ?? ""}"`;
  switch (i.issue) {
    case "steps_list":
      return "steps must be a list";
    case "no_steps":
      return "a form needs at least one step";
    case "too_many_steps":
      return "at most 20 steps";
    case "no_fields":
      return "a form needs at least one field";
    case "too_many_fields":
      return "at most 100 fields";
    case "step_title":
      return `step ${i.step}: a title of at most 120 characters`;
    case "key":
      return `${at}: a key is lowercase letters, digits and _, starting with a letter (at most 40)`;
    case "key_twice":
      return `${at}: used twice`;
    case "kind":
      return `${at}: unknown kind "${i.value}"`;
    case "label":
      return `${at}: a label of 1 to 200 characters`;
    case "help":
      return `${at}: help of at most 500 characters`;
    case "options_count":
      return `${at}: 1 to 100 options`;
    case "option_incomplete":
      return `${at}: every option needs a value and a label`;
    case "option_twice":
      return `${at}: option "${i.value}" twice`;
    case "pattern_kind":
      return `${at}: only text takes a pattern`;
    case "pattern_long":
      return `${at}: a pattern of at most 300 characters`;
    case "pattern_bad":
      return `${at}: the pattern is not a regular expression`;
    case "max_size":
      return `${at}: largest file from 1 byte to 100 MB`;
    case "max_files":
      return `${at}: 1 to 10 files`;
    case "accept":
      return `${at}: name the file types it takes`;
    case "condition_field":
      return `${at}: a condition looks at an earlier field (not "${i.value}")`;
    case "condition_op":
      return `${at}: unknown condition "${i.value}"`;
    case "condition_file":
      return `${at}: a file field can only be tested for empty or filled`;
    case "slug":
      return "the address is lowercase letters, digits and -";
    case "title":
      return "a name of 1 to 120 characters";
    case "success_message":
      return "the message after sending is at most 1000 characters";
    case "notify_email":
      return `not an e-mail address: ${i.value}`;
    case "notify_count":
      return "at most 20 addresses";
    case "keep_days":
      return "keep 1 to 3650 days";
    case "redirect":
      return "the address after sending starts with https:// or /";
    case "status":
      return "status";
  }
  return String(i.issue);
}

/** Problems with a definition as codes, or an empty list. */
export function definitionIssues(
  steps: readonly FormStep[],
): FormDefinitionIssue[] {
  const out: FormDefinitionIssue[] = [];
  if (!Array.isArray(steps) || !steps.length) return [{ issue: "no_steps" }];
  if (steps.length > 20) out.push({ issue: "too_many_steps" });
  const keys = new Set<string>();
  const all = formFields(steps);
  if (!all.length) out.push({ issue: "no_fields" });
  if (all.length > 100) out.push({ issue: "too_many_fields" });
  for (const [si, s] of steps.entries()) {
    if (typeof s.title !== "string" || s.title.length > 120)
      out.push({ issue: "step_title", step: si + 1 });
    for (const f of s.fields) {
      const field = String(f.key);
      const add = (issue: FormInvalidReason, value?: string) =>
        void out.push({
          issue,
          field,
          ...(value === undefined ? {} : { value }),
        });
      if (typeof f.key !== "string" || !FORM_KEY_RE.test(f.key)) add("key");
      if (keys.has(f.key)) add("key_twice");
      if (!(FORM_FIELD_KINDS as readonly string[]).includes(f.kind))
        add("kind", String(f.kind));
      if (
        typeof f.label !== "string" ||
        !f.label.trim() ||
        f.label.length > 200
      )
        add("label");
      if (f.help != null && (typeof f.help !== "string" || f.help.length > 500))
        add("help");
      if (f.kind === "select" || f.kind === "multiselect") {
        const opts = f.options ?? [];
        if (!opts.length || opts.length > 100) add("options_count");
        const vals = new Set<string>();
        for (const o of opts) {
          if (
            typeof o?.value !== "string" ||
            !o.value.trim() ||
            o.value.length > 200 ||
            typeof o.label !== "string" ||
            !o.label.trim()
          )
            add("option_incomplete");
          else if (vals.has(o.value)) add("option_twice", o.value);
          else vals.add(o.value);
        }
      }
      if (f.pattern != null && f.pattern !== "") {
        if (f.kind !== "text" && f.kind !== "textarea") add("pattern_kind");
        else if (f.pattern.length > 300) add("pattern_long");
        else {
          try {
            new RegExp(f.pattern, "u");
          } catch {
            add("pattern_bad");
          }
        }
      }
      if (f.kind === "file") {
        if (
          f.maxSize != null &&
          (!Number.isInteger(f.maxSize) ||
            f.maxSize < 1 ||
            f.maxSize > FORM_MAX_FILE_SIZE)
        )
          add("max_size");
        if (
          f.maxFiles != null &&
          (!Number.isInteger(f.maxFiles) || f.maxFiles < 1 || f.maxFiles > 10)
        )
          add("max_files");
        if (
          f.accept != null &&
          (!Array.isArray(f.accept) ||
            !f.accept.length ||
            f.accept.some(
              (a: unknown) =>
                typeof a !== "string" ||
                !(a as string).trim() ||
                (a as string).trim() === "*" ||
                (a as string).trim() === "*/*",
            ))
        )
          add("accept");
      }
      if (f.showIf) {
        const c = f.showIf;
        if (!keys.has(c.field)) add("condition_field", String(c.field));
        if (!(FORM_CONDITION_OPS as readonly string[]).includes(c.op))
          add("condition_op", String(c.op));
        const target = all.find((x) => x.key === c.field);
        if (target?.kind === "file" && c.op !== "empty" && c.op !== "filled")
          add("condition_file");
      }
      keys.add(f.key);
    }
  }
  return out;
}

/** Problems with a definition (in English, for the admin), or an empty list. */
export function definitionProblems(steps: readonly FormStep[]): string[] {
  return definitionIssues(steps).map(formIssueText);
}

/** "Bug" for a select's value, "yes" for a ticked box: a value as people read it. */
export function displayValue(
  f: FormField | undefined,
  v: unknown,
  o: { yes?: string; no?: string } = {},
): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) {
    if (f?.kind === "file")
      return v
        .map((x) =>
          x && typeof x === "object" && "name" in x
            ? String((x as FormFileValue).name)
            : String(x),
        )
        .join(", ");
    return v.map((x) => displayValue(f, x, o)).join(", ");
  }
  if (typeof v === "boolean") return v ? (o.yes ?? "yes") : (o.no ?? "no");
  if (f && (f.kind === "select" || f.kind === "multiselect"))
    return f.options?.find((x) => x.value === v)?.label ?? String(v);
  return String(v);
}

/** Does `accept` take this file? (`image/*`, `.pdf`, `application/pdf`.) */
export function formAccepts(
  accept: readonly string[],
  file: { name: string; mime: string },
): boolean {
  const m = /\.([a-z0-9]{1,10})$/i.exec(file.name);
  const ext = m ? m[1].toLowerCase() : "";
  const mime = (file.mime || "").toLowerCase();
  return accept.some((raw) => {
    const r = raw.trim().toLowerCase();
    if (r.startsWith(".")) return r.slice(1) === ext;
    if (r.endsWith("/*")) return mime.startsWith(r.slice(0, -1));
    return r === mime;
  });
}
