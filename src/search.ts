/**
 * In-memory keyword search over published documents, split into sections.
 *
 * Why not Postgres full-text or embeddings: the corpus is small (hundreds of
 * sections), the agent is waiting on it mid-answer, and Korean questions
 * ("슬랙 어떻게 연결해?") rarely share exact words with a title ("Slack
 * 연결하기"). Hangul words are indexed as whole words AND 2-grams, so
 * "연결해" still meets "연결하기"; authors add aliases ("슬랙", "slack") as
 * keywords, which weigh the most. Building the index is a few ms; a query is
 * well under one.
 */

import { splitSections, plainText } from "./markdown";

export interface SearchUnit {
  docId: string;
  collection: string;
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  keywords: string[];
  /** Section anchor ("" = intro). */
  anchor: string;
  heading: string;
  markdown: string;
  publishedAt: string | null;
  fields: Record<string, unknown>;
  /** The published version this unit was cut from (0.18.0): results are checked against that copy. */
  version?: number;
}

export interface SearchHit {
  unit: SearchUnit;
  score: number;
  /** Share of the query's meaningful words that matched (0–1). */
  coverage: number;
}

const HANGUL = /[\uac00-\ud7a3]/;

/** Words that carry no meaning in a "how do I…" question. */
const STOP = new Set([
  "어떻게", "어떡해", "어떻게해", "어떻게해요", "방법", "하는법", "하는", "해", "해줘", "해요", "하나요", "되나요", "어디", "어디서", "어디에",
  "뭐야", "뭐", "좀", "법", "방법은", "법은", "보는", "봐", "하고", "싶어요", "알려줘", "알려", "알려주세요", "쓰는", "써", "쓰나요", "사용법", "하기", "수", "있어", "있나요", "있어요", "돼", "되", "나",
  "내", "제", "저", "거", "것", "이거", "그거", "서비서", "서비서에서", "서비서에", "하면", "하려면", "싶어", "싶은데", "그리고", "the", "a", "an",
  "how", "to", "do", "i", "is", "can", "what", "where", "in", "on", "of", "and", "or", "my", "use",
]);

const PARTICLES = ["에서는", "으로는", "에게서", "한테서", "이랑", "에서", "으로", "에게", "한테", "하고", "까지", "부터", "처럼", "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "도", "만", "의", "께", "랑"];

export function normalizeQuery(q: string): string {
  return words(q)
    .filter((w) => !STOP.has(w))
    .map(stemOf)
    // Grouping only (not indexing): "법은" and "법" are the same question.
    .map((w) => (w.length === 2 && /[은는을를이가]$/.test(w) ? w[0] : w))
    // Word order does not change the question: "슬랙 연결" = "연결 슬랙".
    .filter((w, i, all) => all.indexOf(w) === i)
    .sort()
    .join(" ");
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^0-9a-z\uac00-\ud7a3]+/i)
    .filter(Boolean);
}

/**
 * Verb endings on a noun stem ("연결해", "연결하기", "연결하려면" → "연결").
 * Longest first. Only stripped when a 2+ syllable stem remains.
 */
const VERB_ENDINGS = [
  "하려면", "하는법", "할수있", "하나요", "했는데", "하는데", "해주세요", "해줘요", "합니다", "해야", "해줘", "해요", "해서", "하기", "하는", "하면",
  "하고", "했어", "할래", "할게", "되나요", "되요", "돼요", "된", "되는", "되면", "해", "하", "할", "함", "됨",
];

function stripParticle(w: string): string {
  if (!HANGUL.test(w) || w.length < 3) return w;
  for (const p of PARTICLES) if (w.length - p.length >= 2 && w.endsWith(p)) return w.slice(0, -p.length);
  return w;
}

function stemOf(w: string): string {
  const s = stripParticle(w);
  if (!HANGUL.test(s) || s.length < 3) return s;
  for (const e of VERB_ENDINGS) if (s.length - e.length >= 2 && s.endsWith(e)) return s.slice(0, -e.length);
  return s;
}

/** Index/query tokens for one word: the word itself, its stem, Hangul 2-grams. */
function tokensOf(w: string): { tok: string; weight: number }[] {
  const out: { tok: string; weight: number }[] = [{ tok: w, weight: 1 }];
  const stem = stemOf(w);
  if (stem !== w) out.push({ tok: stem, weight: 1 });
  if (HANGUL.test(w) && w.length >= 3) {
    for (let i = 0; i + 2 <= w.length; i++) out.push({ tok: w.slice(i, i + 2), weight: 0.6 });
  }
  return out;
}

type Field = "keywords" | "title" | "heading" | "summary" | "body";
const FIELD_WEIGHT: Record<Field, number> = { keywords: 3, title: 2, heading: 1.5, summary: 1.5, body: 1 };

export class SearchIndex {
  private units: SearchUnit[] = [];
  /** token → unit index → best field weight × token weight */
  private postings = new Map<string, Map<number, number>>();
  private latinVocab: string[] = [];

