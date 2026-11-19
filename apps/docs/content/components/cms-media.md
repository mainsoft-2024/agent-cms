---
title: "Media library"
summary: "Folders and stores on the left, tiles or a list, a panel with the picture, alt text, tags and the documents that use the file. Upload by drag and drop with progress per file, import from a URL, rename, delete with a list of where the file is used."
order: 10
---
## Usage

```tsx
// app/admin/media/page.tsx
"use client";
import { CmsMedia } from "@/components/cms/cms-media";

export default function MediaPage() {
  return <CmsMedia />;
}
```

The sidebar links to `<basePath>/media` by itself when the app has a [media library](/docs/media-library). `basePath` and `docHref(collection, slug)` tell the panel where a document that uses the file opens.

## Uploads

Files go from the browser straight to the storage (`cms-upload.ts`, no React in it): one request for files up to 16MB, 16MB parts above that, four at a time. A failed part is tried three more times; "Try again" sends only what is missing. The browser also makes the small picture the tiles show and reads width, height and length.

## Extending

`<CmsProvider slots={{ assetAlt: (asset, { setAlt }) => … }}>` puts your own control next to the alt text field, for example a button that suggests a description.

> [!note]
> The demo library is read-only: its pictures are drawn by this site, and uploading is off.
