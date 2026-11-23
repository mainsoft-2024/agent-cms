/**
 * The REST API as an OpenAPI 3.1 document, for clients in other languages and for tools that
 * read one (code generators, API explorers, GPT actions). `GET /openapi.json` serves it and
 * `npx @mainsoft/agent-cms openapi` prints it.
 *
 * The list of routes below is checked against the real handler by a test (`openapi.test.ts`):
 * every route written here must be answered by the handler, and every first path segment the
 * handler knows must appear here. Each collection the caller may read gets its own paths, so
 * a generated client has the collection's `fields` as a type.
 */
import { z } from "zod";
import { coreOf, PREVIEW_TTLS, BULK_ACTIONS, type CmsLike } from "./cms";
import { ERROR_CODES } from "./errors";
import { toJsonSchema } from "./mcp";
import { DOC_STATUSES, KEY_SCOPES, WEBHOOK_EVENTS, type Actor } from "./types";
import { SCHEMA_VERSION } from "./schema-version";
import { VERSION } from "./version";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Json = Record<string, unknown>;

export interface ApiRoute {
  method: Method;
  /** Path under the mount point, with `{name}` parameters. */
  path: string;
  summary: string;
  tag: string;
  /** Who may call it: anyone, a signed-in person or a key, someone who may write, an admin, or the cron secret. */
  auth: "public" | "read" | "write" | "admin" | "cron";
  query?: Record<string, string>;
  body?: z.ZodTypeAny | "binary";
  /** JSON Schema of the answer. */
  returns?: Json;
  /** Success status. Default 200. */
  status?: number;
  /** Only present when this part of the CMS is switched on. */
  needs?: "media" | "cron" | "preview" | "auth" | "redirects";
  /** The answer is a `text/event-stream` that stays open. */
  stream?: boolean;
}

const seoInput = z
  .object({ title: z.string().nullable().optional(), description: z.string().nullable().optional(), image: z.string().nullable().optional(), canonical: z.string().nullable().optional(), noindex: z.boolean().optional() })
  .nullable()
  .optional()
  .describe("Search engine details (collections with seo). Empty parts fall back to the title, summary and first image.");
const docInput = z
  .object({
    slug: z.string().optional().describe("Lowercase letters, digits and hyphens. Required when creating."),
    title: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional().describe("Markdown."),
    category: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
    fields: z.record(z.unknown()).optional().describe("The collection's own fields. On update this is merged (JSON Merge Patch): null removes a key."),
    seo: seoInput,
  })
  .strict();
const expectedVersion = z.number().int().positive().optional().describe("The version you read. A mismatch answers 409 with the current copy. `If-Match: \"v<n>\"` does the same.");
const writeBody = z.object({ doc: docInput, expectedVersion, publish: z.boolean().optional(), note: z.string().max(300).nullable().optional(), template: z.string().max(100).optional().describe("Start from a template (its key or id; 0.21.0)") });
const templateBody = z.object({ label: z.string().max(80).optional(), description: z.string().max(200).optional(), title: z.string().optional(), summary: z.string().optional(), body: z.string().optional(), fields: z.record(z.unknown()).optional() });
const redirectBody = z.object({ from: z.string().max(500).optional(), to: z.string().max(2000).optional(), toDocumentId: z.string().max(64).nullable().optional().describe("Follow this document's current public address (0.21.0)"), status: z.union([z.literal(301), z.literal(302)]).optional() });
const expected = z.object({ expectedVersion });
const comment = z.object({ body: z.string().max(8000), anchor: z.string().max(300).nullable().optional(), quote: z.string().max(2000).nullable().optional(), threadId: z.string().max(60).nullable().optional() });
const tags = z.array(z.string().max(40)).max(30).optional();
const trashItems = z.array(z.object({ kind: z.enum(["document", "asset"]), id: z.string() })).min(1).max(200);
const pick = z.object({ keys: z.array(z.string()).max(1000).optional(), folders: z.array(z.string()).max(1000).optional() });
const ttl = z.enum(Object.keys(PREVIEW_TTLS) as [string, ...string[]]).optional();
const automation = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  trigger: z.object({ event: z.string(), collection: z.string().nullable() }).optional(),
  conditions: z.array(z.object({ field: z.string(), op: z.enum(["is", "is_not", "contains", "empty", "not_empty"]), value: z.string().optional() })).max(10).optional(),
  actions: z.array(z.object({ type: z.string(), target: z.string().optional(), name: z.string().optional(), value: z.string().optional() })).max(10).optional(),
});
const role = z.object({ name: z.string().optional(), admin: z.boolean().optional(), permissions: z.record(z.record(z.boolean())).optional() });
const webhook = z.object({ name: z.string(), url: z.string(), events: z.array(z.enum(WEBHOOK_EVENTS)).optional(), collections: z.array(z.string()).optional(), enabled: z.boolean().optional() });

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Json, required: string[] = Object.keys(properties)): Json => ({ type: "object", properties, required });
const arr = (items: Json): Json => ({ type: "array", items });
const OK = obj({ ok: { const: true } });
const any: Json = { type: "object", additionalProperties: true };
const C = "/collections/{collection}";
const D = `${C}/{slug}`;

