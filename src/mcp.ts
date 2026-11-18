/**
 * MCP over Streamable HTTP, stateless: every POST is one JSON-RPC message (or
 * a batch) and the reply is plain JSON. No sessions, no SSE — a coding agent
 * registers `https://app/api/cms/mcp` with `Authorization: Bearer sgk_…` and
 * gets the same rules as REST, because both call `cms`.
 *
 * Tool names follow Payload's MCP plugin in spirit (find / create / update per
 * resource) but stay collection-generic so a new collection needs no new tool.
 */

import { z } from "zod";
import type { Cms } from "./cms";
import { lookupForAgent } from "./agent";
import { CmsError, type Actor } from "./types";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const docInput = {
  slug: z.string().optional().describe("URL slug: lowercase letters, digits, hyphens"),
  title: z.string().optional(),
  summary: z.string().optional().describe("One-line summary shown in lists and search"),
  body: z.string().optional().describe("Markdown body. Use `## ` sections; `[[link:key|label]]` for app screens"),
  category: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional().describe("Aliases people search with, e.g. 슬랙, slack"),
  covers: z.array(z.string()).optional().describe("Source globs this doc explains, e.g. src/features/settings/**"),
  fields: z.record(z.unknown()).optional(),
};

interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (cms: Cms, actor: Actor, args: Record<string, unknown>) => Promise<unknown>;
  /** Hidden from tools/list when the actor could never call it. */
  needs?: "write" | "publish";
}

const col = z.string().describe("Collection slug");

const TOOLS: ToolDef[] = [
  {
    name: "list_collections",
    description: "List the collections in this CMS with their categories and whether coverage applies.",
    input: z.object({}),
    run: async (cms) =>
      cms.collections().map((c) => ({ slug: c.slug, label: c.label, categories: c.categories ?? null, coverage: !!c.coverage, draftsMode: c.versions?.drafts !== false })),
  },
  {
    name: "search_documents",
    description: "Keyword search over published documents (returns sections). Use before writing to avoid duplicates.",
    input: z.object({ collections: z.array(z.string()).optional(), query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    run: async (cms, actor, a) => {
      const cols = (a.collections as string[] | undefined)?.length ? (a.collections as string[]) : cms.collections().map((c) => c.slug);
      const r = await cms.search(actor, cols, a.query as string, { limit: (a.limit as number) ?? 8, logGap: false });
      return r.hits.map((h) => ({ collection: h.unit.collection, slug: h.unit.slug, title: h.unit.title, heading: h.unit.heading, score: Number(h.score.toFixed(3)) }));
    },
  },
  {
    name: "read_for_answer",
    description: "What an assistant sees when answering a user: the best matching sections and resolved screen links.",
    input: z.object({ collections: z.array(z.string()), query: z.string(), slug: z.string().optional() }),
    run: async (cms, actor, a) => lookupForAgent(cms, actor, a.collections as string[], a.query as string, { slug: (a.slug as string) ?? null }),
  },
  {
    name: "list_documents",
    description: "List documents. With drafts=true (needs write access) includes drafts, pending and archived, with status and needsReview.",
    input: z.object({ collection: col, drafts: z.boolean().optional(), status: z.enum(["draft", "pending", "published", "archived"]).optional(), needsReview: z.boolean().optional() }),
    run: async (cms, actor, a) =>
      (await cms.list(actor, a.collection as string, { drafts: !!a.drafts, status: a.status as never, needsReview: a.needsReview as boolean | undefined })).map((d) => ({
        slug: d.slug,
        title: d.title,
        category: d.category,
        status: d.status,
        version: d.version,
        publishedVersion: d.publishedVersion,
        needsReview: d.needsReview,
        pendingPr: d.pendingPr,
        updatedAt: d.updatedAt,
      })),
  },
  {
    name: "get_document",
    description: "Read one document. draft=true returns the working copy (needs write access), including covers and review reason.",
    input: z.object({ collection: col, slug: z.string(), draft: z.boolean().optional() }),
    run: async (cms, actor, a) => cms.get(actor, a.collection as string, a.slug as string, { draft: !!a.draft }),
  },
  {
    name: "create_document",
    needs: "write",
    description:
      "Create a document. Without publish it is a draft. With pr=<number> it waits for that PR to deploy and is then published automatically (this also satisfies the CI coverage check).",
    input: z.object({ collection: col, doc: z.object(docInput), pr: z.number().int().positive().optional(), publish: z.boolean().optional(), note: z.string().optional() }),
    run: async (cms, actor, a) => cms.create(actor, a.collection as string, a.doc as never, { pr: a.pr as number | undefined, publish: a.publish as boolean | undefined, note: a.note as string | undefined }),
  },
  {
    name: "update_document",
    needs: "write",
    description:
      "Change fields of a document (only the fields you pass). Pass expectedVersion (from get_document draft=true) so a concurrent human edit is not overwritten. pr / publish behave as in create_document.",
    input: z.object({
      collection: col,
      slug: z.string(),
      doc: z.object(docInput),
      expectedVersion: z.number().int().positive().optional(),
      pr: z.number().int().positive().optional(),
      publish: z.boolean().optional(),
      note: z.string().optional(),
    }),
    run: async (cms, actor, a) =>
      cms.update(actor, a.collection as string, a.slug as string, a.doc as never, {
        expectedVersion: a.expectedVersion as number | undefined,
        pr: a.pr as number | undefined,
        publish: a.publish as boolean | undefined,
        note: a.note as string | undefined,
      }),
  },
  {
    name: "publish_document",
    needs: "publish",
    description: "Publish the latest (or a given) version of a document.",
    input: z.object({ collection: col, slug: z.string(), version: z.number().int().positive().optional() }),
    run: async (cms, actor, a) => cms.publish(actor, a.collection as string, a.slug as string, { version: a.version as number | undefined }),
  },
  {
    name: "list_versions",
    needs: "write",
    description: "Version history of a document (newest first), with author and note.",
    input: z.object({ collection: col, slug: z.string() }),
    run: async (cms, actor, a) =>
      (await cms.versions(actor, a.collection as string, a.slug as string)).map((v) => ({ version: v.version, author: v.authorLabel, authorKind: v.authorKind, note: v.note, pr: v.pr, published: v.published, createdAt: v.createdAt })),
  },
  {
    name: "restore_version",
    needs: "write",
    description: "Make an old version the latest again (as a new version).",
    input: z.object({ collection: col, slug: z.string(), version: z.number().int().positive(), publish: z.boolean().optional() }),
    run: async (cms, actor, a) => cms.restore(actor, a.collection as string, a.slug as string, a.version as number, { publish: a.publish as boolean | undefined }),
  },
  {
    name: "mark_reviewed",
    needs: "write",
    description: "Clear the 'needs review' flag after checking a document against a code change.",
    input: z.object({ collection: col, slug: z.string() }),
    run: async (cms, actor, a) => cms.markReviewed(actor, a.collection as string, a.slug as string),
  },
  {
    name: "list_gaps",
    needs: "write",
    description: "Questions users asked that no document answered (open by default). Good input for new documents.",
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
  {
    name: "check_coverage",
    description: "Which documents cover the given changed files, and whether PR <pr> already carries an update for each.",
    input: z.object({ files: z.array(z.string()), pr: z.number().int().positive().optional() }),
    run: async (cms, actor, a) => cms.coverage(actor, a.files as string[], (a.pr as number | undefined) ?? null),
  },
];

/** JSON Schema for a zod object (the subset our tool inputs use). */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const describe = (s: z.ZodTypeAny, out: Record<string, unknown>) => (s.description ? { ...out, description: s.description } : out);
  const inner = (s: z.ZodTypeAny): z.ZodTypeAny => (s instanceof z.ZodOptional || s instanceof z.ZodNullable ? inner(s.unwrap()) : s);
  const base = inner(schema);
  let out: Record<string, unknown>;
  if (base instanceof z.ZodObject) {
    const shape = base.shape as Record<string, z.ZodTypeAny>;
    out = {
      type: "object",
      properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, toJsonSchema(v)])),
      required: Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([k]) => k),
      additionalProperties: false,
    };
  } else if (base instanceof z.ZodString) out = { type: "string" };
  else if (base instanceof z.ZodNumber) out = { type: base.isInt ? "integer" : "number" };
  else if (base instanceof z.ZodBoolean) out = { type: "boolean" };
  else if (base instanceof z.ZodEnum) out = { type: "string", enum: base.options };
  else if (base instanceof z.ZodArray) out = { type: "array", items: toJsonSchema(base.element) };
  else if (base instanceof z.ZodRecord) out = { type: "object", additionalProperties: true };
  else out = {};
  if (schema instanceof z.ZodNullable || (schema instanceof z.ZodOptional && schema.unwrap() instanceof z.ZodNullable)) {
    out = { anyOf: [out, { type: "null" }] };
  }
  return describe(schema, describe(base, out));
}

