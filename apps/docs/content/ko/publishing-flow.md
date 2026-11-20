---
title: 게시 흐름
summary: 예약 게시, 검토 요청, 댓글, 릴리스, 휴지통과 이들이 필요로 하는 cron 호출 하나.
category: Guides
order: 8
sourceVersion: 1
---
> [!note]
> npm에서는 0.10.0부터 쓸 수 있어요. 이전 버전에서 올리는 중이라면 [0.10으로 올리기](/ko/docs/upgrade-0-10)를 먼저 보세요.

편집기, 문서 목록, 그리고 화면 두 개(`cms-trash`, `cms-releases`)가 "저장함"과 "공개됨" 사이의 일을 맡아요. cron 호출 말고는 따로 설정할 것이 없어요.

## cron 호출

예약 게시, 예약된 릴리스, 휴지통 비우기는 경로 하나를 부를 때 실행돼요. 얼마나 정확한 시각에 실행되는지는 그 호출 간격이 정해요.

```ts
// lib/cms.ts
createCms({ cronSecret: process.env.CRON_SECRET /* ... */ });
```

```json
// vercel.json
{ "crons": [{ "path": "/api/cms/_cron", "schedule": "*/10 * * * *" }] }
```

Vercel은 프로젝트에 이 변수가 있으면 `Authorization: Bearer $CRON_SECRET`을 알아서 보내요. Vercel의 Hobby 요금제에서는 cron이 하루에 한 번까지만 돌고, 더 짧은 주기를 적으면 배포가 실패해요. 그럴 때는 하루 한 번짜리를 두고, 자주 부르는 일은 다른 스케줄러에 맡기세요(이 사이트는 GitHub Actions 스케줄로 10분마다 불러요). 다른 곳에서는 같은 헤더로 `GET` 또는 `POST /api/cms/_cron`을 부르면 돼요. `cronSecret`이 없으면 이 경로는 404로 답하고, 시크릿이 틀리면 401이에요. 응답은 무엇을 실행했는지 알려줘요.

```json
{ "published": ["posts/launch"], "unpublished": [], "failed": [], "releases": [], "purged": { "documents": 0, "assets": 0 } }
```

## 예약

"게시" 옆 화살표에서 게시 시각과 게시 취소 시각을 정해요. 시각은 `createCms({ timeZone })`의 시간대로 입력해요.

- 예약할 때의 버전이 나가요. 그 뒤에 고치면 경고와 함께 "최신 버전으로 다시 예약"이 나와요.
- 시각이 되면 그 버전을 다시 검사해요. 오류가 있는 버전은 게시하지 않고 `failed`에 알려요.
- 목록에 "예약됨" 탭이 있고, 각 행에 시각이 보여요.

## 검토

```ts
defineCollection({ name: "guide", review: { agents: "required" } });
```

- `agents: "required"`이면 API 키나 에이전트가 쓴 글은 사람이 승인해야 공개돼요.
- `everyone: "required"`이면 사람이 쓴 글도 그래요. 요청한 사람은 자기 요청을 승인할 수 없어요.
- 편집기에 요청이 "돌려보내기", "승인하고 게시"와 함께 보여요. 목록에는 "검토 대기" 탭이 있어요.
- 요청이 열려 있는 동안 저장하면 요청이 새 버전으로 옮겨가요. 검토를 승인하는 도구는 없어요. 에이전트는 요청하고(`request_review`) 목록을 읽을(`list_review_requests`) 수만 있어요.

## 댓글

섹션이나 선택한 글에 댓글을 달고, 답글을 달고, "해결"로 닫아요.

- 글을 고쳐도 댓글이 그 글을 따라가요. 글이 사라지면 맨 아래 "위치를 잃은 댓글"로 옮겨져요.
- "댓글 허용"으로 만든 미리보기 링크에서는 계정이 없는 사람도 댓글을 달 수 있어요. 그런 링크는 `readPreview(token)`이 `comments: true`를 돌려주고, 페이지에 `<CmsPreviewComments token={token} />`을 두면 댓글 상자가 보여요([미리보기 댓글](/components/cms-preview-comments) 참고).
- 에이전트는 `list_comments`, `add_comment`, `resolve_comment`로 댓글을 읽고, 답하고, 해결해요.

## 릴리스

릴리스는 문서 여러 개를 지금 또는 정한 시각에 함께 게시해요.

- 편집기 메뉴의 "릴리스에 담기"나 릴리스 화면에서 문서를 담아요. 항목마다 게시인지 게시 취소인지 정해요.
- 담을 때의 버전이 고정돼요. 그 뒤에 고쳤으면 행에 "v5 → v7"이 보여요.
- 전부 나가거나 아무것도 안 나가요. 하나라도 막히면 아무것도 게시하지 않고, 무엇이 막았는지 보여줘요.
- 문서는 열린 릴리스 하나에만 담을 수 있어요. 되돌리기는 없어요. 되돌리려면 게시를 취소하거나 이전 버전을 복원하세요.

## 휴지통

삭제한 문서와 파일은 30일 동안 남아요.

```ts
createCms({ trash: { days: 30 } }); // 0이면 0.10 전처럼 바로 지워요
```

- 삭제한 문서의 주소는 영구 삭제할 때까지 다시 쓸 수 없어요.
- 게시됐던 문서를 복구하면 다시 공개돼요.
- 삭제한 파일의 공개 주소는 영구 삭제할 때까지 열려 있어요.
- 영구 삭제와 휴지통 비우기는 관리자만 할 수 있어요. cron 호출이 `trash.days`보다 오래된 것을 지워요.

## 작은 것들

- **함께 편집.** 편집기와 목록에 같은 문서를 연 사람이 보이고, 본문에는 그 사람의 커서가 보여요. 다른 사람이 저장하면 편집기가 새 버전을 받아오고, 저장하지 않은 내 수정과 겹치지 않으면 합쳐요. 15초마다 확인하고, 다른 사람이 있으면 3초마다 확인해요. `presenceMs={0}`이면 꺼져요.
- **붙여넣기.** 웹 페이지나 문서 프로그램에서 복사한 글이 마크다운으로 들어가요(제목, 목록, 굵게, 링크, 표, 코드). 색과 글자 크기는 빠지고, 편집기가 한 번 알려줘요.
- **버전**에 이름을 붙이고 고정할 수 있어요. 고정한 버전은 정리되지 않아요.
- **저장된 필터**는 탭, 검색어, 카테고리, 작성자를 이름 하나로 묶어 둬요. 나만 쓰거나 (관리자는) 모두에게 보일 수 있어요.

## 에이전트 도구

이 흐름에 도구 15개가 딸려 와요. `label_version`, `preview_document`, `schedule_document`, `unschedule_document`, `request_review`, `list_review_requests`, `list_comments`, `add_comment`, `resolve_comment`, `list_trash`, `restore_from_trash`, `list_releases`, `create_release`, `add_to_release`, `publish_release`. 키의 범위에 따라 에이전트에게 보이는 도구가 달라져요. 경로는 [REST API](/ko/docs/rest-api) 페이지에 있어요.
