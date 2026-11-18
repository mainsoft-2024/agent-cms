/**
 * The one list of operations an agent can perform. MCP (`mcp.ts`), the AI SDK
 * tools (`ai.ts`) and the CLI all expose exactly this list, so an agent sees
 * the same tools whichever way it connects.
 */

import { z } from "zod";
import type { Cms } from "./cms";
import { lookupForAgent } from "./agent";
import { DOC_STATUSES, type Actor } from "./types";

const docInput = {
  slug: z.string().optional().describe("URL slug, e.g. my-first-post (lowercase letters, digits, hyphens unless the collection allows more)"),
  title: z.string().optional(),
  summary: z.string().optional().describe("One-line summary shown in lists and search results"),
  body: z.string().optional().describe("Markdown body. `## ` headings split it into sections for search"),
  category: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional().describe("Other words people search with, e.g. synonyms or English names"),
  fields: z.record(z.unknown()).optional().describe("Collection-specific fields (see list_collections)"),
};

export interface CmsToolDef {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (cms: Cms, actor: Actor, args: Record<string, unknown>) => Promise<unknown>;
  /** Hidden when the actor could never call it. */
  needs?: "write" | "publish";
}

const col = z.string().describe("Collection slug (see list_collections)");
const slug = z.string().describe("Document slug");

