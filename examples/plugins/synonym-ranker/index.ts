/**
 * synonym-ranker: a search ranker that finds sections by synonyms admins keep, with no model.
 *
 *   import synonymRanker from "./plugins/synonym-ranker";
 *   createCms({ ..., plugins: [synonymRanker()] });
 *
 * An admin writes groups of words that mean the same on the Plugins screen, groups separated by
 * `;` (or lines), words by commas:
 *
 *   payment, card approval, checkout; 결제, 카드 승인
 *
 * A search for "payment fails" then also finds the section that only says "card approval". The CMS
 * merges this ranking with its own keyword search (reciprocal rank fusion) and applies its read
 * rules afterwards, so a draft or a hidden document never shows.
 *
 * It also shows how to follow the keyword index: `start` reads every section once
 * (`ctx.search.sections()`, a page at a time), and the events that change what search finds
 * (published, updated, unpublished, archived, deleted, restored, moved, `search.stale`) read the
 * sections of that document again.
 *
 * One server only: the index is kept in memory, and an event is heard on the server where the
 * write happened. With several servers (or serverless), keep the index in a table (`sql`), do
 * the work in a job (`ctx.job`), and read everything again now and then (a scheduled job) to
 * catch what was missed. Collection settings (`search.enabled`, locales) change with a deploy:
 * `start` reads everything again then.
 */
import { definePlugin, type CmsEvent, type PluginContext, type SearchSection } from "@mainsoft/agent-cms";
import { z } from "zod";

const settings = z.object({
  synonyms: z.string().max(20_000).default("").describe("Synonyms: groups separated by ; and words by commas"),
});
type Settings = z.infer<typeof settings>;

interface Entry {
  collection: string;
  slug: string;
  locale: string | null;
  anchor: string;
  /** Lowercased title, heading and text. */
  text: string;
}

/** "a, b c; d, e" (or one group per line) → [["a", "b c"], ["d", "e"]] */
export function parseGroups(text: string): string[][] {
  return text
    .split(/[;\n]/)
    .map((line) => [...new Set(line.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean))])
    .filter((g) => g.length > 1);
}

/** The query's words, plus every synonym of a word or phrase it contains. */
export function expand(query: string, groups: string[][]): string[] {
  const q = query.toLowerCase();
  const words = new Set(q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  for (const g of groups) if (g.some((w) => q.includes(w))) for (const w of g) words.add(w);
  return [...words];
}

/** The events after which a document may read differently in search, or not be searchable at all. */
const FOLLOW = ["doc.published", "doc.updated", "doc.unpublished", "doc.archived", "doc.deleted", "doc.restored", "doc.moved"] as const;

/** The sections, by document id: what the ranker reads. */
class SynonymIndex {
  private docs = new Map<string, Entry[]>();

  put(sections: SearchSection[]) {
    const byDoc = new Map<string, Entry[]>();
    for (const s of sections) {
      const list = byDoc.get(s.docId) ?? [];
      list.push({ collection: s.collection, slug: s.slug, locale: s.locale, anchor: s.anchor, text: `${s.title}\n${s.heading}\n${s.text}`.toLowerCase() });
      byDoc.set(s.docId, list);
    }
    for (const [id, list] of byDoc) this.docs.set(id, list);
  }

  /** Ids of the documents at this address (with a language: that one only; without: every language). */
  idsAt(collection: string, slug: string, lang?: string | null): string[] {
    const at = slug.lastIndexOf("@");
    const base = at > 0 ? slug.slice(0, at) : slug;
    const locale = lang || (at > 0 ? slug.slice(at + 1) : null);
    return [...this.docs].filter(([, l]) => l[0]?.collection === collection && l[0].slug === base && (!locale || l[0].locale === locale)).map(([id]) => id);
  }

  drop(ids: string[]) {
    for (const id of ids) this.docs.delete(id);
  }

  clear() {
    this.docs.clear();
  }

  entries() {
    return this.docs.entries();
  }
}

export default definePlugin({
  name: "synonym-ranker",
  version: "1.0.0",
  engine: ">=0.25",
  options: z.object({
    /** Its weight next to the keyword search (which has 1). */
    weight: z.number().positive().default(1),
  }),
  settings,
  setup(ctx, options) {
    const index = new SynonymIndex();
    indexes.set(ctx, index);

    // One document changed: read its sections again. When it is not searchable any more, the CMS
    // says so in `missing`: drop what was kept at that address (and read back the other languages).
    const follow = async (e: CmsEvent) => {
      if (!e.collection || !e.slug) return;
      // Events carry the language of a translated document: pass it on.
      const page = await ctx.search.sections({ docs: [{ collection: e.collection, slug: e.slug, locale: e.locale ?? null }] });
      if (page.missing.docs.length) {
        const ids = index.idsAt(e.collection, e.slug, e.locale);
        index.drop(ids);
        if (ids.length) index.put((await ctx.search.sections({ docIds: ids })).sections);
      }
      index.put(page.sections);
    };
    for (const event of FOLLOW) ctx.on(event, follow);
    // A snippet changed what other documents read: read everything again. Otherwise (a document
    // back from the archive) it names the document.
    ctx.on("search.stale", (e) => ((e.detail as { reason?: string } | undefined)?.reason === "snippet" ? reread(ctx, index) : follow(e)));

    ctx.search.ranker({
      name: "synonyms",
      weight: options.weight,
      rank(query, { collections, locale, limit }) {
        const groups = parseGroups(ctx.settings<Settings>().synonyms);
        if (!groups.length) return [];
        const terms = expand(query, groups);
        const scored: { documentId: string; section: string; score: number }[] = [];
        for (const [documentId, entries] of index.entries()) {
          for (const e of entries) {
            if (!collections.includes(e.collection) || (locale && e.locale && e.locale !== locale)) continue;
            const score = terms.filter((t) => e.text.includes(t)).length;
            if (score) scored.push({ documentId, section: e.anchor, score });
          }
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, limit);
      },
    });
  },
  async start(ctx) {
    await reread(ctx, indexes.get(ctx)!);
  },
});

/** One index per CMS the plugin is given to: `setup` and `start` get the same `ctx`. */
const indexes = new WeakMap<PluginContext, SynonymIndex>();

/** Read every section, a page at a time, then swap the index. */
async function reread(ctx: PluginContext, index: SynonymIndex) {
  let cursor: string | null = null;
  const all: SearchSection[] = [];
  do {
    const page = await ctx.search.sections({ cursor, limit: 200 });
    all.push(...page.sections);
    cursor = page.next;
  } while (cursor);
  index.clear();
  index.put(all);
}
