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
  defineSingle,
  SINGLE_SLUG,
  SLUG_HANGUL_RE,
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
  cmsComments,
  cmsPresence,
  cmsReleases,
  cmsSavedFilters,
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
  fillLocaleSql,
  localeDuplicatesSql,
} from "./tables";
export { localeAddress, splitAddress, translatableFields, LOCALE_RE } from "./locale";
export type { TranslationInfo, TranslationList, TranslationStatus } from "./locale";
export type { CmsTables, CmsTablesOptions } from "./tables";
export { citationId, envelope, ENVELOPE_PREAMBLE, lookupForAgent, verifyCitations } from "./agent";
export type { AgentLink, AgentLookup, AgentSection, Citation, LookupOptions } from "./agent";
export { applyPatch, sectionRanges } from "./patch";
export type { PatchOp, SectionRange } from "./patch";
export { normalizeQuery } from "./search";
export { callTool, CMS_TOOLS, CMS_TOOL_NAMES, runTool, toolErrorResult, toolsFor } from "./tools";
export { assetFields, assetId, humanSize } from "./assets";
export { relation, assetIds, fieldMarks, type FieldMark } from "./fields";
export { keyBetween, normalizePath, type RelatedDoc, type TreeNode } from "./model";
export { DEFAULT_VIDEO_HOSTS, videoEmbed } from "./video";
export type { AssetInfo, AssetListOptions, AssetUsage, AssetView, CmsAssets, MediaOptions, MediaStoreConfig, ScanFile, UploadInstructions, UploadRequest } from "./assets";
export { DEFAULT_ACCEPT, MemoryStorage } from "./storage";
export type { StorageAdapter } from "./storage";
export type { CallToolOptions, CmsToolDef, ToolErrorResult, ToolOutcome } from "./tools";
export { createCmsClient, createRestClient, CmsRemoteError, isCmsRemoteError, localeSlug } from "./client";
export type { TranslationView, TranslationsView } from "./client";
export type { CmsClient, CmsClientOptions, RestClient, RestClientOptions } from "./client";
export { docFromMarkdown, parseFrontmatter } from "./frontmatter";
export { VERSION } from "./version";
export * from "./types";

// 0.12.0: background jobs, webhooks, plugins, telemetry
export { JOB_LOCK_MS, type CmsJobs, type JobKind, type JobsRun } from "./jobs";
export { WEBHOOK_MAX_FAILURES, WEBHOOK_RETRY, type CmsOutbox, type OutEvent, type WebhookInput, type WebhookOptions, type WebhookView } from "./outbox";
export { definePlugin, versionSatisfies, type CmsEvent, type CmsPlugin, type CmsPluginFactory, type PluginContext, type PluginAccessQuery, type PluginDefinition, type PluginFilterName, type PluginFilters, type PluginHookName, type PluginInfo, type PluginSettingsView, type SettingField, type SettingFieldType, type PluginMail, type PluginStore, type SitemapEntry, type PluginInput, type PluginNav, type PluginRouteArgs, type PluginState, type PluginTool } from "./plugin";
export { PLUGIN_START_TIMEOUT_MS, PLUGIN_STOP_TIMEOUT_MS, type PluginHost } from "./plugins";
export { createSealer, type Sealer } from "./secrets";
export { signWebhook, verifyWebhook, WebhookVerifyError, type WebhookPayload } from "./webhooks";
export { cmsJobs, cmsWebhookDeliveries, cmsWebhooks } from "./tables";
export type { CmsTelemetry } from "./cms";

// 0.13.0: OpenAPI, import sources
export { API_ROUTES, openApiDocument, type ApiRoute, type OpenApiOptions } from "./openapi";
export { docsFromCsv, docsFromJson, docsFromWordpress, filesFromDocs, filesFromSource, htmlToMarkdown, IMPORT_SOURCES, parseCsv, slugify, type ImportSource, type SourceDoc } from "./import-sources";

// 0.14.0: request limits, retention, the events stream
export { clientIp, clientIpBehind, createLimiter, ipAllowed, MemoryRateLimitStore, type RateLimitOptions, type RateLimitStore, type RateVerdict } from "./limits";
export { type RetentionOptions, type RetentionReport } from "./retention";
// 0.22.0: forms
export { FORM_HONEYPOT, FORM_MAX_BODY, toCsv, type CmsForms, type FormCounts, type FormInput, type FormListItem, type FormNotice, type FormSettings, type FormsOptions, type FormSubmissionView, type FormView, type PublicForm, type UploadGrant } from "./forms";
export * from "./form-rules";
export type { FormSubmission, FormSubmissionStatus } from "./types";
export { eventStream, type EventStreamOptions } from "./events";

// 0.17.0: across servers, caching, metrics, tenants (also as their own entries)
export { memoryCache, pgChangeSignal, postgresJsChangeSignal, type CacheAdapter, type CacheOptions, type ChangeEvent, type ChangeSignal, type ChangesOptions } from "./changes";
export { createMetrics, routeOf, type Metrics } from "./metrics";
export type { FeedEvent } from "./cms";
export type { ChangeRow, DocPage, DocPageQuery, NewChange } from "./repo";
export { EXPECTED_INDEXES } from "./drizzle-repo";
