/**
 * Server entry of `@mainsoft-2024/agent-cms`.
 *   .            createCms, defineCollection, types, DrizzleRepo, MemoryRepo, tables
 *   ./http       createCmsHandler (REST + MCP on one route)
 *   ./mcp        createMcpServer, handleMcp (official MCP SDK)
 *   ./ai         cmsTools, remoteCmsTools (AI SDK / slash-agent-sdk tools)
 *   ./client     createCmsClient (MCP with a key), createRestClient (admin screens)
 *   ./tools      CMS_TOOLS (the one tool list behind MCP, ./ai and the CLI)
 *   ./agent      lookupForAgent, envelope, verifyCitations
 *   ./diff       line diff, hunks, merge3, mergeDocs (safe in the browser)
 *   ./markdown   parseMarkdown, extractToc (safe in the browser)
 *   ./errors     CmsError, codes; ./messages/en, ./messages/ko
 *   ./config     defineConfig for agent-cms.config.ts
 *   ./frontmatter docFromMarkdown
 *   ./cli        runCli
 */

export {
  BULK_ACTIONS,
  coreOf,
  createCms,
  createCmsCore,
  dayIn,
  defineCollection,
  LIMITS,
  mergePatch,
  PREVIEW_TTLS,
  SLUG_RE,
} from "./cms";
export type {
  AgentChange,
  AnyCollection,
  BulkAction,
  BulkResult,
  ChangeInfo,
  Cms,
  CmsCore,
  CmsLike,
  CollectionName,
  CreateCmsOptions,
  DocDiff,
  DocInput,
  FieldsOf,
  FieldsPatch,
  ListOptions,
  PreviewLink,
  PreviewRead,
  PreviewTtl,
  SearchOptions,
  SearchResult,
  TypedDoc,
  WriteOptions,
} from "./cms";
export { DrizzleRepo } from "./drizzle-repo";
export type { DoctorReport, DrizzleRepoOptions } from "./drizzle-repo";
export { MemoryRepo } from "./repo";
export type { AuditQuery, CmsRepo, DocPatch, KeyRow, NewDoc, NewVersion, StoredVersion } from "./repo";
export {
  cmsApiKeys,
  cmsAudit,
  cmsDdl,
  cmsDocuments,
  cmsHits,
  cmsMeta,
  cmsTables,
  cmsVersions,
  defaultTables,
  SCHEMA_VERSION,
  schemaVersionSql,
  splitSql,
  upgradeSteps,
} from "./tables";
export type { CmsTables, CmsTablesOptions } from "./tables";
export { citationId, envelope, ENVELOPE_PREAMBLE, lookupForAgent, verifyCitations } from "./agent";
export type { AgentLink, AgentLookup, AgentSection, Citation, LookupOptions } from "./agent";
export { applyPatch, sectionRanges } from "./patch";
export type { PatchOp, SectionRange } from "./patch";
export { normalizeQuery } from "./search";
export { CMS_TOOLS, CMS_TOOL_NAMES, toolsFor } from "./tools";
export type { CmsToolDef } from "./tools";
export { createCmsClient, createRestClient, CmsRemoteError, isCmsRemoteError } from "./client";
export type { CmsClient, CmsClientOptions, RestClient, RestClientOptions } from "./client";
export { docFromMarkdown, parseFrontmatter } from "./frontmatter";
export { VERSION } from "./version";
export * from "./types";
