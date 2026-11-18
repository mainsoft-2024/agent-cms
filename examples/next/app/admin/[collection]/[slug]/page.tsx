"use client";

import { useRouter } from "next/navigation";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";

export default function EditPage({ params }: { params: { collection: string; slug: string } }) {
  const router = useRouter();
  return (
    <CmsDocEditor
      collection={params.collection}
      slug={decodeURIComponent(params.slug)}
      onBack={() => router.push(`/admin/${params.collection}`)}
      onOpenVersions={(c, s) => router.push(`/admin/${c}/${s}/versions`)}
      publicUrlFor={(c, s) => (c === "posts" ? `/posts/${s}` : "")}
    />
  );
}