  constructor(units: SearchUnit[] = []) {
    for (const u of units) this.add(u);
    this.latinVocab = [...this.postings.keys()].filter((t) => !HANGUL.test(t) && t.length >= 3);
  }

  get size(): number {
    return this.units.length;
  }

  private add(u: SearchUnit) {
    const idx = this.units.push(u) - 1;
    const put = (text: string, field: Field) => {
      for (const w of words(text)) {
        for (const { tok, weight } of tokensOf(w)) {
          let m = this.postings.get(tok);
          if (!m) this.postings.set(tok, (m = new Map()));
          const v = FIELD_WEIGHT[field] * weight;
          if ((m.get(idx) ?? 0) < v) m.set(idx, v);
        }
      }
    };
    put(u.keywords.join(" "), "keywords");
    put(u.title, "title");
    put(u.heading, "heading");
    put(u.summary, "summary");
    put(plainText(u.markdown), "body");
  }

  private idf(tok: string): number {
    const df = this.postings.get(tok)?.size ?? 0;
    return Math.log(1 + (this.units.length + 1) / (df + 0.5));
  }

  search(query: string, opts: { limit?: number; perDoc?: number; filter?: (u: SearchUnit) => boolean } = {}): SearchHit[] {
    const limit = opts.limit ?? 5;
    const perDoc = opts.perDoc ?? 2;
    const qWords = [...new Set(words(query).filter((w) => !STOP.has(w)))];
    if (!qWords.length || !this.units.length) return [];

    const scores = new Map<number, number>();
    const matchedWords = new Map<number, Set<number>>();
    qWords.forEach((w, wi) => {
      // Best contribution of this query word per unit.
      const best = new Map<number, number>();
      const consider = (tok: string, weight: number) => {
        const m = this.postings.get(tok);
        if (!m) return;
        const idf = this.idf(tok);
        for (const [u, fw] of m) {
          const s = fw * weight * idf;
          if ((best.get(u) ?? 0) < s) best.set(u, s);
        }
      };
      for (const { tok, weight } of tokensOf(w)) consider(tok, weight);
      if (!HANGUL.test(w) && w.length >= 3) {
        for (const v of this.latinVocab) {
          if (v !== w && (v.startsWith(w) || (w.length >= 5 && editDistance1(v, w)))) consider(v, 0.5);
        }
      }
      for (const [u, s] of best) {
        scores.set(u, (scores.get(u) ?? 0) + s);
        let set = matchedWords.get(u);
        if (!set) matchedWords.set(u, (set = new Set()));
        set.add(wi);
      }
    });

    // Title/keyword matches lift every section of the same document a little,
    // so "슬랙" finds the right section of "Slack 연결하기" even when that
    // section's own text never says "슬랙".
    const docBoost = new Map<string, number>();
    for (const [u, s] of scores) {
      const id = this.units[u].docId;
      docBoost.set(id, Math.max(docBoost.get(id) ?? 0, s));
    }

    // A document's coverage is the union of what its sections matched.
    const docWords = new Map<string, Set<number>>();
    for (const [u, set] of matchedWords) {
      const id = this.units[u].docId;
      let all = docWords.get(id);
      if (!all) docWords.set(id, (all = new Set()));
      set.forEach((x) => all!.add(x));
    }

    const ranked: SearchHit[] = [];
    for (const [u, s] of scores) {
      const unit = this.units[u];
      if (opts.filter && !opts.filter(unit)) continue;
      const boosted = s + 0.25 * (docBoost.get(unit.docId) ?? 0);
      ranked.push({ unit, score: boosted, coverage: (docWords.get(unit.docId)?.size ?? 0) / qWords.length });
    }
    ranked.sort((a, b) => b.score - a.score);

    const perDocCount = new Map<string, number>();
    const out: SearchHit[] = [];
    for (const hit of ranked) {
      const n = perDocCount.get(hit.unit.docId) ?? 0;
      if (n >= perDoc) continue;
      perDocCount.set(hit.unit.docId, n + 1);
      out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function editDistance1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Split a published document into search units (one per `##` section). */
export function unitsOf(doc: {
  id: string;
  collection: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  keywords: string[];
  publishedAt: string | null;
  fields: Record<string, unknown>;
  version?: number;
}): SearchUnit[] {
  const sections = splitSections(doc.body);
  const base = {
    docId: doc.id,
    collection: doc.collection,
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    category: doc.category,
    keywords: doc.keywords,
    publishedAt: doc.publishedAt,
    fields: doc.fields,
    ...(doc.version !== undefined ? { version: doc.version } : {}),
  };
  if (!sections.length) return [{ ...base, anchor: "", heading: "", markdown: "" }];
  return sections.map((s) => ({ ...base, anchor: s.anchor, heading: s.heading, markdown: s.markdown }));
}
