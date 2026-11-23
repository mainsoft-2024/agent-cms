"use client";

import { useRouter } from "next/navigation";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";
import { CmsDocList } from "@/components/cms/cms-doc-list";
import { useCms } from "@/components/cms/use-cms";

export default function ListPage({ params }: { params: { collection: string } }) {
  const router = useRouter();
  const { me } = useCms();
  if (!me) return null;
  // A single (one document) has no list: its address opens the editor.
  if (me.collections.find((c) => c.slug === params.collection)?.single)
    return (
      <CmsDocEditor
        collection={params.collection}
        slug="_single"
        onOpenVersions={(c, s) => router.push(`/admin/${c}/${encodeURIComponent(s)}/versions`)}
        onOpenRelease={(id) => router.push(`/admin/releases/${id}`)}
        onOpenDocument={(c, s) => router.push(`/admin/${c}/${encodeURIComponent(s)}`)}
      />
    );
  return (
    <CmsDocList
      collection={params.collection}
      hrefFor={(c, s) => `/admin/${c}/${s}`}
      onOpenDocument={(c, s) => router.push(`/admin/${c}/${encodeURIComponent(s)}`)}
      onNewDocument={(c) => router.push(`/admin/${c}/new`)}
      keysHref="/admin/keys"
    />
  );
}
