---
title: 오류
summary: 모든 통로에서 같은 오류 모양. 세부 코드와 큰 분류.
category: Reference
order: 2
sourceVersion: 1
---
REST, MCP, 도구(`callTool`), CLI 모두 같은 모양으로 돌려줘요.

```json
{ "error": "conflict_version", "kind": "conflict", "message": "…", "params": { "expected": 3, "current": 4 } }
```

`error`는 세부 코드, `kind`는 큰 분류예요. 검증 오류에는 `diagnostics`(모든 문제를 한 번에)가, 충돌에는 `current`(상대 내용)가 더 붙어요.

## 분류

- `not_found`: `not_found`, `version_not_found`, `key_not_found`, `route_not_found`
- `unauthorized`: `unauthorized`, `invalid_key`, `key_expired`, `preview_invalid`, `preview_expired`
- `forbidden`: `forbidden_read`, `forbidden_write`, `forbidden_publish`, `forbidden_keys`, `key_too_wide`, `cross_site` 등
- `invalid`: `invalid_slug`, `invalid_title`, `invalid_field`, `slug_locked`, `schema_outdated` 등
- `conflict`: `conflict_version`, `slug_taken`
- `precondition`: `precondition_required` (`requireIfMatch`를 켰을 때 428)

전체 목록은 `@mainsoft/agent-cms/errors`의 `ERROR_CODES`에 있어요.

## 문구

오류 문구는 영어가 기본이에요. `createCms`에 `@mainsoft/agent-cms/messages/ko`의 `messages: ko`를 주면 한국어가 돼요.
