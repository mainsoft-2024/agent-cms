---
title: Media library
summary: Pictures, video and files in your own bucket. Uploads go straight from the browser to the storage.
category: Guides
order: 6
---
> [!note]
> On npm from 0.10.0 (0.8.0 and 0.9.0 were not published on their own). Without `media` in `createCms` the feature is off and nothing changes.

Documents can hold images, video and files. The files live in your own
storage bucket; the CMS keeps a row per file and hands the browser a signed
address, so uploads go straight to the storage and never through your app
server (which is why a 5GB video works on a serverless host). Without `media`
the feature is off and nothing changes.

## Set up

```ts
import { s3Storage } from "@mainsoft/agent-cms/storage-s3";

const s3 = (bucket: string, publicUrl?: string) =>
  s3Storage({ bucket, region: "auto", endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET!, publicUrl });

export const cms = createCms({
  // …
  media: {
    stores: {
      // The first store is the default. `public`: anyone with the address can read.
      public: { label: "Public", visibility: "public", adapter: s3("site-media", "https://media.example.com") },
      // `private`: opened through the CMS after a permission check, with a link that works for 5 minutes.
      private: { label: "Private", visibility: "private", adapter: s3("site-private"), accept: ["application/pdf"], maxFileSize: 100 * 1024 ** 2 },
    },
    // accept: ["image/*", "video/*", ".pdf"],   // what every store takes; default below
    // maxFileSize: 5 * 1024 ** 3,               // default 5GB
    imageUrl: ({ url, width }) => `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=75`,
  },
});
```

