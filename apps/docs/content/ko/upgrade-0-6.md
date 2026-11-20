---
title: 0.6, 0.7로 올리기
summary: 무엇이 바뀌었고 무엇을 실행할지, 그리고 cms_gaps를 지우기 전에 옮기는 법.
category: Upgrade
order: 1
sourceVersion: 1
---
> [!warning]
> 0.5의 검색 gaps를 썼다면, 스키마를 바꾸기 **전에** `cms_gaps`를 앱의 테이블로 복사하세요. Drizzle 스키마에서 `cmsGaps`를 빼면 drizzle-kit이 `DROP TABLE`을 만들 수 있어요.

## 새 패키지 이름

이제 npmjs.com의 `@mainsoft/agent-cms`예요. `.npmrc`에서 `@mainsoft-2024` 줄을 지우고:

```sh
npm uninstall @mainsoft-2024/agent-cms
npm i @mainsoft/agent-cms
```

import 경로는 범위만 바뀌어요. `@mainsoft-2024/agent-cms/http`는 `@mainsoft/agent-cms/http`가 돼요. 복사한 화면은 `npx @mainsoft/agent-cms add --update`를 실행하세요.

## 데이터베이스

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply
```

0.6은 열과 `cms_audit` 테이블을 더해요. 실행하기 전까지 CMS는 `schema_outdated`(503)로 답해요.

## 코드

- 컬렉션마다 `visibility: "public"` 또는 `"internal"`이 필요하고, internal은 `access.read`도 필요해요.
- 오류: `error`는 이제 세부 코드(`conflict_version`)이고, 예전 값은 `kind`에 있어요.
- `update`는 `fields`를 JSON Merge Patch로 다뤄요(`null`이면 키 삭제).
- gaps는 라이브러리에서 빠졌어요. `onSearchMiss`와 앱의 테이블을 쓰세요([검색](/docs/search) 참고).
- 함께 필요한 `zod`는 `^3.25` 또는 `^4`예요.

## cms_gaps 옮기기

1. 앱의 테이블을 만들어요(예: `app_search_misses`).
2. `INSERT … SELECT` 한 번으로 행을 복사하고 개수를 비교해요.
3. 옮기는 동안 `cms_gaps`는 그대로 둬요. agent-cms는 이 테이블을 읽지도, 쓰지도, 지우지도 않고, `doctor`는 경고만 해요.
4. 새 검색 실패는 `onSearchMiss`로 모아요.
5. 더 필요 없을 때 마지막으로 `cms_gaps`를 지워요.

SQL 전체, Drizzle 테이블, `onSearchMiss` upsert 예시는 [UPGRADE-0.6.md](https://github.com/mainsoft-2024/agent-cms/blob/main/UPGRADE-0.6.md)에 있어요.

## 0.7

바꿀 것이 없어요. `mcp: { anonymous: "read" }`가 새로 생겼고 기본은 꺼져 있어요.
