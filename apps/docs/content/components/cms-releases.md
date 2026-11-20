---
title: "Releases"
summary: "Several documents published together, now or at a set time. A list of releases, and one release with its documents, what changes, and what blocks it."
order: 14
---
## Usage

```tsx
// app/admin/releases/page.tsx
"use client";
import { useRouter } from "next/navigation";
import { CmsReleases } from "@/components/cms/cms-releases";

export default function ReleasesPage() {
  const router = useRouter();
  return <CmsReleases hrefFor={(id) => `/admin/releases/${id}`} onOpenRelease={(id) => router.push(`/admin/releases/${id}`)} />;
}
```

```tsx
// app/admin/releases/[id]/page.tsx
"use client";
import { useParams, useRouter } from "next/navigation";
import { CmsRelease } from "@/components/cms/cms-releases";

export default function ReleasePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  return <CmsRelease id={id} onBack={() => router.push("/admin/releases")} onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)} />;
}
```

Give the editor `onOpenRelease` too, so "Add to a release" in its menu can open the release. Publishing is all or nothing; a scheduled release goes out on the [cron call](/docs/publishing-flow).

> [!note]
> On npm from 0.10.0.
