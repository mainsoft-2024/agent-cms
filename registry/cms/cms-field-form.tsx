// agent-cms registry: cms-doc-editor (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The document info form: title, slug, summary, category, keywords and the
// collection's own fields, generated from `_schema` (JSON Schema plus the
// `admin` hints: label, help, widget). Problems from `diagnose()` land on the
// field they belong to (aria-invalid + aria-describedby).
"use client";

import * as React from "react";
import { Lock, X } from "lucide-react";
import type { CollectionSchema } from "@mainsoft/agent-cms/client";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AssetThumb, assetMeta, CmsMediaPicker } from "./cms-media-picker";
import { GalleryField, GroupField, RelationField, RowsField, type SubField } from "./cms-fields-more";
import type { DocContent } from "./use-cms";
import { useAsset, useCms } from "./use-cms";

export type Widget = "text" | "textarea" | "number" | "switch" | "select" | "multiselect" | "date" | "tags" | "json" | "image" | "file" | "relation" | "gallery" | "rows" | "group";

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  format?: string;
  description?: string;
  maxLength?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  "x-cms-relation"?: { collections: string[]; many: boolean; max: number | null };
  "x-cms-gallery"?: { max: number | null; accept: string[] | null };
};

export interface FieldSpec {
  key: string;
  label: string;
  help?: string;
  widget: Widget;
  required: boolean;
  options?: string[];
  integer?: boolean;
  /** For `image` and `file`: the collection the field belongs to and the field's own upload rules. */
  collection?: string;
  accept?: string[];
  store?: string;
  /** This person cannot change it (`fieldAccess` on the server). */
  readOnly?: boolean;
  /** 0.21.0: relation targets, gallery limits, and the small fields of rows and groups. */
  relation?: { collections: string[]; many: boolean; max: number | null };
  max?: number | null;
  sub?: SubField[];
}

/** The small fields inside a row or group (plain values only; anything else stays JSON). */
function subFields(s: JsonSchema): SubField[] | null {
  const props = unwrap(s).properties;
  if (!props || !Object.keys(props).length) return null;
  const req = new Set(unwrap(s).required ?? []);
  const out: SubField[] = [];
  for (const [key, raw] of Object.entries(props)) {
    const w = widgetFor(raw);
    const kind = w === "text" || w === "number" || w === "switch" || w === "select" || w === "textarea" ? w : null;
    if (!kind) return null;
    out.push({ key, label: unwrap(raw).description ?? key, kind, options: kind === "select" ? (unwrap(raw).enum as string[]) : undefined, required: req.has(key) });
  }
  return out;
}

/** Drop `null` from `anyOf: [X, null]` (nullable fields). */
function unwrap(s: JsonSchema): JsonSchema {
  if (s.anyOf) {
    const rest = s.anyOf.filter((x) => x.type !== "null");
    if (rest.length === 1) return { ...unwrap(rest[0]), description: s.description ?? rest[0].description };
  }
  return s;
}

/** How many columns of the form grid a field takes (the cell around it carries this). */
export function fieldSpan(s: Pick<FieldSpec, "widget" | "relation">): string | undefined {
  switch (s.widget) {
    case "rows":
      return "md:col-span-2 xl:col-span-3";
    case "gallery":
      return "md:col-span-2";
    case "relation":
      return s.relation?.many ? "md:col-span-2" : undefined;
    case "textarea":
    case "json":
    case "image":
    case "file":
    case "group":
      return "md:col-span-2";
    default:
      return undefined;
  }
}

/** Which widget fits a JSON Schema property (an `admin.widget` hint wins). */
export function widgetFor(schema: JsonSchema, hint?: string): Widget {
  if (hint) return hint as Widget;
  const s = unwrap(schema);
  if (s["x-cms-relation"]) return "relation";
  if (s["x-cms-gallery"]) return "gallery";
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (s.enum && s.enum.every((x) => typeof x === "string")) return "select";
  if (type === "string") return s.format === "date" || s.format === "date-time" ? "date" : (s.maxLength ?? 0) > 200 ? "textarea" : "text";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "switch";
  if (type === "array") {
    const it = s.items ? unwrap(s.items) : {};
    if (it.enum && it.enum.every((x) => typeof x === "string")) return "multiselect";
    if (it.type === "string") return "tags";
    if (it.type === "object" && subFields(it)) return "rows";
  }
  if (type === "object" && subFields(s)) return "group";
  return "json";
}

