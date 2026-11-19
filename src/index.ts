/**
 * Server entry of `@mainsoft/agent-cms`.
 *   .            createCms, defineCollection, types, DrizzleRepo, MemoryRepo, tables
 *   ./http       createCmsHandler (REST + MCP on one route)
 *   ./mcp        createMcpServer, handleMcp (official MCP SDK)
 *   ./client     createCmsClient (MCP with a key), createRestClient (admin screens)
 *   ./tools      CMS_TOOLS (the one tool list behind MCP and the CLI), toolsFor, callTool
 *   ./storage    StorageAdapter (what a file store must do), MemoryStorage, DEFAULT_ACCEPT, acceptsFile
 *   ./storage-s3 s3Storage: S3-compatible storage (AWS S3, R2, MinIO) for the media library
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
export type { AssetPatch, AssetQuery, AuditQuery, CmsRepo, DocPatch, KeyRow, NewAsset, NewAudit, NewDoc, NewVersion, StoredVersion } from "./repo";
export {
  cmsApiKeys,
  cmsAssetRefs,
  cmsAssets,
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
export { callTool, CMS_TOOLS, CMS_TOOL_NAMES, runTool, toolErrorResult, toolsFor } from "./tools";
export { assetFields, assetId, humanSize } from "./assets";
export type { AssetInfo, AssetListOptions, AssetUsage, AssetView, CmsAssets, MediaOptions, MediaStoreConfig, UploadInstructions, UploadRequest } from "./assets";
export { DEFAULT_ACCEPT, MemoryStorage } from "./storage";
export type { StorageAdapter } from "./storage";
export type { CallToolOptions, CmsToolDef, ToolErrorResult, ToolOutcome } from "./tools";
export { createCmsClient, createRestClient, CmsRemoteError, isCmsRemoteError } from "./client";
export type { CmsClient, CmsClientOptions, RestClient, RestClientOptions } from "./client";
export { docFromMarkdown, parseFrontmatter } from "./frontmatter";
export { VERSION } from "./version";
export * from "./types";
