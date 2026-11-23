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
  forbidden_release: "forbidden",
  release_changed: "conflict",
  check_failed: "invalid",
  check_hidden: "invalid",
  release_failed: "precondition",
  document_replaced: "conflict",
  forbidden_keys: "forbidden",
  forbidden_audit: "forbidden",
  forbidden_media: "forbidden",
  key_too_wide: "forbidden",
  cross_site: "forbidden",
  forbidden_ip: "forbidden",
  forbidden_admin: "forbidden",
  forbidden_html: "forbidden",
  forbidden_field: "forbidden",
  forbidden_html_scripts: "forbidden",
  raw_link_invalid: "unauthorized",
  raw_link_expired: "unauthorized",
  suggestion_not_found: "not_found",
  suggestion_stale: "conflict",
  format_not_allowed: "invalid",
  html_inert: "invalid",
  edit_not_found: "invalid",
  edit_not_unique: "invalid",
  edit_invalid: "invalid",
  file_invalid: "invalid",
  pattern_invalid: "invalid",
  publish_check_failed: "precondition",
  zip_too_large: "invalid",
  rate_limited: "forbidden",
  // sign-in (0.16.0)
  login_failed: "unauthorized",
  login_locked: "forbidden",
  mfa_invalid: "unauthorized",
  mfa_ticket_invalid: "unauthorized",
  setup_invalid: "unauthorized",
  setup_done: "conflict",
  invite_invalid: "not_found",
  reset_invalid: "not_found",
  password_weak: "invalid",
  password_common: "invalid",
  password_wrong: "unauthorized",
  reauth_required: "unauthorized",
  passkey_invalid: "unauthorized",
  passkey_unknown: "unauthorized",
  oidc_failed: "unauthorized",
  oidc_domain: "forbidden",
  oidc_not_invited: "forbidden",
  user_not_found: "not_found",
  email_taken: "conflict",
  email_invalid: "invalid",
  user_last_admin: "conflict",
  user_disabled: "unauthorized",
  auth_off: "not_found",
  mfa_setup_required: "forbidden",
  totp_not_started: "conflict",
  invalid_ip_range: "invalid",
  invalid_rate_limit: "invalid",
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
  asset_replace_type: "invalid",
  unknown_image_size: "not_found",
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
  name_taken: "conflict",
  asset_in_use: "conflict",
  folder_not_empty: "conflict",
  slug_in_trash: "conflict",
  in_other_release: "conflict",
  comment_not_found: "not_found",
  release_not_found: "not_found",
  filter_not_found: "not_found",
  webhook_not_found: "not_found",
  role_not_found: "not_found",
  automation_not_found: "not_found",
  delivery_not_found: "not_found",
  trash_not_found: "not_found",
  review_required: "forbidden",
  review_self: "forbidden",
  review_people_only: "forbidden",
  forbidden_trash: "forbidden",
  forbidden_filter: "forbidden",
  forbidden_webhooks: "forbidden",
  forbidden_roles: "forbidden",
  forbidden_automations: "forbidden",
  role_last_admin: "conflict",
  automation_invalid: "invalid",
  comments_off: "forbidden",
  review_not_requested: "precondition",
  not_scheduled: "precondition",
  release_closed: "precondition",
  release_empty: "precondition",
  secrets_key_missing: "precondition",
  release_blocked: "precondition",
  transactions_required: "precondition",
  schedule_invalid: "invalid",
  comment_invalid: "invalid",
  name_invalid: "invalid",
  webhook_url_blocked: "invalid",
  webhook_event_unknown: "invalid",
  hook_rejected: "invalid",
  too_many_files: "invalid",
  precondition_required: "precondition",
  // anything else
  // 0.21.0 content model
  slug_needs_publish: "invalid",
  relation_missing: "invalid",
  relation_wrong_collection: "invalid",
  relation_unpublished: "invalid",
  doc_referenced: "conflict",
  tree_off: "invalid",
  tree_cycle: "invalid",
  tree_too_deep: "invalid",
  doc_has_children: "conflict",
  single_only: "invalid",
  template_not_found: "not_found",
  forbidden_template: "forbidden",
  template_invalid: "invalid",
  snippet_missing: "invalid",
  snippet_cycle: "invalid",
  snippet_inline_multi: "invalid",
  video_host_blocked: "invalid",
  anchor_pin_taken: "invalid",
  redirect_not_found: "not_found",
  redirects_off: "not_found",
  redirect_invalid: "invalid",
  redirect_loop: "invalid",
  redirect_document: "invalid",
  redirect_taken: "conflict",
  forbidden_redirects: "forbidden",
  seo_title_long: "invalid",
  seo_description_long: "invalid",
  seo_description_missing: "invalid",
  seo_image_small: "invalid",
  // 0.22.0 multilingual documents
  locale_unknown: "invalid",
  locale_not_localized: "invalid",
  translation_exists: "conflict",
  translation_not_found: "not_found",
  locale_field_shared: "invalid",
  locale_source_missing: "invalid",
  locale_is_source: "invalid",
  translation_source_trashed: "conflict",
  locale_etag_mismatch: "conflict",
  trash_changed: "conflict",
  // 0.22.0 forms
  forms_off: "not_found",
  form_not_found: "not_found",
  submission_not_found: "not_found",
  forbidden_forms: "forbidden",
  form_verify_failed: "forbidden",
  form_invalid: "invalid",
  form_slug_taken: "conflict",
  form_conflict: "conflict",
  form_rejected: "invalid",
  form_upload_invalid: "invalid",
  form_uploads_off: "invalid",
  form_uploads_unavailable: "invalid",
  form_file_too_large: "invalid",
  form_file_type: "invalid",
  form_required: "invalid",
  form_length: "invalid",
  form_email: "invalid",
  form_number: "invalid",
  form_option: "invalid",
  form_date: "invalid",
  form_pattern: "invalid",
  form_file: "invalid",
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
