import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/site/code-block";
import { siteUrl } from "@/lib/site";

export const metadata: Metadata = { title: "Read the docs with an agent", description: "Connect a coding agent to these docs over MCP, without a key." };

export default function Agents() {
  const base = siteUrl();
  const mcp = `${base}/api/cms/mcp`;
  const json = JSON.stringify({ mcpServers: { "agent-cms-docs": { url: mcp } } }, null, 2);
  return (
    <div className="mx-auto max-w-[880px] px-5 pt-6 pb-20 md:px-10">
      <h1 className="display d48 mb-2">Read the docs with an agent</h1>
      <p className="mb-8 max-w-[640px] text-[16px] text-[var(--color-warm-gray)]">
        These docs are served by agent-cms, so a coding agent can search and read them over MCP. No key is needed to read: anonymous callers get the read tools and published pages only.
      </p>

      <h2 className="mb-2 text-[18px] font-semibold">MCP server</h2>
      <div className="mb-4">
        <CodeBlock lang="url" code={mcp} />
      </div>
      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <div>
          <p className="label-mono mb-2">Claude Code</p>
          <CodeBlock lang="sh" code={`claude mcp add --transport http agent-cms-docs ${mcp}`} />
        </div>
        <div>
          <p className="label-mono mb-2">Cursor, VS Code and others (mcp.json)</p>
          <CodeBlock lang="json" code={json} />
        </div>
      </div>
      <p className="mb-10 text-[var(--color-warm-gray)]">
        Tools: <code className="inline-code">search_documents</code>, <code className="inline-code">read_for_answer</code> (sections with citation ids), <code className="inline-code">get_document</code>, <code className="inline-code">list_documents</code>, <code className="inline-code">list_collections</code>.
      </p>

      <h2 className="mb-2 text-[18px] font-semibold">Plain text</h2>
      <ul className="prose-site mb-10">
        <li>
          <a className="link" href="/llms.txt">
            /llms.txt
          </a>{" "}
          lists every page with a link to its markdown.
        </li>
        <li>
          <a className="link" href="/llms-full.txt">
            /llms-full.txt
          </a>{" "}
          is every English page in one file.
        </li>
        <li>
          Add <code className="inline-code">.md</code> to any docs address, for example{" "}
          <a className="link" href="/docs/install.md">
            /docs/install.md
          </a>
          .
        </li>
      </ul>

      <div className="callnote">
        <h3>Writing is for keys</h3>
        <p>
          Agents that edit these docs use an API key with the write scope; maintainers review their changes in the admin before publishing. To do the same in your app, see{" "}
          <Link href="/docs/mcp" className="underline">
            MCP
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