function visibleTools(cms: Cms, actor: Actor): ToolDef[] {
  const cols = cms.collections().map((c) => c.slug);
  return TOOLS.filter((t) => !t.needs || cols.some((c) => cms.can(actor, c, t.needs!)));
}

async function dispatch(cms: Cms, actor: Actor, msg: RpcRequest): Promise<Record<string, unknown> | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-cms", version: "0.1.0" },
        instructions:
          "Documents are markdown with `## ` sections. Search before creating. When a code PR changes what a document explains, update it with pr=<PR number> so it publishes on deploy.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: visibleTools(cms, actor).map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.input) })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      // Same list as tools/list: a hidden tool is not callable either.
      const tool = visibleTools(cms, actor).find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${name}`);
      const parsed = tool.input.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) {
        return reply({ isError: true, content: [{ type: "text", text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }] });
      }
      try {
        const result = await tool.run(cms, actor, parsed.data as Record<string, unknown>);
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: Array.isArray(result) ? { items: result } : result ?? {} });
      } catch (err) {
        const text = err instanceof CmsError ? `${err.code}: ${err.message}` : "internal error";
        if (!(err instanceof CmsError)) console.error("[agent-cms] mcp tool failed:", err);
        return reply({ isError: true, content: [{ type: "text", text }] });
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(cms: Cms, actor: Actor, req: Request): Promise<Response> {
  if (actor.kind === "anonymous") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "API key required" } }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="agent-cms"' },
    });
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(payload);
  const msgs = (batch ? payload : [payload]) as RpcRequest[];
  if (msgs.length > 20) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large (max 20)" } }, { status: 413 });
  const out: Record<string, unknown>[] = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      out.push({ jsonrpc: "2.0", id: (m as RpcRequest | null)?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    const r = await dispatch(cms, actor, m);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0], { headers: { "cache-control": "no-store" } });
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
