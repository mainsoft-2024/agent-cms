/**
 * Server entry. Future package layout (`@mainsoft-2024/agent-cms`):
 *   .            → this file (createCms, defineCollection, types, DrizzleRepo, tables)
 *   ./http       → createCmsHandler
 *   ./mcp        → handleMcp
 *   ./agent      → lookupForAgent
 *   ./markdown   → parseMarkdown, extractToc (safe in the browser)
 *   ./cli        → runCli
 */

export { createCms, defineCollection, SLUG_RE } from "./cms";
export type { Cms, CoverageDoc, CreateCmsOptions, DocInput, SearchResult, WriteOptions } from "./cms";
export { DrizzleRepo } from "./drizzle-repo";
export { MemoryRepo } from "./repo";
export type { CmsRepo } from "./repo";
export { cmsDdl, cmsTables, cmsApiKeys, cmsDocuments, cmsGaps, cmsHits, cmsMeta, cmsVersions } from "./tables";
export { lookupForAgent } from "./agent";
export type { AgentLink, AgentLookup, AgentSection } from "./agent";
export * from "./types";
