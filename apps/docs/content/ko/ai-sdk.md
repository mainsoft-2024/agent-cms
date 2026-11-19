---
title: 직접 만든 에이전트
summary: 앱 안의 에이전트에 CMS 도구를 줘요. 같은 프로세스에서, 또는 다른 서비스에서. 패키지는 모델을 부르지 않아요.
category: Agents
order: 1
sourceVersion: 2
---
> [!note]
> 이 페이지는 전에 "AI SDK 도구"였어요. `./ai` 입구(`cmsTools`, `remoteCmsTools`)는 0.8.0에서 없어졌어요. agent-cms는 에이전트에게 도구만 건네고, 모델 라이브러리에 의존하지 않아요. 대신 쓰는 방법이 아래에 있고, 바꾸는 법은 [0.8로 올리기](/docs/upgrade-0-8)에 있어요.

## 같은 프로세스에서

`toolsFor(cms, actor)`는 이 actor가 쓸 수 있는 도구를 줘요. 이름, 설명, 입력의 zod 스키마예요. `callTool`은 도구 하나를 실행해요. 쓰는 에이전트 프레임워크의 도구 모양으로 감싸면 돼요.

```ts
import { toolsFor, callTool } from "@mainsoft/agent-cms/tools";

const actor = { kind: "system", label: "assistant" } as const;

const tools = toolsFor(cms, actor).map((t) => ({
  name: t.name,
  description: t.description,
  input: t.input, // a zod object; toJsonSchema(t.input) from ./mcp gives JSON Schema
  run: (args: unknown) => callTool(cms, actor, t.name, args),
}));
```

`callTool(cms, actor, name, args, { only })`는 입력을 확인하고, actor의 권한으로 도구를 실행하고, 에이전트가 한 호출로 기록해요. `toolsFor(cms, actor, only)`와 `only` 옵션으로 목록을 줄일 수 있어요.

## 다른 서비스에서

스크립트, 예약 작업, 다른 서비스는 키를 써요.

```ts
import { createCmsClient } from "@mainsoft/agent-cms/client";
import { toolErrorResult } from "@mainsoft/agent-cms/tools";

const api = createCmsClient({ url: "https://app.example.com/api/cms", key: process.env.AGENT_CMS_KEY! });

const tools = await api.listTools(); // only what this key may use: { name, description, inputSchema }
const run = (name: string, args: Record<string, unknown>) =>
  api.call(name, args).catch((e) => toolErrorResult(e) ?? Promise.reject(e));
```

`listTools()`는 그 키가 쓸 수 있는 도구를 서버에 먼저 물어봐요. 읽기 전용 키에는 읽기 도구만 보여요.

## 로그인한 사람을 대신할 때

에이전트가 로그인한 사람의 권한으로 일하면 actor에 표시하세요.

```ts
await callTool(cms, { ...user, agent: { label: "assistant" } }, "patch_document", args);
```

권한은 그 사람과 똑같아요. 버전, 문서, 감사 로그에 에이전트 이름도 함께 남고, 고친 내용은 "에이전트 변경"에 떠서 검토할 수 있고, 어드민에는 "assistant, Kim"처럼 보여요. CMS를 같은 프로세스에서 부르는 코드만 이렇게 할 수 있어요. REST와 MCP는 받지 않아요.

## 오류도 결과예요

도구 오류는 던져지지 않고 결과로 돌아와요. 모델이 다시 읽고 다시 시도할 수 있어요. `{ error: "conflict_version", kind: "conflict", message, params: { expected, current } }` 모양이에요. 모든 코드는 [오류](/docs/errors) 페이지에 있어요.

## 도구 목록

- **read:** `list_collections`, `search_documents`, `read_for_answer`, `list_documents`, `get_document`
- **write:** `create_document`, `update_document`, `patch_document`, `diagnose_document`, `list_versions`, `restore_version`
- **publish:** `publish_document`, `unpublish_document`, `archive_document`, `delete_document`, `bulk_documents`
- **[미디어 라이브러리](/docs/media-library)가 있을 때:** `list_assets`, `get_asset`(read), `import_asset`, `update_asset`(write), `move_asset`, `delete_asset`(publish)
- **[파일 관리자](/docs/file-manager)와 함께:** `list_store_files`(read), `register_asset`(write), `create_share_link`(publish)

같은 목록이 [MCP](/docs/mcp)로도 나가요. 코딩 에이전트와 앱 안의 에이전트가 같은 도구를 봐요. 문서로 질문에 답하는 방법은 [답변하기](/docs/answering)를 보세요.
