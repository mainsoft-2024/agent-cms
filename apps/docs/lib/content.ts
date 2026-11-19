import "server-only";
import { isCmsError, type CmsDoc } from "@mainsoft/agent-cms";
import { SECTIONS } from "./collections";
import { anonymous, getCms, system } from "./cms";

export type DocsCollection = "docs" | "docs-ko";
export type Lang = "en" | "ko";

export const collectionFor = (lang: Lang): DocsCollection => (lang === "ko" ? "docs-ko" : "docs");
export const docHref = (lang: Lang, slug: string) => (lang === "ko" ? `/ko/docs/${slug}` : `/docs/${slug}`);

export interface NavItem {
  slug: string;
  title: string;
  order: number;
}
export interface NavGroup {
  section: string;
  items: NavItem[];
}

const orderOf = (d: CmsDoc) => Number((d.fields as { order?: number }).order ?? 100);

/** Published pages grouped by section (sidebar and llms.txt). */
export async function docsNav(lang: Lang): Promise<NavGroup[]> {
  const cms = await getCms();
  const docs = await cms.list(anonymous, collectionFor(lang));
  const groups = new Map<string, NavItem[]>();
  for (const d of docs) {
    const s = d.category ?? "Guides";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push({ slug: d.slug, title: d.title, order: orderOf(d) });
  }
  const known = [...SECTIONS] as string[];
  return [...groups.entries()]
    .sort(([a], [b]) => (known.indexOf(a) === -1 ? 99 : known.indexOf(a)) - (known.indexOf(b) === -1 ? 99 : known.indexOf(b)))
    .map(([section, items]) => ({ section, items: items.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)) }));
}

/** First page in the sidebar order (where /docs goes). */
export async function firstDoc(lang: Lang): Promise<string | null> {
  return (await docsNav(lang))[0]?.items[0]?.slug ?? null;
}

/** A published page, or null. */
export async function publishedDoc(collection: string, slug: string): Promise<CmsDoc | null> {
  const cms = await getCms();
  try {
    return await cms.get(anonymous, collection as DocsCollection, slug);
  } catch (e) {
    if (isCmsError(e) && (e.kind === "not_found" || e.kind === "unauthorized" || e.kind === "invalid")) return null;
    throw e;
  }
}

/** Versions up to the public one, newest first (the public "Version history"). */
export async function publicVersions(doc: CmsDoc) {
  const cms = await getCms();
  const all = await cms.versionList(system, doc.collection, doc.slug);
  return all.filter((v) => doc.publishedVersion !== null && v.version <= doc.publishedVersion);
}

export async function listPublished(collection: "components" | "changelog") {
  const cms = await getCms();
  return cms.list(anonymous, collection);
}
