---
title: "Import and export"
summary: "Import an export file or markdown files after looking at what each would do; download the documents as one file."
order: 20
---
## Usage

```tsx
// app/admin/transfer/page.tsx
"use client";
import { CmsTransfer } from "@/components/cms/cms-transfer";

export default function Page() {
  return <CmsTransfer />;
}
```

The sidebar shows "Import and export" to admins. Import: choose an export file (`.json`) or markdown files, pick what happens when the address exists, and read the table (new document, v1 → v2, skipped, cannot import with the reason). Untick what you do not want, then import: everything arrives as a draft. Export: pick a collection or all, with or without drafts.

Files in the media library travel with the CLI (`export --with-files`), not with this screen.

See [Export and import](/docs/import-export).

> [!note]
> From 0.13.0.
