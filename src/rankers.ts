/**
 * Search rankers (0.25.0, roadmap 135): a plugin adds a ranking of its own to the CMS's keyword
 * search (an embedding index, a click log, a synonym list, ...). The CMS asks every ranker in
 * parallel with its own keyword search, waits at most `timeoutMs`, and merges the lists with
 * reciprocal rank fusion (RRF), so scores in different units can be merged. Read rules are applied
 * after the merge: a ranker that returns a draft, a hidden document or another language changes
 * nothing.
 *
 *   definePlugin({
 *     name: "vectors",
 *     setup(ctx) {
 *       ctx.search.ranker({
 *         name: "embeddings",
 *         async rank(query, { collections, locale, limit, signal }) {
 *           return myVectorTable.nearest(query, { collections, locale, limit, signal });  // [{ documentId, section, score }]
 *         },
 *       });
 *     },
 *   });
 *
 * The package never calls a model: embeddings, vector tables and model settings belong to the
 * plugin. `cms.searchSections()` gives it the very sections the keyword index holds.
 */
import { hex, sha256 } from "./crypto";
import { plainText } from "./markdown";
import type { SearchHit, SearchUnit } from "./search";
import type { Actor } from "./types";

/** What a ranker returns: documents (by id), best first. */
export interface SearchRankerHit {
  /** The document's id (`CmsDoc.id`, `SearchSection.docId`). */
  documentId: string;
  /** The section's anchor (`SearchSection.anchor`; `""` = the part before the first heading). Leave it out to let the CMS pick. */
  section?: string | null;
  /** The ranker's own score. Only the order counts in the merge; it is kept for your logs. */
  score?: number;
}

/** What a ranker is told about the search. */
export interface SearchRankContext {
  /** The collections searched (all of them readable by the caller). */
  collections: string[];
  /** The language searched in localized collections (null without locales). */
  locale: string | null;
  /** How many documents are worth returning. */
  limit: number;
  /** Aborted when the ranker runs out of time: pass it to `fetch` and database calls. */
  signal: AbortSignal;
  /** Who is searching. Read rules are applied after the merge anyway. */
  actor: Actor;
}

export interface SearchRanker {
  /** Lowercase letters, digits, `-` and `_`. Its full name is `<plugin>.<name>` (in `matchedBy` and telemetry). */
  name: string;
  rank(query: string, ctx: SearchRankContext): readonly SearchRankerHit[] | Promise<readonly SearchRankerHit[]>;
  /** Its weight in the merge (the keyword search has 1). Default 1. */
  weight?: number;
  /** How long to wait for it (ms). Default 500, at most 2000. Late or failing: skipped for this search. */
  timeoutMs?: number;
}

export const RRF_K = 60;
export const RANKER_TIMEOUT_MS = 500;
export const RANKER_TIMEOUT_MAX_MS = 2000;
/** The keyword search's name in `matchedBy`. */
export const KEYWORD_RANKER = "keyword";
export const RANKER_NAME = /^[a-z][a-z0-9_-]{0,40}$/;
/** At most this many hits of one ranker are read. */
export const RANKER_MAX_HITS = 200;

export interface RankerRun {
  name: string;
  ok: boolean;
  ms: number;
  hits: SearchRankerHit[];
  error: unknown;
  timedOut: boolean;
}

export function rankerTimeout(r: { timeoutMs?: number }): number {
  const t = r.timeoutMs;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return RANKER_TIMEOUT_MS;
  return Math.min(Math.round(t), RANKER_TIMEOUT_MAX_MS);
}

export function rankerWeight(r: { weight?: number }): number {
  const w = r.weight;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
}

