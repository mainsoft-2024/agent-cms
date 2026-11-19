"use client";

import { useParams, useRouter } from "next/navigation";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";

export default function NewPage() {
  const { collection } = useParams<{ collection: string }>();
  const router = useRouter();
  return <CmsDocEditor collection={collection} onBack={() => router.push(`/admin/${collection}`)} onCreated={(c, s) => router.replace(`/admin/${c}/${s}`)} />;
}
