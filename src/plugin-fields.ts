/**
 * 0.24.0: a plugin's settings schema (zod) described as form fields, so the admin can draw
 * the settings dialog without zod in the browser. Works with zod 3 and zod 4 schemas: it
 * reads `_def.typeName` (3) or `_zod.def.type` (4) and never imports zod itself.
 *
 * Kinds: string, number, boolean, enum, url, secret; anything else is `json` (a text area
 * that takes JSON). A secret is a field whose description is `"secret"` or starts with
 * `"secret:"` (the rest is its label).
 */

export type SettingFieldType = "string" | "number" | "boolean" | "enum" | "url" | "secret" | "json";

export interface SettingField {
  key: string;
  type: SettingFieldType;
  /** The schema's `.describe()` text (without the `secret:` mark), else the key. */
  label: string;
  /** Can be left empty (optional, nullable or with a default). */
  optional: boolean;
  /** The schema's default, when it has one (never for secrets). */
  default?: unknown;
  /** The choices of an `enum`, as text. */
  options?: string[];
  /** The same choices with their real types (`1`, `true`), in the same order, to send back. */
  choices?: (string | number | boolean)[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const desc = (s: any): string | undefined => {
  try {
    const d = s?.description ?? s?._def?.description;
    return typeof d === "string" ? d : undefined;
  } catch {
    return undefined;
  }
};

/** `"secret"` or `"secret: Label"`. */
export const isSecretDescription = (d: string | undefined): boolean => d === "secret" || (typeof d === "string" && /^secret\s*:/.test(d));

/** The kind of a zod node (zod 3 `ZodString` → `string`; zod 4 `string`). */
function kindOf(s: any): string {
  const v4 = s?._zod?.def?.type;
  if (typeof v4 === "string") return v4;
  const v3 = s?._def?.typeName;
  return typeof v3 === "string" ? v3.replace(/^Zod/, "").toLowerCase() : "unknown";
}

function defaultOf(s: any): unknown {
  const d = s?._zod?.def?.defaultValue ?? s?._def?.defaultValue;
  try {
    return typeof d === "function" ? d() : d;
  } catch {
    return undefined;
  }
}

function isUrl(s: any): boolean {
  if (s?._zod?.def?.format === "url") return true;
  const checks: any[] = s?._def?.checks ?? s?._zod?.def?.checks ?? [];
  return checks.some((c) => c?.kind === "url" || c?._zod?.def?.format === "url" || c?.format === "url");
}

/** The values of an enum object, without a TS numeric enum's reverse entries (`{ "0": "A" }`). */
function enumValues(obj: Record<string, unknown>): unknown[] {
  return Object.keys(obj)
    .filter((n) => !(typeof obj[n] === "string" && n !== "" && String(Number(n)) === n && obj[obj[n] as string] === Number(n)))
    .map((n) => obj[n]);
}

const WRAPPERS = new Set(["optional", "nullable", "nullish", "default", "prefault", "effects", "pipe", "pipeline", "readonly", "catch", "branded", "brand", "lazy"]);

interface Peeled {
  /** The innermost (value) schema. */
  inner: any;
  /** Every description met on the way in, outermost first. */
  descriptions: string[];
  optional: boolean;
  /** The outermost default node, if any (not evaluated). */
  defaultNode: any;
}

/** Peel optional/nullable/default/effects/pipe/readonly/catch/brand wrappers, collecting descriptions. */
function peel(schema: unknown): Peeled {
  let s: any = schema;
  let optional = false;
  let defaultNode: any;
  const descriptions: string[] = [];
  for (let i = 0; s && i < 12; i++) {
    const d = desc(s);
    if (d !== undefined && descriptions[descriptions.length - 1] !== d) descriptions.push(d);
    const k = kindOf(s);
    if (!WRAPPERS.has(k)) break;
    if (k === "optional" || k === "nullable" || k === "nullish") optional = true;
    else if (k === "default" || k === "prefault") {
      optional = true;
      defaultNode ??= s;
    }
    const next =
      k === "lazy"
        ? (() => {
            try {
              return s._zod?.def?.getter?.() ?? s._def?.getter?.();
            } catch {
              return undefined;
            }
          })()
        : (s._zod?.def?.innerType ?? s._zod?.def?.in ?? s._def?.innerType ?? s._def?.schema ?? s._def?.in ?? s._def?.type);
    if (!next || next === s) break;
    s = next;
  }
  return { inner: s, descriptions, optional, defaultNode };
}

/**
 * Whether a settings field is a secret: any description on it, outside or inside its wrappers
 * (optional, default, pipe, …), is `"secret"` or starts with `"secret:"`. The one rule used for
 * sealing, masking and the form, so they never disagree.
 */
export function isSecretSchema(schema: unknown): boolean {
  return secretMarked(schema, new Set());
}

/** Any `secret` mark on the schema or any wrapper or pipe side under it (both `in` and `out`). */
function secretMarked(s: any, seen: Set<unknown>): boolean {
  if (!s || typeof s !== "object" || seen.has(s) || seen.size > 64) return false;
  seen.add(s);
  if (isSecretDescription(desc(s))) return true;
  if (!WRAPPERS.has(kindOf(s))) return false;
  const d = s._zod?.def ?? {};
  const d3 = s._def ?? {};
  let lazy: unknown;
  if (kindOf(s) === "lazy")
    try {
      lazy = d.getter?.() ?? d3.getter?.();
    } catch {
      lazy = undefined;
    }
  return [d.innerType, d.in, d.out, d3.innerType, d3.schema, d3.in, d3.out, d3.type, lazy].some((n) => n && secretMarked(n, seen));
}

/** One field of an object schema. */
export function describeSetting(key: string, schema: unknown): SettingField {
  const { inner, descriptions, optional, defaultNode } = peel(schema);
  const secret = isSecretSchema(schema);
  // The label: a `secret: Label` text, else the first description that is not the bare mark.
  const marked = descriptions.find((d) => /^secret\s*:/.test(d));
  const plain = descriptions.find((d) => !isSecretDescription(d));
  const text = marked ? marked.replace(/^secret\s*:\s*/, "") || plain : plain;
  const base = { key, label: text || key, optional };
  // A secret's default is never evaluated nor sent.
  if (secret) return { ...base, type: "secret" };
  const dflt = defaultNode ? defaultOf(defaultNode) : undefined;
  const s = inner;
  const k = kindOf(s);
  const withDefault = <T extends SettingField>(f: T): T => (dflt === undefined ? f : { ...f, default: dflt });
  if (k === "string") return withDefault({ ...base, type: isUrl(s) ? "url" : "string" });
  if (k === "url") return withDefault({ ...base, type: "url" });
  if (k === "number" || k === "int") return withDefault({ ...base, type: "number" });
  if (k === "boolean") return withDefault({ ...base, type: "boolean" });
  const choice = (vals: unknown[]) => {
    const typed = vals.filter((v): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
    return withDefault({ ...base, type: "enum" as const, options: typed.map(String), choices: typed });
  };
  if (k === "enum") {
    const raw = s._def?.values ?? s._zod?.def?.entries ?? s.options;
    return choice(Array.isArray(raw) ? raw : enumValues(raw ?? {}));
  }
  if (k === "nativeenum") return choice(enumValues(s._def?.values ?? {}));
  if (k === "literal") return choice(s._def?.value !== undefined ? [s._def.value] : (s._zod?.def?.values ?? []));
  return withDefault({ ...base, type: "json" });
}

/** Every field of an object schema's shape, in order. */
export function describeSettings(shape: Record<string, unknown>): SettingField[] {
  return Object.keys(shape).map((k) => describeSetting(k, shape[k]));
}
