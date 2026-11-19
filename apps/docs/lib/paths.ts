/** Public address of a document on this site ("" when it has none). */
export function publicPath(collection: string, slug: string): string {
  if (collection === "docs") return `/docs/${slug}`;
  if (collection === "docs-ko") return `/ko/docs/${slug}`;
  if (collection === "components") return `/components/${slug}`;
  if (collection === "changelog") return `/changelog#${slug}`;
  return "";
}