/** Every route of the handler. Collection routes are written once here and repeated per collection in the document. */
const BASE_ROUTES: readonly ApiRoute[] = [
  { method: "get", path: "/_me", summary: "Who am I, and what may I do", tag: "session", auth: "public", returns: any },
  { method: "get", path: "/openapi.json", summary: "This document", tag: "session", auth: "public", returns: any },
  { method: "get", path: "/search", summary: "Search published documents", tag: "search", auth: "public", query: { q: "The question or words", collections: "Comma-separated collections. Default: all you may read", limit: "1 to 20, default 8", miss: "1: tell the app when nothing is found (onSearchMiss)" }, returns: obj({ empty: { type: "boolean" }, hits: arr(ref("SearchHit")) }) },
  { method: "post", path: "/mcp", summary: "MCP endpoint (streamable HTTP, stateless)", tag: "agents", auth: "read", body: z.record(z.unknown()), returns: any },

  // documents
  { method: "get", path: C, summary: "List documents", tag: "documents", auth: "public", query: { fields: "summary: a page without bodies, with limit and cursor", drafts: "1: working copies (needs write)", state: "draft | published | modified | archived | scheduled | review", status: DOC_STATUSES.join(" | "), category: "", q: "Filter by title or address", by: "user | key | system: who wrote the latest version", limit: "", cursor: "", hits: "1: add hits7d (needs write)" }, returns: obj({ docs: arr(ref("Doc")) }) },
  { method: "post", path: C, summary: "Create a document", tag: "documents", auth: "write", body: writeBody, returns: obj({ doc: ref("Doc") }), status: 201 },
  { method: "get", path: `${C}/_counts`, summary: "How many documents are in each state", tag: "documents", auth: "write", returns: obj({ counts: any }) },
  { method: "get", path: `${C}/_schema`, summary: "The collection's fields as JSON Schema, with admin hints", tag: "documents", auth: "public", returns: any },
  { method: "post", path: `${C}/_diagnose`, summary: "Every problem a save would report; nothing is saved", tag: "documents", auth: "write", body: z.object({ doc: docInput, slug: z.string().optional() }), returns: obj({ diagnostics: arr(ref("Diagnostic")) }) },
  { method: "post", path: `${C}/_preview`, summary: "Blocks, table of contents, problems and diff of unsaved content", tag: "documents", auth: "write", body: z.object({ doc: docInput, slug: z.string().optional() }), returns: any },
  { method: "post", path: `${C}/_bulk`, summary: "One action on many documents", tag: "documents", auth: "write", body: z.object({ action: z.enum(BULK_ACTIONS), items: z.array(z.object({ slug: z.string(), expectedVersion })).min(1).max(200) }), returns: obj({ results: arr(any) }) },
  { method: "get", path: `${C}/_presence`, summary: "Who has which document open", tag: "editing together", auth: "write", returns: obj({ presence: arr(any) }) },
  { method: "get", path: `${C}/_filters`, summary: "Saved filters", tag: "documents", auth: "write", returns: obj({ filters: arr(any) }) },
  { method: "post", path: `${C}/_filters`, summary: "Save a filter", tag: "documents", auth: "write", body: z.object({ name: z.string().max(200), query: z.record(z.unknown()), shared: z.boolean().optional() }), returns: obj({ filter: any }), status: 201 },
  { method: "delete", path: `${C}/_filters/{id}`, summary: "Delete a saved filter", tag: "documents", auth: "write", returns: OK },
  { method: "get", path: D, summary: "Read a document", tag: "documents", auth: "public", query: { draft: "1: the working copy (needs write). Default: the public copy", expand: "Relation fields to fill in with the documents they point at, comma-separated (one level)", snippets: "raw: keep [[snippet:…]] tokens instead of filling them in" }, returns: obj({ doc: ref("Doc") }, ["doc"]) },
  { method: "get", path: `${D}/_refs`, summary: "Documents that point at this one through relation fields", tag: "content model", auth: "public", returns: obj({ referencedBy: arr(any) }) },
  { method: "get", path: `${D}/_seo`, summary: "Search engine details with fallbacks (title, description, image, canonical, noindex)", tag: "content model", auth: "public", query: { draft: "1: the working copy" }, returns: obj({ seo: any }) },
  { method: "get", path: `${D}/_ancestors`, summary: "Parents of a document in a tree, top first", tag: "content model", auth: "public", query: { draft: "1: working copies" }, returns: obj({ ancestors: arr(any) }) },
  { method: "get", path: `${D}/_snippet-uses`, summary: "Documents that use this snippet", tag: "content model", auth: "write", returns: obj({ docs: arr(any) }) },
  { method: "get", path: `${C}/_tree`, summary: "The collection's documents as a tree (collections with tree)", tag: "content model", auth: "public", query: { draft: "1: working copies (needs write)" }, returns: obj({ tree: arr(any) }) },
  { method: "post", path: `${C}/_move`, summary: "Move a document in the tree (no new version)", tag: "content model", auth: "write", body: z.object({ slug: z.string(), parentId: z.string().nullable().optional(), before: z.string().nullable().optional() }), returns: obj({ doc: ref("Doc") }) },
  { method: "get", path: `${C}/_suggest-slug`, summary: "An address for a title (Korean romanized unless slugs.hangul says otherwise)", tag: "content model", auth: "write", query: { title: "" }, returns: obj({ slug: { type: "string" } }) },
  { method: "get", path: `${C}/_templates`, summary: "Templates for new documents (the collection's own and the ones editors saved). Without write access: names only, no title, summary, body or fields", tag: "content model", auth: "read", returns: obj({ templates: arr(any) }) },
  { method: "post", path: `${C}/_templates`, summary: "Save a template", tag: "content model", auth: "write", body: templateBody, returns: obj({ template: any }), status: 201 },
  { method: "patch", path: `${C}/_templates/{id}`, summary: "Change a saved template (its maker or an admin)", tag: "content model", auth: "write", body: templateBody, returns: obj({ template: any }) },
  { method: "delete", path: `${C}/_templates/{id}`, summary: "Delete a saved template (its maker or an admin)", tag: "content model", auth: "write", returns: OK },
  { method: "get", path: "/singles/{collection}", summary: "The one document of a single (defaults until it is saved)", tag: "content model", auth: "public", query: { draft: "1: the working copy", expand: "" }, returns: obj({ doc: ref("Doc") }) },
  { method: "put", path: "/singles/{collection}", summary: "Save the one document of a single", tag: "content model", auth: "write", body: writeBody, returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: "/singles/{collection}/_publish", summary: "Publish the one document of a single", tag: "content model", auth: "write", body: expected, returns: obj({ doc: ref("Doc") }) },
  { method: "get", path: "/redirects", summary: "Redirects (admins), each with hits30d, daily (30 days, oldest first) and the target document", tag: "redirects", auth: "admin", returns: obj({ redirects: arr(any) }), needs: "redirects" },
  { method: "get", path: "/redirects/{id}/hits", summary: "Visits of a redirect per day (admins)", tag: "redirects", auth: "admin", query: { days: "How many days back (1 to 90, default 30)" }, returns: obj({ days: arr(any), total: { type: "integer" } }), needs: "redirects" },
  { method: "post", path: "/redirects", summary: "Add a redirect (chains are shortened, loops refused)", tag: "redirects", auth: "admin", body: redirectBody, returns: obj({ redirect: any }), status: 201, needs: "redirects" },
  { method: "get", path: "/redirects/_resolve", summary: "Where an old address goes now", tag: "redirects", auth: "public", query: { path: "" }, returns: obj({ redirect: any }), needs: "redirects" },
  { method: "patch", path: "/redirects/{id}", summary: "Change a redirect", tag: "redirects", auth: "admin", body: redirectBody, returns: obj({ redirect: any }), needs: "redirects" },
  { method: "delete", path: "/redirects/{id}", summary: "Delete a redirect", tag: "redirects", auth: "admin", returns: OK, needs: "redirects" },
  { method: "get", path: "/sitemap.xml", summary: "sitemap.xml of published public documents (noindex left out)", tag: "content model", auth: "public", query: { page: "Part of a sitemap with more than 50 000 addresses" }, returns: { type: "string" } },
  { method: "patch", path: D, summary: "Update a document (a new version)", tag: "documents", auth: "write", body: writeBody, returns: obj({ doc: ref("Doc") }) },
  { method: "delete", path: D, summary: "Move a document to the trash (409 doc_referenced when other documents point at it)", tag: "documents", auth: "write", query: { expectedVersion: "", force: "1: delete although documents point at it" }, returns: OK },
  { method: "post", path: `${D}/patch`, summary: "Change sections by anchor instead of sending the whole body", tag: "documents", auth: "write", body: z.object({ ops: z.array(z.object({ op: z.enum(["replace", "insert_after", "insert_before", "delete", "append"]), anchor: z.string().optional(), markdown: z.string().optional(), heading: z.string().optional() })).min(1).max(50), expectedVersion, dryRun: z.boolean().optional(), note: z.string().max(300).optional() }), returns: any },
  { method: "get", path: `${D}/read`, summary: "The document as a file with line numbers (for agents)", tag: "files", auth: "read", query: { offset: "First line (1-based)", limit: "Lines (default 400)", outline: "1: headings and blocks with their lines" }, returns: any },
  { method: "get", path: `${D}/file`, summary: "The document as one text file (frontmatter + body)", tag: "files", auth: "read", returns: { type: "string" } },
  { method: "put", path: `${D}/file`, summary: "Replace the document with a file (If-Match: version)", tag: "files", auth: "write", body: "binary", returns: any },
  { method: "post", path: `${D}/edit`, summary: "Replace exact text with new text, all edits or none, one version", tag: "files", auth: "write", body: z.object({ edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() })).min(1).max(50), expectedVersion, note: z.string().max(300).optional() }), returns: any },
  { method: "post", path: `${D}/file-link`, summary: "A 10-minute link to download or upload the file", tag: "files", auth: "read", body: z.object({ method: z.enum(["GET", "PUT"]).optional() }), returns: any, status: 201 },
  { method: "get", path: `${D}/suggestions`, summary: "Agents' edits kept as suggestions", tag: "files", auth: "write", returns: obj({ suggestions: arr(any) }) },
  { method: "post", path: `${D}/suggestions/{id}/apply`, summary: "Apply a suggestion (optionally changed)", tag: "files", auth: "write", body: z.object({ edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() })).min(1).max(50).optional(), note: z.string().max(300).optional() }), returns: any },
  { method: "post", path: `${D}/suggestions/{id}/reject`, summary: "Drop a suggestion", tag: "files", auth: "write", returns: any },
  { method: "post", path: `${D}/checks`, summary: "Problems and publish checks before publishing", tag: "documents", auth: "write", body: z.object({ doc: docInput.optional() }), returns: any },
  { method: "post", path: "/grep", summary: "Find lines across documents (literal or regex)", tag: "files", auth: "read", body: z.object({ pattern: z.string().min(1), regex: z.boolean().optional(), ignoreCase: z.boolean().optional(), collections: z.array(z.string()).optional(), slugs: z.array(z.string()).optional(), glob: z.string().optional(), context: z.number().int().min(0).max(5).optional(), output: z.enum(["lines", "files", "count"]).optional(), drafts: z.boolean().optional(), limit: z.number().int().positive().max(2000).optional() }), returns: any },
  { method: "get", path: "/raw/{token}", summary: "Download a document file through a link from file-link", tag: "files", auth: "public", returns: { type: "string" } },
  { method: "put", path: "/raw/{token}", summary: "Upload a document file through a link from file-link", tag: "files", auth: "public", body: "binary", returns: any },
  { method: "get", path: `${D}/sections`, summary: "The document's sections and anchors", tag: "documents", auth: "public", returns: obj({ sections: arr(any) }) },
  { method: "put", path: `${D}/autosave`, summary: "Keep unsaved editor content (no version is made)", tag: "documents", auth: "write", body: z.object({ doc: docInput, baseVersion: z.number().int().positive() }), returns: obj({ autosave: any }) },
  { method: "delete", path: `${D}/autosave`, summary: "Discard the unsaved content", tag: "documents", auth: "write", returns: OK },
  { method: "get", path: `${D}/changes`, summary: "Agent changes waiting for a person", tag: "review", auth: "write", returns: obj({ changes: arr(any) }) },
  { method: "post", path: `${D}/review`, summary: "Accept or revert agent changes", tag: "review", auth: "write", body: z.object({ hunks: z.union([z.literal("all"), z.array(z.string()).min(1)]), action: z.enum(["accepted", "reverted"]).optional() }), returns: any },
  { method: "post", path: `${D}/review/request`, summary: "Ask for a review", tag: "review", auth: "write", body: z.object({ note: z.string().max(2000).nullable().optional() }), returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/review/approve`, summary: "Approve a review", tag: "review", auth: "write", body: z.object({ note: z.string().max(2000).nullable().optional(), publish: z.boolean().optional() }), returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/review/reject`, summary: "Send a review back", tag: "review", auth: "write", body: z.object({ note: z.string().max(2000).nullable().optional() }), returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/preview`, summary: "Make a signed preview link", tag: "preview", auth: "write", body: z.object({ ttl, comments: z.boolean().optional() }), returns: any, status: 201, needs: "preview" },
  { method: "post", path: `${D}/schedule`, summary: "Publish or unpublish at a time", tag: "publishing", auth: "write", body: z.object({ publishAt: z.string().nullable().optional(), unpublishAt: z.string().nullable().optional(), expectedVersion }), returns: obj({ doc: ref("Doc") }) },
  { method: "delete", path: `${D}/schedule`, summary: "Cancel the schedule", tag: "publishing", auth: "write", returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/publish`, summary: "Publish", tag: "publishing", auth: "write", body: z.object({ version: z.number().int().positive().optional(), expectedVersion }), returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/unpublish`, summary: "Take the public copy down", tag: "publishing", auth: "write", body: expected, returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/archive`, summary: "Archive (409 doc_referenced when other documents point at it; force: true hides it anyway)", tag: "publishing", auth: "write", body: z.object({ expectedVersion, force: z.boolean().optional() }), returns: obj({ doc: ref("Doc") }) },
  { method: "post", path: `${D}/unarchive`, summary: "Bring back from the archive", tag: "publishing", auth: "write", body: expected, returns: obj({ doc: ref("Doc") }) },
  { method: "get", path: `${D}/comments`, summary: "Comments", tag: "review", auth: "write", query: { limit: "Page size (at most 500). Without it, everything", cursor: "nextCursor of the previous page" }, returns: obj({ comments: arr(any), nextCursor: { type: ["string", "null"] } }) },
  { method: "post", path: `${D}/comments`, summary: "Add a comment", tag: "review", auth: "write", body: comment, returns: obj({ comment: any }), status: 201 },
  { method: "post", path: `${D}/comments/{id}/resolve`, summary: "Resolve or reopen a comment thread", tag: "review", auth: "write", body: z.object({ resolved: z.boolean().optional() }), returns: obj({ comment: any }) },
  { method: "post", path: `${D}/presence`, summary: "Say that this document is open here", tag: "editing together", auth: "write", body: z.object({ cursor: z.object({ line: z.number().int(), ch: z.number().int() }).nullable().optional(), selection: z.object({ line: z.number().int(), ch: z.number().int() }).nullable().optional() }), returns: any },
  { method: "delete", path: `${D}/presence`, summary: "Leave the document", tag: "editing together", auth: "write", returns: OK },
  { method: "get", path: `${D}/diff`, summary: "Compare two versions", tag: "versions", auth: "write", query: { a: "Version number", b: "Version number" }, returns: any },
  { method: "get", path: `${D}/versions`, summary: "Version history", tag: "versions", auth: "write", query: { fields: "summary: without snapshots", limit: "This many (at most 500), cut by the database. Without it, all of them. Newest first either way", cursor: "nextCursor of the previous page (v.<version>)" }, returns: obj({ versions: arr(ref("Version")), total: { type: "integer" }, nextCursor: { type: ["string", "null"] } }) },
  { method: "get", path: `${D}/versions/{n}`, summary: "One version", tag: "versions", auth: "write", returns: obj({ version: ref("Version") }) },
  { method: "patch", path: `${D}/versions/{n}`, summary: "Name or pin a version", tag: "versions", auth: "write", body: z.object({ label: z.string().max(200).nullable().optional(), pinned: z.boolean().optional() }), returns: obj({ version: ref("Version") }) },
  { method: "post", path: `${D}/versions/{n}/restore`, summary: "Restore a version (as a new version)", tag: "versions", auth: "write", body: z.object({ expectedVersion, publish: z.boolean().optional() }), returns: obj({ doc: ref("Doc") }) },

  { method: "get", path: "/preview", summary: "The version a preview link points at", tag: "preview", auth: "public", query: { token: "" }, returns: any },
  { method: "get", path: "/preview/comments", summary: "Comments on a preview link", tag: "preview", auth: "public", query: { token: "" }, returns: obj({ comments: arr(any) }) },
  { method: "post", path: "/preview/comments", summary: "Comment through a preview link", tag: "preview", auth: "public", query: { token: "" }, body: comment.extend({ name: z.string().max(120).nullable().optional() }), returns: obj({ comment: any }), status: 201 },
  { method: "get", path: "/reviews", summary: "Documents waiting for a review", tag: "review", auth: "write", query: { collection: "" }, returns: obj({ requests: arr(any) }) },

  { method: "get", path: "/trash", summary: "What is in the trash", tag: "trash", auth: "write", query: { kind: "document | asset", q: "Words in the title, place or who deleted it", limit: "Page size (at most 500). Without it, everything", cursor: "nextCursor of the previous page" }, returns: any },
  { method: "post", path: "/trash/_restore", summary: "Bring items back", tag: "trash", auth: "write", body: z.object({ items: trashItems }), returns: any },
  { method: "post", path: "/trash/_purge", summary: "Delete items for good", tag: "trash", auth: "write", body: z.object({ items: trashItems.optional(), all: z.boolean().optional() }), returns: any },

  { method: "get", path: "/releases", summary: "Releases", tag: "releases", auth: "write", returns: obj({ releases: arr(any) }) },
  { method: "post", path: "/releases", summary: "Make a release", tag: "releases", auth: "write", body: z.object({ name: z.string().max(200) }), returns: obj({ release: any }), status: 201 },
  { method: "get", path: "/releases/{id}", summary: "One release with its items", tag: "releases", auth: "write", returns: obj({ release: any }) },
  { method: "patch", path: "/releases/{id}", summary: "Rename a release", tag: "releases", auth: "write", body: z.object({ name: z.string().max(200) }), returns: obj({ release: any }) },
  { method: "delete", path: "/releases/{id}", summary: "Delete a release (its documents stay)", tag: "releases", auth: "write", returns: OK },
  { method: "post", path: "/releases/{id}/items", summary: "Put documents into a release", tag: "releases", auth: "write", body: z.object({ items: z.array(z.object({ collection: z.string(), slug: z.string(), action: z.enum(["publish", "unpublish"]).optional() })).min(1).max(200) }), returns: obj({ release: any }) },
  { method: "delete", path: "/releases/{id}/items/{documentId}", summary: "Take a document out of a release", tag: "releases", auth: "write", returns: obj({ release: any }) },
  { method: "post", path: "/releases/{id}/publish", summary: "Publish everything in the release, or nothing", tag: "releases", auth: "write", returns: obj({ release: any }) },
  { method: "post", path: "/releases/{id}/schedule", summary: "Publish the release at a time", tag: "releases", auth: "write", body: z.object({ publishAt: z.string().max(40).nullable() }), returns: obj({ release: any }) },

  { method: "get", path: "/audit", summary: "Audit log", tag: "operations", auth: "admin", query: { cursor: "", limit: "", action: "", group: "All actions of one kind: doc, asset, key, …", outcome: "ok | denied | failed", actorKind: "user | key | system | anonymous", actorId: "One person or key", who: "Words in the name of who did it", collection: "", slug: "", since: "ISO time, inclusive", until: "ISO time, exclusive" }, returns: any },
  { method: "get", path: "/keys", summary: "API keys", tag: "operations", auth: "admin", returns: obj({ keys: arr(any) }) },
  { method: "post", path: "/keys", summary: "Make an API key (the secret is shown once)", tag: "operations", auth: "admin", body: z.object({ name: z.string(), scopes: z.array(z.enum(KEY_SCOPES)).min(1), collections: z.array(z.string()).nullable().optional(), expiresAt: z.string().nullable().optional(), rateLimit: z.number().int().min(1).max(100000).nullable().optional().describe("Requests per minute"), allowedIps: z.array(z.string()).max(50).nullable().optional().describe("Addresses and ranges, e.g. 203.0.113.0/24") }), returns: any, status: 201 },
  { method: "post", path: "/keys/{id}/rotate", summary: "A new secret for the same key; the old one works for graceMinutes more (default 60)", tag: "operations", auth: "admin", body: z.object({ graceMinutes: z.number().int().min(0).max(10080).optional() }), returns: any, status: 201 },
  { method: "delete", path: "/keys/{id}", summary: "Revoke a key", tag: "operations", auth: "admin", query: { reason: "Why (kept with the key)" }, returns: OK },
  { method: "get", path: "/retention", summary: "The retention rules in force", tag: "operations", auth: "admin", returns: obj({ rules: arr(any) }) },
  { method: "post", path: "/retention", summary: "Delete what is older than the rules allow; `dryRun` only counts", tag: "operations", auth: "admin", body: z.object({ dryRun: z.boolean().optional() }), returns: any },
  { method: "get", path: "/_events", summary: "What happens, as a stream (Server-Sent Events)", tag: "operations", auth: "public", query: { collections: "Comma-separated. Default: all you may read", since: "The last event id (a number in the change log), or an ISO time" }, stream: true },
  { method: "get", path: "/_changes", summary: "What changed after a number in the change log (polling instead of the stream)", tag: "operations", auth: "public", query: { since: "The `last` of the previous answer. 0: everything the log keeps", collections: "Comma-separated", limit: "Default 200, at most 1000" }, returns: obj({ changes: arr({ type: "object" }), last: { type: "integer" }, more: { type: "boolean" }, reset: { type: "boolean" } }) },
  { method: "get", path: "/_stats", summary: "The dashboard's numbers", tag: "operations", auth: "read", query: { days: "7 | 14 | 30" }, returns: any },
  { method: "get", path: "/export", summary: "Documents as markdown files", tag: "import and export", auth: "read", query: { collections: "Comma-separated. Default: all you may read", drafts: "1: working copies where you may write", download: "1: as a file download" }, returns: obj({ files: arr(ref("TransferFile")), documents: { type: "integer" } }) },
  { method: "post", path: "/import", summary: "Read files into documents (drafts); `dryRun` says what would happen", tag: "import and export", auth: "write", body: z.object({ files: z.array(z.object({ path: z.string().max(400), text: z.string() })).max(2000), dryRun: z.boolean().optional(), diff: z.boolean().optional(), publish: z.boolean().optional(), onConflict: z.enum(["file-wins", "db-wins", "newest"]).optional(), collection: z.string().optional(), only: z.array(z.string()).optional(), assetMap: z.record(z.string()).optional() }), returns: obj({ items: arr(any), applied: { type: "boolean" } }) },

  { method: "get", path: "/automations", summary: "Automations, with the triggers and actions that can be picked", tag: "automations", auth: "admin", returns: any },
  { method: "post", path: "/automations", summary: "Make an automation", tag: "automations", auth: "admin", body: automation, returns: obj({ automation: any }), status: 201 },
  { method: "patch", path: "/automations/{id}", summary: "Change an automation", tag: "automations", auth: "admin", body: automation, returns: obj({ automation: any }) },
  { method: "delete", path: "/automations/{id}", summary: "Delete an automation and its run history", tag: "automations", auth: "admin", returns: OK },
  { method: "get", path: "/automations/{id}/runs", summary: "Run history", tag: "automations", auth: "admin", query: { limit: "" }, returns: obj({ runs: arr(any) }) },
  { method: "post", path: "/automations/{id}/test", summary: "Check the conditions against one document; nothing is changed", tag: "automations", auth: "admin", body: z.object({ collection: z.string(), slug: z.string() }), returns: any },

  { method: "get", path: "/roles", summary: "Roles, with what can be allowed", tag: "roles", auth: "admin", returns: any },
  { method: "post", path: "/roles", summary: "Make a role", tag: "roles", auth: "admin", body: role, returns: obj({ role: any }), status: 201 },
  { method: "get", path: "/roles/_users", summary: "People by name or email (the app's, the sign-in's, and everyone who has used the admin), most recently active first", tag: "roles", auth: "admin", query: { q: "" }, returns: obj({ users: arr(any) }) },
  { method: "patch", path: "/roles/{id}", summary: "Change a role", tag: "roles", auth: "admin", body: role, returns: obj({ role: any }) },
  { method: "delete", path: "/roles/{id}", summary: "Delete a role", tag: "roles", auth: "admin", returns: OK },
  { method: "post", path: "/roles/{id}/members", summary: "Add a person to a role: one found by search (`id`), or by `email` (someone who has not signed in yet joins at their first visit)", tag: "roles", auth: "admin", body: z.object({ id: z.string().min(1).max(200).optional(), email: z.string().max(254).optional(), label: z.string().max(120).optional() }), returns: obj({ role: any }) },
  { method: "delete", path: "/roles/{id}/members/{userId}", summary: "Remove a person from a role", tag: "roles", auth: "admin", returns: obj({ role: any }) },

  { method: "get", path: "/webhooks", summary: "Webhooks", tag: "webhooks", auth: "admin", returns: any },
  { method: "post", path: "/webhooks", summary: "Make a webhook (the signing secret is returned once)", tag: "webhooks", auth: "admin", body: webhook, returns: any, status: 201 },
  { method: "patch", path: "/webhooks/{id}", summary: "Change a webhook", tag: "webhooks", auth: "admin", body: webhook.partial(), returns: obj({ webhook: any }) },
  { method: "delete", path: "/webhooks/{id}", summary: "Delete a webhook", tag: "webhooks", auth: "admin", returns: OK },
  { method: "get", path: "/webhooks/{id}/secret", summary: "Show the signing secret", tag: "webhooks", auth: "admin", returns: any },
  { method: "post", path: "/webhooks/{id}/test", summary: "Send a test delivery now", tag: "webhooks", auth: "admin", returns: obj({ delivery: any }) },
  { method: "get", path: "/webhooks/{id}/deliveries", summary: "Delivery history", tag: "webhooks", auth: "admin", query: { limit: "" }, returns: obj({ deliveries: arr(any) }) },
  { method: "post", path: "/webhooks/deliveries/{id}/retry", summary: "Send a delivery again", tag: "webhooks", auth: "admin", returns: any, status: 202 },
  { method: "get", path: "/jobs", summary: "Background jobs", tag: "operations", auth: "admin", query: { state: "waiting | failed | done", kind: "", limit: "" }, returns: any },
  { method: "post", path: "/jobs/{id}/retry", summary: "Run a failed job again", tag: "operations", auth: "admin", returns: OK },
  { method: "get", path: "/_cron", summary: "Run what is due: schedules, the trash, jobs. `Authorization: Bearer <cronSecret>`", tag: "operations", auth: "cron", returns: any, needs: "cron" },
  { method: "post", path: "/_cron", summary: "Same as GET", tag: "operations", auth: "cron", returns: any, needs: "cron" },

  // media
  { method: "get", path: "/assets/_zip", summary: "Several files as one zip download (at most 200 files, 200MB)", tag: "media", auth: "read", query: { ids: "" }, returns: any, needs: "media" },
  { method: "get", path: "/assets", summary: "Files in the media library", tag: "media", auth: "read", query: { store: "", folder: "", kind: "image,video,audio,document,other", q: "", tag: "", unused: "true", missingAlt: "true", sort: "new,old,name,size", cursor: "", limit: "" }, returns: any, needs: "media" },
  { method: "get", path: "/assets/_folders", summary: "Stores with their folders", tag: "media", auth: "read", returns: obj({ stores: arr(any) }), needs: "media" },
  { method: "post", path: "/assets/_folders", summary: "Make a folder", tag: "media", auth: "write", body: z.object({ store: z.string().nullable().optional(), path: z.string().min(1).max(400) }), returns: any, status: 201, needs: "media" },
  { method: "delete", path: "/assets/_folders", summary: "Delete an empty folder", tag: "media", auth: "write", query: { store: "", path: "" }, returns: OK, needs: "media" },
  { method: "post", path: "/assets/uploads", summary: "Ask to upload: the answer says where the bytes go", tag: "media", auth: "write", body: z.object({ name: z.string().min(1).max(300), mime: z.string().max(200).nullable().optional(), size: z.number().int().positive(), folder: z.string().max(400).nullable().optional(), store: z.string().nullable().optional(), alt: z.string().max(500).optional(), tags, field: z.object({ collection: z.string(), path: z.string() }).nullable().optional(), replace: z.string().max(40).nullable().optional() }), returns: any, status: 201, needs: "media" },
  { method: "get", path: "/assets/uploads/{id}", summary: "Which parts of an upload have arrived", tag: "media", auth: "write", returns: any, needs: "media" },
  { method: "delete", path: "/assets/uploads/{id}", summary: "Give up an upload", tag: "media", auth: "write", returns: OK, needs: "media" },
  { method: "post", path: "/assets/uploads/{id}/parts", summary: "Signed addresses for parts", tag: "media", auth: "write", body: z.object({ parts: z.array(z.number().int().positive()).min(1).max(200) }), returns: obj({ parts: arr(any) }), needs: "media" },
  { method: "post", path: "/assets/uploads/{id}/complete", summary: "Finish an upload (the file is checked)", tag: "media", auth: "write", body: z.object({ width: z.number().nullable().optional(), height: z.number().nullable().optional(), duration: z.number().nullable().optional() }), returns: obj({ asset: ref("Asset") }), needs: "media" },
  { method: "post", path: "/assets/_import", summary: "Fetch a file from a public https address", tag: "media", auth: "write", body: z.object({ url: z.string().max(2000), name: z.string().max(300).nullable().optional(), folder: z.string().max(400).nullable().optional(), store: z.string().nullable().optional(), alt: z.string().max(500).optional(), tags }), returns: obj({ asset: ref("Asset") }), status: 201, needs: "media" },
  { method: "get", path: "/assets/{id}", summary: "A file and the documents that use it", tag: "media", auth: "read", returns: obj({ asset: ref("Asset") }), needs: "media" },
  { method: "patch", path: "/assets/{id}", summary: "Change alt text, tags or the focal point", tag: "media", auth: "write", body: z.object({ alt: z.string().max(500).optional(), tags, focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional() }), returns: obj({ asset: ref("Asset") }), needs: "media" },
  { method: "delete", path: "/assets/{id}", summary: "Move a file to the trash (409 when documents use it)", tag: "media", auth: "write", query: { confirm: "1: delete although documents use it" }, returns: OK, needs: "media" },
  { method: "post", path: "/assets/{id}/move", summary: "Move or rename a file", tag: "media", auth: "write", body: z.object({ folder: z.string().max(400).nullable().optional(), name: z.string().max(300).nullable().optional() }), returns: obj({ asset: ref("Asset") }), needs: "media" },
  { method: "post", path: "/assets/{id}/share", summary: "A link to a private file that expires", tag: "media", auth: "write", body: z.object({ ttl }), returns: obj({ url: { type: "string" }, expiresAt: { type: "string" } }), needs: "media" },
  { method: "post", path: "/assets/{id}/thumb", summary: "Store a thumbnail (WebP, JPEG or PNG up to 512KB)", tag: "media", auth: "write", body: "binary", returns: obj({ asset: ref("Asset") }), needs: "media" },
  { method: "get", path: "/files/{id}/{name}", summary: "Redirect to the file (private files need a session or a key)", tag: "media", auth: "public", query: { thumb: "1", download: "1", size: "A size name from the image module" }, status: 302, needs: "media" },
  { method: "get", path: "/stores/{store}/files", summary: "One folder of a bucket: sub-folders and files", tag: "files", auth: "admin", query: { prefix: "", q: "", cursor: "", limit: "" }, returns: any, needs: "media" },
  { method: "get", path: "/stores/{store}/files/_open", summary: "Redirect to a file by key", tag: "files", auth: "admin", query: { key: "", download: "1" }, status: 302, needs: "media" },
  { method: "post", path: "/stores/{store}/files/_register", summary: "Make the library know a file that is already in the bucket", tag: "files", auth: "admin", body: z.object({ key: z.string().min(1).max(1024), alt: z.string().max(500).optional(), tags }), returns: obj({ asset: ref("Asset") }), status: 201, needs: "media" },
  { method: "post", path: "/stores/{store}/files/_move", summary: "Move files and folders", tag: "files", auth: "admin", body: pick.extend({ to: z.string().max(1024).nullable() }), returns: any, needs: "media" },
  { method: "post", path: "/stores/{store}/files/_delete", summary: "Delete files and folders", tag: "files", auth: "admin", body: pick.extend({ confirm: z.boolean().optional(), check: z.boolean().optional() }), returns: any, needs: "media" },
];

