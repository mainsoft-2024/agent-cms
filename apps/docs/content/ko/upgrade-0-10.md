---
title: 0.10으로 올리기
summary: 스키마는 버전 4예요. 삭제하면 휴지통으로 가고, 예약은 cron 호출이 있어야 실행돼요. 화면 네 개에 새 부품이 생겼어요.
category: Upgrade
order: 3
sourceVersion: 1
---
0.10.0은 0.7.0 다음에 나온 첫 npm 릴리스이고, 0.8.0과 0.9.0이 들어 있어요. 0.7.0에서 올린다면 [0.8로 올리기](/docs/upgrade-0-8)를 먼저 하세요. 0.9.0은 따로 할 일이 없어요.

## 1. 스키마 버전 4

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply    # 또는 `migrate print`로 SQL을 받아 직접 실행
```

추가만 하는 단계라 두 번 실행해도 괜찮아요.

- `cms_documents`의 열 (`deleted_at`, `deleted_by`, `schedule`, `due_at`, `review`), `cms_versions`의 열 (`label`, `pinned`, `approved_by`, `approved_at`), `cms_assets`의 열 (`deleted_at`, `deleted_by`)
- 표 `cms_comments`, `cms_releases`, `cms_saved_filters`, `cms_presence`

Drizzle 스키마에서 다른 표 옆에 `cmsComments`, `cmsReleases`, `cmsSavedFilters`, `cmsPresence`를 다시 내보내세요.

## 2. 삭제하면 휴지통으로 가요

`cms.remove`, `DELETE /collections/:c/:slug`, `delete_document` 도구, 파일 삭제는 예전에는 바로 지웠어요. 이제는 문서나 파일을 휴지통에 30일 동안 둬요.

- 휴지통의 문서는 `get`, `list`, 검색, 에이전트에게 보이지 않아요. 주소는 그대로 차지해요. 복구하거나 영구 삭제하기 전에는 같은 슬러그로 문서를 만들 수 없어요(`slug_in_trash`).
- 휴지통의 파일은 영구 삭제할 때까지 버킷에 남아 있어요. 공개 주소도 그때까지 열려요.
- `createCms({ trash: { days: 0 } })`이면 예전처럼 바로 지워요. 삭제 뒤에 행 수를 세는 테스트는 이 설정을 쓰거나 `cms.trash.purge(admin, "all")`을 부르세요.
- 오래된 휴지통은 `cms.runScheduled()`가 돌 때 비워져요(다음 절).

## 3. 예약과 휴지통을 위한 cron 호출

예약 게시와 휴지통 비우기는 `cms.runScheduled()`가 돌 때 실행돼요. `createCms({ cronSecret })`을 설정하고 몇 분마다 이 경로를 부르세요.

```
POST /api/cms/_cron
Authorization: Bearer <cronSecret>
```

`GET`으로 불러도 돼요. `cronSecret`이 없으면 이 경로는 404로 답해요. Vercel에서는 `CRON_SECRET`을 둔 cron 작업이 바로 이 헤더를 보내요. 두 곳에서 동시에 불러도 안전해요.

> [!note]
> 스스로 게시되는 것은 없어요. 아무도 이 경로를 부르지 않으면 예약한 문서는 시각이 지나도 "예약됨"으로 남아요.

## 4. 어드민 화면

```sh
npx @mainsoft/agent-cms add --update
npx @mainsoft/agent-cms add cms-trash cms-releases
```

- `cms-doc-editor`에 파일이 두 개 늘었어요: `cms-flow.tsx`, `cms-paste.ts`.
- `cms-doc-list`는 shadcn의 `label`이 필요해요. `cms-versions`는 `dialog`와 `input`이 필요해요.
- `cms-shell`은 편집할 수 있는 사람에게 "릴리스"와 "휴지통"을 보여 줘요. `hrefFor`가 받는 대상에 `releases`와 `trash`가 생겼으니 앱에 두 경로를 추가하세요.
- `cms-preview-comments`는 선택이에요. "댓글 허용"으로 만든 링크를 받은 외부 사람이 공개 미리보기 페이지에서 쓰는 댓글 상자예요.

## 5. 검토는 켜야 생겨요

컬렉션이 요청하기 전에는 아무것도 달라지지 않아요.

```ts
defineCollection({ slug: "guide", review: { agents: "required" } });
```

이렇게 하면 API 키와 사람을 대신하는 에이전트는 아무도 승인하지 않은 버전을 게시할 수 없어요(`review_required`). `everyone: "required"`이면 사람도 자기가 요청한 검토를 스스로 승인할 수 없어요.

## 6. 타입 변경

`CmsDoc`에 `deletedAt`, `deletedBy`, `schedule`, `dueAt`, `review`가 생겼어요. `CmsVersion`에는 `label`, `pinned`, `approvedBy`, `approvedAt`, `DocSummary`에는 `schedule`과 `review`, `DocCounts`에는 `scheduled`와 `review`, `CmsAsset`에는 `deletedAt`, `deletedBy`가 생겼어요.

직접 만든 `CmsRepo`에는 새 메서드(`updateVersion`, 댓글, 릴리스, 필터, 함께 편집)가 필요하고, `findDoc`, `findDocById`, `findAsset`은 `{ trashed }`를 받아요. `MemoryRepo`와 `DrizzleRepo`에는 이미 들어 있어요.