const summaryOf = (d: Awaited<ReturnType<Cms["get"]>>) => ({
  slug: d.slug,
  title: d.title,
  summary: d.summary,
  category: d.category,
  status: d.status,
  version: d.version,
  publishedVersion: d.publishedVersion,
  publishedAt: d.publishedAt,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

export const CMS_TOOLS: CmsToolDef[] = [
  {
    name: "list_collections",
    description: "List the collections in this CMS (e.g. blog posts, docs, notices) with their categories and whether edits wait for publish.",
    input: z.object({}),
    run: async (cms, actor) =>
      cms
        .collections()
        .filter((c) => cms.can(actor, c.slug, "read"))
        .map((c) => ({
          slug: c.slug,
          label: c.label,
          categories: c.categories ?? null,
          draftsMode: c.versions?.drafts !== false,
          canWrite: cms.can(actor, c.slug, "write"),
          canPublish: cms.can(actor, c.slug, "publish"),
        })),
  },
  {
    name: "search_documents",
    description: "Keyword search over published documents; returns matching sections. Search before creating, to avoid duplicates.",
    input: z.object({ collections: z.array(z.string()).optional(), query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    run: async (cms, actor, a) => {
      const cols = (a.collections as string[] | undefined)?.length
        ? (a.collections as string[])
        : cms.collections().map((c) => c.slug).filter((c) => cms.can(actor, c, "read"));
      const r = await cms.search(actor, cols, a.query as string, { limit: (a.limit as number) ?? 8, logGap: false });
      return r.hits.map((h) => ({ collection: h.unit.collection, slug: h.unit.slug, title: h.unit.title, heading: h.unit.heading, score: Number(h.score.toFixed(3)) }));
    },
  },
  {
    name: "read_for_answer",
    description: "Find the sections that answer a question, with their links. Use to answer a user from the CMS content.",
    input: z.object({ collections: z.array(z.string()), query: z.string(), slug: z.string().optional() }),
    run: async (cms, actor, a) => lookupForAgent(cms, actor, a.collections as string[], a.query as string, { slug: (a.slug as string) ?? null }),
  },
  {
    name: "list_documents",
    description: "List documents of a collection. drafts=true (needs write access) also lists drafts and archived ones.",
    input: z.object({ collection: col, drafts: z.boolean().optional(), status: z.enum(DOC_STATUSES).optional(), category: z.string().optional() }),
    run: async (cms, actor, a) =>
      (await cms.list(actor, a.collection as string, { drafts: !!a.drafts, status: a.status as never, category: a.category as string | undefined })).map(summaryOf),
  },
  {
    name: "get_document",
    description: "Read one document. draft=true returns the latest working copy (needs write access); use its version as expectedVersion when updating.",
    input: z.object({ collection: col, slug, draft: z.boolean().optional() }),
    run: async (cms, actor, a) => cms.get(actor, a.collection as string, a.slug as string, { draft: !!a.draft }),
  },
  {
    name: "create_document",
    needs: "write",
    description: "Create a document. It stays a draft unless publish=true (needs publish access).",
    input: z.object({ collection: col, doc: z.object(docInput), publish: z.boolean().optional(), note: z.string().optional().describe("Why, shown in the version history") }),
    run: async (cms, actor, a) =>
      cms.create(actor, a.collection as string, a.doc as never, { publish: a.publish as boolean | undefined, note: a.note as string | undefined }),
  },
  {
    name: "update_document",
    needs: "write",
    description:
      "Change a document (only the fields you pass). Pass expectedVersion from get_document(draft=true) so a person's concurrent edit is never overwritten: a mismatch fails with a conflict.",
    input: z.object({
      collection: col,
      slug,
      doc: z.object(docInput),
      expectedVersion: z.number().int().positive().optional(),
      publish: z.boolean().optional(),
      note: z.string().optional(),
    }),
    run: async (cms, actor, a) =>
      cms.update(actor, a.collection as string, a.slug as string, a.doc as never, {
        expectedVersion: a.expectedVersion as number | undefined,
        publish: a.publish as boolean | undefined,
        note: a.note as string | undefined,
      }),
  },
  {
    name: "publish_document",
    needs: "publish",
    description: "Publish the latest (or a given) version of a document.",
    input: z.object({ collection: col, slug, version: z.number().int().positive().optional() }),
    run: async (cms, actor, a) => cms.publish(actor, a.collection as string, a.slug as string, { version: a.version as number | undefined }),
  },
  {
    name: "unpublish_document",
    needs: "publish",
    description: "Take a document off the public site and back to draft. History is kept.",
    input: z.object({ collection: col, slug }),
    run: async (cms, actor, a) => cms.unpublish(actor, a.collection as string, a.slug as string),
  },
  {
    name: "archive_document",
    needs: "publish",
    description: "Hide a published document (archived=true) or show it again (archived=false).",
    input: z.object({ collection: col, slug, archived: z.boolean() }),
    run: async (cms, actor, a) =>
      a.archived ? cms.archive(actor, a.collection as string, a.slug as string) : cms.unarchive(actor, a.collection as string, a.slug as string),
  },
  {
    name: "delete_document",
    needs: "publish",
    description: "Delete a document and its history permanently. Prefer archive_document unless asked to delete.",
    input: z.object({ collection: col, slug }),
    run: async (cms, actor, a) => {
      await cms.remove(actor, a.collection as string, a.slug as string);
      return { deleted: true };
    },
  },
  {
    name: "list_versions",
    needs: "write",
    description: "Version history of a document (newest first), with author and note.",
    input: z.object({ collection: col, slug }),
    run: async (cms, actor, a) =>
      (await cms.versions(actor, a.collection as string, a.slug as string)).map((v) => ({ version: v.version, author: v.authorLabel, authorKind: v.authorKind, note: v.note, published: v.published, createdAt: v.createdAt })),
  },
  {
    name: "restore_version",
    needs: "write",
    description: "Make an old version the latest again (saved as a new version).",
    input: z.object({ collection: col, slug, version: z.number().int().positive(), publish: z.boolean().optional() }),
    run: async (cms, actor, a) => cms.restore(actor, a.collection as string, a.slug as string, a.version as number, { publish: a.publish as boolean | undefined }),
  },
  {
    name: "list_gaps",
    needs: "write",
    description: "Searches and questions that no document answered (open by default). Good ideas for new documents.",
    input: z.object({ collection: col, state: z.enum(["open", "done", "ignored"]).optional() }),
    run: async (cms, actor, a) => cms.gaps(actor, a.collection as string, (a.state as "open" | "done" | "ignored" | undefined) ?? "open"),
  },
  {
    name: "resolve_gap",
    needs: "write",
    description: "Mark a gap done (a document now answers it) or ignored.",
    input: z.object({ collection: col, id: z.string(), state: z.enum(["open", "done", "ignored"]) }),
    run: async (cms, actor, a) => cms.setGapState(actor, a.collection as string, a.id as string, a.state as "open" | "done" | "ignored"),
  },
];

export const CMS_TOOL_NAMES = CMS_TOOLS.map((t) => t.name);

/** The tools this actor can use (read-only tools for readers, and so on). */
export function toolsFor(cms: Cms, actor: Actor, only?: readonly string[]): CmsToolDef[] {
  const cols = cms.collections().map((c) => c.slug);
  return CMS_TOOLS.filter((t) => (!only || only.includes(t.name)) && (!t.needs || cols.some((c) => cms.can(actor, c, t.needs!))));
}