const doc = (fields: Json): Json => ({
  type: "object",
  required: ["id", "collection", "slug", "title", "summary", "body", "category", "keywords", "fields", "status", "version", "publishedVersion", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    collection: { type: "string" },
    slug: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    body: { type: "string", description: "Markdown" },
    category: { type: ["string", "null"] },
    keywords: arr({ type: "string" }),
    fields,
    status: { enum: [...DOC_STATUSES] },
    version: { type: "integer", description: "Latest version (the working copy). Send it back as expectedVersion or If-Match." },
    publishedVersion: { type: ["integer", "null"] },
    published: { type: ["object", "null"], description: "The public copy (title, summary, body, category, keywords, fields), or null when never published", additionalProperties: true },
    publishedAt: { type: ["string", "null"], format: "date-time" },
    republishedAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    updatedBy: { type: ["string", "null"] },
    updatedByKind: { enum: ["user", "key", "system", null] },
    updatedByAgent: { type: ["string", "null"] },
    deletedAt: { type: ["string", "null"], format: "date-time" },
    schedule: { type: ["object", "null"], additionalProperties: true },
    review: { type: ["object", "null"], additionalProperties: true },
  },
});

const SCHEMAS: Json = {
  Error: {
    type: "object",
    required: ["error", "kind", "message"],
    properties: { error: { type: "string", description: "A stable code", examples: ["not_found", "conflict_version", "forbidden_write"], enum: Object.keys(ERROR_CODES) }, kind: { type: "string" }, message: { type: "string", description: "For people; in the CMS's language" }, params: { type: "object", additionalProperties: true }, current: { description: "On 409: the copy that is there now", type: "object", additionalProperties: true } },
  },
  Doc: doc({ type: "object", additionalProperties: true }),
  DocInput: toJsonSchema(docInput),
  Diagnostic: { type: "object", required: ["path", "code", "message", "severity"], properties: { path: { type: "string" }, code: { type: "string" }, message: { type: "string" }, severity: { enum: ["error", "warning"] }, params: { type: "object", additionalProperties: true } } },
  SearchHit: { type: "object", properties: { collection: { type: "string" }, slug: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, category: { type: ["string", "null"] }, heading: { type: ["string", "null"] }, anchor: { type: ["string", "null"] }, score: { type: "number" } } },
  Version: { type: "object", properties: { version: { type: "integer" }, authorKind: { enum: ["user", "key", "system"] }, authorLabel: { type: "string" }, authorAgent: { type: ["string", "null"] }, note: { type: ["string", "null"] }, published: { type: "boolean" }, createdAt: { type: "string", format: "date-time" }, label: { type: ["string", "null"] }, pinned: { type: "boolean" }, snapshot: { type: "object", additionalProperties: true } } },
  TransferFile: { type: "object", required: ["path", "text"], properties: { path: { type: "string", examples: ["guide/getting-started.md"] }, text: { type: "string" } } },
  Asset: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, name: { type: "string" }, store: { type: "string" }, key: { type: "string" }, mime: { type: "string" }, size: { type: "integer" }, kind: { type: "string" }, alt: { type: "string" }, tags: arr({ type: "string" }), url: { type: "string" }, width: { type: ["integer", "null"] }, height: { type: ["integer", "null"] } } },
};

