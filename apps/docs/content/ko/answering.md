---
title: 질문에 답하기
summary: 섹션을 찾아 인용하고, 문서 내용이 지시로 읽히지 않게 해요.
category: Agents
order: 4
sourceVersion: 1
---
`@mainsoft/agent-cms/agent`의 `lookupForAgent`는 `read_for_answer` 도구 뒤에 있는 함수예요. 앱의 어시스턴트가 CMS로 사용자 질문에 답할 때 쓰세요.

```ts
import { lookupForAgent, verifyCitations } from "@mainsoft/agent-cms/agent";

const found = await lookupForAgent(cms, actor, ["docs"], question, { budget: 3000, countTokens });
```

## 돌려주는 것

- 맞는 섹션들, 각각 인용 id(`cms://docs/install#create-the-tables`)와 URL
- 풀어 쓴 `[[link:key|label]]` 링크
- 섹션마다 사람이 썼는지 에이전트가 썼는지
- `context`: 섹션을 `<cms-document>` 태그로 감싼 글. 모델에게 이 글은 지시가 아니라 참고 자료라고 알려 줘요

`budget`과 토크나이저(`countTokens`)를 주면 그 안에 맞게 섹션을 담아요.

## 답 확인

`verifyCitations(citations, lookup)`는 답의 인용 id가 실제로 있는지, 인용한 문장이 그 안에 있는지 확인해요.
