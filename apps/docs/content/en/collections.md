---
title: Collections
summary: Visibility, fields, categories, access rules and hooks.
category: Guides
order: 1
---
A collection is a kind of document: posts, guides, notices. All collections share the same tables, so adding one needs no migration.

## Options

```ts
defineCollection({
  slug: "posts",
  label: "Blog",
  visibility: "public",                    // required: "public" or "internal"
  categories: ["News", "Engineering"],
  versions: { max: 100, drafts: true },    // edits wait for publish
  search: { enabled: true },
  fields: z.object({ cover: z.string().url().optional() }),
  admin: { fields: { cover: { label: "Cover image" } } },
  url: (d) => `/blog/${d.slug}`,
  access: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin },
});
```

## Visibility

Every collection says whether it is `public` or `internal`. An `internal` collection must say who may read it (`access.read`); the CMS refuses to start otherwise, so nothing is public by accident.

## Fields

`fields` is a zod object. The editor builds its form from it, and `cms.get` returns `fields` typed as the zod output. On `update`, `fields` is a JSON Merge Patch: keys you send replace, `null` removes, the rest stay.

## Access

The default: anyone reads published documents of public collections; admins write and publish; API keys do what their scopes allow (`read`, `write`, `publish`, `admin`, optionally per collection). Override `read`, `write` and `publish` per collection.

`managed: true` makes a collection writable only by your app code (the `system` actor).

## Hooks

`afterChange` hooks and `cms.onChange` listeners get `{ contentChanged }` as a second argument: false when only a draft changed and the public copy is the same, so you can skip revalidating pages.

`timeZone` on `createCms` (default `UTC`) decides which calendar day a usage count lands on.
