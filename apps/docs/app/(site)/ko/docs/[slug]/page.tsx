import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DocPage } from "@/components/site/doc-page";
import { previewDoc, publishedDoc } from "@/lib/content";
import { previewToken } from "@/lib/paths";

export async function generateMetadata({ params, searchParams }: PageProps<"/ko/docs/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const draft = await previewDoc(previewToken(await searchParams), "docs-ko", slug);
  if (draft) return { title: draft.doc.title, robots: { index: false, follow: false } };
  const doc = await publishedDoc("docs-ko", slug);
  const en = doc ? await publishedDoc("docs", slug).catch(() => null) : null;
  return doc ? { title: doc.title, description: doc.summary || undefined, alternates: { canonical: `/ko/docs/${slug}`, languages: en ? { en: `/docs/${slug}`, ko: `/ko/docs/${slug}` } : undefined } } : {};
}

export default async function Page({ params, searchParams }: PageProps<"/ko/docs/[slug]">) {
  const { slug } = await params;
  const preview = previewToken(await searchParams);
  // Not translated yet: show the English page (a preview link to a new translation still opens).
  if (!(await publishedDoc("docs-ko", slug)) && !(await previewDoc(preview, "docs-ko", slug))) {
    if (await publishedDoc("docs", slug)) redirect(`/docs/${slug}`);
    notFound();
  }
  return (
    <div lang="ko">
      <DocPage lang="ko" slug={slug} preview={preview} />
    </div>
  );
}
