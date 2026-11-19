"use client";

import { useParams, useRouter } from "next/navigation";
import { CmsVersions } from "@/components/cms/cms-versions";

export default function VersionsPage() {
  const { collection, slug } = useParams<{ collection: string; slug: string }>();
  const router = useRouter();
  return <CmsVersions collection={collection} slug={decodeURIComponent(slug)} onBack={() => router.push(`/admin/${collection}/${slug}`)} />;
}
