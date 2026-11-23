/**
 * Multilingual documents (0.22.0). A translation is a document row with the same slug as its
 * source, its own `locale`, and `groupId` set to the source's id. Each one has its own versions,
 * drafts, publish state and schedule. What is translated: title, summary, body, keywords, seo and
 * the string fields of the schema; everything else (dates, numbers, switches, relations, files,
 * choices) belongs to the source and is filled in on read.
 *
 * Inside the CMS a translation is addressed as `slug@locale` (see `localeAddress`), so every
 * function that takes a slug (publish, versions, schedule, comments…) works on a translation too.
 * Apps without `locales` never see any of this: rows keep locale "" and the repo is not wrapped.
 */

import type { ZodTypeAny } from "zod";
import { markOf } from "./fields";
import type { CmsRepo, FindOptions } from "./repo";
import type { CmsDoc, FieldAdmin } from "./types";

/** A language tag: `ko`, `en`, `pt-BR`, `zh-Hant`. */
export const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Translation status of one locale of a document. */
export type TranslationStatus = "source" | "missing" | "outdated" | "current";

/** One row of `cms.translations()`. */
export interface TranslationInfo {
  locale: string;
  status: TranslationStatus;
  /** Latest version of this locale's document (null: missing). */
  version: number | null;
  /** The source version this translation was last aligned to (null: the source, or missing). */
  sourceVersion: number | null;
  publishedVersion: number | null;
  updatedAt: string | null;
  /** Document state (draft, published, archived) of this locale (null: missing). */
  docStatus: CmsDoc["status"] | null;
  /** Where the site shows this language of the document (the collection's `url()`), or null. */
  url: string | null;
}

/** The answer of `cms.translations()`. */
export interface TranslationList {
  collection: string;
  slug: string;
  defaultLocale: string;
  /**
   * The source version translations are compared with: its published version, or its latest when never
   * published. `null` for a reader who may not read the source (review 0.22).
   */
  sourceVersion: number | null;
  translations: TranslationInfo[];
}

/** `slug@locale`: how a translation is named wherever the CMS takes a slug. */
export const localeAddress = (slug: string, locale?: string | null): string => (locale ? `${slug}@${locale}` : slug);

/** `about@en` → { slug: "about", locale: "en" }; `about` → { slug: "about", locale: null }. */
export function splitAddress(address: string): { slug: string; locale: string | null } {
  const at = address.lastIndexOf("@");
  if (at <= 0) return { slug: address, locale: null };
  const locale = address.slice(at + 1);
  return LOCALE_RE.test(locale) ? { slug: address.slice(0, at), locale } : { slug: address, locale: null };
}

/** A translation row (it belongs to another document's group). */
export const isTranslationDoc = (d: { id: string; groupId?: string | null }): boolean => !!d.groupId && d.groupId !== d.id;

type AnyDef = Record<string, unknown> & { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny; in?: ZodTypeAny; shape?: unknown; checks?: { kind?: string }[] };
type V4Def = { type?: string; innerType?: ZodTypeAny; in?: ZodTypeAny; element?: ZodTypeAny; format?: string; shape?: Record<string, ZodTypeAny> };
const defOf = (s: ZodTypeAny): AnyDef => ((s as unknown as { _def?: AnyDef })._def ?? {}) as AnyDef;
const v4Of = (s: ZodTypeAny): V4Def | undefined => (s as unknown as { _zod?: { def?: V4Def } })._zod?.def;

/** The schema under `.optional()`, `.nullable()`, `.default()`, `.refine()`. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let s = schema;
  for (let i = 0; i < 12; i++) {
    const d = defOf(s);
    const v4 = v4Of(s);
    const next = d.innerType ?? d.schema ?? (d.typeName === "ZodPipeline" ? d.in : undefined) ?? v4?.innerType ?? (v4?.type === "pipe" ? v4.in : undefined);
    if (!next) return s;
    s = next;
  }
  return s;
}

/** String checks that keep a value prose (anything else, e.g. url, email, uuid, regex, date, is data). */
const PROSE_CHECKS = new Set(["min", "max", "length", "trim", "toLowerCase", "toUpperCase", "includes", "startsWith", "endsWith"]);

function isProseString(schema: ZodTypeAny): boolean {
  if (markOf(schema)) return false;
  const s = unwrap(schema);
  const d = defOf(s);
  if (d.typeName === "ZodString") return (d.checks ?? []).every((c) => PROSE_CHECKS.has(c.kind ?? ""));
  const v4 = v4Of(s);
  if (v4?.type === "string") return !v4.format;
  return false;
}

