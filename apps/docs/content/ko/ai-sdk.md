---
title: AI SDK 도구
summary: 내 에이전트에 CMS 도구를 줘요. 같은 프로세스에서, 또는 다른 서비스에서.
category: Agents
order: 1
sourceVersion: 1
---
## 같은 프로세스에서

```ts
import { streamText } from "ai";
import { cmsTools } from "@mainsoft/agent-cms/ai";

const result = streamText({
  model,
  tools: {
    ...myTools,
    ...cmsTools(cms, { kind: "system", label: "assistant" }, { prefix: "cms_" }),
  },
  messages,
});
```

이 actor가 쓸 수 있는 도구가 모두 들어와요. `only`와 `prefix`로 줄이거나 이름을 바꿀 수 있어요. 평범한 AI SDK 도구라서 AI SDK로 만든 무엇이든 쓸 수 있어요.

## 다른 서비스에서

```ts
import { remoteCmsTools } from "@mainsoft/agent-cms/ai";

const tools = remoteCmsTools(
  { url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! },
  { only: ["search_documents", "get_document", "patch_document"] }
);
```

`await remoteCmsToolsFor(client, opts)`는 먼저 서버에 키가 쓸 수 있는 도구를 물어봐요. 그래서 읽기 전용 키에는 읽기 도구만 줘요.

## 도구

- **read:** `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document`
- **write:** `create_document`, `update_document`, `patch_document`, `diagnose_document`, `list_versions`, `restore_version`
- **publish:** `publish_document`, `unpublish_document`, `archive_document`, `delete_document`, `bulk_documents`

도구 오류는 예외가 아니라 결과로 돌아와서, 모델이 다시 읽고 재시도할 수 있어요: `{ error: "conflict_version", kind: "conflict", message, params }`. [오류](/docs/errors)를 보세요.
