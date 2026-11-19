/**
 * The error contract. Every failure has a fine `code` (stable, for programs
 * and agents), a coarse `kind` (what kind of failure, decides the HTTP
 * status) and `params` (the values a message is built from). The message is
 * only for people and comes from a catalog (`messages/en.ts` by default,
 * `messages/ko.ts` or your own via `createCms({ messages })`).
 */

import { en } from "./messages/en";

export const ERROR_KINDS = ["not_found", "unknown_collection", "forbidden", "unauthorized", "invalid", "conflict", "precondition", "internal"] as const;
export type CmsErrorKind = (typeof ERROR_KINDS)[number];

/** Every code with its kind. Add new codes here and in both catalogs. */
export const ERROR_CODES = {
  // not found
  not_found: "not_found",
  version_not_found: "not_found",
  key_not_found: "not_found",
  route_not_found: "not_found",
  asset_not_found: "not_found",
  unknown_store: "not_found",
  unknown_collection: "unknown_collection",
  // access
  unauthorized: "unauthorized",
  invalid_key: "unauthorized",
  key_expired: "unauthorized",
  preview_invalid: "unauthorized",
  preview_expired: "unauthorized",
  forbidden: "forbidden",
  forbidden_read: "forbidden",
  forbidden_write: "forbidden",
  forbidden_publish: "forbidden",
  forbidden_keys: "forbidden",
  forbidden_audit: "forbidden",
  forbidden_media: "forbidden",
  key_too_wide: "forbidden",
  cross_site: "forbidden",
  // validation
  invalid: "invalid",
  invalid_slug: "invalid",
  invalid_title: "invalid",
  summary_too_long: "invalid",
  body_too_long: "invalid",
  invalid_keywords: "invalid",
  forbidden_char: "invalid",
  invalid_category: "invalid",
  invalid_field: "invalid",
  unknown_link: "invalid",
  slug_locked: "invalid",
  not_published: "invalid",
  invalid_key_name: "invalid",
  scopes_required: "invalid",
  invalid_expiry: "invalid",
  invalid_anchor: "invalid",
  invalid_version: "invalid",
  invalid_request: "invalid",
  invalid_json: "invalid",
  body_too_large: "invalid",
  preview_disabled: "invalid",
  // media
  media_disabled: "invalid",
  asset_type_not_allowed: "invalid",
  asset_type_mismatch: "invalid",
  asset_too_large: "invalid",
  invalid_folder: "invalid",
  upload_incomplete: "invalid",
  import_blocked: "invalid",
  import_failed: "invalid",
  asset_rejected: "invalid",
  asset_missing: "invalid",
  asset_wrong_kind: "invalid",
  asset_alt_missing: "invalid",
  asset_alt_empty: "invalid",
  asset_private_in_public: "invalid",
  no_public_url: "invalid",
  schema_outdated: "invalid",
  // concurrency
  conflict_version: "conflict",
  slug_taken: "conflict",
  asset_in_use: "conflict",
  folder_not_empty: "conflict",
  too_many_files: "invalid",
  precondition_required: "precondition",
  // anything else
  internal: "internal",
} as const satisfies Record<string, CmsErrorKind>;

export type CmsErrorCode = keyof typeof ERROR_CODES;
export type ErrorParams = Record<string, string | number | boolean | null | string[] | undefined>;

/** A message is a template (`{name}` placeholders) or a function of the params. */
export type MessageTemplate = string | ((p: ErrorParams) => string);
export type Messages = Record<CmsErrorCode, MessageTemplate>;

const STATUS: Record<CmsErrorKind, number> = {
  not_found: 404,
  unknown_collection: 404,
  unauthorized: 401,
  forbidden: 403,
  invalid: 422,
  conflict: 409,
  precondition: 428,
  internal: 500,
};

export function formatMessage(messages: Partial<Messages> | undefined, code: CmsErrorCode, params: ErrorParams = {}): string {
  const t = messages?.[code] ?? en[code] ?? code;
  if (typeof t === "function") return t(params);
  return t.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
  });
}

/** One problem with a document, from `diagnose()`. */
export interface Diagnostic {
  /** Where: `slug`, `title`, `body`, `fields.tags.0`, … */
  path: string;
  code: CmsErrorCode;
  message: string;
  params: ErrorParams;
  severity: "error" | "warning";
}

export interface CmsErrorOptions {
  message?: string;
  messages?: Partial<Messages>;
  /** Override the HTTP status the kind implies (e.g. 413, 400). */
  status?: number;
  /** Every problem when the error came from validation. */
  diagnostics?: Diagnostic[];
  /** On `conflict_version`: the current working copy, for a 3-way merge. */
  current?: unknown;
}

export class CmsError extends Error {
  readonly kind: CmsErrorKind;
  readonly status: number;
  readonly params: ErrorParams;
  readonly diagnostics?: Diagnostic[];
  current?: unknown;
  /** Marks CmsErrors so `isCmsError` works across bundle copies of this class. */
  readonly isCmsError = true;

  constructor(
    public readonly code: CmsErrorCode,
    params: ErrorParams = {},
    o: CmsErrorOptions = {}
  ) {
    super(o.message ?? formatMessage(o.messages, code, params));
    this.name = "CmsError";
    this.kind = ERROR_CODES[code] ?? "internal";
    this.status = o.status ?? STATUS[this.kind];
    this.params = params;
    this.diagnostics = o.diagnostics;
    this.current = o.current;
  }

  /** The wire shape (REST body, MCP error text, `callTool` result). */
  toJSON() {
    return {
      error: this.code,
      kind: this.kind,
      message: this.message,
      params: this.params,
      ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}),
      ...(this.current !== undefined ? { current: this.current } : {}),
    };
  }
}

/**
 * True for any CmsError, even one from another copy of this package (bundlers
 * can duplicate the class, which breaks `instanceof`). Use this, not instanceof.
 */
export function isCmsError(e: unknown): e is CmsError {
  return !!e && typeof e === "object" && (e as { isCmsError?: unknown }).isCmsError === true;
}
