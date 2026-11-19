import { defineCollection } from "@mainsoft/agent-cms";
import { z } from "zod";

/** Sidebar groups of the docs, in order. */
export const SECTIONS = ["Get started", "Guides", "Agents", "Admin screens", "Reference", "Upgrade"] as const;
export type Section = (typeof SECTIONS)[number];

// Access: the defaults. Everyone reads published pages; people with push
// access to the repository (admins) write and publish; API keys do what their scopes allow.

const order = z.number().int().default(100);

export const docs = defineCollection({
  slug: "docs",
  label: "Docs",
  visibility: "public",
  categories: SECTIONS,
  url: (d) => `/docs/${d.slug}`,
  fields: z.object({ order }),
  admin: { fields: { order: { label: "Order in section", help: "Lower comes first." } } },
});

export const docsKo = defineCollection({
  slug: "docs-ko",
  label: "Docs (KO)",
  visibility: "public",
  categories: SECTIONS,
  url: (d) => `/ko/docs/${d.slug}`,
  fields: z.object({
    order,
    sourceVersion: z.number().int().min(0).default(0),
  }),
  admin: {
    fields: {
      order: { label: "Order in section" },
      sourceVersion: { label: "English version translated", help: "The page shows a notice when the English page is newer." },
    },
  },
});

export const components = defineCollection({
  slug: "components",
  label: "Components",
  visibility: "public",
  url: (d) => `/components/${d.slug}`,
  fields: z.object({ order }),
  admin: { fields: { order: { label: "Order in gallery" } } },
});

export const changelog = defineCollection({
  slug: "changelog",
  label: "Changelog",
  visibility: "public",
  url: (d) => `/changelog#${d.slug}`,
  // A release note is edited in place: saving republishes it.
  versions: { drafts: false },
  fields: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  admin: { fields: { date: { label: "Release date", help: "YYYY-MM-DD" } } },
});

export const collections = [docs, docsKo, components, changelog] as const;
