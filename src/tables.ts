/**
 * Drizzle table definitions. The app re-exports these from its own schema so
 * drizzle-kit and the app's typed client see them; `cmsDdl()` prints the
 * idempotent SQL that creates (and upgrades) them for apps that write their
 * own migrations.
 *
 * One set of tables serves every collection (a `collection` column), so a new
 * collection never needs a migration. `cmsTables({ prefix, schema })` makes a
 * set with another name prefix or in another Postgres schema.
 *
 * 0.6.0 no longer defines `cms_gaps`. An existing `cms_gaps` table is left
 * alone (never read, written or dropped): see UPGRADE-0.6.md.
 */

import { bigint, bigserial, boolean, date, index, integer, jsonb, pgSchema, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AuditEntry, AutosaveState, DocContent, DocSeo, KeyScope, Presence, ReleaseItem, ReviewMark, ReviewRequest, Schedule, VersionChange } from "./types";

import { SCHEMA_VERSION } from "./schema-version";

export { SCHEMA_VERSION };

export interface CmsTablesOptions {
  /** Table name prefix. Default "cms_". */
  prefix?: string;
  /** Postgres schema. Default: the search path (usually "public"). */
  schema?: string;
}

const NAME_RE = /^[a-z_][a-z0-9_]*$/;

export function cmsTables(o: CmsTablesOptions = {}) {
  const prefix = o.prefix ?? "cms_";
  if (!NAME_RE.test(prefix)) throw new Error(`[agent-cms] table prefix must match ${NAME_RE}: ${prefix}`);
  if (o.schema && !NAME_RE.test(o.schema)) throw new Error(`[agent-cms] schema name must match ${NAME_RE}: ${o.schema}`);
  const table = (o.schema ? pgSchema(o.schema).table : pgTable) as typeof pgTable;
  const n = (s: string) => `${prefix}${s}`;

  const documents = table(
    n("documents"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      collection: text("collection").notNull(),
      slug: text("slug").notNull(),
      status: text("status").notNull().default("draft"),
      title: text("title").notNull(),
      summary: text("summary").notNull().default(""),
      body: text("body").notNull().default(""),
      /** "markdown" (default) or "html" (0.15.0, schema 8). */
      format: text("body_format").notNull().default("markdown"),
      category: text("category"),
      keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
      fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
      version: integer("version").notNull().default(1),
      publishedVersion: integer("published_version"),
      published: jsonb("published").$type<DocContent | null>(),
      updatedBy: text("updated_by"),
      updatedByKind: text("updated_by_kind"),
      /** Name of the agent that acted for `updatedBy` (a person), when one did. */
      updatedByAgent: text("updated_by_agent"),
      publishedAt: timestamp("published_at", { withTimezone: true }),
      republishedAt: timestamp("republished_at", { withTimezone: true }),
      autosave: jsonb("autosave").$type<AutosaveState["content"] | null>(),
      autosaveAt: timestamp("autosave_at", { withTimezone: true }),
      autosaveBy: text("autosave_by"),
      autosaveBaseVersion: integer("autosave_base_version"),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      deletedBy: text("deleted_by"),
      schedule: jsonb("schedule").$type<Schedule | null>(),
      dueAt: timestamp("due_at", { withTimezone: true }),
      review: jsonb("review").$type<ReviewRequest | null>(),
      /** Tree collections (0.21.0, schema 10): the parent and the place among siblings. */
      parentId: uuid("parent_id"),
      position: text("position"),
      /** Search engine details of the working copy (0.21.0). */
      seo: jsonb("seo").$type<DocSeo | null>(),
      /**
       * Multilingual documents (0.22.0, schema 11). `locale`: "" when the app has no locales or the
       * collection is not localized. `groupId`: links the translations of one document (the source's
       * id). `sourceVersion`: the source version a translation was last aligned to (null: a source).
       */
      locale: text("locale").notNull().default(""),
      groupId: uuid("group_id"),
      sourceVersion: integer("source_version"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({
      slugIdx: uniqueIndex(n("documents_collection_slug_locale_idx")).on(t.collection, t.slug, t.locale),
      groupIdx: index(n("documents_group_idx")).on(t.groupId),
      statusIdx: index(n("documents_collection_status_idx")).on(t.collection, t.status),
      dueIdx: index(n("documents_due_idx")).on(t.dueAt),
    })
  );

  const versions = table(
    n("versions"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      version: integer("version").notNull(),
      snapshot: jsonb("snapshot").$type<DocContent>().notNull(),
      authorKind: text("author_kind").notNull(),
      authorId: text("author_id"),
      authorLabel: text("author_label").notNull(),
      authorAgent: text("author_agent"),
      note: text("note"),
      changed: jsonb("changed").$type<VersionChange | null>(),
      reviewed: jsonb("reviewed").$type<ReviewMark[]>().notNull().default([]),
      label: text("label"),
      pinned: boolean("pinned").notNull().default(false),
      approvedBy: text("approved_by"),
      approvedAt: timestamp("approved_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({
      docVersionIdx: uniqueIndex(n("versions_doc_version_idx")).on(t.documentId, t.version),
    })
  );

  const apiKeys = table(n("api_keys"), {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    scopes: jsonb("scopes").$type<KeyScope[]>().notNull(),
    collections: jsonb("collections").$type<string[] | null>(),
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  });

  /** How often a document was handed to an agent or reader, per day and source. */
  const hits = table(
    n("hits"),
    {
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      day: date("day").notNull(),
      source: text("source").notNull().default("rest"),
      count: integer("count").notNull().default(0),
    },
    (t) => ({ pk: primaryKey({ columns: [t.documentId, t.day, t.source] }), dayIdx: index(n("hits_day_idx")).on(t.day) })
  );

  /** Settings and one-shot markers; `schema_version` lives here. */
  const meta = table(n("meta"), {
    key: text("key").primaryKey(),
    value: jsonb("value"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });

  /** Who did what (keys, publishing, deletes, refusals). */
  const audit = table(
    n("audit"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
      actorKind: text("actor_kind").notNull(),
      actorId: text("actor_id"),
      actorLabel: text("actor_label").notNull(),
      actorAgent: text("actor_agent"),
      action: text("action").notNull(),
      collection: text("collection"),
      slug: text("slug"),
      version: integer("version"),
      outcome: text("outcome").notNull(),
      via: text("via"),
      detail: jsonb("detail").$type<AuditEntry["detail"]>().notNull().default({}),
    },
    (t) => ({ atIdx: index(n("audit_at_idx")).on(t.at), actionIdx: index(n("audit_action_idx")).on(t.action, t.at) })
  );

  /**
   * Files in a storage (0.8.0). A document points at a file by `id`, never by
   * its path, so moving or renaming a file breaks nothing. `key` is the path
   * inside the store, readable as it is (`blog/launch-hero.jpg`): the folders
   * of the media screen are the folders of the bucket.
   */
  const assets = table(
    n("assets"),
    {
      id: text("id").primaryKey(),
      store: text("store").notNull(),
      key: text("key").notNull(),
      folder: text("folder").notNull().default(""),
      name: text("name").notNull(),
      kind: text("kind").notNull(),
      mime: text("mime").notNull().default("application/octet-stream"),
      size: bigint("size", { mode: "number" }).notNull().default(0),
      width: integer("width"),
      height: integer("height"),
      duration: real("duration"),
      alt: text("alt").notNull().default(""),
      tags: jsonb("tags").$type<string[]>().notNull().default([]),
      thumbKey: text("thumb_key"),
      focalX: real("focal_x"),
      focalY: real("focal_y"),
      rev: integer("rev").notNull().default(0),
      status: text("status").notNull().default("pending"),
      uploadId: text("upload_id"),
      createdBy: text("created_by"),
      createdByKind: text("created_by_kind"),
      createdByAgent: text("created_by_agent"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      deletedBy: text("deleted_by"),
    },
    (t) => ({
      keyIdx: uniqueIndex(n("assets_store_key_idx")).on(t.store, t.key),
      folderIdx: index(n("assets_store_folder_idx")).on(t.store, t.folder),
      statusIdx: index(n("assets_status_idx")).on(t.status, t.createdAt),
    })
  );

  /** Which documents use which files (recomputed on every save and publish). */
  const assetRefs = table(
    n("asset_refs"),
    {
      assetId: text("asset_id")
        .notNull()
        .references(() => assets.id, { onDelete: "cascade" }),
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      inDraft: boolean("in_draft").notNull().default(false),
      inPublished: boolean("in_published").notNull().default(false),
    },
    (t) => ({ pk: primaryKey({ columns: [t.assetId, t.documentId] }), docIdx: index(n("asset_refs_document_idx")).on(t.documentId) })
  );

  /** Comments on a document (0.10.0). They belong to the document, not to a version. */
  const comments = table(
    n("comments"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      threadId: uuid("thread_id"),
      anchor: text("anchor").notNull().default(""),
      quote: text("quote").notNull().default(""),
      body: text("body").notNull(),
      authorKind: text("author_kind").notNull(),
      authorId: text("author_id"),
      authorLabel: text("author_label").notNull(),
      authorAgent: text("author_agent"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
      resolvedBy: text("resolved_by"),
    },
    (t) => ({ docIdx: index(n("comments_document_idx")).on(t.documentId, t.createdAt) })
  );

  /** Documents that go public (or come down) together. The items live in the row: a release is small. */
  const releases = table(n("releases"), {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    state: text("state").notNull().default("open"),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    items: jsonb("items").$type<ReleaseItem[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdById: text("created_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    lastError: text("last_error"),
  });

  /** Named list filters: a person's own, or shared with everyone. */
  const savedFilters = table(
    n("saved_filters"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      collection: text("collection").notNull(),
      name: text("name").notNull(),
      query: jsonb("query").$type<Record<string, string>>().notNull().default({}),
      ownerId: text("owner_id").notNull(),
      ownerLabel: text("owner_label").notNull().default(""),
      shared: boolean("shared").notNull().default(false),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ colIdx: index(n("saved_filters_collection_idx")).on(t.collection) })
  );

  /** Who has a document open right now (a row lives for 45 seconds without a sign of life). */
  const presence = table(
    n("presence"),
    {
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      actorId: text("actor_id").notNull(),
      label: text("label").notNull(),
      kind: text("kind").notNull(),
      agent: text("agent"),
      cursor: jsonb("cursor").$type<Presence["cursor"]>(),
      selection: jsonb("selection").$type<Presence["selection"]>(),
      seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ pk: primaryKey({ columns: [t.documentId, t.actorId] }), seenIdx: index(n("presence_seen_idx")).on(t.seenAt) })
  );

  /** Work to run later: webhook deliveries, plugin jobs. Taken with a lock so two callers never run the same row. */
  const jobs = table(
    n("jobs"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      kind: text("kind").notNull(),
      payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
      runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
      attempts: integer("attempts").notNull().default(0),
      maxAttempts: integer("max_attempts").notNull().default(1),
      lockedUntil: timestamp("locked_until", { withTimezone: true }),
      lastError: text("last_error"),
      doneAt: timestamp("done_at", { withTimezone: true }),
      failedAt: timestamp("failed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ dueIdx: index(n("jobs_due_idx")).on(t.runAt) })
  );

  const webhooks = table(n("webhooks"), {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    collections: jsonb("collections").$type<string[]>().notNull().default([]),
    secretEnc: text("secret_enc").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    failures: integer("failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });

  const webhookDeliveries = table(
    n("webhook_deliveries"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      webhookId: uuid("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
      event: text("event").notNull(),
      payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
      status: integer("status"),
      ok: boolean("ok").notNull().default(false),
      responseMs: integer("response_ms"),
      attempt: integer("attempt").notNull().default(1),
      error: text("error"),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ hookIdx: index(n("webhook_deliveries_hook_idx")).on(t.webhookId, t.at) })
  );

  /** Small objects the CMS keeps for itself: automations and their runs, roles. One table, so a new kind needs no migration. */
  const records = table(
    n("records"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      kind: text("kind").notNull(),
      scope: text("scope").notNull().default(""),
      key: text("key"),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ keyIdx: uniqueIndex(n("records_key_idx")).on(t.kind, t.key), scopeIdx: index(n("records_scope_idx")).on(t.kind, t.scope, t.createdAt) })
  );

  /**
   * What happened, in order (0.17.0, schema 9): one row per event, numbered. Other processes and
   * apps catch up from a number (`GET /_changes?since=`); the events stream resumes from it.
   */
  const changes = table(
    n("changes"),
    {
      seq: bigserial("seq", { mode: "number" }).primaryKey(),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
      event: text("event").notNull(),
      collection: text("collection"),
      slug: text("slug"),
      version: integer("version"),
      /** The process that made the change (so it does not hear itself again). */
      origin: text("origin").notNull().default(""),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    },
    (t) => ({ atIdx: index(n("changes_at_idx")).on(t.at), docIdx: index(n("changes_doc_idx")).on(t.collection, t.slug, t.seq) })
  );

  /** Which documents point at which through relation fields (0.21.0, schema 10). Recomputed on every save. */
  const docRefs = table(
    n("doc_refs"),
    {
      fromId: uuid("from_document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      toId: uuid("to_document_id").notNull(),
      field: text("field").notNull(),
      inDraft: boolean("in_draft").notNull().default(false),
      inPublished: boolean("in_published").notNull().default(false),
    },
    (t) => ({ pk: primaryKey({ columns: [t.fromId, t.toId, t.field] }), toIdx: index(n("doc_refs_to_idx")).on(t.toId) })
  );

  /** Old heading anchors that still lead to the heading (0.21.0). */
  const anchorAliases = table(
    n("anchor_aliases"),
    {
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      old: text("old").notNull(),
      current: text("current").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ pk: primaryKey({ columns: [t.documentId, t.old] }) })
  );

  /** Old addresses and where they lead (0.21.0). */
  const redirects = table(
    n("redirects"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      fromPath: text("from_path").notNull(),
      toPath: text("to_path").notNull(),
      toDocumentId: uuid("to_document_id"),
      status: integer("status").notNull().default(301),
      source: text("source").notNull().default("manual"),
      hits: integer("hits").notNull().default(0),
      lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
      createdBy: text("created_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ fromIdx: uniqueIndex(n("redirects_from_idx")).on(t.fromPath) })
  );

  /** Visits of a redirect per calendar day (0.21.0); the redirects screen shows the last 30 days. */
  const redirectHits = table(
    n("redirect_hits"),
    {
      redirectId: uuid("redirect_id")
        .notNull()
        .references(() => redirects.id, { onDelete: "cascade" }),
      day: date("day").notNull(),
      n: integer("n").notNull().default(0),
    },
    (t) => ({ pk: primaryKey({ columns: [t.redirectId, t.day] }), dayIdx: index(n("redirect_hits_day_idx")).on(t.day) })
  );

  /**
   * Form submissions (0.22.0). The form itself is a record (`cms_records`, kind `form`). The
   * sender's address is kept as a keyed hash only; files stay in private storage (`files` holds
   * their keys).
   */
  const formSubmissions = table(
    n("form_submissions"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      formId: text("form_id").notNull(),
      formVersion: integer("form_version").notNull().default(1),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
      files: jsonb("files").$type<{ field: string; id: string; key: string; name: string; size: number; mime: string }[]>().notNull().default([]),
      status: text("status").notNull().default("new"),
      ipHash: text("ip_hash"),
      userAgent: text("user_agent"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({ listIdx: index(n("form_submissions_list_idx")).on(t.formId, t.status, t.createdAt), createdIdx: index(n("form_submissions_created_idx")).on(t.createdAt) })
  );

  return { documents, versions, apiKeys, hits, meta, audit, assets, assetRefs, comments, releases, savedFilters, presence, jobs, webhooks, webhookDeliveries, records, changes, docRefs, anchorAliases, redirects, redirectHits, formSubmissions, options: { prefix, schema: o.schema ?? null } };
}

export type CmsTables = ReturnType<typeof cmsTables>;

/** The default set (`cms_*` in the search path). */
export const defaultTables = cmsTables();
export const cmsDocuments = defaultTables.documents;
export const cmsVersions = defaultTables.versions;
export const cmsApiKeys = defaultTables.apiKeys;
export const cmsHits = defaultTables.hits;
export const cmsMeta = defaultTables.meta;
export const cmsAudit = defaultTables.audit;
export const cmsAssets = defaultTables.assets;
export const cmsAssetRefs = defaultTables.assetRefs;
export const cmsComments = defaultTables.comments;
export const cmsReleases = defaultTables.releases;
export const cmsSavedFilters = defaultTables.savedFilters;
export const cmsPresence = defaultTables.presence;
export const cmsJobs = defaultTables.jobs;
export const cmsWebhooks = defaultTables.webhooks;
export const cmsWebhookDeliveries = defaultTables.webhookDeliveries;
export const cmsRecords = defaultTables.records;
export const cmsChanges = defaultTables.changes;
export const cmsDocRefs = defaultTables.docRefs;
export const cmsAnchorAliases = defaultTables.anchorAliases;
export const cmsRedirects = defaultTables.redirects;
export const cmsRedirectHits = defaultTables.redirectHits;
export const cmsFormSubmissions = defaultTables.formSubmissions;

function names(t?: CmsTables | CmsTablesOptions) {
  const o = t && "options" in t ? t.options : ((t as CmsTablesOptions | undefined) ?? {});
  const prefix = o.prefix ?? "cms_";
  const schema = o.schema ?? null;
  const q = (s: string) => `"${s}"`;
  const tbl = (s: string) => (schema ? `${q(schema)}.${q(prefix + s)}` : q(prefix + s));
  const idx = (s: string) => q(prefix + s);
  return { prefix, schema, tbl, idx, q };
}

/** Columns added after the first release, by schema version: `ALTER … ADD COLUMN IF NOT EXISTS`. */
export function upgradeSteps(t?: CmsTables | CmsTablesOptions): { version: number; name: string; sql: string }[] {
  const { tbl, idx, schema, q } = names(t);
  return [
    {
      version: 2,
      name: "agent-cms 0.6.0: autosave, republished_at, version changes and reviews, key expiry, hit source, audit log",
      sql: `
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "republished_at" timestamptz;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "autosave" jsonb;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "autosave_at" timestamptz;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "autosave_by" text;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "autosave_base_version" integer;
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "changed" jsonb;
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "reviewed" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ${tbl("api_keys")} ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
ALTER TABLE ${tbl("hits")} ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'rest';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = '${tbl("hits").replace(/'/g, "''")}'::regclass AND c.contype = 'p' AND array_length(c.conkey, 1) = 2
  ) THEN
    EXECUTE (SELECT 'ALTER TABLE ${tbl("hits").replace(/'/g, "''")} DROP CONSTRAINT ' || quote_ident(conname) FROM pg_constraint WHERE conrelid = '${tbl("hits").replace(/'/g, "''")}'::regclass AND contype = 'p');
    ALTER TABLE ${tbl("hits")} ADD PRIMARY KEY ("document_id", "day", "source");
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ${idx("hits_day_idx")} ON ${tbl("hits")} ("day");
CREATE TABLE IF NOT EXISTS ${tbl("audit")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "at" timestamptz NOT NULL DEFAULT now(),
  "actor_kind" text NOT NULL,
  "actor_id" text,
  "actor_label" text NOT NULL,
  "action" text NOT NULL,
  "collection" text,
  "slug" text,
  "version" integer,
  "outcome" text NOT NULL,
  "via" text,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ${idx("audit_at_idx")} ON ${tbl("audit")} ("at");
CREATE INDEX IF NOT EXISTS ${idx("audit_action_idx")} ON ${tbl("audit")} ("action", "at");`.trim(),
    },
    {
      version: 3,
      name: "agent-cms 0.8.0: media files and their uses, agents acting for a person",
      sql: `
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "updated_by_agent" text;
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "author_agent" text;
ALTER TABLE ${tbl("audit")} ADD COLUMN IF NOT EXISTS "actor_agent" text;
CREATE TABLE IF NOT EXISTS ${tbl("assets")} (
  "id" text PRIMARY KEY,
  "store" text NOT NULL,
  "key" text NOT NULL,
  "folder" text NOT NULL DEFAULT '',
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "mime" text NOT NULL DEFAULT 'application/octet-stream',
  "size" bigint NOT NULL DEFAULT 0,
  "width" integer,
  "height" integer,
  "duration" real,
  "alt" text NOT NULL DEFAULT '',
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "thumb_key" text,
  "focal_x" real,
  "focal_y" real,
  "rev" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'pending',
  "upload_id" text,
  "created_by" text,
  "created_by_kind" text,
  "created_by_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${idx("assets_store_key_idx")} ON ${tbl("assets")} ("store", "key");
CREATE INDEX IF NOT EXISTS ${idx("assets_store_folder_idx")} ON ${tbl("assets")} ("store", "folder");
CREATE INDEX IF NOT EXISTS ${idx("assets_status_idx")} ON ${tbl("assets")} ("status", "created_at");
CREATE TABLE IF NOT EXISTS ${tbl("asset_refs")} (
  "asset_id" text NOT NULL REFERENCES ${tbl("assets")}("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "in_draft" boolean NOT NULL DEFAULT false,
  "in_published" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("asset_id", "document_id")
);
CREATE INDEX IF NOT EXISTS ${idx("asset_refs_document_idx")} ON ${tbl("asset_refs")} ("document_id");`.trim(),
    },
    {
      version: 4,
      name: "agent-cms 0.10.0: schedules, trash, reviews, version labels, comments, releases, saved filters, presence",
      sql: `
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "deleted_by" text;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "schedule" jsonb;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "due_at" timestamptz;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "review" jsonb;
CREATE INDEX IF NOT EXISTS ${idx("documents_due_idx")} ON ${tbl("documents")} ("due_at");
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "label" text;
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "pinned" boolean NOT NULL DEFAULT false;
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "approved_by" text;
ALTER TABLE ${tbl("versions")} ADD COLUMN IF NOT EXISTS "approved_at" timestamptz;
ALTER TABLE ${tbl("assets")} ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
ALTER TABLE ${tbl("assets")} ADD COLUMN IF NOT EXISTS "deleted_by" text;
CREATE TABLE IF NOT EXISTS ${tbl("comments")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "thread_id" uuid,
  "anchor" text NOT NULL DEFAULT '',
  "quote" text NOT NULL DEFAULT '',
  "body" text NOT NULL,
  "author_kind" text NOT NULL,
  "author_id" text,
  "author_label" text NOT NULL,
  "author_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  "resolved_by" text
);
CREATE INDEX IF NOT EXISTS ${idx("comments_document_idx")} ON ${tbl("comments")} ("document_id", "created_at");
CREATE TABLE IF NOT EXISTS ${tbl("releases")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "publish_at" timestamptz,
  "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" text NOT NULL,
  "created_by_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  "published_by" text,
  "last_error" text
);
CREATE TABLE IF NOT EXISTS ${tbl("saved_filters")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "collection" text NOT NULL,
  "name" text NOT NULL,
  "query" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "owner_id" text NOT NULL,
  "owner_label" text NOT NULL DEFAULT '',
  "shared" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${idx("saved_filters_collection_idx")} ON ${tbl("saved_filters")} ("collection");
CREATE TABLE IF NOT EXISTS ${tbl("presence")} (
  "document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL,
  "label" text NOT NULL,
  "kind" text NOT NULL,
  "agent" text,
  "cursor" jsonb,
  "selection" jsonb,
  "seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("document_id", "actor_id")
);
CREATE INDEX IF NOT EXISTS ${idx("presence_seen_idx")} ON ${tbl("presence")} ("seen_at");`.trim(),
    },
    {
      version: 5,
      name: "agent-cms 0.11.0: an image's focal point, replacing a file at the same address",
      sql: `
ALTER TABLE ${tbl("assets")} ADD COLUMN IF NOT EXISTS "focal_x" real;
ALTER TABLE ${tbl("assets")} ADD COLUMN IF NOT EXISTS "focal_y" real;
ALTER TABLE ${tbl("assets")} ADD COLUMN IF NOT EXISTS "rev" integer NOT NULL DEFAULT 0;`.trim(),
    },
    {
      version: 6,
      name: "agent-cms 0.12.0: background jobs, webhooks and their deliveries",
      sql: `
CREATE TABLE IF NOT EXISTS ${tbl("jobs")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "run_at" timestamptz NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 1,
  "locked_until" timestamptz,
  "last_error" text,
  "done_at" timestamptz,
  "failed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${idx("jobs_due_idx")} ON ${tbl("jobs")} ("run_at");
CREATE TABLE IF NOT EXISTS ${tbl("webhooks")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "url" text NOT NULL,
  "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "collections" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "secret_enc" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "failures" integer NOT NULL DEFAULT 0,
  "disabled_reason" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${tbl("webhook_deliveries")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "webhook_id" uuid NOT NULL REFERENCES ${tbl("webhooks")}("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" integer,
  "ok" boolean NOT NULL DEFAULT false,
  "response_ms" integer,
  "attempt" integer NOT NULL DEFAULT 1,
  "error" text,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${idx("webhook_deliveries_hook_idx")} ON ${tbl("webhook_deliveries")} ("webhook_id", "at");`.trim(),
    },
    {
      version: 7,
      name: "agent-cms 0.13.0: records (automations and their runs, roles)",
      sql: `
CREATE TABLE IF NOT EXISTS ${tbl("records")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "scope" text NOT NULL DEFAULT '',
  "key" text,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${idx("records_key_idx")} ON ${tbl("records")} ("kind", "key");
CREATE INDEX IF NOT EXISTS ${idx("records_scope_idx")} ON ${tbl("records")} ("kind", "scope", "created_at");`.trim(),
    },
    {
      version: 8,
      name: "agent-cms 0.15.0: body format (markdown or html)",
      sql: `ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "body_format" text NOT NULL DEFAULT 'markdown';`,
    },
    {
      version: 9,
      name: "agent-cms 0.17.0: change log (catching up across servers), indexes for lists, trash, history and jobs",
      sql: `
CREATE TABLE IF NOT EXISTS ${tbl("changes")} (
  "seq" bigserial PRIMARY KEY,
  "at" timestamptz NOT NULL DEFAULT now(),
  "event" text NOT NULL,
  "collection" text,
  "slug" text,
  "version" integer,
  "origin" text NOT NULL DEFAULT '',
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ${idx("changes_at_idx")} ON ${tbl("changes")} ("at");
CREATE INDEX IF NOT EXISTS ${idx("changes_doc_idx")} ON ${tbl("changes")} ("collection", "slug", "seq");
CREATE INDEX IF NOT EXISTS ${idx("documents_list_idx")} ON ${tbl("documents")} ("collection", "updated_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS ${idx("documents_public_idx")} ON ${tbl("documents")} ("collection", "published_at" DESC) WHERE "deleted_at" IS NULL AND "published_version" IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${idx("documents_trash_idx")} ON ${tbl("documents")} ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${idx("documents_updated_idx")} ON ${tbl("documents")} ("updated_at");
CREATE INDEX IF NOT EXISTS ${idx("versions_created_idx")} ON ${tbl("versions")} ("created_at");
CREATE INDEX IF NOT EXISTS ${idx("audit_doc_idx")} ON ${tbl("audit")} ("collection", "slug", "at");
CREATE INDEX IF NOT EXISTS ${idx("jobs_done_idx")} ON ${tbl("jobs")} ("done_at") WHERE "done_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${idx("assets_trash_idx")} ON ${tbl("assets")} ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${idx("comments_thread_idx")} ON ${tbl("comments")} ("thread_id") WHERE "thread_id" IS NOT NULL;`.trim(),
    },
    {
      version: 10,
      name: "agent-cms 0.21.0: relations, document trees, SEO, heading anchor aliases, redirects",
      sql: `
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "parent_id" uuid;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "position" text;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "seo" jsonb;
CREATE INDEX IF NOT EXISTS ${idx("documents_tree_idx")} ON ${tbl("documents")} ("collection", "parent_id", "position");
CREATE TABLE IF NOT EXISTS ${tbl("doc_refs")} (
  "from_document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "to_document_id" uuid NOT NULL,
  "field" text NOT NULL,
  "in_draft" boolean NOT NULL DEFAULT false,
  "in_published" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("from_document_id", "to_document_id", "field")
);
CREATE INDEX IF NOT EXISTS ${idx("doc_refs_to_idx")} ON ${tbl("doc_refs")} ("to_document_id");
CREATE TABLE IF NOT EXISTS ${tbl("anchor_aliases")} (
  "document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "old" text NOT NULL,
  "current" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("document_id", "old")
);
CREATE TABLE IF NOT EXISTS ${tbl("redirects")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_path" text NOT NULL,
  "to_path" text NOT NULL,
  "to_document_id" uuid,
  "status" integer NOT NULL DEFAULT 301,
  "source" text NOT NULL DEFAULT 'manual',
  "hits" integer NOT NULL DEFAULT 0,
  "last_hit_at" timestamptz,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${idx("redirects_from_idx")} ON ${tbl("redirects")} ("from_path");
CREATE TABLE IF NOT EXISTS ${tbl("redirect_hits")} (
  "redirect_id" uuid NOT NULL REFERENCES ${tbl("redirects")}("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "n" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("redirect_id", "day")
);
CREATE INDEX IF NOT EXISTS ${idx("redirect_hits_day_idx")} ON ${tbl("redirect_hits")} ("day");`.trim(),
    },
    {
      version: 11,
      name: "agent-cms 0.22.0: multilingual documents (locale, group_id, source_version; one slug per locale), form submissions",
      // The unique index swap: the new one is built before the old one goes, so a slug is never
      // unguarded. On a big table build it by hand first with CREATE UNIQUE INDEX CONCURRENTLY
      // (UPGRADE-0.22.md); then this step finds it and only drops the old one.
      sql: `
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT '';
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "group_id" uuid;
ALTER TABLE ${tbl("documents")} ADD COLUMN IF NOT EXISTS "source_version" integer;
CREATE UNIQUE INDEX IF NOT EXISTS ${idx("documents_collection_slug_locale_idx")} ON ${tbl("documents")} ("collection", "slug", "locale");
DROP INDEX IF EXISTS ${schema ? `${q(schema)}.` : ""}${idx("documents_collection_slug_idx")};
CREATE INDEX IF NOT EXISTS ${idx("documents_group_idx")} ON ${tbl("documents")} ("group_id");
CREATE TABLE IF NOT EXISTS ${tbl("form_submissions")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "form_id" text NOT NULL,
  "form_version" integer NOT NULL DEFAULT 1,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "files" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'new',
  "ip_hash" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${idx("form_submissions_list_idx")} ON ${tbl("form_submissions")} ("form_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS ${idx("form_submissions_created_idx")} ON ${tbl("form_submissions")} ("created_at");`.trim(),
    },
  ];
}

/**
 * Turning locales on (0.22.0): documents of localized collections written before have locale ""
 * (the CMS reads them as the default language). This gives them the default language for good, in
 * batches of `batch` rows so a big table is never locked for long. Run it until it changes 0 rows
 * (`npx @mainsoft/agent-cms migrate locales` does).
 */
export function fillLocaleSql(t: CmsTables | CmsTablesOptions | undefined, o: { collections: readonly string[]; defaultLocale: string; batch?: number }): string {
  const { tbl } = names(t);
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  if (!o.collections.length) return "SELECT 0";
  const batch = Math.max(1, Math.floor(o.batch ?? 1000));
  return `UPDATE ${tbl("documents")} SET "locale" = ${lit(o.defaultLocale)} WHERE "id" IN (SELECT "id" FROM ${tbl("documents")} WHERE "locale" = '' AND "collection" IN (${o.collections.map(lit).join(", ")}) LIMIT ${batch}) RETURNING "id"`;
}

/** Rows that would break the new unique index (collection, slug, locale): run before building it by hand. */
export function localeDuplicatesSql(t?: CmsTables | CmsTablesOptions): string {
  const { tbl } = names(t);
  return `SELECT "collection", "slug", "locale", count(*) AS "n" FROM ${tbl("documents")} GROUP BY "collection", "slug", "locale" HAVING count(*) > 1`;
}

/** Records the schema version (run after the DDL or upgrade steps). */
export function schemaVersionSql(t?: CmsTables | CmsTablesOptions, version = SCHEMA_VERSION): string {
  const { tbl } = names(t);
  return `INSERT INTO ${tbl("meta")} ("key", "value") VALUES ('schema_version', '${version}'::jsonb) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now();`;
}

/**
 * Idempotent DDL for every table: creates what is missing, adds columns from
 * newer versions and records the schema version. Safe to run on every deploy.
 */
export function cmsDdl(t?: CmsTables | CmsTablesOptions): string {
  const { tbl, idx, schema, q } = names(t);
  const create = `
${schema ? `CREATE SCHEMA IF NOT EXISTS ${q(schema)};\n` : ""}CREATE TABLE IF NOT EXISTS ${tbl("documents")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "collection" text NOT NULL,
  "slug" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "title" text NOT NULL,
  "summary" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "category" text,
  "keywords" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "published_version" integer,
  "published" jsonb,
  "updated_by" text,
  "updated_by_kind" text,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${idx("documents_collection_status_idx")} ON ${tbl("documents")} ("collection", "status");

CREATE TABLE IF NOT EXISTS ${tbl("versions")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "author_kind" text NOT NULL,
  "author_id" text,
  "author_label" text NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${idx("versions_doc_version_idx")} ON ${tbl("versions")} ("document_id", "version");

CREATE TABLE IF NOT EXISTS ${tbl("api_keys")} (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "hash" text NOT NULL UNIQUE,
  "scopes" jsonb NOT NULL,
  "collections" jsonb,
  "created_by" text,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${tbl("hits")} (
  "document_id" uuid NOT NULL REFERENCES ${tbl("documents")}("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "source" text NOT NULL DEFAULT 'rest',
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("document_id", "day", "source")
);

CREATE TABLE IF NOT EXISTS ${tbl("meta")} (
  "key" text PRIMARY KEY,
  "value" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);`.trim();
  return [create, ...upgradeSteps(t).map((s) => s.sql), schemaVersionSql(t)].join("\n\n");
}

/**
 * Split SQL text into statements (respects quotes, `$$` bodies and comments),
 * for drivers that run one statement per call (pglite, prepared queries).
 */
export function splitSql(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let dollar: string | null = null;
  let quote = false;
  while (i < text.length) {
    const c = text[i];
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length;
        dollar = null;
      } else cur += text[i++];
      continue;
    }
    if (quote) {
      cur += c;
      i++;
      if (c === "'") quote = false;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === "'") quote = true;
    if (c === "$") {
      const m = /^\$[a-zA-Z_]*\$/.exec(text.slice(i));
      if (m) {
        dollar = m[0];
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Columns from 0.4.0 and earlier that nothing reads any more (`doctor` offers to drop them). */
export const LEGACY_COLUMNS = [
  { table: "documents", column: "covers" },
  { table: "documents", column: "needs_review" },
  { table: "documents", column: "review_reason" },
  { table: "documents", column: "pending_pr" },
  { table: "versions", column: "pr" },
] as const;

