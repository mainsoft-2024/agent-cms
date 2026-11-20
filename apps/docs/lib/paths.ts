/** Public address of a document on this site ("" when it has none). */
export function publicPath(collection: string, slug: string): string {
  if (collection === "docs") return `/docs/${slug}`;
  if (collection === "docs-ko") return `/ko/docs/${slug}`;
  if (collection === "components") return `/components/${slug}`;
  if (collection === "changelog") return `/changelog#${slug}`;
  return "";
}

/** The token of a signed draft preview link (`?cms_preview=<token>`), if the address has one. */
export function previewToken(searchParams: Record<string, string | string[] | undefined>): string | undefined {
  const v = searchParams.cms_preview;
  const token = Array.isArray(v) ? v[0] : v;
  return token && token.length <= 2000 ? token : undefined;
}