`s3Storage` works with AWS S3 (leave `endpoint` out, set `region`),
Cloudflare R2 (`region: "auto"`, the account's S3 endpoint) and MinIO or any
other S3-compatible server. It signs requests itself (`aws4fetch`), so there
is no AWS SDK to install. Another kind of storage is a `StorageAdapter`
(`./storage`).

**Cloudflare R2**, checked against a real bucket on 2026-11-20 (the same
contract test CI runs against an S3-compatible server): single and multipart
uploads from a browser, signed links, copy, list and the CORS rule all work.
Three things to know. Make the R2 key an **Object Read & Write** token limited
to that bucket. A public store needs the bucket's public address as
`publicUrl`: the `pub-….r2.dev` address or a custom domain (the S3 endpoint
itself never serves files without a signature). And set the CORS rule in the
dashboard (R2, the bucket, Settings, CORS policy) or with Cloudflare's API:
your site's origin and the methods `GET`, `HEAD`, `PUT`. `storage check`
tells you if it is missing.

## Vercel Blob

From 0.11.0. Install `@vercel/blob` and give a store the Blob adapter:

```ts
import { vercelBlobStorage } from "@mainsoft/agent-cms/storage-vercel-blob";

stores: {
  public: { visibility: "public", adapter: vercelBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN!, access: "public" }) },
  private: { visibility: "private", adapter: vercelBlobStorage({ token: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN!, access: "private" }) },
}
```

`access` is how the Blob store was created. A private store is read through signed links only. `prefix` puts every key under one folder of the store.

| | S3-compatible | Vercel Blob |
|---|---|---|
| Browser uploads straight to the storage | yes | yes |
| Large files | 16MB parts, four at a time | one request per file |
| A failed part is retried by itself | yes | not supported on this store: the file starts again |
| Carry on after a reload | yes | not supported on this store |
| CORS rule | yours to set | nothing to set |
| Stored type | what the CMS signed | read from the extension by Blob |
| File manager, share links, replace, image sizes | yes | yes |

The signed address holds an upload to the size it declared. Share links last at most seven days. A 150MB file went up in one request when we measured; Vercel's own advice is to use parts above 100MB, which this adapter cannot do, so think about `maxFileSize` for the store. Checked against real public and private Blob stores with `@vercel/blob` 2.9.0 on 2026-11-20.

## CORS

The bucket needs a CORS rule that lets your site `PUT` to it. Add `media`
(the same object) to `agent-cms.config.ts` and run:

```
npx @mainsoft/agent-cms storage check --origin https://your-site.example
```

It uploads, reads, moves and deletes a test file in every store for real
(also in parts, also with a browser-style signed address), tests the CORS
rule, prints the rule to paste into the bucket, and lists what each store
accepts. `npx @mainsoft/agent-cms storage cleanup` removes uploads that were started
and never finished (`doctor` tells you when there are any).

## What may be uploaded

What may be uploaded is yours to decide, at three levels: `media.accept`
for the app, `stores.<name>.accept` for one store (replaces the app-wide
list), and `admin.fields.<field>.accept` for one field (narrows its store's
list). Entries are MIME types (`image/png`), groups (`image/*`) or
extensions (`.pdf`); `["*/*"]` takes anything. Unset, the default
(`DEFAULT_ACCEPT`) takes images, video, sound, PDF, office documents, plain
text and ZIP; web pages and programs only when you list them. `maxFileSize`
has the same three levels. The server checks the name and declared type when
an upload starts, and the first bytes of what actually arrived when it ends:
a web page named `photo.png` is deleted again (`asset_type_mismatch`).

## Your own check

`media.scan` is called once for every file that arrives:
when a browser upload completes, when a file is imported or stored by the
server, and when a file that was already in the bucket gets registered. It
is where a virus scanner or a content policy goes:

```ts
media: {
  stores: { /* … */ },
  scan: async ({ url, bytes, name, mime, size }) => {
    // `url`: a signed address that works for 10 minutes. `bytes` instead when the CMS holds the file in memory.
    const verdict = await myScanner.check(url ?? bytes);
    return verdict.clean ? true : { ok: false, reason: verdict.name };
  },
},
```

A refused file is deleted from the storage and never becomes usable (a
registered one is left where it was); the caller gets `asset_rejected` and
the audit log has the reason. A check that throws refuses the file too.

## In a document

In a document a file is named by its id, so moving or renaming it never
breaks a page:

```md
![The new dashboard](asset:8k2m4x9pq1zt/dashboard.png "Caption under the picture")

Read [the full report](asset:r7w2k9m4x1pa/report-2026.pdf).
```

An image line of its own is a media block (a picture, a video player or a
download card, by the file's type). `![alt](https://…)` shows an image from
elsewhere. For a field, use the `image` or `file` widget; the value is the
file's id:

```ts
import { assetId } from "@mainsoft/agent-cms";

fields: z.object({ cover: assetId().optional(), brochure: assetId().optional() }),
admin: { fields: { cover: { widget: "image" }, brochure: { widget: "file", accept: [".pdf"], maxFileSize: 20 * 1024 ** 2 } } },
media: { requireAlt: true },   // an image without alt text stops a save (default: a warning)
```

Saving checks the files a document names: one that does not exist or is the
wrong kind for its field is an error; a missing alt text or a private file
in a public document is a warning.

## On your page

On your page, ask for the files a document uses and render the block
tree as before:

```ts
const doc = await cms.get(anon, "posts", slug);
const files = await cms.assetsFor(doc);        // { [id]: { url, width, height, alt, kind, mime, … } }
const cover = files[doc.fields.cover];
<img src={cms.imageUrl(cover, { width: 1200 })} width={cover.width} height={cover.height} alt={cover.alt} />
```

`parseMarkdown` gives `{ t: "media", asset, alt, caption }` blocks; look the
`asset` up in `files`. By default the CMS stores originals only, and resizing is your
framework's or CDN's job, through `media.imageUrl`.

## Image sizes

From 0.11.0, the CMS can make the sizes itself. It is an optional module: install `sharp` and name the sizes. Node runtime only; on the Edge runtime the app fails at start with the reason.

```ts
import { sharpTransforms } from "@mainsoft/agent-cms/image-sharp";

media: {
  stores: { … },
  transforms: sharpTransforms({
    presets: { thumb: { width: 480 }, card: { width: 800, height: 450, fit: "cover" }, full: { width: 1600 } },
    formats: ["webp"], // webp (default), avif, jpeg, png
  }),
}
```

```tsx
<img
  src={cms.imageUrl(cover, { size: "card" })}
  style={{ objectPosition: cover.focal ? `${cover.focal.x * 100}% ${cover.focal.y * 100}%` : undefined }}
  alt={cover.alt}
/>
```

- Only the sizes you name exist: `/api/cms/files/<id>/<name>?size=card`. Another name answers 404 (`unknown_image_size`).
- A size is made the first time it is asked for and kept in the same store under `_cms/derived/`. After that the route redirects to the stored copy. Copies are deleted with the original and when it is replaced.
- Limits: 4096px on the long side, four at a time, ten seconds each, 40MB of input. Past a limit, or when sharp fails, the original is served. SVG and GIF are served as they are. Nothing is enlarged.
- With the module on, pictures an agent imports or the CLI uploads get their list thumbnail from the server.

**Focal point.** In a file's panel, "Focal point" lets an editor click the part of a picture that must stay in view; the arrow keys move it too. Sizes with `fit: "cover"` are cropped around it, and `assetsFor` returns it as `focal: { x, y }` (0 to 1). Agents set it with `update_asset`. There is no crop editor: the original is never changed.

## Who may do what

Listing files and opening private ones: signed-in
people and keys. Uploading, importing, alt text, tags, new folders: admins
and keys with `write`. Moving, renaming and deleting: admins and keys with
`publish`. A store's `access: { read, write, delete }` replaces any of the
three. Deleting a file that documents use fails with `asset_in_use` and the
list of documents until the caller confirms. Uploads, moves and deletes are
in the audit log.

The file route is `GET /api/cms/files/<id>/<name>`: it checks permission and
redirects to the public address or to a short-lived signed one
(`media.linkTtlSeconds`, default 300). Set `media.filesUrl` when your handler
is not mounted at `/api/cms`.

## In the admin

In the admin, add the screen (`npx @mainsoft/agent-cms add cms-media`) and a page
for it; the sidebar shows "Media" by itself when the app has a library:

```tsx
// app/admin/media/page.tsx
"use client";
import { CmsMedia } from "@/components/cms/cms-media";
export default function MediaPage() {
  return <CmsMedia />;
}
```

The browser sends files straight to the storage, four parts at a time for
large ones, tries a failed part again three times, and "Try again" sends only
what is still missing. It also makes a small picture of each image and video
(480px, WebP) for the library, and reads width, height and length.
"Import from URL" fetches a public https address into the open folder
(addresses inside your network are refused, as for agents), and the pencil
in a file's panel renames it; the extension stays, so the type cannot change.
"Replace" puts new content at a file's address, and `media.stripMetadata` removes camera data from photos before they are sent. The [media library screen](/components/cms-media) has the details. `<CmsProvider slots={{ assetAlt }}>` lets an extension package put its own
control next to a file's alt text field.

## Agents and the CLI

Agents get six more tools when the app has a media library: `list_assets`,
`get_asset` (read), `import_asset` (fetch an https address into the library;
addresses inside your network are refused), `update_asset` (write),
`move_asset` and `delete_asset` (publish). From a terminal:

```
npx @mainsoft/agent-cms upload ./hero.png ./talk.mp4 --folder launch --alt "The launch screen" --tag launch
```

## The whole bucket

The library shows the files the CMS knows. The [file manager](/docs/file-manager) shows a bucket as it is.
