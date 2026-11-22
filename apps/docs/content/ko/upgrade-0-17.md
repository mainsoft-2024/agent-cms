---
title: 0.17로 올리기
summary: 스키마 9에서 변경 로그와 색인이 더해집니다. 이벤트가 모든 서버에 닿고, 목록은 DB에서 페이지를 나눕니다.
category: Upgrade
order: 10
sourceVersion: 1
---
**스키마 9**: 표 하나(`cms_changes`, 변경 로그)와 색인 11개가 더해집니다.

```sh
npx @mainsoft/agent-cms migrate check   # SQL을 보여 줌
npx @mainsoft/agent-cms migrate apply   # 또는 직접 실행
```

다시 실행해도 안전합니다(`IF NOT EXISTS`). 큰 표에서 쓰기가 멈추면 안 되면 색인을 먼저 `CONCURRENTLY`로 만드세요. 빠진 색인은 `npx @mainsoft/agent-cms doctor`가 알려 줍니다.

## 아무것도 안 해도 바뀌는 것

- **목록은 DB에서 페이지를 나눕니다.** `cms.page()`, `GET /collections/<c>`, `list_documents`가 SQL에서 거르고 정렬하고 자르며, 마지막 행으로 다음 페이지를 찾습니다(커서 `k.…`). 예전 숫자 커서도 됩니다.
- **이벤트가 모든 서버에 닿습니다.** 이벤트 스트림의 메시지 id는 변경 로그 번호이고, 다시 연결하면 놓친 것만 받습니다. 로그는 7일 보관(`changes.keepDays`), cron 호출이 정리합니다.
- **코어가 `node:crypto`를 불러오지 않습니다.** Edge 런타임에서 돕니다. 웹훅 시크릿은 여전히 Node의 crypto가 필요합니다.
- **`/\host` 같은 링크**는 더 이상 링크가 아닙니다(브라우저가 다른 사이트로 읽음).
- **`afterRead`가 목록 행에도 돕니다**(`ctx.list`가 true).

## 원할 때 켜는 것

`cache`, `changes.signal`, `@mainsoft/agent-cms/db`, `@mainsoft/agent-cms/tenants`, `fieldAccess`·`fieldHooks`·`hooks.beforeRead`, 미디어 저장소 역할 권한, 편집기 확장 자리(`editorActions`, `editorPanel`, `fieldAddon`), `/metrics`, `GET /_changes`, `config.plugins`의 표 만들기, CLI `doctor --fix`·`import --from notion`·`user create`·`user reset-link`. 자세한 것은 [여러 서버, 캐시, 여러 사이트](/ko/docs/scaling)에 있습니다.
