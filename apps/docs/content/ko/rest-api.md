---
title: REST API
summary: /api/cms 아래 경로들.
category: Reference
order: 1
sourceVersion: 1
---
인증: `Authorization: Bearer sgk_…` 키, 없으면 앱의 로그인 사용자(`resolveUser`), 그것도 없으면 익명(게시된 문서 읽기만)이에요.

## 문서

```text
GET    /collections/:c                    목록 (?fields=summary&state=&q=&category=&by=&limit=&cursor=, ?drafts=1)
POST   /collections/:c                    만들기 {doc, publish?, note?}
GET    /collections/:c/:slug              읽기 (?draft=1이면 작업본)
PATCH  /collections/:c/:slug              고치기 {doc, expectedVersion?, publish?, note?}
DELETE /collections/:c/:slug
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
POST   /collections/:c/:slug/preview      {ttl: "1h" | "24h" | "7d"}
```

## 버전

```text
GET    /collections/:c/:slug/versions[/:n]
GET    /collections/:c/:slug/diff?a=&b=
POST   /collections/:c/:slug/versions/:n/restore  {publish?}
```

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
