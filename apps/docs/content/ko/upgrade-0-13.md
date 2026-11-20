---
title: 0.13으로 올리기
summary: 스키마 버전 7은 자동화와 역할을 담는 표 하나를 더합니다. 새 화면 네 개. 쓰기 전에는 기존 앱에 바뀌는 것이 없습니다.
category: Upgrade
order: 6
sourceVersion: 1
---
## 1. 스키마 버전 7

새 표 하나: `cms_records`. 자동화, 자동화 실행 기록, 역할을 담습니다. 기존 표는 바뀌지 않습니다.

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply     # 또는 `migrate print`로 SQL을 받아 직접 실행
```

Drizzle 스키마 파일에서 표를 다시 내보내고 있다면 `cmsRecords`를 추가하세요 (새로 `init` 하면 들어 있습니다).

## 2. 역할은 만들기 전에는 아무것도 바꾸지 않습니다

누가 무엇을 할 수 있는지는 이 순서로 정해집니다: 시스템, 코드에 적은 컬렉션의 `access` 함수, 역할, 기본값(관리자만). 역할을 하나도 만들지 않은 앱은 전과 똑같이 동작합니다. [자동화, 역할, 대시보드](/docs/automations)를 보세요.

## 3. 자동화는 cron 호출 때 실행됩니다

자동화의 일은 백그라운드 작업이라, 웹훅을 보내는 것과 같은 `POST /_cron` 호출 때 실행됩니다. 화면에서 새로 만든 자동화는 꺼진 채로 시작합니다.

## 4. 화면

`npx @mainsoft/agent-cms add --update`가 `cms-shell`(대시보드, 자동화, 역할, 가져오기와 내보내기)과 `cms-messages`를 가져옵니다. 그다음 새 화면을 더하고 각각 페이지를 만드세요.

```sh
npx @mainsoft/agent-cms add cms-dashboard cms-automations cms-roles cms-transfer
```

| 화면 | 페이지 | 메뉴가 보이는 사람 |
|---|---|---|
| `CmsDashboard` | `/admin/dashboard` | 로그인한 모든 사람 |
| `CmsAutomations` | `/admin/automations` | 관리자 |
| `CmsRoles` | `/admin/roles` | 관리자 |
| `CmsTransfer` | `/admin/transfer` | 관리자 |

## 5. REST와 CLI

- 새 경로: `GET /openapi.json`, `GET /_stats`, `GET /export`, `POST /import`, `/automations…`, `/roles…`. `GET /_me`가 `dashboard`, `automations`, `roles`를 돌려줍니다.
- `openapi.json`은 이제 예약된 이름이라 컬렉션의 슬러그로 쓸 수 없습니다.
- 새 명령: `export <dir> [--with-files]`, `import <dir>`, `import <file> --from json|csv|wordpress`, `openapi`. [내보내기와 가져오기](/docs/import-export), [OpenAPI와 다른 서버](/docs/openapi)를 보세요.
- 새 입구 `@mainsoft/agent-cms/adapters/node`.

## 6. 타입

- `CreateCmsOptions`에 `users`와 `automations`가 생겼습니다.
- 직접 만든 `CmsRepo`에는 레코드 메서드(`insertRecord`, `findRecord`, `findRecordByKey`, `listRecords`, `updateRecord`, `deleteRecords`)와 `versionsSince`가 필요합니다. `MemoryRepo`와 `DrizzleRepo`에는 있습니다.
- 새 오류 코드: `name_taken`, `role_not_found`, `role_last_admin`, `forbidden_roles`, `automation_not_found`, `automation_invalid`, `forbidden_automations`.
