---
title: 버전과 초안
summary: 스냅샷, 게시, 되돌리기, 버전 비교.
category: Guides
order: 2
sourceVersion: 1
---
저장할 때마다 작성자, 메모, 바뀐 필드와 함께 전체 스냅샷이 남아요.

## 초안

`versions: { drafts: true }`(기본값)면 게시된 문서를 저장해도 작업본만 바뀌어요. 누가 게시하기 전까지 공개 페이지는 게시된 버전을 그대로 보여 줘요. 목록에서는 이런 문서를 **게시 후 수정됨**으로 보여 줘요.

`drafts: false`면 저장할 때마다 게시돼요(릴리스 노트에 알맞아요).

## 게시, 게시 취소, 숨김

```ts
await cms.publish(actor, "posts", "hello");
await cms.unpublish(actor, "posts", "hello");   // 초안으로
await cms.archive(actor, "posts", "hello");     // 숨기고 보관
```

`republishedAt`은 문서가 다시 공개된 시각을 기록해요.

## 되돌리기와 비교

```ts
await cms.restore(actor, "posts", "hello", 3, { publish: true });
const diff = await cms.diff(actor, "posts", "hello", 3, 5);
```

**버전 기록** 화면도 같은 일을 해요. 나란히 보기나 한 줄 보기로, 바뀐 단어를 강조해서 보여 줘요.

## 개수 제한

`versions.max`(기본 100)는 문서마다 최근 N개 버전만 남겨요. 게시된 버전은 항상 남아요.
