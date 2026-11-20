---
title: Upgrading to 0.11
summary: Schema version 5 adds three columns for files. The editor now fills the window's height. Vercel Blob and image sizes are off until you turn them on.
category: Upgrade
order: 4
---
Coming from 0.10.x. Nothing is removed and no call changes its meaning. There is one schema step and one layout change in a copied screen.

## 1. Schema version 5

```sh
npx agent-cms migrate check
npx agent-cms migrate apply    # or `migrate print` and run the SQL yourself
```

The step adds three columns to `cms_assets` and is safe to run twice: `focal_x`, `focal_y` (a picture's focal point, empty by default) and `rev` (how many times the file was replaced, 0 by default). Apps that create their tables at start get them by themselves.

`CmsAsset` gained `focalX`, `focalY` and `rev`, and the `AssetInfo` that `assetsFor` returns gained `focal`. Code that builds a `CmsAsset` by hand (your own `CmsRepo`, test fixtures) has to fill them in.

## 2. Update the copied screens

```sh
npx agent-cms add --update
```

`cms-doc-editor` got a new file (`cms-body-tools.tsx`). `cms-upload.ts`, `cms-media.tsx`, `cms-media-picker.tsx`, `cms-parts.tsx` and `cms-messages.ts` changed.

> [!warning]
> **The editor's height.** On wide screens the editor used to grow with its content and scroll with the page. It now takes the window's height and scrolls inside itself, which is what lets the text and the preview scroll together. If your admin has a bar above the editor, pass the height that is left: `<CmsDocEditor className="md:h-[calc(100dvh-4rem)]" />`. Phones are unchanged.

## 3. New, off until you turn it on

- **Vercel Blob:** `npm install @vercel/blob`, then [`vercelBlobStorage`](/docs/media-library#vercel-blob) as a store's adapter.
- **Image sizes:** `npm install sharp`, then [`media.transforms`](/docs/media-library#image-sizes). Node runtime only.
- **Camera data:** `media.stripMetadata: true`.
- Replacing a file, the focal point and carrying on an upload after a reload need no setting. They appear in the media screen after step 2.

## 4. If you wrote your own storage adapter

Nothing to do. `StorageAdapter` gained three optional members: `multipart` (set it to `false` if your storage cannot take a file in parts; the CMS then sends every file in one request), `settle(key, options)` (called once after a browser upload passed its checks) and `size` in the options of `presignPut` (the size the uploader declared).

A replaced file keeps its address. The CMS adds `?v=<rev>` to the addresses it hands out; how long a CDN in front of a public bucket keeps the old content is the CDN's setting.
