---
title: "Trash"
summary: "Deleted documents and files, kept for 30 days. Restore them, delete them for good, or empty the trash; each row shows the days it has left."
order: 13
---
## Usage

```tsx
// app/admin/trash/page.tsx
"use client";
import { CmsTrash } from "@/components/cms/cms-trash";

export default function TrashPage() {
  return <CmsTrash />;
}
```

The sidebar shows "Trash" with its count to whoever may edit. Restoring a document that was published makes it public again. Deleting for good and "Empty trash" are for admins. How long things stay is `createCms({ trash: { days } })`; see [Publishing flow](/docs/publishing-flow).

> [!note]
> On npm from 0.10.0. The demo is shared by every visitor and starts over every 30 minutes.
