/**
 * Drizzle table definitions. The app re-exports these from its own schema so
 * drizzle-kit and the app's typed client see them; `cmsDdl()` prints the
 * idempotent SQL that creates them (the app pastes it into its migrations).
 *
 * One set of tables serves every collection (a `collection` column), so a new
 * collection never needs a migration.
 */

import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DocContent, KeyScope, ReviewReason } from "./types";

export const cmsDocuments = pgTable(
  "cms_documents",
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
    covers: jsonb("covers").$type<string[]>().notNull().default([]),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    publishedVersion: integer("published_version"),
    published: jsonb("published").$type<DocContent | null>(),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: jsonb("review_reason").$type<ReviewReason | null>(),
    pendingPr: integer("pending_pr"),
    updatedBy: text("updated_by"),
    updatedByKind: text("updated_by_kind"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex("cms_documents_collection_slug_idx").on(t.collection, t.slug),
    statusIdx: index("cms_documents_collection_status_idx").on(t.collection, t.status),
  })
);

export const cmsVersions = pgTable(
  "cms_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => cmsDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<DocContent>().notNull(),
    authorKind: text("author_kind").notNull(),
    authorId: text("author_id"),
    authorLabel: text("author_label").notNull(),
    note: text("note"),
    pr: integer("pr"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docVersionIdx: uniqueIndex("cms_versions_doc_version_idx").on(t.documentId, t.version),
  })
);

export const cmsApiKeys = pgTable("cms_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull().unique(),
  scopes: jsonb("scopes").$type<KeyScope[]>().notNull(),
  collections: jsonb("collections").$type<string[] | null>(),
  createdBy: text("created_by"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cmsGaps = pgTable(
  "cms_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collection: text("collection").notNull(),
    kind: text("kind").notNull(),
    query: text("query").notNull(),
    normalized: text("normalized").notNull(),
    note: text("note"),
    documentSlug: text("document_slug"),
    count: integer("count").notNull().default(1),
    state: text("state").notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    groupIdx: uniqueIndex("cms_gaps_group_idx").on(t.collection, t.kind, t.normalized),
  })
);

/** How often a document was handed to an agent, per day ("답변에 쓰임"). */
export const cmsHits = pgTable(
  "cms_hits",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => cmsDocuments.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.documentId, t.day] }) })
);

/** One-shot markers (e.g. "imported the legacy table"). */
export const cmsMeta = pgTable("cms_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cmsTables = {
  documents: cmsDocuments,
  versions: cmsVersions,
  apiKeys: cmsApiKeys,
  gaps: cmsGaps,
  hits: cmsHits,
  meta: cmsMeta,
};
export type CmsTables = typeof cmsTables;

/** Idempotent DDL for every table above. Safe to run on every deploy. */
export function cmsDdl(): string {
  return `
CREATE TABLE IF NOT EXISTS "cms_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "collection" text NOT NULL,
  "slug" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "title" text NOT NULL,
  "summary" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "category" text,
  "keywords" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "covers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "published_version" integer,
  "published" jsonb,
  "needs_review" boolean NOT NULL DEFAULT false,
  "review_reason" jsonb,
  "pending_pr" integer,
  "updated_by" text,
  "updated_by_kind" text,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cms_documents_collection_slug_idx" ON "cms_documents" ("collection", "slug");
CREATE INDEX IF NOT EXISTS "cms_documents_collection_status_idx" ON "cms_documents" ("collection", "status");

CREATE TABLE IF NOT EXISTS "cms_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES "cms_documents"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "author_kind" text NOT NULL,
  "author_id" text,
  "author_label" text NOT NULL,
  "note" text,
  "pr" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cms_versions_doc_version_idx" ON "cms_versions" ("document_id", "version");

CREATE TABLE IF NOT EXISTS "cms_api_keys" (
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

CREATE TABLE IF NOT EXISTS "cms_gaps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "collection" text NOT NULL,
  "kind" text NOT NULL,
  "query" text NOT NULL,
  "normalized" text NOT NULL,
  "note" text,
  "document_slug" text,
  "count" integer NOT NULL DEFAULT 1,
  "state" text NOT NULL DEFAULT 'open',
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cms_gaps_group_idx" ON "cms_gaps" ("collection", "kind", "normalized");

CREATE TABLE IF NOT EXISTS "cms_hits" (
  "document_id" uuid NOT NULL REFERENCES "cms_documents"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("document_id", "day")
);

CREATE TABLE IF NOT EXISTS "cms_meta" (
  "key" text PRIMARY KEY,
  "value" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
`.trim();
}