/** Ask one ranker, never longer than its time limit; it never throws. */
export async function runRanker(full: string, r: SearchRanker, query: string, ctx: Omit<SearchRankContext, "signal">, now: () => number = Date.now): Promise<RankerRun> {
  const started = now();
  const ms = rankerTimeout(r);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((ok) => (timer = setTimeout(() => ok("late"), ms)));
  try {
    const out = await Promise.race([Promise.resolve().then(() => r.rank(query, { ...ctx, collections: [...ctx.collections], signal: ac.signal })), late]);
    // A ranker that blocks (synchronous work) cannot be stopped; its late answer is not used either.
    if (out === "late" || now() - started > ms) {
      ac.abort();
      return { name: full, ok: false, ms: now() - started, hits: [], error: new Error(`the search ranker ${full} took longer than ${ms} ms`), timedOut: true };
    }
    if (!Array.isArray(out)) throw new Error(`the search ranker ${full} did not return a list`);
    const hits: SearchRankerHit[] = [];
    for (const h of out.slice(0, RANKER_MAX_HITS)) {
      if (!h || typeof h !== "object" || typeof h.documentId !== "string" || !h.documentId) continue;
      hits.push({ documentId: h.documentId, section: typeof h.section === "string" ? h.section : null, ...(typeof h.score === "number" && Number.isFinite(h.score) ? { score: h.score } : {}) });
    }
    return { name: full, ok: true, ms: now() - started, hits, error: null, timedOut: false };
  } catch (error) {
    ac.abort();
    return { name: full, ok: false, ms: now() - started, hits: [], error, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

// ── sections: what the keyword index holds, for a plugin that keeps its own index ──

/** One section of a published, searchable document, as the keyword index holds it. */
export interface SearchSection {
  docId: string;
  collection: string;
  slug: string;
  /** The document's language (localized collections only). */
  locale: string | null;
  /** The published version the section was cut from. */
  version: number | null;
  title: string;
  summary: string;
  category: string | null;
  keywords: string[];
  /** `""` = the part before the first `##` heading. */
  anchor: string;
  heading: string;
  /** The section's markdown, snippets filled in. */
  markdown: string;
  /** The same as plain text (what the keyword index reads). */
  text: string;
  /** sha256 of what is indexed (title, summary, category, keywords, heading, text, language): unchanged hash, nothing to embed again. */
  hash: string;
}

/** A document named by its address, as events name it (`slug` may be `slug@locale` for a translation). */
export interface SearchDocRef {
  collection: string;
  slug: string;
  locale?: string | null;
}

export interface SearchSectionsOptions {
  /** These documents only (up to 200). Ids not in the index come back in `missing`. */
  docIds?: readonly string[];
  /** These documents only, by address (up to 200): what events carry. Ones not in the index come back in `missing`. */
  docs?: readonly SearchDocRef[];
  /** Every searchable document of these collections (paged). Default: all. */
  collections?: readonly string[];
  /** From `next` of the page before (listing everything). */
  cursor?: string | null;
  /** Documents per page when listing everything. Default 100, at most 500. */
  limit?: number;
}

export interface SearchSectionsPage {
  sections: SearchSection[];
  /** What was asked for and is not searchable now (unpublished, deleted, archived, search off): remove it from your index. */
  missing: { docIds: string[]; docs: SearchDocRef[] };
  /** Pass as `cursor` for the next page; null on the last one. */
  next: string | null;
}

export const SECTIONS_MAX_IDS = 200;
export const SECTIONS_PAGE = 100;
export const SECTIONS_PAGE_MAX = 500;

export function sectionOf(u: SearchUnit): SearchSection {
  const text = plainText(u.markdown);
  const locale = u.locale ?? null;
  const hash = hex(sha256(JSON.stringify([u.title, u.summary, u.category, u.keywords, u.heading, text, locale])));
  return { docId: u.docId, collection: u.collection, slug: u.slug, locale, version: u.version ?? null, title: u.title, summary: u.summary, category: u.category, keywords: [...u.keywords], anchor: u.anchor, heading: u.heading, markdown: u.markdown, text, hash };
}

/** Read `cms.searchSections` options off the units of the keyword index. Throws a plain Error on bad input. */
export function pickSections(units: readonly SearchUnit[], o: SearchSectionsOptions, lang: { localized: (collection: string) => boolean; defaultLocale: string | undefined }): SearchSectionsPage {
  const ids = o.docIds ? [...new Set(o.docIds.filter((x) => typeof x === "string" && x))] : null;
  const refs = o.docs ? o.docs.filter((r) => r && typeof r.collection === "string" && typeof r.slug === "string") : null;
  if ((ids?.length ?? 0) + (refs?.length ?? 0) > SECTIONS_MAX_IDS) throw new Error(`at most ${SECTIONS_MAX_IDS} documents at a time`);
  if (ids || refs) {
    const byId = new Map<string, SearchUnit[]>();
    for (const u of units) {
      const l = byId.get(u.docId);
      if (l) l.push(u);
      else byId.set(u.docId, [u]);
    }
    const want = new Set<string>();
    const missingIds: string[] = [];
    for (const id of ids ?? []) {
      if (byId.has(id)) want.add(id);
      else missingIds.push(id);
    }
    const missingDocs: SearchDocRef[] = [];
    for (const r of refs ?? []) {
      // Events name a translation `slug@locale`.
      const at = r.slug.lastIndexOf("@");
      const slug = at > 0 ? r.slug.slice(0, at) : r.slug;
      const locale = r.locale || (at > 0 ? r.slug.slice(at + 1) : null);
      const loc = lang.localized(r.collection);
      const hit = units.find((u) => u.collection === r.collection && u.slug === slug && (!loc || (u.locale ?? lang.defaultLocale) === (locale || lang.defaultLocale)));
      if (hit) want.add(hit.docId);
      else missingDocs.push({ collection: r.collection, slug: r.slug, ...(r.locale ? { locale: r.locale } : {}) });
    }
    const sections = units.filter((u) => want.has(u.docId)).map(sectionOf);
    return { sections, missing: { docIds: missingIds, docs: missingDocs }, next: null };
  }
  const cols = o.collections ? new Set(o.collections) : null;
  const per = Math.max(1, Math.min(Math.floor(o.limit ?? SECTIONS_PAGE) || SECTIONS_PAGE, SECTIONS_PAGE_MAX));
  const docIds = [...new Set(units.filter((u) => !cols || cols.has(u.collection)).map((u) => u.docId))].sort();
  const from = o.cursor ? docIds.findIndex((id) => id > o.cursor!) : 0;
  const page = from < 0 ? [] : docIds.slice(from, from + per);
  const want = new Set(page);
  const sections = units.filter((u) => want.has(u.docId)).map(sectionOf);
  const last = page[page.length - 1];
  const next = page.length && from + per < docIds.length ? last : null;
  return { sections, missing: { docIds: [], docs: [] }, next };
}

const keyOf = (u: SearchUnit) => `${u.docId}#${u.anchor}`;

/** A hit after the merge: `score` is the fused score, `matchedBy` the rankings that found it. */
export type FusedHit = SearchHit & { matchedBy: string[] };

/**
 * Reciprocal rank fusion: each list adds `weight / (k + rank)` (rank from 1) to the units it holds.
 * Ties keep the keyword order, then the order the lists were given in.
 */
export function fuse(lists: { name: string; weight: number; units: SearchUnit[] }[], coverage: (u: SearchUnit) => number): FusedHit[] {
  const acc = new Map<string, { unit: SearchUnit; score: number; matchedBy: string[]; first: number }>();
  let seq = 0;
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const u of list.units) {
      const k = keyOf(u);
      if (seen.has(k)) continue;
      seen.add(k);
      rank++;
      const add = list.weight / (RRF_K + rank);
      const cur = acc.get(k);
      if (cur) {
        cur.score += add;
        cur.matchedBy.push(list.name);
      } else acc.set(k, { unit: u, score: add, matchedBy: [list.name], first: seq++ });
    }
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map((x) => ({ unit: x.unit, score: x.score, coverage: coverage(x.unit), matchedBy: x.matchedBy }));
}
