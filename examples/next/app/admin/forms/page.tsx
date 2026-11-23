"use client";

import { useRouter } from "next/navigation";
import { CmsForms } from "@/components/cms/cms-forms";

export default function FormsPage() {
  const router = useRouter();
  return <CmsForms hrefFor={(s) => `/admin/forms/${s}`} onOpenForm={(s) => router.push(`/admin/forms/${s}`)} />;
}
