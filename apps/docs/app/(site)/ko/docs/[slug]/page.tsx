import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DocPage } from "@/components/site/doc-page";
import { publishedDoc } from "@/lib/content";

export async function generateMetadata({ params }: PageProps<"/ko/docs/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const doc = await publishedDoc("docs-ko", slug);
  return doc ? { title: doc.title, description: doc.summary || undefined, alternates: { canonical: `/ko/docs/${slug}`, languages: { en: `/docs/${slug}` } } } : {};
}

export default async function Page({ params }: PageProps<"/ko/docs/[slug]">) {
  const { slug } = await params;
  // Not translated yet: show the English page.
  if (!(await publishedDoc("docs-ko", slug))) {
    if (await publishedDoc("docs", slug)) redirect(`/docs/${slug}`);
    notFound();
  }
  return (
    <div lang="ko">
      <DocPage lang="ko" slug={slug} />
    </div>
  );
}
