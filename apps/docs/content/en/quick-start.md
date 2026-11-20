---
title: Quick start
summary: One collection, the API route and the admin screens in a Next.js app.
category: Get started
order: 3
---
## 1. Define a collection

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

## 2. Mount the route

Create `app/api/cms/[...path]/route.ts`:

```ts
import { createCmsHandler } from "@mainsoft/agent-cms/http";

const handler = createCmsHandler({ cms, resolveUser });
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
```

`resolveUser(req)` returns your signed-in user as `{ kind: "user", id, label, isAdmin }`, or `null`. That one route serves REST under `/api/cms` and MCP at `/api/cms/mcp`.

## 3. Add the admin

```sh
npx @mainsoft/agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command
```

Wrap the screens in `CmsProvider` and give each one a page. See [Admin screens](/docs/admin-screens).

## 4. Show a page

```ts
const doc = await cms.get({ kind: "anonymous" }, "posts", slug);
```

Render `doc.body` with `parseMarkdown` (see [Rendering](/docs/rendering)).

## 5. Let an agent in

Create an API key in the admin, then register `https://your-app/api/cms/mcp` in your coding agent with `Authorization: Bearer <key>`. See [MCP](/docs/mcp).
