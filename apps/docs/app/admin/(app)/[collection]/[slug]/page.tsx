"use client";

import { useParams, useRouter } from "next/navigation";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";
import { publicPath } from "@/lib/paths";

export default function EditPage() {
  const { collection, slug } = useParams<{ collection: string; slug: string }>();
  const router = useRouter();
  return (
    <CmsDocEditor
      collection={collection}
      slug={decodeURIComponent(slug)}
      onBack={() => router.push(`/admin/${collection}`)}
      onOpenVersions={(c, s) => router.push(`/admin/${c}/${s}/versions`)}
      onOpenRelease={(id) => router.push(`/admin/releases/${id}`)}
      publicUrlFor={publicPath}
    />
  );
}
