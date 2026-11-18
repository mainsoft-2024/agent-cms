/**
 * Server entry of `@mainsoft-2024/agent-cms`.
 *   .            createCms, defineCollection, types, DrizzleRepo, MemoryRepo, tables
 *   ./http       createCmsHandler (REST + MCP on one route)
 *   ./ai         cmsTools, remoteCmsTools (AI SDK / slash-agent-sdk tools)
 *   ./client     createCmsClient (call a remote CMS with an API key)
 *   ./tools      CMS_TOOLS (the one tool list behind MCP, ./ai and the CLI)
 *   ./agent      lookupForAgent (sections + links to answer a question)
 *   ./markdown   parseMarkdown, extractToc (safe in the browser)
 *   ./frontmatter docFromMarkdown
 *   ./cli        runCli
 */

export { createCms, defineCollection, SLUG_RE } from "./cms";
export type { Cms, CreateCmsOptions, DocInput, SearchResult, WriteOptions } from "./cms";
export { DrizzleRepo } from "./drizzle-repo";
export { MemoryRepo } from "./repo";
export type { CmsRepo } from "./repo";
export { cmsDdl, cmsTables, cmsApiKeys, cmsDocuments, cmsGaps, cmsHits, cmsMeta, cmsVersions } from "./tables";
export { lookupForAgent } from "./agent";
export type { AgentLink, AgentLookup, AgentSection } from "./agent";
export { CMS_TOOLS, CMS_TOOL_NAMES, toolsFor } from "./tools";
export type { CmsToolDef } from "./tools";
export { createCmsClient, CmsRemoteError, isCmsRemoteError } from "./client";
export type { CmsClient, CmsClientOptions } from "./client";
export { docFromMarkdown, parseFrontmatter } from "./frontmatter";
export * from "./types";