const AUTH_TEXT: Record<ApiRoute["auth"], string> = {
  public: "Anyone, for what is public. A key or a session sees more.",
  read: "A signed-in person or a key.",
  write: "A person or key that may write (the action's own permission is checked: write, publish, delete).",
  admin: "An admin, or a key with the admin scope.",
  cron: "The cron secret.",
};

export interface OpenApiOptions {
  /** Where the handler is mounted. Default "/api/cms". */
  basePath?: string;
  /** The site's address, e.g. "https://example.com". Default: none (paths are relative). */
  origin?: string;
  /** Whose view: collections this actor cannot read are left out. Default: anonymous. */
  actor?: Actor;
  /** The handler has the CMS's own sign-in: list `/auth/*` and `/users/*`. */
  auth?: boolean;
}

/** The OpenAPI 3.1 document for this CMS as it is configured. */
// The CMS's own sign-in (`createAuth`): what it needs in bodies.
const credential = z.object({ id: z.string(), rawId: z.string().optional(), type: z.literal("public-key"), response: z.record(z.unknown()) }).passthrough().describe("What navigator.credentials.create/get returned, with ArrayBuffers as base64url");
const AUTH_ROUTES: readonly ApiRoute[] = [
  { method: "get", path: "/auth/state", summary: "Is setup needed, which ways to sign in, who is signed in", tag: "sign-in", auth: "public", returns: any, needs: "auth" },
  { method: "post", path: "/auth/setup", summary: "Make the first admin with the setup code the server printed", tag: "sign-in", auth: "public", body: z.object({ code: z.string(), email: z.string(), name: z.string().optional(), password: z.string().optional() }), returns: any, status: 201, needs: "auth" },
  { method: "post", path: "/auth/login", summary: "Sign in with email and password (may answer `mfa: true` with a ticket)", tag: "sign-in", auth: "public", body: z.object({ email: z.string(), password: z.string() }), returns: any, needs: "auth" },
  { method: "post", path: "/auth/mfa", summary: "Finish signing in with a two-step code or a recovery code", tag: "sign-in", auth: "public", body: z.object({ ticket: z.string(), code: z.string().optional(), recovery: z.string().optional(), remember: z.boolean().optional() }), returns: any, needs: "auth" },
  { method: "post", path: "/auth/logout", summary: "Sign out this browser", tag: "sign-in", auth: "public", body: z.object({}), returns: OK, needs: "auth" },
  { method: "post", path: "/auth/reset/request", summary: "Mail a password reset link (the same answer whether the account exists or not)", tag: "sign-in", auth: "public", body: z.object({ email: z.string() }), returns: any, needs: "auth" },
  { method: "get", path: "/auth/reset", summary: "Whose reset link this is", tag: "sign-in", auth: "public", query: { token: "From the link" }, returns: any, needs: "auth" },
  { method: "post", path: "/auth/reset", summary: "Set a new password with a reset link; ends every session", tag: "sign-in", auth: "public", body: z.object({ token: z.string(), password: z.string() }), returns: any, needs: "auth" },
  { method: "get", path: "/auth/invite/{id}", summary: "Who an invitation is for", tag: "sign-in", auth: "public", returns: any, needs: "auth" },
  { method: "post", path: "/auth/invite/{id}", summary: "Accept an invitation (a password, or none and add a passkey next)", tag: "sign-in", auth: "public", body: z.object({ name: z.string().optional(), password: z.string().optional() }), returns: any, status: 201, needs: "auth" },
  { method: "post", path: "/auth/passkey/options", summary: "Options for navigator.credentials (login, register or reauth)", tag: "sign-in", auth: "public", body: z.object({ purpose: z.enum(["login", "register", "reauth"]) }), returns: any, needs: "auth" },
  { method: "post", path: "/auth/passkey/verify", summary: "Check what the browser's passkey sent back", tag: "sign-in", auth: "public", body: z.object({ challengeId: z.string(), credential, label: z.string().optional() }), returns: any, needs: "auth" },
  { method: "get", path: "/auth/oidc/start", summary: "Go to the single sign-on provider", tag: "sign-in", auth: "public", query: { next: "Admin path to come back to" }, returns: any, status: 303, needs: "auth" },
  { method: "get", path: "/auth/oidc/callback", summary: "Where the provider sends the browser back", tag: "sign-in", auth: "public", returns: any, status: 303, needs: "auth" },
  { method: "post", path: "/auth/reauth", summary: "Confirm it is you with the password (10 minutes)", tag: "sign-in", auth: "read", body: z.object({ password: z.string() }), returns: OK, needs: "auth" },
  { method: "get", path: "/auth/policy", summary: "The sign-in policy", tag: "people", auth: "admin", returns: any, needs: "auth" },
  { method: "patch", path: "/auth/policy", summary: "Require two-step sign-in for everyone", tag: "people", auth: "admin", body: z.object({ requireMfa: z.boolean() }), returns: any, needs: "auth" },
  { method: "get", path: "/auth/me", summary: "My account: profile, preferences, passkeys, two-step", tag: "account", auth: "read", returns: any, needs: "auth" },
  { method: "patch", path: "/auth/me", summary: "Change my name, theme or language", tag: "account", auth: "read", body: z.object({ name: z.string().nullable().optional(), prefs: z.object({ theme: z.enum(["light", "dark", "system"]).optional(), locale: z.string().optional() }).optional() }), returns: any, needs: "auth" },
  { method: "post", path: "/auth/me/password", summary: "Change my password (ends my other sessions)", tag: "account", auth: "read", body: z.object({ current: z.string().optional(), password: z.string() }), returns: any, needs: "auth" },
  { method: "get", path: "/auth/me/sessions", summary: "Where I am signed in", tag: "account", auth: "read", returns: any, needs: "auth" },
  { method: "delete", path: "/auth/me/sessions", summary: "Sign out everywhere else", tag: "account", auth: "read", returns: any, needs: "auth" },
  { method: "delete", path: "/auth/me/sessions/{id}", summary: "Sign out one device", tag: "account", auth: "read", returns: any, needs: "auth" },
  { method: "post", path: "/auth/me/totp", summary: "Start two-step setup (no code: secret and QR), or confirm it (code: recovery codes)", tag: "account", auth: "read", body: z.object({ code: z.string().optional() }), returns: any, needs: "auth" },
  { method: "delete", path: "/auth/me/totp", summary: "Turn two-step sign-in off (confirm first)", tag: "account", auth: "read", returns: OK, needs: "auth" },
  { method: "post", path: "/auth/me/recovery", summary: "New recovery codes (the old ones stop working)", tag: "account", auth: "read", body: z.object({}), returns: any, needs: "auth" },
  { method: "patch", path: "/auth/me/passkeys/{id}", summary: "Rename a passkey", tag: "account", auth: "read", body: z.object({ label: z.string() }), returns: any, needs: "auth" },
  { method: "delete", path: "/auth/me/passkeys/{id}", summary: "Remove a passkey (confirm first)", tag: "account", auth: "read", returns: any, needs: "auth" },
  { method: "get", path: "/users", summary: "People and open invitations", tag: "people", auth: "admin", query: { q: "Search by name or email" }, returns: any, needs: "auth" },
  { method: "post", path: "/users/invite", summary: "Invite people by email (links for 7 days)", tag: "people", auth: "admin", body: z.object({ emails: z.array(z.string()).min(1).max(50), roleId: z.string().nullable().optional(), admin: z.boolean().optional() }), returns: any, status: 201, needs: "auth" },
  { method: "delete", path: "/users/invites/{id}", summary: "Withdraw an invitation", tag: "people", auth: "admin", returns: OK, needs: "auth" },
  { method: "post", path: "/users/invites/{id}/resend", summary: "Send an invitation again (a new link)", tag: "people", auth: "admin", body: z.object({}), returns: any, needs: "auth" },
  { method: "patch", path: "/users/{id}", summary: "Change a person: name, role, admin, switched off (ends their sessions)", tag: "people", auth: "admin", body: z.object({ name: z.string().nullable().optional(), disabled: z.boolean().optional(), admin: z.boolean().optional(), roleId: z.string().nullable().optional() }), returns: any, needs: "auth" },
  { method: "post", path: "/users/{id}/reset-link", summary: "A password reset link for someone (mailed when mail is set up)", tag: "people", auth: "admin", body: z.object({}), returns: any, needs: "auth" },
  { method: "delete", path: "/users/{id}/sessions", summary: "Sign someone out everywhere", tag: "people", auth: "admin", returns: any, needs: "auth" },
];