function shapeOf(schema: ZodTypeAny | undefined): Record<string, ZodTypeAny> | null {
  if (!schema) return null;
  const s = unwrap(schema);
  const d = defOf(s);
  if (d.typeName === "ZodObject") return (typeof d.shape === "function" ? (d.shape as () => Record<string, ZodTypeAny>)() : d.shape) as Record<string, ZodTypeAny>;
  const v4 = v4Of(s);
  return v4?.type === "object" && v4.shape ? v4.shape : null;
}

const SHARED_WIDGETS = new Set<FieldAdmin["widget"]>(["number", "switch", "select", "multiselect", "date", "image", "file", "gallery", "relation", "json"]);

/**
 * Which top-level fields of a collection are translated: prose strings (`z.string()` with no
 * format) and lists of them, unless `admin.fields.<name>.localized` says otherwise. Fields picked
 * with a choice, date, file or relation widget are shared. Nested objects and lists of objects are
 * shared as a whole unless marked `localized: true`.
 */
export function translatableFields(cfg: { fields?: ZodTypeAny; admin?: { fields?: Record<string, FieldAdmin> } }): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const shape = shapeOf(cfg.fields);
  if (!shape) return out;
  for (const [k, v] of Object.entries(shape)) {
    const admin = cfg.admin?.fields?.[k];
    if (admin?.localized !== undefined) {
      out[k] = !!admin.localized;
      continue;
    }
    if (admin?.widget && SHARED_WIDGETS.has(admin.widget)) {
      out[k] = false;
      continue;
    }
    if (markOf(v)) {
      out[k] = false;
      continue;
    }
    const inner = unwrap(v);
    const d = defOf(inner);
    const v4 = v4Of(inner);
    const element = d.typeName === "ZodArray" ? (d.type as ZodTypeAny | undefined) : v4?.type === "array" ? v4.element : undefined;
    out[k] = isProseString(v) || (!!element && isProseString(element));
  }
  return out;
}

/**
 * The repo as the CMS sees it when locales are on: `findDoc(col, "slug@en")` finds the English
 * translation, `findDoc(col, "slug@<default>")` the source, and source rows of localized collections
 * written before locales were turned on (locale "") read as the default language.
 */
export function localeRepo(base: CmsRepo, o: { defaultLocale: string; localized: (col: string) => boolean }): CmsRepo {
  const norm = (d: CmsDoc | null): CmsDoc | null => {
    if (!d || d.locale || !o.localized(d.collection)) return d;
    return { ...d, locale: o.defaultLocale };
  };
  const normAll = (ds: CmsDoc[]) => ds.map((d) => norm(d)!);
  const wrap = (r: CmsRepo): CmsRepo => {
    const proxy: CmsRepo = new Proxy(r, {
      get(target, prop) {
        if (prop === "findDoc")
          return async (col: string, slug: string, f: FindOptions = {}) => {
            const { slug: s, locale } = splitAddress(slug);
            if (!locale || !o.localized(col)) return norm(await target.findDoc(col, slug, f));
            if (locale === o.defaultLocale) return norm(await target.findDoc(col, s, f));
            return norm(await target.findDoc(col, s, { ...f, locale }));
          };
        if (prop === "findDocById") return async (id: string, f?: FindOptions) => norm(await target.findDocById(id, f));
        if (prop === "listDocs") return async (f: Parameters<CmsRepo["listDocs"]>[0]) => normAll(await target.listDocs(f));
        if (prop === "findDocsByIds" && target.findDocsByIds) return async (ids: readonly string[]) => normAll(await target.findDocsByIds!(ids));
        if (prop === "pageDocs" && target.pageDocs)
          return async (q: Parameters<NonNullable<CmsRepo["pageDocs"]>>[0]) => {
            const p = await target.pageDocs!(q);
            return { ...p, docs: normAll(p.docs) };
          };
        if (prop === "tx") return <T>(fn: (r: CmsRepo) => Promise<T>, txo?: { atomic?: boolean }) => target.tx((inner) => fn(inner === target ? proxy : wrap(inner)), txo);
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return proxy;
  };
  return wrap(base);
}

/** The source version translations follow: the published one, or the latest when never published. */
export const referenceVersion = (source: Pick<CmsDoc, "version" | "publishedVersion">): number => source.publishedVersion ?? source.version;

/** Status of a translation against its source. */
export function statusOf(source: Pick<CmsDoc, "version" | "publishedVersion">, t: Pick<CmsDoc, "sourceVersion"> | null): TranslationStatus {
  if (!t) return "missing";
  return (t.sourceVersion ?? 0) < referenceVersion(source) ? "outdated" : "current";
}

/** A cache/ETag-safe form of a locale (`pt-BR` → `ptbr`). */
export const localeTag = (locale: string): string => locale.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How the CMS names a document row: `slug` for a source, `slug@locale` for a translation. */
export const docAddress = (d: { id: string; slug: string; locale?: string; groupId?: string | null }): string => (isTranslationDoc(d) && d.locale ? `${d.slug}@${d.locale}` : d.slug);
