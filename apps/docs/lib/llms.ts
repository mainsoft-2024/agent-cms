import "server-only";
import { docsNav, publishedDoc } from "./content";
import { siteUrl } from "./site";

/** llms.txt: what this site is and where each page's markdown lives. */
export async function llmsIndex(): Promise<string> {
  const base = siteUrl();
  const nav = await docsNav("en");
  const lines = [
    "# agent-cms",
    "",
    "> Serverless CMS for agents and humans: an add-on for Next.js apps with Postgres. People edit in admin screens; agents edit the same documents through MCP, AI SDK tools, a CLI and REST.",
    "",
    `Read these docs over MCP without a key: ${base}/api/cms/mcp (tools: search_documents, read_for_answer, get_document, list_documents, list_collections).`,
    `Full text in one file: ${base}/llms-full.txt`,
    "",
  ];
  for (const g of nav) {
    lines.push(`## ${g.section}`, "");
    for (const it of g.items) {
      const doc = await publishedDoc("docs", it.slug);
      lines.push(`- [${it.title}](${base}/docs/${it.slug}.md)${doc?.summary ? `: ${doc.summary}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Every English page in sidebar order, as one markdown file. */
export async function llmsFull(): Promise<string> {
  const nav = await docsNav("en");
  const parts: string[] = ["# agent-cms documentation", ""];
  for (const g of nav) {
    for (const it of g.items) {
      const doc = await publishedDoc("docs", it.slug);
      if (!doc) continue;
      parts.push(`# ${doc.title}`, "", `Source: ${siteUrl()}/docs/${doc.slug}`, "", doc.summary ? `${doc.summary}\n` : "", doc.body.trim(), "", "---", "");
    }
  }
  return parts.join("\n");
}
