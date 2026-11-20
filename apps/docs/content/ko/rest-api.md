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

## 웹훅과 작업

관리자와 `admin` 스코프 키만 쓸 수 있어요.

```text
GET    /webhooks                           {webhooks, events, enabled}
POST   /webhooks                           {name, url, events?, collections?, enabled?} → {webhook, secret}
PATCH  /webhooks/:id                       같은 필드 | DELETE
GET    /webhooks/:id/secret                서명 키
POST   /webhooks/:id/test                  시험 전송을 바로 보냄 → {delivery}
GET    /webhooks/:id/deliveries?limit=     최근 30일, 최신순
POST   /webhooks/deliveries/:id/retry      같은 이벤트를 다시 대기열에
GET    /jobs?state=waiting|failed|done&kind=   {waiting, failed, jobs}
POST   /jobs/:id/retry                     실패한 작업을 다시 시도
POST   /_cron                              Bearer cronSecret: 예약, 때가 된 작업, 정리 → {published, …, jobs}
ANY    /<plugin name>/…                    플러그인이 추가한 라우트
```

## 자동화, 역할, 대시보드, 내보내기

0.13.0부터. 따로 적지 않으면 관리자(또는 `admin` 범위의 키)만.

| 메서드와 경로 | 하는 일 |
|---|---|
| `GET /automations` | 자동화 목록과 고를 수 있는 트리거, 동작 |
| `POST /automations`, `PATCH /automations/:id`, `DELETE /automations/:id` | 만들기, 바꾸기, 지우기 |
| `GET /automations/:id/runs` | 실행 기록 (30일) |
| `POST /automations/:id/test` `{collection, slug}` | 문서 하나에 무슨 일이 생길지. 아무것도 바뀌지 않음 |
| `GET /roles`, `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id` | 역할과 허용하는 것 |
| `POST /roles/:id/members` `{id, label?}`, `DELETE /roles/:id/members/:userId` | 역할의 사람 |
| `GET /roles/_users?q=` | 사람 찾기 (`createCms({ users })`에서) |
| `GET /_stats?days=7\|14\|30` | 대시보드의 숫자. 로그인한 누구나, 읽을 수 있는 것만 |
| `GET /export?collections=&drafts=1&download=1` | 문서를 마크다운 파일로. 읽을 수 있는 누구나 |
| `POST /import` `{files, dryRun?, diff?, publish?, onConflict?, collection?, only?, assetMap?}` | 파일을 초안으로 읽기. 쓰기 권한 필요 |
| `GET /openapi.json` | 이 API의 OpenAPI 3.1 문서. 누구나, 읽을 수 있는 것만 |

[자동화, 역할, 대시보드](/docs/automations), [내보내기와 가져오기](/docs/import-export), [OpenAPI와 다른 서버](/docs/openapi)를 보세요.

## 파일

[미디어 라이브러리](/ko/docs/media-library)가 있을 때만 동작해요. 없으면 `media_disabled`로 답해요.

```text
GET    /assets?store=&folder=&kind=image,video&q=&tag=&cursor=&limit=
GET    /assets/_folders | POST {path, store?} | DELETE ?path=&store=
POST   /assets/_import                    {url, folder?, store?, alt?, tags?}   https와 공개 주소만
POST   /assets/uploads                    {name, mime, size, folder?, store?, alt?, tags?, replace?} → {asset, upload}
GET    /assets/uploads/:id                어느 조각이 도착했는지   DELETE: 그만두기
POST   /assets/uploads/:id/parts          {parts: [1, 2]} → 그 조각들의 서명된 주소
POST   /assets/uploads/:id/complete       {width?, height?, duration?} → 검사를 거쳐 라이브러리에 들어가요
GET    /assets/:id | PATCH {alt?, tags?, focal?: {x, y} | null} | DELETE ?confirm=1
POST   /assets/:id/move                   {folder?, name?}
POST   /assets/:id/share                  {ttl?: "1h" | "24h" | "7d"}
POST   /assets/:id/thumb                  작은 그림을 요청 본문으로
GET    /files/:id/:name                   파일로 302. ?thumb=1, ?download=1, ?size=<이름>
GET    /stores/:store/files?prefix=&q=&cursor=   버킷에 있는 모든 것 (파일 관리자)
POST   /stores/:store/files/_register | _move | _delete
```

`upload`는 `{kind: "single", url, headers}`(그 주소로 파일을 PUT)이거나 `{kind: "multipart", partSize, partCount}`(조각 주소를 받아 조각마다 PUT)예요. `replace: <id>`를 주면 올린 파일이 검사를 통과한 뒤 그 파일의 새 내용이 돼요. `?size=`는 [이미지 크기](/ko/docs/media-library#이미지-크기)를 켜야 하고, 없는 이름이면 `unknown_image_size`로 답해요.

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
