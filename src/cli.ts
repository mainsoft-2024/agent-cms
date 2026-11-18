/**
 * `agent-cms` CLI: read and write documents in an app's CMS with an API key.
 * Handy for an agent with a shell (a coding agent posting a release note) or a
 * script. Same operations as the MCP tools.
 *
 *   agent-cms tools                                   tools this key can use
 *   agent-cms collections
 *   agent-cms list <collection> [--drafts]
 *   agent-cms get <collection> <slug> [--draft]
 *   agent-cms search <query> [--collections a,b]
 *   agent-cms put <collection> <file.md> [--publish] [--note "why"]
 *       create, or update (with the current version, so a concurrent edit
 *       is never overwritten). Frontmatter: see frontmatter.ts.
 *   agent-cms publish <collection> <slug>
 *   agent-cms call <tool> '<json args>'               any tool
 *
 * Env: AGENT_CMS_URL (https://app/api/cms) and AGENT_CMS_KEY (sgk_…), or
 * `--env <file>` with those two lines. Output is JSON.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createCmsClient, CmsRemoteError, isCmsRemoteError } from "./client";
import { docFromMarkdown } from "./frontmatter";

export interface CliIo {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

/** Positional args (flags and their values removed). */
function positional(argv: string[]): string[] {
  const out: string[] = [];
  const withValue = new Set(["--env", "--note", "--collections"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (withValue.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const USAGE = `usage: agent-cms <tools|collections|list|get|search|put|publish|call> ... [--env file]
see https://github.com/mainsoft-2024/agent-cms#cli`;

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const read = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const envFile = flag(argv, "env");
  const env = { ...(io.env ?? process.env), ...(envFile ? parseEnvFile(read(envFile)) : {}) };
  const [cmd, ...args] = positional(argv);
  if (!cmd || cmd === "help" || argv.includes("--help")) {
    out(USAGE);
    return cmd ? 0 : 1;
  }
  if (!env.AGENT_CMS_URL || !env.AGENT_CMS_KEY) {
    err("[agent-cms] set AGENT_CMS_URL and AGENT_CMS_KEY (or pass --env <file>).");
    return 1;
  }
  const api = createCmsClient({ url: env.AGENT_CMS_URL, key: env.AGENT_CMS_KEY, fetch: io.fetch });
  const print = (v: unknown) => out(JSON.stringify(v, null, 2));
  const need = (n: number) => {
    if (args.length < n) throw new CmsRemoteError(`missing arguments\n${USAGE}`, "usage");
  };

  try {
    switch (cmd) {
      case "tools":
        print((await api.listTools()).map((t) => ({ name: t.name, description: t.description })));
        return 0;
      case "collections":
        print(await api.call("list_collections"));
        return 0;
      case "list":
        need(1);
        print(await api.call("list_documents", { collection: args[0], drafts: argv.includes("--drafts") }));
        return 0;
      case "get":
        need(2);
        print(await api.call("get_document", { collection: args[0], slug: args[1], draft: argv.includes("--draft") }));
        return 0;
      case "search": {
        need(1);
        const cols = flag(argv, "collections");
        print(await api.call("search_documents", { query: args.join(" "), collections: cols ? cols.split(",") : undefined }));
        return 0;
      }
      case "publish":
        need(2);
        print(await api.call("publish_document", { collection: args[0], slug: args[1] }));
        return 0;
      case "put": {
        need(2);
        const [collection, file] = args;
        const doc = docFromMarkdown(read(file), basename(file).replace(/\.(md|markdown)$/i, ""));
        const publish = argv.includes("--publish");
        const note = flag(argv, "note");
        const current = await api
          .call<{ version: number }>("get_document", { collection, slug: doc.slug, draft: true })
          .catch((e: unknown) => {
            if (isCmsRemoteError(e) && e.code === "not_found") return null;
            throw e;
          });
        const result = current
          ? await api.call("update_document", { collection, slug: doc.slug, doc, expectedVersion: current.version, publish, note })
          : await api.call("create_document", { collection, doc, publish, note });
        print(result);
        return 0;
      }
      case "call": {
        need(1);
        const parsed = args[1] ? JSON.parse(args[1]) : {};
        print(await api.call(args[0], parsed));
        return 0;
      }
      default:
        err(`unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    err(`[agent-cms] ${isCmsRemoteError(e) ? `${e.code}: ` : ""}${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
