/**
 * Field helpers for collection schemas (0.21.0): relations to other documents and image
 * galleries. Each helper returns an ordinary zod schema and remembers what it is, so the
 * CMS can check the values, record who points at whom, and the admin can pick the widget.
 */

import { z, type ZodTypeAny } from "zod";
import { ASSET_ID_RE } from "./storage";

/** What a marked field is. */
export type FieldMark =
  | { kind: "relation"; collections: string[]; many: boolean; max: number | null }
  | { kind: "gallery"; max: number | null; accept: string[] | null };

const MARKS = new WeakMap<object, FieldMark>();

/** A document id (uuid shape). */
export const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mark<T extends ZodTypeAny>(schema: T, m: FieldMark): T {
  MARKS.set(schema, m);
  return schema;
}

/**
 * A field that points at other documents by id: `author: relation("people")`,
 * `related: relation(["guides", "faq"], { many: true, max: 5 })`. Agents may also send
 * `{ collection, slug }`; the CMS stores the id, so the link survives a change of address.
 */
export function relation(target: string | readonly string[], o: { many: true; max?: number }): z.ZodArray<z.ZodString>;
export function relation(target: string | readonly string[], o?: { many?: false }): z.ZodString;
export function relation(target: string | readonly string[], o: { many?: boolean; max?: number } = {}): ZodTypeAny {
  const collections = typeof target === "string" ? [target] : [...target];
  const id = z.string().regex(DOC_ID_RE, "not a document id");
  const m: FieldMark = { kind: "relation", collections, many: !!o.many, max: o.max ?? null };
  if (!o.many) return mark(id.describe(`Id of a document in ${collections.join(" or ")}`), m);
  let arr = z.array(id);
  if (o.max) arr = arr.max(o.max);
  return mark(arr.describe(`Ids of documents in ${collections.join(" or ")}`), m);
}

/** Several media library files in order (a gallery): `photos: assetIds({ max: 12, accept: ["image/*"] })`. */
export function assetIds(o: { max?: number; accept?: readonly string[] } = {}): z.ZodArray<z.ZodString> {
  let arr = z.array(z.string().regex(ASSET_ID_RE, "not a file id"));
  if (o.max) arr = arr.max(o.max);
  return mark(arr, { kind: "gallery", max: o.max ?? null, accept: o.accept ? [...o.accept] : null });
}

type AnyDef = Record<string, unknown> & { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny; in?: ZodTypeAny; getter?: () => ZodTypeAny; shape?: unknown };
const defOf = (s: ZodTypeAny): AnyDef => ((s as unknown as { _def?: AnyDef })._def ?? {}) as AnyDef;

/** The mark on a schema or on any wrapper around it (`.optional()`, `.nullable()`, `.default()`). */
export function markOf(schema: ZodTypeAny | undefined): FieldMark | null {
  let s: ZodTypeAny | undefined = schema;
  for (let i = 0; s && i < 12; i++) {
    const m = MARKS.get(s);
    if (m) return m;
    const d = defOf(s);
    const v4: { innerType?: ZodTypeAny; in?: ZodTypeAny } | undefined = (s as unknown as { _zod?: { def?: { innerType?: ZodTypeAny; in?: ZodTypeAny } } })._zod?.def;
    s = d.innerType ?? d.schema ?? (d.typeName === "ZodPipeline" ? d.in : undefined) ?? v4?.innerType ?? v4?.in;
  }
  return null;
}

/** The object shape under wrappers, or null. */
function shapeOf(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  let s: ZodTypeAny | undefined = schema;
  for (let i = 0; s && i < 12; i++) {
    const d = defOf(s);
    if (d.typeName === "ZodObject") return (typeof d.shape === "function" ? (d.shape as () => Record<string, ZodTypeAny>)() : d.shape) as Record<string, ZodTypeAny>;
    const v4: { type?: string; shape?: Record<string, ZodTypeAny>; innerType?: ZodTypeAny } | undefined = (s as unknown as { _zod?: { def?: { type?: string; shape?: Record<string, ZodTypeAny>; innerType?: ZodTypeAny } } })._zod?.def;
    if (v4?.type === "object" && v4.shape) return v4.shape;
    s = d.innerType ?? d.schema ?? (d.typeName === "ZodPipeline" ? d.in : undefined) ?? v4?.innerType;
  }
  return null;
}

/** Every marked field in a collection's `fields`, by dotted path (nested objects included). */
export function fieldMarks(fields: ZodTypeAny | undefined): Map<string, FieldMark> {
  const out = new Map<string, FieldMark>();
  if (!fields) return out;
  const walk = (s: ZodTypeAny, prefix: string, depth: number) => {
    const shape = shapeOf(s);
    if (!shape || depth > 4) return;
    for (const [k, v] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const m = markOf(v);
      if (m) out.set(path, m);
      else walk(v, path, depth + 1);
    }
  };
  walk(fields, "", 0);
  return out;
}

/** The JSON Schema extension for a marked schema (`x-cms-relation`, `x-cms-gallery`). */
export function markJson(m: FieldMark): Record<string, unknown> {
  return m.kind === "relation" ? { "x-cms-relation": { collections: m.collections, many: m.many, max: m.max } } : { "x-cms-gallery": { max: m.max, accept: m.accept } };
}
