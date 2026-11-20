---
title: OpenAPI와 다른 서버
summary: REST API를 OpenAPI 3.1 문서로, 컬렉션마다 타입이 있는 스키마와 함께. 핸들러를 Express, Fastify, Hono 등에 붙이는 법.
category: Reference
order: 4
sourceVersion: 1
---
> [!note]
> 0.13.0부터.

## 문서

```sh
curl https://app.example.com/api/cms/openapi.json
npx @mainsoft/agent-cms openapi > openapi.json     # 내 키가 읽을 수 있는 것
```

이 설치의 지금 설정을 그대로 설명합니다.

- [REST API](/docs/rest-api)의 모든 경로와 그 매개변수, 본문, 응답.
- 읽을 수 있는 컬렉션마다 자기 경로(`/collections/posts`, `/collections/posts/{slug}`)와 스키마(`PostsDoc`, `PostsInput`)가 컬렉션의 필드로 만들어집니다. 그래서 생성한 클라이언트가 실제 타입을 갖습니다. 카테고리는 enum입니다.
- 꺼져 있는 부분(미디어, cron, 미리보기 링크)은 빠집니다.
- 로그인하지 않은 사람은 공개 컬렉션만, 키나 세션은 읽을 수 있는 것만 받습니다.

패키지의 테스트가 문서에 적힌 모든 경로를 실제 핸들러에 보내 보고, 어느 쪽으로든 둘이 다르면 실패합니다.

```sh
npx openapi-typescript https://app.example.com/api/cms/openapi.json -o cms.d.ts
```

코드에서는 `openApiDocument(cms, { basePath, origin, actor })`와 경로 목록 `API_ROUTES`.

## 다른 서버

핸들러는 웹 `Request`를 받아 웹 `Response`를 돌려줍니다. 이미 그 둘을 쓰는 프레임워크는 더 필요한 것이 없습니다.

```ts
// Hono
app.all("/api/cms/*", (c) => handler(c.req.raw));

// SvelteKit: src/routes/api/cms/[...path]/+server.ts
export const GET = ({ request }) => handler(request);
export const POST = GET, PATCH = GET, PUT = GET, DELETE = GET;

// Bun, Deno
Bun.serve({ fetch: handler });
```

Node의 `(req, res)`를 쓰는 서버에는:

```ts
import { toNodeHandler } from "@mainsoft/agent-cms/adapters/node";

const handler = createCmsHandler({ cms, resolveUser, basePath: "/api/cms" });

app.use("/api/cms", toNodeHandler(handler));                 // Express
http.createServer(toNodeHandler(handler)).listen(3000);      // node:http
```

`toNodeHandler(handler, { origin, maxBodyBytes })`: `origin`은 서버가 `Host`와 `X-Forwarded-Proto`로 알 수 없을 때 사람들이 여는 주소입니다. `maxBodyBytes`(기본 8MB)를 넘는 본문은 413 `body_too_large`로 답합니다. `express.json()` 같은 본문 파서 뒤에서도 동작합니다. `toWebRequest(req)`는 `resolveUser` 코드에 다른 곳과 같은 `Request`를 줍니다.

어드민 화면은 React 컴포넌트이고 API하고만 이야기하므로 어떤 React 앱에서든 돕니다. 다른 언어에서는 위 문서로 클라이언트를 생성하세요.
