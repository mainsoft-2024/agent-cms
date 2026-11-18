"use client";

import { useRouter } from "next/navigation";
import { CmsVersions } from "@/components/cms/cms-versions";

export default function VersionsPage({ params }: { params: { collection: string; slug: string } }) {
  const router = useRouter();
  return <CmsVersions collection={params.collection} slug={decodeURIComponent(params.slug)} onBack={() => router.push(`/admin/${params.collection}/${params.slug}`)} />;
}
