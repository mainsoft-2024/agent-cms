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
- `forbidden`: `forbidden_read`, `forbidden_write`, `forbidden_publish`, `forbidden_keys`, `key_too_wide`, …
- `invalid`: `invalid_slug`, `invalid_title`, `invalid_field`, `slug_locked`, `schema_outdated`, …
- `conflict`: `conflict_version`, `slug_taken`
- `precondition`: `precondition_required` (428, when `requireIfMatch` is on)

The full list is `ERROR_CODES` in `@mainsoft/agent-cms/errors`.

## Messages

Messages are English by default. Pass `messages: ko` from `@mainsoft/agent-cms/messages/ko` to `createCms` for Korean.