/** The custom fields of a collection, in schema order. */
export function fieldSpecs(schema: CollectionSchema): FieldSpec[] {
  const root = (schema.fields ?? {}) as JsonSchema;
  const props = root.properties ?? {};
  const req = new Set(root.required ?? []);
  const hidden = new Set(schema.fieldRules?.hidden ?? []);
  const readOnly = new Set(schema.fieldRules?.readOnly ?? []);
  return Object.entries(props).filter(([key]) => !hidden.has(key)).map(([key, raw]) => {
    const s = unwrap(raw);
    const hint = schema.admin?.[key];
    const widget = widgetFor(raw, hint?.widget);
    const options = (widget === "select" ? s.enum : widget === "multiselect" ? (s.items ? unwrap(s.items).enum : undefined) : undefined) as string[] | undefined;
    const gallery = s["x-cms-gallery"];
    const sub = widget === "rows" ? subFields(s.items ?? {}) : widget === "group" ? subFields(s) : null;
    return {
      key,
      label: hint?.label ?? key,
      // A relation's own description ("Id of a document in …") is for agents; the picker already says it.
      help: hint?.help ?? (s["x-cms-relation"] ? undefined : s.description),
      widget,
      required: req.has(key),
      options,
      integer: s.type === "integer",
      collection: schema.slug,
      accept: hint?.accept ?? gallery?.accept ?? (widget === "image" || widget === "gallery" ? ["image/*"] : undefined),
      store: hint?.store,
      readOnly: readOnly.has(key) || undefined,
      ...(s["x-cms-relation"] ? { relation: s["x-cms-relation"] } : {}),
      ...(gallery ? { max: gallery.max } : {}),
      ...(sub ? { sub } : {}),
    };
  });
}

// ── problems per field ───────────────────────────────────────────────────────

export interface FieldProblem {
  path: string;
  message: string;
  severity: "error" | "warning";
}

/** `fields.tags.0` → `fields.tags`; `title` → `title`. */
export function problemKey(path: string): string {
  const p = path.split(".");
  return p[0] === "fields" && p[1] ? `fields.${p[1]}` : p[0];
}

// ── small inputs ─────────────────────────────────────────────────────────────

interface Described {
  id: string;
  help?: string;
  errors?: FieldProblem[];
}

