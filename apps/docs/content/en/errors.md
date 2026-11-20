---
title: Errors
summary: One error shape on every transport, with fine codes and coarse kinds.
category: Reference
order: 2
---
REST, MCP, the tools (`callTool`) and the CLI return the same shape:

```json
{ "error": "conflict_version", "kind": "conflict", "message": "…", "params": { "expected": 3, "current": 4 } }
```

`error` is the fine code, `kind` the coarse class. Validation errors add `diagnostics` (every problem at once); conflicts add `current` (the other copy).

## Kinds

- `not_found`: `not_found`, `version_not_found`, `key_not_found`, `route_not_found`
- `unauthorized`: `unauthorized`, `invalid_key`, `key_expired`, `preview_invalid`, `preview_expired`
- `forbidden`: `forbidden_read`, `forbidden_write`, `forbidden_publish`, `forbidden_keys`, `key_too_wide`, `cross_site`, …
- `invalid`: `invalid_slug`, `invalid_title`, `invalid_field`, `slug_locked`, `schema_outdated`, …
- `conflict`: `conflict_version`, `slug_taken`
- `precondition`: `precondition_required` (428, when `requireIfMatch` is on)

With a [media library](/docs/media-library), files add their own:

- `not_found`: `asset_not_found`, `unknown_store`, `unknown_image_size`
- `forbidden`: `forbidden_media`
- `invalid`: `asset_type_not_allowed`, `asset_type_mismatch` (the content is not what the extension says), `asset_too_large` (413), `upload_incomplete`, `asset_rejected` (your `media.scan` said no), `asset_replace_type` (a file is replaced by one of the same type only), `import_blocked`, `import_failed`, `invalid_folder`, `media_disabled`
- `conflict`: `asset_in_use` (with the documents in `current`), `folder_not_empty`

The full list is `ERROR_CODES` in `@mainsoft/agent-cms/errors`.

## Messages

Messages are English by default. Pass `messages: ko` from `@mainsoft/agent-cms/messages/ko` to `createCms` for Korean.
