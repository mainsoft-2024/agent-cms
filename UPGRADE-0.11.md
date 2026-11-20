# Upgrading to 0.11

Coming from 0.10.x. Nothing is removed and no call changes its meaning; there is one schema step and one layout change in a copied screen.

## 1. Schema version 5

```sh
npx agent-cms migrate check
npx agent-cms migrate apply    # or `migrate print` and run the SQL yourself
```

The step adds three columns to `cms_assets` and is safe to run twice: `focal_x`, `focal_y` (a picture's focal point, empty by default) and `rev` (how many times the file was replaced, 0 by default). Apps that create their tables at start (`ensureSchema`) get them by themselves. Drizzle users who keep the tables in their own schema file: re-export from `@mainsoft/agent-cms/tables` as before, the columns come with it.

`CmsAsset` gained `focalX`, `focalY` and `rev`; the `AssetInfo` that `assetsFor` returns gained `focal`. Code that builds a `CmsAsset` by hand (a custom `CmsRepo`, test fixtures) has to fill them in.

## 2. Update the copied screens

```sh
npx agent-cms add --update
```

`cms-doc-editor` got a new file (`cms-body-tools.tsx`), and `cms-upload.ts`, `cms-media.tsx`, `cms-media-picker.tsx`, `cms-parts.tsx` and `cms-messages.ts` changed. `add --update` shows a diff first for files you edited.

**The editor's height.** On wide screens the editor used to grow with its content and scroll with the page. It now takes the window's height (`h-dvh`) and scrolls inside itself, which is what lets the text and the preview scroll together while the header stays in view. If your admin has a bar above the editor, pass the height that is left:

```tsx
<CmsDocEditor className="md:h-[calc(100dvh-4rem)]" … />
```

Phones are unchanged.

## 3. New, all off until you turn them on

- **Vercel Blob:** `npm install @vercel/blob`, then `vercelBlobStorage({ token, access })` from `@mainsoft/agent-cms/storage-vercel-blob` as a store's adapter.
- **Image sizes:** `npm install sharp`, then `media.transforms: sharpTransforms({ presets })` from `@mainsoft/agent-cms/image-sharp`. Node runtime only.
- **Camera data:** `media.stripMetadata: true`.
- Replacing a file, the focal point and carrying on an upload after a reload need no setting; they appear in the media screen after step 2.

## 4. If you wrote your own storage adapter

Nothing to do. Three optional members were added to `StorageAdapter`: `multipart` (set it to `false` if your storage cannot take a file in parts; the CMS then sends every file in one request), `settle(key, options)` (called once after a browser upload passed its checks, before the file joins the library) and `size` in the options of `presignPut` (the size the uploader declared).

A store that hands out one address per file version behind a CDN should know that a replaced file keeps its address: the CMS adds `?v=<rev>` to the addresses it hands out, and how long a CDN keeps the old content is the CDN's setting.
