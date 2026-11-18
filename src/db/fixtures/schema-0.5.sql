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
