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
  return doc ? { title: doc.title, description: doc.summary || undefined, alternates: { canonical: `/docs/${slug}`, languages: { ko: `/ko/docs/${slug}` } } } : {};
}

export default async function Page({ params, searchParams }: PageProps<"/docs/[slug]">) {
  const { slug } = await params;
  return <DocPage lang="en" slug={slug} preview={previewToken(await searchParams)} />;
}
