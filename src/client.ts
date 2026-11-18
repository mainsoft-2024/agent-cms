/**
 * A small client for an app that runs agent-cms, over its MCP endpoint and an
 * API key. Used by `remoteCmsTools` (an agent running anywhere: a script, CI,
 * another app) and by the CLI. Needs only `fetch` (Node 18+, edge runtimes).
 * Never ship a write key to a browser.
 */

export interface CmsClientOptions {
  /** The CMS base URL, e.g. https://app.example.com/api/cms */
  url: string;
  /** An API key (`sgk_…`). */
  key: string;
  fetch?: typeof fetch;
}

export class CmsRemoteError extends Error {
  constructor(
    message: string,
    /** e.g. "conflict", "forbidden", "not_found" (from the server), or "http" / "rpc". */
    public code: string
  ) {
    super(message);
  }
}

export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createCmsClient(opts: CmsClientOptions) {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  let seq = 0;

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await doFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${opts.key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
    });
    const text = await res.text();
    let msg: { result?: unknown; error?: { message?: string } } | null = null;
    try {
      msg = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok || !msg) throw new CmsRemoteError(msg?.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`, "http");
    if (msg.error) throw new CmsRemoteError(msg.error.message ?? "RPC error", "rpc");
    return msg.result;
  }

  return {
    /** Tools this key can use. */
    async listTools(): Promise<RemoteTool[]> {
      const r = (await rpc("tools/list", {})) as { tools: RemoteTool[] };
      return r.tools;
    },
    /** Call one tool (see `CMS_TOOL_NAMES`). Throws CmsRemoteError on failure. */
    async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = (await rpc("tools/call", { name, arguments: args })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
        structuredContent?: unknown;
      };
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      if (r.isError) {
        const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
        throw new CmsRemoteError(m ? m[2] : text, m ? m[1] : "tool");
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return r.structuredContent as T;
      }
    },
  };
}

export type CmsClient = ReturnType<typeof createCmsClient>;
