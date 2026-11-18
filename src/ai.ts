/**
 * The CMS as AI SDK tools (`ai` v5+). They are plain AI SDK `Tool`s, so they
 * also work as-is with anything built on the AI SDK, such as slash-agent-sdk:
 * spread them into `tools` next to your own.
 *
 *   // Inside the app that hosts the CMS (no HTTP):
 *   tools: { ...cmsTools(cms, { kind: "system", label: "assistant" }) }
 *
 *   // Anywhere else (a script, CI, another service), with an API key:
 *   tools: { ...remoteCmsTools({ url: "https://app/api/cms", key: process.env.CMS_KEY! }) }
 *
 * Both expose the same list as the MCP endpoint (`CMS_TOOLS` in tools.ts).
 * Errors come back as `{ error, message }` results rather than throws, so the
 * model can read a conflict and retry instead of the run failing.
 */

import { tool, zodSchema, type Tool } from "ai";
import type { Cms } from "./cms";
import { createCmsClient, isCmsRemoteError, type CmsClientOptions } from "./client";
import { CMS_TOOLS, toolsFor, type CmsToolDef } from "./tools";
import { CmsError, isCmsError, type Actor } from "./types";

export interface CmsToolsOptions {
  /** Only these tools (by name). Default: every tool the actor may use. */
  only?: readonly string[];
  /** Prefix for tool names, e.g. "cms_" gives cms_get_document. Default none. */
  prefix?: string;
}

export type CmsToolMap = Record<string, Tool>;

function wrap(def: CmsToolDef, run: (args: Record<string, unknown>) => Promise<unknown>): Tool {
  return tool({
    description: def.description,
    inputSchema: zodSchema(def.input),
    execute: async (args: Record<string, unknown>) => {
      try {
        return await run(args);
      } catch (err) {
        if (isCmsError(err) || isCmsRemoteError(err)) return { error: err.code, message: err.message };
        throw err;
      }
    },
  } as never) as Tool;
}

/** Tools that act on a CMS in this process, as `actor`. */
export function cmsTools(cms: Cms, actor: Actor, opts: CmsToolsOptions = {}): CmsToolMap {
  const out: CmsToolMap = {};
  for (const def of toolsFor(cms, actor, opts.only)) {
    out[(opts.prefix ?? "") + def.name] = wrap(def, (args) => def.run(cms, actor, def.input.parse(args) as Record<string, unknown>));
  }
  return out;
}

/**
 * Tools that act on a CMS in another app, over its MCP endpoint with an API
 * key. Permissions are the key's: a read-only key gets errors from write
 * tools, so pass `only` to offer the model just what the key can do.
 */
export function remoteCmsTools(client: CmsClientOptions, opts: CmsToolsOptions = {}): CmsToolMap {
  const api = createCmsClient(client);
  const out: CmsToolMap = {};
  for (const def of CMS_TOOLS) {
    if (opts.only && !opts.only.includes(def.name)) continue;
    out[(opts.prefix ?? "") + def.name] = wrap(def, (args) => api.call(def.name, args));
  }
  return out;
}

/**
 * Like `remoteCmsTools`, but first asks the server (`tools/list`) which tools
 * this key may use, so the model is offered only those. One extra request at
 * startup; tools the server does not know are left out too.
 */
export async function remoteCmsToolsFor(client: CmsClientOptions, opts: CmsToolsOptions = {}): Promise<CmsToolMap> {
  const allowed = new Set((await createCmsClient(client).listTools()).map((t) => t.name));
  const names = CMS_TOOLS.map((t) => t.name).filter((n) => allowed.has(n) && (!opts.only || opts.only.includes(n)));
  return remoteCmsTools(client, { ...opts, only: names });
}
