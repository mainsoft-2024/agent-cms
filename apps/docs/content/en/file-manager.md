---
title: File manager
summary: The storage bucket as it is, folder by folder. Move, share and delete files, also ones nobody uploaded through the CMS.
category: Guides
order: 7
---
> [!note]
> On npm from 0.10.0.

The [media library](/docs/media-library) shows the files the CMS knows. The file manager
(`npx @mainsoft/agent-cms add cms-files`, a page with `<CmsFiles />`) shows a bucket as
it is, folder by folder: files another program put there appear too. The
sidebar shows "Files" to whoever may look around a store (by default whoever
may read it; a store's `access.browse` narrows that).

## Files the CMS did not know

- A file the CMS did not know gets a row when someone opens it, tags it,
  shares it or an agent registers it. From then on it works in documents like
  any other file. `npx @mainsoft/agent-cms storage sync [--store name] [--folder path]`
  registers everything at once and lists files the CMS knows that are gone
  from the bucket (it deletes nothing).
- Several files and whole folders can be moved or deleted at once (up to
  1000 objects per request). A move copies and deletes, one file after the
  other: files that fail are reported, and moving again takes the rest. A name
  that is taken at the destination gets a number; nothing is overwritten.
  Deleting shows the documents that use any of the files first.
- "Make a link" gives an address for someone outside. For a private store it
  works for 1 hour, 24 hours or 7 days and **cannot be taken back** (it is a
  signed address); for a public store it is the file's public address. Making
  one needs the permission to delete in that store, and is in the audit log.
- The CMS's own folder (`_cms/`, thumbnails) is hidden and cannot be touched.

## Agents

Agents get three more tools: `list_store_files` (read), `register_asset`
(write) and `create_share_link` (publish).

## REST

`GET /stores/:store/files?folder=` lists a folder. `POST /stores/:store/files/_register`, `_move` and `_delete` act on keys (`check: true` on a delete only counts what would go and which documents use it). `POST /assets/:id/share` with `{ ttl: "1h" | "24h" | "7d" }` makes a link.
