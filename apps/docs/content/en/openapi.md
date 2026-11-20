---
title: OpenAPI and other servers
summary: The REST API as an OpenAPI 3.1 document with a typed schema per collection, and how to mount the handler on Express, Fastify, Hono and others.
category: Reference
order: 4
---
> [!note]
> From 0.13.0.

## The document

```sh
curl https://app.example.com/api/cms/openapi.json
npx @mainsoft/agent-cms openapi > openapi.json     # what your key may read
```

It describes this installation as it is configured:

- Every route of the [REST API](/docs/rest-api) with its parameters, body and answer.
- For each collection the caller may read, its own paths (`/collections/posts`, `/collections/posts/{slug}`) and schemas (`PostsDoc`, `PostsInput`) built from the collection's fields, so a generated client has real types. Categories are an enum.
- Parts that are switched off (media, cron, preview links) are left out.
- A stranger gets only public collections; a key or a session gets what it may read.

A test in the package sends every documented route to the real handler and fails when the two disagree, in either direction.

```sh
npx openapi-typescript https://app.example.com/api/cms/openapi.json -o cms.d.ts
```

In code: `openApiDocument(cms, { basePath, origin, actor })` and the route list `API_ROUTES`.

## Other servers

The handler takes a web `Request` and returns a web `Response`. Frameworks that already speak those need nothing else:

```ts
// Hono
app.all("/api/cms/*", (c) => handler(c.req.raw));

// SvelteKit: src/routes/api/cms/[...path]/+server.ts
export const GET = ({ request }) => handler(request);
export const POST = GET, PATCH = GET, PUT = GET, DELETE = GET;

// Bun, Deno
Bun.serve({ fetch: handler });
```

For servers that speak Node's `(req, res)`:

```ts
import { toNodeHandler } from "@mainsoft/agent-cms/adapters/node";

const handler = createCmsHandler({ cms, resolveUser, basePath: "/api/cms" });

app.use("/api/cms", toNodeHandler(handler));                 // Express
http.createServer(toNodeHandler(handler)).listen(3000);      // node:http
```

`toNodeHandler(handler, { origin, maxBodyBytes })`: `origin` is the address people open when the server cannot tell from `Host` and `X-Forwarded-Proto`; bodies over `maxBodyBytes` (8MB by default) answer 413 `body_too_large`. It works after a body parser such as `express.json()` too. `toWebRequest(req)` gives your `resolveUser` code the same `Request` it would get elsewhere.

The admin screens are React components and talk to the API only, so they run in any React app. From another language, generate a client from the document above.
