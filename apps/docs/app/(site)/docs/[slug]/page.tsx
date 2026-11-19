import type { Metadata } from "next";
import { DocPage } from "@/components/site/doc-page";
import { publishedDoc } from "@/lib/content";

export async function generateMetadata({ params }: PageProps<"/docs/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const doc = await publishedDoc("docs", slug);
  return doc ? { title: doc.title, description: doc.summary || undefined, alternates: { canonical: `/docs/${slug}`, languages: { ko: `/ko/docs/${slug}` } } } : {};
}

export default async function Page({ params }: PageProps<"/docs/[slug]">) {
  const { slug } = await params;
  return <DocPage lang="en" slug={slug} />;
}
