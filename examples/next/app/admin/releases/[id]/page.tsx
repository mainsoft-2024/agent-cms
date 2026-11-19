"use client";

import { useRouter } from "next/navigation";
import { CmsRelease } from "@/components/cms/cms-releases";

export default function ReleasePage({ params }: { params: { id: string } }) {
  const router = useRouter();
  return <CmsRelease id={params.id} onBack={() => router.push("/admin/releases")} onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)} />;
}
