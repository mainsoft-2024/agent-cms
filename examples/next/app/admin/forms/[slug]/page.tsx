"use client";

import { useRouter } from "next/navigation";
import { CmsFormEditor, type CmsFormTab } from "@/components/cms/cms-forms";

export default function FormPage({ params }: { params: { slug: string; tab?: string } }) {
  const router = useRouter();
  const at = (slug: string, tab: CmsFormTab) => `/admin/forms/${slug}${tab === "fields" ? "" : `/${tab}`}`;
  return (
    <CmsFormEditor
      key={params.slug}
      slug={params.slug}
      tab={(params.tab as CmsFormTab | undefined) ?? "fields"}
      onTab={(tab) => router.replace(at(params.slug, tab))}
      onBack={() => router.push("/admin/forms")}
      onSlugChange={(slug) => router.replace(at(slug, "settings"))}
    />
  );
}
