"use client";

import { useRouter } from "next/navigation";
import { CmsDocList } from "@/components/cms/cms-doc-list";

export default function ListPage({ params }: { params: { collection: string } }) {
  const router = useRouter();
  return (
    <CmsDocList
      collection={params.collection}
      hrefFor={(c, s) => `/admin/${c}/${s}`}
      onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)}
      onNewDocument={(c) => router.push(`/admin/${c}/new`)}
      keysHref="/admin/keys"
    />
  );
}
