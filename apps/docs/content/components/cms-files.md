---
title: "File manager"
summary: "The bucket as it is: a table of folders and files, also ones the CMS did not know. Select several to move, download, share or delete; a private file's link works for 1 hour, 24 hours or 7 days."
order: 12
---
## Usage

```tsx
// app/admin/files/page.tsx
"use client";
import { CmsFiles } from "@/components/cms/cms-files";

export default function FilesPage() {
  return <CmsFiles />;
}
```

The sidebar shows "Files" to whoever may look around a store. What it does and who may do it is on the [file manager](/docs/file-manager) page.

> [!note]
> Coming in 0.9.0. In the demo, moving and deleting are off.
