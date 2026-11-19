---
title: MCP
summary: 코딩 에이전트를 CMS에 연결해요. 키로, 또는 키 없이 읽기만.
category: Agents
order: 2
sourceVersion: 1
---
붙인 라우트가 `/api/cms/mcp`에서 MCP를 제공해요(공식 MCP SDK, streamable HTTP, 상태 없음).

## 키로

**API 키** 화면에서 키를 만들고, `Authorization: Bearer sgk_…` 헤더와 함께 서버를 등록하세요.

```sh
claude mcp add --transport http my-cms https://app.example.com/api/cms/mcp --header "Authorization: Bearer sgk_…"
```

키의 범위에 따라 에이전트가 볼 수 있는 도구가 정해져요. 게시된 문서는 MCP 리소스(`cms://<collection>/<slug>`)로도 보이고, 프롬프트 두 개(`answer_from_cms`, `edit_document`)가 안전하게 일하는 방법을 알려 줘요.

## 키 없이 (읽기만)

누구나 읽어도 되는 공개 문서라면 익명 읽기를 켜세요.

```ts
createCmsHandler({ cms, resolveUser, mcp: { anonymous: "read" } });
```

그러면 키 없는 요청은 읽기 도구(`list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document`)만 받고, 누구나 읽을 수 있는 컬렉션의 게시된 문서만 봐요. 쓰기 도구는 목록에 나오지 않아요. 기본값은 꺼져 있어요(키 없으면 401).

> [!tip]
> 이 사이트가 바로 이렇게 해요. [에이전트로 읽기](/agents)에서 해 보세요.