function describedBy({ id, help, errors }: Described): string | undefined {
  const ids = [help ? `${id}-help` : null, errors?.length ? `${id}-err` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function FieldShell({ id, label, help, errors, required, children, className, asGroup }: Described & { label: React.ReactNode; required?: boolean; children: React.ReactNode; className?: string; asGroup?: boolean }) {
  const { t } = useCms();
  const hasError = errors?.some((e) => e.severity === "error");
  const msgs = (
    <>
      {help ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      {errors?.length ? (
        <p id={`${id}-err`} className={cn("text-xs", hasError ? "text-destructive" : "text-amber-700")}>
          {sameOnce(errors.map((e) => e.message))}
        </p>
      ) : null}
    </>
  );
  const req = required ? (
    <span className="ml-0.5 text-destructive" aria-hidden title={t("required")}>
      *
    </span>
  ) : null;
  if (asGroup)
    return (
      <fieldset className={cn("flex min-w-0 flex-col gap-1.5", className)} aria-describedby={describedBy({ id, help, errors })}>
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
          {label}
          {req}
        </legend>
        {children}
        {msgs}
      </fieldset>
    );
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
        {req}
      </Label>
      {children}
      {msgs}
    </div>
  );
}

/** The same message for several items (three images without alt text) shows once, with how many. */
function sameOnce(msgs: string[]): string {
  const n = new Map<string, number>();
  for (const m of msgs) n.set(m, (n.get(m) ?? 0) + 1);
  return [...n].map(([m, c]) => (c > 1 ? `${m} (×${c})` : m)).join(" ");
}

/** Chips with an input: Enter or comma adds, the x removes. */
export function TagsInput({ id, value, onChange, invalid, describedBy: by, required }: { id: string; value: string[]; onChange: (v: string[]) => void; invalid?: boolean; describedBy?: string; required?: boolean }) {
  const { t } = useCms();
  const [text, setText] = React.useState("");
  const add = () => {
    const parts = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setText("");
  };
  return (
    <div className={cn("flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1 focus-within:ring-1 focus-within:ring-ring", invalid && "border-destructive")}>
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
          {tag}
          <button type="button" className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={t("tag_remove", { tag })} onClick={() => onChange(value.filter((x) => x !== tag))}>
            <X aria-hidden className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        placeholder={value.length ? "" : t("tags_add")}
        aria-invalid={invalid || undefined}
        aria-describedby={by}
        aria-required={required || undefined}
        className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
      />
    </div>
  );
}

function JsonInput({ id, value, onChange, invalid, describedBy: by, onLocalError }: { id: string; value: unknown; onChange: (v: unknown) => void; invalid?: boolean; describedBy?: string; onLocalError: (msg: string | null) => void }) {
  const { t } = useCms();
  const [text, setText] = React.useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const last = React.useRef(value);
  React.useEffect(() => {
    if (JSON.stringify(last.current) !== JSON.stringify(value)) {
      setText(value === undefined ? "" : JSON.stringify(value, null, 2));
      last.current = value;
    }
  }, [value]);
  return (
    <Textarea
      id={id}
      value={text}
      rows={4}
      spellCheck={false}
      className="font-mono text-xs"
      aria-invalid={invalid || undefined}
      aria-describedby={by}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (!v.trim()) {
          last.current = undefined;
          onLocalError(null);
          onChange(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(v);
          last.current = parsed;
          onLocalError(null);
          onChange(parsed);
        } catch {
          onLocalError(t("json_invalid"));
        }
      }}
    />
  );
}

/**
 * Fields whose text cannot be turned into a value yet (JSON that does not
 * parse): the editor listens and refuses to save, so a save never quietly
 * stores the last value that did parse.
 */
export const FieldGate = React.createContext<((key: string, bad: boolean) => void) | null>(null);

// ── one custom field ─────────────────────────────────────────────────────────

export function FieldInput(props: { spec: FieldSpec; idPrefix: string; value: unknown; onChange: (v: unknown) => void; problems?: FieldProblem[] }) {
  const { t } = useCms();
  if (!props.spec.readOnly) return <FieldControl {...props} />;
  // Read-only for this person (`fieldAccess`): the value as text (selectable, copyable), not a greyed-out control.
  const id = `${props.idPrefix}-f-${props.spec.key}`;
  const v = props.value;
  const shown = v === undefined || v === null || v === "" ? null : typeof v === "boolean" ? t(v ? "field_yes" : "field_no") : Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
  return (
    <div className="min-w-0 space-y-1.5" role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-ro`}>
      <div className="flex items-center gap-2">
        <span id={`${id}-label`} className="text-sm font-medium">
          {props.spec.label}
        </span>
        <span id={`${id}-ro`} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          {t("field_read_only")}
        </span>
      </div>
      <div className={cn("min-h-9 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm break-words", typeof v === "object" && v !== null && !Array.isArray(v) && "whitespace-pre-wrap font-mono text-xs")}>
        {shown ?? <span className="text-muted-foreground">{t("field_empty_value")}</span>}
      </div>
      {props.spec.help ? <p className="text-xs text-muted-foreground">{props.spec.help}</p> : null}
    </div>
  );
}

function FieldControl({ spec, idPrefix, value, onChange, problems }: { spec: FieldSpec; idPrefix: string; value: unknown; onChange: (v: unknown) => void; problems?: FieldProblem[] }) {
  const { t } = useCms();
  const id = `${idPrefix}-f-${spec.key}`;
  const [localError, setLocalError] = React.useState<string | null>(null);
  const gate = React.useContext(FieldGate);
  React.useEffect(() => {
    gate?.(spec.key, !!localError);
    return () => gate?.(spec.key, false);
  }, [gate, spec.key, localError]);
  const errors = [...(problems ?? []), ...(localError ? [{ path: spec.key, message: localError, severity: "error" as const }] : [])];
  const invalid = errors.some((e) => e.severity === "error");
  const by = describedBy({ id, help: spec.help, errors });
  const common = { id, "aria-invalid": invalid || undefined, "aria-describedby": by, "aria-required": spec.required || undefined } as const;
  const shell = (children: React.ReactNode, o: { asGroup?: boolean; className?: string } = {}) => (
    <FieldShell id={id} label={spec.label} help={spec.help} errors={errors} required={spec.required} asGroup={o.asGroup} className={o.className}>
      {children}
    </FieldShell>
  );

  switch (spec.widget) {
    case "textarea":
      return shell(<Textarea {...common} rows={3} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />, { className: "md:col-span-2" });
    case "number":
      return shell(
        <Input
          {...common}
          type="number"
          inputMode={spec.integer ? "numeric" : "decimal"}
          step={spec.integer ? 1 : "any"}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "switch":
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2 pt-5">
            <Checkbox {...common} checked={value === true} onCheckedChange={(v) => onChange(v === true)} />
            <Label htmlFor={id} className="text-sm font-normal">
              {spec.label}
            </Label>
          </div>
          {spec.help ? (
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              {spec.help}
            </p>
          ) : null}
          {errors.length ? (
            <p id={`${id}-err`} className="text-xs text-destructive">
              {sameOnce(errors.map((e) => e.message))}
            </p>
          ) : null}
        </div>
      );
    case "select":
      return shell(
        <Select value={typeof value === "string" ? value : ""} onValueChange={(v: string | null) => onChange(!v || v === "__none" ? undefined : v)}>
          <SelectTrigger {...common} className="h-9">
            <SelectValue>{typeof value === "string" && value ? value : <span className="text-muted-foreground">{t("pick_one")}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!spec.required ? <SelectItem value="__none">{t("none")}</SelectItem> : null}
            {(spec.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "multiselect": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return shell(
        <div className="flex flex-wrap gap-x-4 gap-y-2" role="group">
          {(spec.options ?? []).map((o) => {
            const oid = `${id}-${o}`;
            return (
              <div key={o} className="flex items-center gap-1.5">
                <Checkbox
                  id={oid}
                  aria-invalid={invalid || undefined}
                  checked={arr.includes(o)}
                  onCheckedChange={(v) => {
                    const next = v === true ? [...arr, o] : arr.filter((x) => x !== o);
                    onChange(next.length ? next : undefined);
                  }}
                />
                <Label htmlFor={oid} className="text-sm font-normal">
                  {o}
                </Label>
              </div>
            );
          })}
        </div>,
        { asGroup: true }
      );
    }
    case "image":
    case "file":
      return shell(<AssetField spec={spec} id={id} value={typeof value === "string" ? value : null} onChange={onChange} invalid={invalid} describedBy={by} />, { className: "md:col-span-2", asGroup: true });
    case "relation":
      return spec.relation
        ? shell(<RelationField spec={{ key: spec.key, label: spec.label, ...spec.relation }} id={id} value={value} onChange={onChange} invalid={invalid} describedBy={by} />, { className: "md:col-span-2", asGroup: true })
        : null;
    case "gallery":
      return shell(<GalleryField id={id} label={spec.label} value={value} onChange={onChange} max={spec.max ?? null} accept={spec.accept} store={spec.store} field={spec.collection ? { collection: spec.collection, path: spec.key } : undefined} invalid={invalid} describedBy={by} />, { className: "md:col-span-2 xl:col-span-3", asGroup: true });
    case "rows":
      return spec.sub ? shell(<RowsField id={id} label={spec.label} fields={spec.sub} value={value} onChange={onChange} invalid={invalid} describedBy={by} />, { className: "md:col-span-2 xl:col-span-3", asGroup: true }) : null;
    case "group":
      return spec.sub ? shell(<GroupField id={id} fields={spec.sub} value={value} onChange={onChange} />, { className: "md:col-span-2", asGroup: true }) : null;
    case "date":
      return shell(<Input {...common} type="date" value={typeof value === "string" ? value.slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || undefined)} />);
    case "tags":
      return shell(<TagsInput id={id} required={spec.required} invalid={invalid} describedBy={by} value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => onChange(v.length ? v : undefined)} />);
    case "json":
      return shell(<JsonInput id={id} value={value} invalid={invalid} describedBy={by} onChange={onChange} onLocalError={setLocalError} />, { className: "md:col-span-2" });
    default:
      return shell(<Input {...common} value={typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />);
  }
}

/** A file from the media library: its small picture and name, or a button that opens the picker. */
function AssetField({ spec, id, value, onChange, invalid, describedBy: by }: { spec: FieldSpec; id: string; value: string | null; onChange: (v: unknown) => void; invalid?: boolean; describedBy?: string }) {
  const { t, me } = useCms();
  const asset = useAsset(value);
  const [open, setOpen] = React.useState(false);
  if (!me?.media) return <Input id={id} value={value ?? ""} aria-invalid={invalid || undefined} aria-describedby={by} onChange={(e) => onChange(e.target.value || undefined)} />;
  return (
    <div className={cn("flex min-h-[60px] items-center gap-3 rounded-md border border-input p-2", invalid && "border-destructive")} aria-describedby={by}>
      {value ? (
        <>
          {asset ? <AssetThumb asset={asset} className="aspect-[4/3] w-16 shrink-0" /> : <span className="aspect-[4/3] w-16 shrink-0 rounded-md border bg-muted" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{asset?.name ?? value}</div>
            {asset ? <div className="truncate text-xs tabular-nums text-muted-foreground">{assetMeta(asset)}</div> : null}
          </div>
          <Button type="button" variant="outline" size="sm" id={id} onClick={() => setOpen(true)}>
            {t("media_replace")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            {t("media_remove")}
          </Button>
        </>
      ) : (
        <Button type="button" variant="outline" size="sm" id={id} onClick={() => setOpen(true)}>
          {t("media_choose")}
        </Button>
      )}
      <CmsMediaPicker open={open} onOpenChange={setOpen} onPick={(a) => onChange(a.id)} kinds={spec.widget === "image" ? ["image"] : undefined} accept={spec.accept} store={spec.store} field={spec.collection ? { collection: spec.collection, path: spec.key } : undefined} />
    </div>
  );
}

// ── the whole form ───────────────────────────────────────────────────────────

export interface CmsFieldFormProps {
  /** Nothing can be changed (the person may not edit this document). */
  disabled?: boolean;
  schema: CollectionSchema;
  value: DocContent;
  onChange: (next: DocContent) => void;
  /** Problems from diagnose(), keyed by `problemKey(path)`. */
  problems?: Record<string, FieldProblem[]>;
  /** The slug cannot change once published. */
  slugLocked?: boolean;
  /** Text before the slug (e.g. "/guide/"). */
  slugPrefix?: string;
  idPrefix?: string;
  className?: string;
  /** For `slots.fieldAddon` (0.17.0): the editor's slot context. */
  slotContext?: import("./use-cms").EditorSlotContext;
  /** 0.21.0: no address or category (the one document of a single). */
  hideSlug?: boolean;
  /** 0.21.0: a note under the slug (e.g. an old address that redirects there now). */
  slugNote?: React.ReactNode;
}

export function CmsFieldForm({ schema, value, onChange, problems = {}, slugLocked, slugPrefix, idPrefix = "cms", className, slotContext, disabled, hideSlug, slugNote }: CmsFieldFormProps) {
  const { t, slots } = useCms();
  const specs = React.useMemo(() => fieldSpecs(schema), [schema]);
  const set = <K extends keyof DocContent>(k: K, v: DocContent[K]) => onChange({ ...value, [k]: v });
  const setField = (k: string, v: unknown) => {
    const fields = { ...value.fields };
    if (v === undefined) delete fields[k];
    else fields[k] = v;
    onChange({ ...value, fields });
  };

  const text = (key: "title" | "slug" | "summary", label: string, o: { mono?: boolean; disabled?: boolean; help?: string; wide?: boolean } = {}) => {
    const id = `${idPrefix}-${key}`;
    const errors = problems[key];
    const invalid = errors?.some((e) => e.severity === "error");
    const help = o.help;
    return (
      <FieldShell id={id} label={label} errors={errors} help={help} required={key !== "summary"} className={o.wide ? "md:col-span-2" : undefined}>
        <div className="relative flex items-center gap-1">
          {key === "slug" && slugPrefix ? <span className="shrink-0 font-mono text-sm text-muted-foreground">{slugPrefix}</span> : null}
          <Input
            id={id}
            value={value[key]}
            disabled={o.disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy({ id, help, errors })}
            aria-required={key !== "summary" || undefined}
            className={cn("h-9", o.mono && "font-mono", o.disabled && "pr-8")}
            onChange={(e) => set(key, e.target.value)}
          />
          {o.disabled ? <Lock aria-hidden className="absolute right-3 h-3.5 w-3.5 text-muted-foreground" /> : null}
        </div>
      </FieldShell>
    );
  };

  const catId = `${idPrefix}-category`;
  const kwId = `${idPrefix}-keywords`;
  const catErr = problems.category;
  const kwErr = problems.keywords;

  return (
    // A disabled fieldset turns off every control inside it, slots included.
    <fieldset disabled={disabled} className={cn("m-0 grid min-w-0 grid-cols-1 gap-x-3 gap-y-3 border-0 p-0 md:grid-cols-2 xl:grid-cols-3", className)}>
      {text("title", t("field_title"))}
      {hideSlug ? null : (
        <div className="min-w-0">
          {text("slug", t("field_slug"), { mono: true, disabled: slugLocked, help: slugLocked ? t("field_slug_locked") : undefined })}
          {slugNote ? <div className="mt-1 text-xs">{slugNote}</div> : null}
        </div>
      )}
      {!hideSlug && schema.categories?.length ? (
        <FieldShell id={catId} label={t("field_category")} errors={catErr}>
          <Select value={value.category ?? "__none"} onValueChange={(v: string | null) => set("category", !v || v === "__none" ? null : v)}>
            <SelectTrigger id={catId} className="h-9" aria-invalid={catErr?.some((e) => e.severity === "error") || undefined} aria-describedby={describedBy({ id: catId, errors: catErr })}>
              <SelectValue>{value.category ?? t("no_category")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">{t("no_category")}</SelectItem>
              {schema.categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldShell>
      ) : null}
      {text("summary", t("field_summary"), { wide: true })}
      {specs.map((s) => (
        <div key={s.key} className={cn("min-w-0", fieldSpan(s))}>
          <FieldInput spec={s} idPrefix={idPrefix} value={value.fields[s.key]} onChange={(v) => setField(s.key, v)} problems={problems[`fields.${s.key}`]} />
          {slots.fieldAddon && slotContext && !s.readOnly ? <div className="mt-1 flex flex-wrap gap-2">{slots.fieldAddon({ key: s.key, label: s.label, widget: s.widget }, { ...slotContext, value: value.fields[s.key], setValue: (v) => setField(s.key, v) })}</div> : null}
        </div>
      ))}
      <FieldShell id={kwId} label={t("field_keywords")} errors={kwErr}>
        <TagsInput id={kwId} value={value.keywords} onChange={(v) => set("keywords", v)} invalid={kwErr?.some((e) => e.severity === "error")} describedBy={describedBy({ id: kwId, errors: kwErr })} />
      </FieldShell>
    </fieldset>
  );
}
