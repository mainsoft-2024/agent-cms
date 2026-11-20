---
title: REST API
summary: /api/cms 아래 경로들.
category: Reference
order: 1
sourceVersion: 1
---
인증: `Authorization: Bearer sgk_…` 키, 없으면 앱의 로그인 사용자(`resolveUser`), 그것도 없으면 익명(게시된 문서 읽기만)이에요.

로그인 세션으로 하는 쓰기는 앱 자신의 페이지에서 온 요청이어야 해요. 핸들러가 브라우저의 `Origin`을 요청의 주소(`Host`, 프록시 뒤에서는 `X-Forwarded-Host`)와 비교하고, 다르면 403 `cross_site`로 답해요. 키로 하는 요청은 검사하지 않아요. 어드민을 다른 주소에서 띄운다면 그 주소를 적어 주세요: `createCmsHandler({ cms, resolveUser, trustedOrigins: ["https://admin.example.com"] })`.

## 문서

```text
GET    /collections/:c                    목록 (?fields=summary&state=&q=&category=&by=&limit=&cursor=, ?drafts=1)
POST   /collections/:c                    만들기 {doc, publish?, note?}
GET    /collections/:c/:slug              읽기 (?draft=1이면 작업본)
PATCH  /collections/:c/:slug              고치기 {doc, expectedVersion?, publish?, note?}
DELETE /collections/:c/:slug              휴지통으로 (기본 30일 보관)
POST   /collections/:c/:slug/patch        {ops, expectedVersion?, dryRun?}
POST   /collections/:c/:slug/publish | archive | unarchive | unpublish
```

## 편집 도우미

```text
GET    /collections/:c/_counts            상태별 개수
GET    /collections/:c/_schema            필드의 JSON Schema와 어드민 힌트
POST   /collections/:c/_diagnose          {doc, slug?} → 모든 문제, 저장 안 함
POST   /collections/:c/_bulk              {action, items:[{slug, expectedVersion?}]}
PUT    /collections/:c/:slug/autosave     {doc, baseVersion}   DELETE: 버리기
GET    /collections/:c/:slug/changes      검토를 기다리는 에이전트 변경
POST   /collections/:c/:slug/review       {hunks: [...] | "all", action?}
POST   /collections/:c/:slug/preview      {ttl: "1h" | "24h" | "7d", comments?}
```

## 버전

```text
GET    /collections/:c/:slug/versions[/:n]
GET    /collections/:c/:slug/diff?a=&b=
POST   /collections/:c/:slug/versions/:n/restore  {publish?}
```

## 게시 흐름

```text
POST   /collections/:c/:slug/schedule     {publishAt?, unpublishAt?, expectedVersion?}   DELETE: 취소
POST   /collections/:c/:slug/review/request {note?} | review/approve {publish?} | review/reject {note?}
GET    /reviews?collection=               검토를 기다리는 문서
GET    /collections/:c/:slug/comments | POST {body, anchor?, quote?, threadId?}
POST   /collections/:c/:slug/comments/:id/resolve {resolved?}
GET    /preview/comments?token= | POST    댓글을 허용한 미리보기 링크로 다는 댓글
POST   /collections/:c/:slug/presence     {cursor?, selection?}   DELETE: 나가기
GET    /collections/:c/_presence          누가 어떤 문서를 열었나
PATCH  /collections/:c/:slug/versions/:n  {label?, pinned?}
POST   /collections/:c/_preview           {doc, slug?} → 블록, 진단, 차이. 저장하지 않아요
GET    /collections/:c/_filters | POST {name, query, shared?} | DELETE /collections/:c/_filters/:id
GET    /releases | POST {name}
GET    /releases/:id | PATCH {name} | DELETE
POST   /releases/:id/items {items} | DELETE /releases/:id/items/:documentId
POST   /releases/:id/publish | POST /releases/:id/schedule {publishAt | null}
GET    /trash?kind=document|asset | POST /trash/_restore {items} | POST /trash/_purge {items | all: true}
GET    /_cron                             때가 된 것을 실행 (Authorization: Bearer <cronSecret>)
```

[게시 흐름](/ko/docs/publishing-flow)을 보세요.

## 그 밖

```text
GET    /_me                               나는 누구이고 무엇을 할 수 있나
GET    /search?q=&collections=a,b&miss=1
GET    /preview?token=
GET    /keys | POST /keys | DELETE /keys/:id
GET    /audit?cursor=&action=&outcome=&actorKind=
POST   /mcp
```

문서 GET은 `ETag: "v<n>"`를 보내고, 쓰기는 `If-Match`를 받아요. [같이 편집하기](/docs/editing-together)를 보세요.
