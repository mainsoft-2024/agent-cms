---
title: 0.8로 올리기
summary: ./ai 입구가 없어졌고, 스키마는 버전 3이에요. 에이전트가 사람을 대신할 수 있고, 미디어 라이브러리는 켜야 생겨요.
category: Upgrade
order: 2
sourceVersion: 2
---
0.8.0은 npm에 따로 올라가지 않았어요. 0.7.0 다음 릴리스인 0.10.0에 들어 있어요. 0.7.0에서 올린다면 이 페이지를 먼저 하고, 이어서 [0.10으로 올리기](/docs/upgrade-0-10)를 하세요.

## 1. `./ai`가 없어졌어요

agent-cms는 에이전트에게 도구를 건네요. 모델을 부르지 않고, 0.8부터는 모델을 부르는 라이브러리에도 의존하지 않아요. `./ai` 입구(`cmsTools`, `remoteCmsTools`, `remoteCmsToolsFor`)와 `ai` 의존성이 없어졌어요. `./ai`를 썼다면 `./tools`의 `toolsFor`와 `callTool`로 도구를 직접 감싸세요.

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

다른 서비스에서는 `createCmsClient().listTools()`와 `call()`을 써요. 자세한 것은 [직접 만든 에이전트](/docs/ai-sdk)에 있어요.

## 2. 스키마 버전 3

```sh
npx @mainsoft/agent-cms migrate check    # 무엇이 빠졌는지
npx @mainsoft/agent-cms migrate apply    # 또는 `migrate print`로 SQL을 받아 직접 실행
```

더하기만 하는 단계라서 두 번 실행해도 안전해요.

- `cms_documents.updated_by_agent`, `cms_versions.author_agent`, `cms_audit.actor_agent`(text, 비어 있을 수 있음)
- 미디어 라이브러리를 위한 표 `cms_assets`, `cms_asset_refs`. 파일 저장소를 설정하기 전에는 비어 있어요.

실행하기 전에는 CMS가 `schema_outdated`로 답해요. 스키마가 바뀔 때마다 그래요.

## 3. 사람을 대신하는 에이전트

앱 안의 에이전트가 로그인한 사람의 권한으로 일할 때 actor에 표시하세요.

```ts
await callTool(cms, { ...user, agent: { label: "assistant" } }, "patch_document", args);
```

권한은 그 사람과 똑같아요. 버전, 문서, 감사 로그에 에이전트 이름이 함께 남고, 고친 내용은 "에이전트 변경"에서 검토할 수 있어요. 같은 프로세스에서 부르는 코드만 정할 수 있고, REST와 MCP는 받지 않아요(`resolveUser`가 돌려줘도 핸들러가 버려요).

타입도 따라 바뀌었어요. `CmsDoc.updatedByAgent`, `CmsVersion.authorAgent`, `AuditEntry.actorAgent`, `DocSummary.updatedByAgent`가 새로 생겼고(`string | null`), `AgentChange.authorKind`는 `"user"`일 수 있고, `AgentChange.behalf`는 에이전트가 대신한 사람이에요. `CmsRepo`를 직접 구현했다면 파일용 메서드(`insertAsset`부터 `listAssetRefs`까지)를 추가해야 해요.

## 4. 미디어 라이브러리는 켜야 생겨요

`createCms`에 `media`를 넘기기 전에는 달라지는 것이 없어요([미디어 라이브러리](/docs/media-library)). 쓰지 않아도 알아 둘 것이 두 가지 있어요.

- `parseMarkdown`에 블록 하나(`media`)와 인라인 둘(`image`, `file`)이 새로 생겼어요. `switch`로 모든 블록을 다루는 렌더러에는 case를 추가해야 해요. 모르는 블록을 무시하는 렌더러는 미디어 줄에 아무것도 그리지 않아요.
- `![alt](https://…)`만 있는 줄은 전에는 글자로 보였고 이제 이미지 블록이에요. 본문의 `![alt](asset:…)`는 저장할 때 확인해요. 미디어 라이브러리가 없으면 `asset_missing`으로 실패해요.

켤 때는 Drizzle 스키마에서 `cmsAssets`와 `cmsAssetRefs`를 다른 표와 함께 다시 내보내고, `agent-cms.config.ts`에 같은 `media` 객체를 넣고, 환경마다 `npx @mainsoft/agent-cms storage check --origin https://your-site`를 한 번 실행하세요.

## 5. 어드민 화면

`npx @mainsoft/agent-cms add --update`(먼저 `--diff`로 볼 수 있어요)로 복사한 화면을 이 버전으로 올려요.

- `cms-doc-editor`가 `./cms-media-picker`(와 `cms-upload.ts`)를 불러와요. 미디어 라이브러리가 없는 앱도 마찬가지고, `add`가 둘 다 가져와요.
- `cms-shell`의 `hrefFor`가 `{ kind: "media" }`를 물어볼 수 있어요. 기본은 `<basePath>/media`예요. 라이브러리를 켤 때 `cms-media`로 그 페이지를 만드세요.
- 새 문구는 `cms-messages.ts`에서 `media_`로 시작해요(영어와 한국어).
