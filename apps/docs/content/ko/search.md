---
title: 검색
summary: 인용 id가 붙은 섹션 검색, 그리고 앱으로 넘기는 검색 실패.
category: Guides
order: 4
sourceVersion: 1
---
## 동작 방식

색인은 메모리에 있고 게시된 문서로 만들어요. 한국어(조사, 어미, 2글자 조각)를 이해하고, `cms://docs/install#create-the-tables` 같은 인용 id가 붙은 **섹션**을 돌려줘요.

```ts
const { hits } = await cms.search(actor, "설치 테이블", { collections: ["docs"] });
```

REST로는 `GET /api/cms/search?q=…&collections=docs,guides`예요.

## 검색 실패

검색 결과가 없으면 agent-cms가 앱에 알려 주고, 무엇을 저장할지는 앱이 정해요.

```ts
createCms({
  onSearchMiss: async (e) => {
    // { query, normalized, collections, actor, source, at, nearest }
    if (e.actor.kind === "anonymous") return;
    await saveMiss(e);
  },
});
```

호출하는 쪽이 요청했을 때만 불려요(`search(…, { reportMiss: true })`, `GET /search?miss=1`, `read_for_answer`). 기다리지 않고, 오류는 `onError`로 가요. `normalized`는 조사와 어순을 무시하니까 이 값으로 묶으세요.

> [!tip]
> 이 사이트는 검색 실패를 자기 테이블 `site_search_misses`에 모으고, `extraNav`로 더한 어드민 화면에서 보여 줘요.
