"use client";

import { useRouter } from "next/navigation";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";

export default function NewPage({ params }: { params: { collection: string } }) {
  const router = useRouter();
  return (
    <CmsDocEditor
      collection={params.collection}
      onBack={() => router.push(`/admin/${params.collection}`)}
      onCreated={(c, s) => router.replace(`/admin/${c}/${s}`)}
    />
  );
}
