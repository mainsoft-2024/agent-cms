/**
 * agent-cms — a small CMS that people (an admin screen) and agents (REST, MCP,
 * AI SDK tools) edit together. Lives inside the app: no separate server.
 *
 * EXTRACTION RULE: nothing under `src/` may import from a host app (`@/`) or
 * any app module. It is written to be lifted into `@mainsoft-2024/agent-cms`
 * unchanged (`src/parts.test.ts` enforces it).
 */

import type { ZodTypeAny } from "zod";

/**
 * draft     — the latest version is not public (an older one may be).
 * pending   — the latest version waits for a PR to deploy (`deploy-sync`).
 * published — the latest version is the public one.
 * archived  — hidden from the public; history kept.
 */
export const DOC_STATUSES = ["draft", "pending", "published", "archived"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const KEY_SCOPES = ["read", "write", "publish", "admin"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Who is acting. Either an app session (user) or an API key. */
export type Actor =
  | { kind: "anonymous" }
  | { kind: "user"; id: string; label: string; email?: string | null; isAdmin: boolean }
  | { kind: "key"; id: string; label: string; scopes: KeyScope[]; collections: string[] | null }
  | { kind: "system"; label: string };

/** The editable content of a document; one version = one snapshot of this. */
export interface DocContent {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  keywords: string[];
  covers: string[];
  fields: Record<string, unknown>;
}

export interface ReviewReason {
  pr?: number | null;
  sha?: string | null;
  files: string[];
  at: string;
}

export interface CmsDoc extends DocContent {
  id: string;
  collection: string;
  status: DocStatus;
  /** Latest version number (the working copy). */
  version: number;
  /** Version that is public, or null when never published. */
  publishedVersion: number | null;
  /** The public snapshot (null when never published). */
  published: DocContent | null;
  needsReview: boolean;
  reviewReason: ReviewReason | null;
  pendingPr: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Label of whoever wrote the latest version. */
  updatedBy: string | null;
  updatedByKind: "user" | "key" | "system" | null;
}

export interface CmsVersion {
  id: string;
  documentId: string;
  version: number;
  snapshot: DocContent;
  authorKind: "user" | "key" | "system";
  authorId: string | null;
  authorLabel: string;
  note: string | null;
  pr: number | null;
  published: boolean;
  createdAt: string;
}

export interface CmsGap {
  id: string;
  collection: string;
  kind: "no_result" | "reported";
  query: string;
  note: string | null;
  documentSlug: string | null;
  count: number;
  state: "open" | "done" | "ignored";
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CmsKey {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  collections: string[] | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AccessArgs {
  actor: Actor;
  collection: string;
  doc?: CmsDoc | null;
}

export interface CollectionConfig<F extends ZodTypeAny | undefined = ZodTypeAny | undefined> {
  slug: string;
  label: string;
  /** Allowed category values (null = free text / none). */
  categories?: readonly string[];
  /** zod object for `fields`; parsed (with defaults) on every save. */
  fields?: F;
  versions?: {
    /** Versions kept per document (0 = all). Default 100. */
    max?: number;
    /**
     * true (default): saving a published document makes a draft; the public
     * copy stays until it is published. false: a save to a published
     * document republishes it (a changelog post edited in place).
     */
    drafts?: boolean;
  };
  /** Slug rule override (default: lowercase ascii words joined by hyphens). */
  slugPattern?: RegExp;
  /** Characters the house style bans from title, summary and body. */
  forbiddenChars?: readonly string[];
  /** `covers` globs + the CI coverage guard apply to this collection. */
  coverage?: boolean;
  search?: {
    /** Index published docs of this collection. Default true. */
    enabled?: boolean;
    /** Record searches that found nothing as gaps. */
    gapLogging?: boolean;
  };
  /** `[[link:key|label]]` keys: return the URL, or null when the key is unknown. */
  links?: { resolve: (key: string) => string | null };
  /** Public URL of a document (for agent results and link chips). */
  url?: (doc: { slug: string }) => string;
  access?: {
    /** Read published documents. Default: everyone. */
    read?: (a: AccessArgs) => boolean;
    /** Read drafts, versions, gaps; create and edit. */
    write?: (a: AccessArgs) => boolean;
    /** Publish, archive, restore-and-publish. */
    publish?: (a: AccessArgs) => boolean;
  };
  hooks?: {
    afterChange?: Array<(doc: CmsDoc) => void | Promise<void>>;
  };
}

export class CmsError extends Error {
  constructor(
    public code:
      | "not_found"
      | "forbidden"
      | "unauthorized"
      | "invalid"
      | "conflict"
      | "unknown_collection",
    message: string,
    public status: number = code === "not_found" || code === "unknown_collection"
      ? 404
      : code === "forbidden"
        ? 403
        : code === "unauthorized"
          ? 401
          : code === "conflict"
            ? 409
            : 422
  ) {
    super(message);
  }
}
