/**
 * What an agent gets back from a guide lookup: a few sections (not whole
 * documents), the screen links found in them already resolved to URLs, and a
 * flag when nothing matched. Kept small on purpose — it lands in the model's
 * context on every "how do I…" question.
 */

import type { Cms } from "./cms";
import { appLinkKeys, APP_LINK_RE, splitSections } from "./markdown";
import { CmsError, type Actor } from "./types";

export interface AgentSection {
  slug: string;
  title: string;
  category: string | null;
  heading: string;
  /** Section markdown; `[[link:key|label]]` rewritten to "label". */
  text: string;
  /** Public URL of the document (with the section anchor). */
  url: string | null;
}

export interface AgentLink {
  key: string;
  label: string;
  href: string;
}

export interface AgentLookup {
  found: boolean;
  sections: AgentSection[];
  /** Screen links collected from the sections, deduped, max 4. */
  links: AgentLink[];
  /** Documents the sections came from (for usage counts). */
  docIds: string[];
}

const MAX_SECTION_CHARS = 1_400;

export async function lookupForAgent(
  cms: Cms,
  actor: Actor,
  collections: string[],
  query: string,
  o: { limit?: number; slug?: string | null; logGap?: boolean; recordHits?: boolean } = {}
): Promise<AgentLookup> {
  let hits: { slug: string; title: string; category: string | null; heading: string; anchor: string; markdown: string; collection: string; docId: string }[] = [];

  if (o.slug) {
    // A specific document: the sections that match the question, else its first ones.
    const inDoc = query.trim()
      ? await cms.search(actor, collections, query, { limit: 3, perDoc: 3, logGap: false, filter: (u) => u.slug === o.slug })
      : null;
    if (inDoc?.hits.length) hits = inDoc.hits.map((h) => ({ ...h.unit }));
    else {
      for (const col of collections) {
        const doc = await cms.get(actor, col, o.slug).catch((e: unknown) => {
          if (e instanceof CmsError && e.code === "not_found") return null;
          throw e;
        });
        if (!doc) continue;
        hits = splitSections(doc.body)
          .slice(0, 4)
          .map((s) => ({ slug: doc.slug, title: doc.title, category: doc.category, heading: s.heading, anchor: s.anchor, markdown: s.markdown, collection: col, docId: doc.id }));
        break;
      }
    }
  }
  if (!hits.length) {
    const r = await cms.search(actor, collections, query, { limit: o.limit ?? 3, perDoc: 2, logGap: o.logGap ?? false });
    hits = r.hits.map((h) => ({ ...h.unit }));
  }
  if (o.recordHits !== false && hits.length) void cms.recordHits([...new Set(hits.map((h) => h.docId))]);

  const links: AgentLink[] = [];
  const sections = hits.map((h) => {
    const cfg = cms.collection(h.collection);
    for (const m of h.markdown.matchAll(APP_LINK_RE)) {
      const href = cfg.links?.resolve(m[1]);
      if (href && !links.some((l) => l.key === m[1])) links.push({ key: m[1], label: m[2], href });
    }
    const text = h.markdown.replace(APP_LINK_RE, "$2");
    const base = cfg.url?.({ slug: h.slug }) ?? null;
    return {
      slug: h.slug,
      title: h.title,
      category: h.category,
      heading: h.heading,
      text: text.length > MAX_SECTION_CHARS ? text.slice(0, MAX_SECTION_CHARS) + "…" : text,
      url: base && h.anchor ? `${base}#${encodeURIComponent(h.anchor)}` : base,
    };
  });

  return { found: sections.length > 0, sections, links: links.slice(0, 4), docIds: [...new Set(hits.map((h) => h.docId))] };
}

export { appLinkKeys };
