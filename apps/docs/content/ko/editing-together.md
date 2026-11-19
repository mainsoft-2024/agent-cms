---
title: 같이 편집하기
summary: 충돌, 병합, 자동 저장, 에이전트 변경 검토, 미리보기 링크, 일괄 작업.
category: Guides
order: 3
sourceVersion: 1
---
사람과 에이전트가 같은 문서를 고치기 때문에, agent-cms는 한쪽 저장이 다른 쪽을 몰래 덮어쓰지 않게 해요.

## 충돌

문서를 GET하면 `ETag: "v<n>"`가 와요. PATCH나 DELETE 때 `If-Match`로 돌려보내거나 `expectedVersion`을 넘기세요. 그사이 누가 저장했으면 `conflict_version`(409)으로 실패하고, 상대 내용을 `current`에 담아 보내요. 핸들러에 `requireIfMatch: true`를 주면 버전 없이 쓰는 요청을 거부해요(428).

## 병합

`@mainsoft/agent-cms/diff`의 `mergeDocs(base, mine, theirs)`(브라우저에서도 동작)는 본문을 줄 단위로, 나머지 값은 필드 단위로 합쳐요. 양쪽이 같은 줄을 고쳤으면 상대 것, 내 것, 둘 다 중에서 골라요. "둘 다"는 상대 것 다음에 내 것을 넣어요. 편집기는 이때 **병합** 화면을 열어요.

## 자동 저장

편집기는 저장하지 않은 수정을 버전을 만들지 않고 `PUT …/autosave`로 보관하고, 다시 열 때 복구할지 물어요.

## 에이전트 변경

API 키나 앱의 어시스턴트가 저장한 본문 덩어리는 사람이 수락하거나 되돌릴 때까지 검토 항목으로 남아요.

```ts
const open = await cms.agentChanges(actor, "docs", "install");
await cms.reviewChanges(actor, "docs", "install", { hunks: "all" });
```

편집기에서는 에이전트 블록마다 **수락**과 **되돌리기**가 있고, 위쪽에 **모두 수락**이 있어요. 되돌린 것들은 버전 하나로 저장돼요.

## 초안 미리보기 링크

`createCms`에 `previewSecret`(32자 이상)을 주면, 정확한 버전 하나를 가리키는 서명된 링크를 만들 수 있어요.

```ts
const { url } = await cms.createPreviewLink(actor, "posts", "hello", { ttl: "24h" });
```

공개 페이지에서 이렇게 읽어요.

```ts
const token = searchParams.cms_preview;
const doc = token ? (await cms.readPreview(token)).doc : await cms.get(anon, "posts", slug);
```

링크를 하나씩 취소할 수는 없어요. `previewSecret`을 바꾸면 모두 취소돼요.

## 일괄 작업

```ts
await cms.bulk(actor, "posts", "publish", [{ slug: "a" }, { slug: "b" }]);
```

작업: `publish`, `unpublish`, `archive`, `unarchive`, `delete`. 문서마다 따로 실행하고, 각각 `{ slug, ok, error? }`를 돌려줘요.
