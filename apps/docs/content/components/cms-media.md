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

A large upload is remembered in the browser's storage: choosing the same file again within a day sends only the parts that are still missing ("Carrying on"). With `media.stripMetadata` on, JPEG photos lose their location, time and device data in the browser before they are sent; the picture, its colour profile and its orientation stay. On a store without parts (Vercel Blob) every file is one request and starts again after a failure.

## The file panel

- **Rename** (the pencil): the extension stays.
- **Focal point**: click the part of a picture that must stay in view, or move the point with the arrow keys (Shift for bigger steps). "Clear" removes it. Used by image sizes with `fit: "cover"`.
- **Replace**: new content at the same address, for a file of the same type. The dialog says how many documents show the file. Needs the right to delete; the old content cannot be brought back.

## Extending

`<CmsProvider slots={{ assetAlt: (asset, { setAlt }) => … }}>` puts your own control next to the alt text field, for example a button that suggests a description.

> [!note]
> The demo library is read-only: its pictures are drawn by this site, and uploading is off.
