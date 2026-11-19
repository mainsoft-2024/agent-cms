"use client";

import { useRouter } from "next/navigation";
import { CmsReleases } from "@/components/cms/cms-releases";

export default function ReleasesPage() {
  const router = useRouter();
  return <CmsReleases hrefFor={(id) => `/admin/releases/${id}`} onOpenRelease={(id) => router.push(`/admin/releases/${id}`)} />;
}
