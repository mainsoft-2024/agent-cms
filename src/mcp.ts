/**
 * MCP over Streamable HTTP, stateless: every POST is one JSON-RPC message (or
 * a batch) and the reply is plain JSON. No sessions, no SSE — a coding agent
 * registers `https://app/api/cms/mcp` with `Authorization: Bearer sgk_…` and
 * gets the same rules as REST, because both call `cms`.
 *
 * The tools are the shared list in `tools.ts`, collection-generic, so a new
 * collection needs no new tool.
 */

import { z } from "zod";
import type { Cms } from "./cms";
import { toolsFor, CMS_TOOL_NAMES } from "./tools";
import { CmsError, type Actor } from "./types";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

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

const visibleTools = (cms: Cms, actor: Actor) => toolsFor(cms, actor);

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
        serverInfo: { name: "agent-cms", version: "0.5.0" },
        instructions:
          "A CMS that people and agents edit together. Documents are markdown with `## ` sections, grouped in collections (list_collections). Search before creating. When updating, read the draft first and pass its version as expectedVersion so a person's edit is never overwritten.",
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

export const MCP_TOOL_NAMES = CMS_TOOL_NAMES;
