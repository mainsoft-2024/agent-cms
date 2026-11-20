"use client";

import { useParams, useRouter } from "next/navigation";
import { CmsRelease } from "@/components/cms/cms-releases";

export default function ReleasePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  return <CmsRelease id={id} onBack={() => router.push("/admin/releases")} onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)} />;
}
