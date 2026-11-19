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

import { bigint, boolean, date, index, integer, jsonb, pgSchema, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AuditEntry, AutosaveState, DocContent, KeyScope, ReviewMark, VersionChange } from "./types";

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
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({
      slugIdx: uniqueIndex(n("documents_collection_slug_idx")).on(t.collection, t.slug),
      statusIdx: index(n("documents_collection_status_idx")).on(t.collection, t.status),
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
      status: text("status").notNull().default("pending"),
      uploadId: text("upload_id"),
      createdBy: text("created_by"),
      createdByKind: text("created_by_kind"),
      createdByAgent: text("created_by_agent"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

  return { documents, versions, apiKeys, hits, meta, audit, assets, assetRefs, options: { prefix, schema: o.schema ?? null } };
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
  const { tbl, idx } = names(t);
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
  ];
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
CREATE UNIQUE INDEX IF NOT EXISTS ${idx("documents_collection_slug_idx")} ON ${tbl("documents")} ("collection", "slug");
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

