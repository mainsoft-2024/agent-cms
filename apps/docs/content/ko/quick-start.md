---
title: 빠른 시작
summary: Next.js 앱에 컬렉션 하나, API 라우트, 어드민 화면을 붙여요.
category: Get started
order: 3
sourceVersion: 1
---
## 1. 컬렉션 정하기

```ts
import { createCms, defineCollection, DrizzleRepo } from "@mainsoft/agent-cms";
import { z } from "zod";

export const posts = defineCollection({
  slug: "posts",
  label: "Blog",
  visibility: "public",
  categories: ["News", "Engineering"],
  fields: z.object({ tags: z.array(z.string()).default([]) }),
  url: (d) => `/blog/${d.slug}`,
});

export const cms = createCms({ repo: new DrizzleRepo(db), collections: [posts] });
```

## 2. 라우트 붙이기

`app/api/cms/[...path]/route.ts`를 만드세요.

```ts
import { createCmsHandler } from "@mainsoft/agent-cms/http";

const handler = createCmsHandler({ cms, resolveUser });
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
```

`resolveUser(req)`는 로그인한 사용자를 `{ kind: "user", id, label, isAdmin }`로 돌려주거나 `null`을 돌려줘요. 이 라우트 하나가 `/api/cms` 아래 REST와 `/api/cms/mcp`의 MCP를 맡아요.

## 3. 어드민 넣기

```sh
npx @mainsoft/agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command
```

화면들을 `CmsProvider`로 감싸고 화면마다 페이지를 만드세요. [어드민 화면](/docs/admin-screens)을 보세요.

## 4. 페이지 보여 주기

```ts
const doc = await cms.get({ kind: "anonymous" }, "posts", slug);
```

`doc.body`는 `parseMarkdown`으로 그려요([렌더링](/docs/rendering) 참고).

## 5. 에이전트 들이기

어드민에서 API 키를 만들고, 코딩 에이전트에 `https://내-앱/api/cms/mcp`를 `Authorization: Bearer <키>`와 함께 등록하세요. [MCP](/docs/mcp)를 보세요.