/** Every REST route. The ones marked `needs: "auth"` exist when the handler has the CMS's own sign-in. */
export const API_ROUTES: readonly ApiRoute[] = [...BASE_ROUTES, ...AUTH_ROUTES];

export function openApiDocument(cms: CmsLike, o: OpenApiOptions = {}): Json {
  const core = coreOf(cms);
  const actor: Actor = o.actor ?? { kind: "anonymous" };
  const base = (o.basePath ?? "/api/cms").replace(/\/$/, "");
  const cols = core.collections().filter((c) => core.can(actor, c.slug, "read"));
  const on = { media: core.assets.describe(actor) !== null, cron: !!core.cronSecret, preview: core.previewEnabled(), auth: !!o.auth, redirects: core.redirects.enabled() };
  const schemas: Json = { ...SCHEMAS };
  const paths: Record<string, Json> = {};
  const param = (name: string, values?: string[]): Json => ({ name, in: "path", required: true, schema: values ? { type: "string", enum: values } : name === "n" ? { type: "integer", minimum: 1 } : { type: "string" } });

  const add = (r: ApiRoute, path: string, id: string, swap: (s: Json | undefined) => Json | undefined = (s) => s, tag = r.tag, bodySchema?: Json) => {
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const op: Json = {
      operationId: id,
      summary: r.summary,
      tags: [tag],
      description: AUTH_TEXT[r.auth],
      ...(r.auth === "public" ? { security: [{}, { apiKey: [] }, { session: [] }] } : r.auth === "cron" ? { security: [{ cronSecret: [] }] } : {}),
      parameters: [...names.map((n) => param(n, n === "collection" ? cols.map((c) => c.slug) : undefined)), ...Object.entries(r.query ?? {}).map(([name, description]) => ({ name, in: "query", required: false, schema: { type: "string" }, ...(description ? { description } : {}) }))],
      responses: {
        [String(r.status ?? 200)]: r.status === 302 ? { description: "Redirect to the file", headers: { location: { schema: { type: "string" } } } } : r.stream ? { description: "Messages with `id`, `event` and a JSON `data` line", content: { "text/event-stream": { schema: { type: "string" } } } } : { description: "OK", content: { "application/json": { schema: swap(r.returns) ?? any } } },
        default: { description: "An error. `error` is a stable code; `message` is for people.", content: { "application/json": { schema: ref("Error") } } },
      },
    };
    if (r.body === "binary") op.requestBody = { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } };
    else if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: bodySchema ?? toJsonSchema(r.body) } } };
    (paths[path] ??= {})[r.method] = op;
  };
  const opId = (r: ApiRoute, suffix = "") =>
    `${r.method}${r.path
      .split("/")
      .filter(Boolean)
      .map((p) => p.replace(/[{}]/g, "").replace(/^_/, "").replace(/\.json$/, ""))
      .map((p) => p[0].toUpperCase() + p.slice(1).replace(/[-_](\w)/g, (_m, c: string) => c.toUpperCase()))
      .join("")}${suffix}`;

  for (const r of API_ROUTES) {
    if (r.needs && !on[r.needs]) continue;
    add(r, r.path, opId(r));
  }
  // Each collection again with its own fields, for typed clients: list, create, read, update, delete.
  for (const c of cols) {
    const name = c.slug.replace(/(^|-)(\w)/g, (_m, _d, ch: string) => ch.toUpperCase());
    const fields = c.fields ? toJsonSchema(c.fields) : { type: "object", additionalProperties: true };
    schemas[`${name}Doc`] = doc(fields);
    const input = toJsonSchema(docInput) as { properties: Json };
    schemas[`${name}Input`] = { ...input, properties: { ...input.properties, fields: { ...fields, description: "On update, send only what changes (null removes a key)." }, ...(c.categories ? { category: { enum: [...c.categories, null] } } : {}) } };
    const swap = (s: Json | undefined) => (s ? (JSON.parse(JSON.stringify(s).replaceAll('"#/components/schemas/Doc"', `"#/components/schemas/${name}Doc"`)) as Json) : s);
    for (const r of API_ROUTES.filter((x) => (x.path === C && (x.method === "get" || x.method === "post")) || (x.path === D && ["get", "patch", "delete"].includes(x.method)))) {
      const body = r.body && r.body !== "binary" ? ({ ...toJsonSchema(r.body), properties: { ...(toJsonSchema(r.body).properties as Json), doc: ref(`${name}Input`) } } as Json) : undefined;
      add(r, r.path.replace("{collection}", c.slug), `${r.method}${name}${r.path === C ? (r.method === "get" ? "List" : "") : "Doc"}`, swap, c.label, body);
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "agent-cms",
      version: VERSION,
      description:
        "REST API of an agent-cms installation. Reads of published documents in public collections need no login. Everything else takes an API key (`Authorization: Bearer sgk_…`, made on the API keys screen) or the app's own session cookie. Writes take `expectedVersion` (or `If-Match`) and answer 409 with the current copy when someone saved in between. Errors are `{ error, kind, message, params }`.",
      license: { name: "MIT" },
    },
    servers: [{ url: `${(o.origin ?? "").replace(/\/$/, "")}${base}` }],
    security: [{ apiKey: [] }, { session: [] }],
    tags: [...new Set([...API_ROUTES.filter((r) => !r.needs || on[r.needs]).map((r) => r.tag), ...cols.map((c) => c.label)])].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "An API key: `sgk_…`. Scopes: read, write, publish, admin; a key can be limited to collections." },
        session: { type: "apiKey", in: "cookie", name: "session", description: "The host app's own login. The cookie's name depends on the app." },
        cronSecret: { type: "http", scheme: "bearer", description: "`createCms({ cronSecret })`." },
      },
      schemas,
    },
    "x-agent-cms": { collections: cols.map((c) => ({ slug: c.slug, label: c.label, visibility: c.visibility })), schemaVersion: SCHEMA_VERSION },
  };
}
