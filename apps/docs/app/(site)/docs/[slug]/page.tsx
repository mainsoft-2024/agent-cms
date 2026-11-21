import type { Metadata } from "next";
import { DocPage } from "@/components/site/doc-page";
import { previewDoc, publishedDoc } from "@/lib/content";
import { previewToken } from "@/lib/paths";

export async function generateMetadata({ params, searchParams }: PageProps<"/docs/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const token = previewToken(await searchParams);
  // A draft opened through a preview link: its own title, and out of search engines.
  const draft = await previewDoc(token, "docs", slug);
  if (draft) return { title: draft.doc.title, robots: { index: false, follow: false } };
  const doc = await publishedDoc("docs", slug);
  // Point to the Korean page only when it is really published.
  const ko = doc ? await publishedDoc("docs-ko", slug).catch(() => null) : null;
  return doc ? { title: doc.title, description: doc.summary || undefined, alternates: { canonical: `/docs/${slug}`, languages: ko ? { en: `/docs/${slug}`, ko: `/ko/docs/${slug}` } : undefined } } : {};
}

export default async function Page({ params, searchParams }: PageProps<"/docs/[slug]">) {
  const { slug } = await params;
  return <DocPage lang="en" slug={slug} preview={previewToken(await searchParams)} />;
}
