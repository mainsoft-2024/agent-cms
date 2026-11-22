---
title: The CMS on its own
summary: npx @mainsoft/agent-cms dev or serve — the admin, the API, MCP and sign-in on one port, without a web app.
category: Guides
order: 15
---
You do not need a Next.js app to use agent-cms. The package ships a built admin and a server.

## Try it

```bash
npx @mainsoft/agent-cms dev
```

Open the address it prints. Nobody can sign in yet: the terminal shows a **setup code** (valid 15 minutes) that the first admin signs up with. `dev` makes a "Posts" collection; it keeps documents in `.agent-cms/dev` when `@electric-sql/pglite` is installed (`npm i -D @electric-sql/pglite`), in memory otherwise.

## Run your own collections

Put your `createCms` in `server` in `agent-cms.config.ts` and run `serve`:

```ts
import { defineConfig } from "@mainsoft/agent-cms/config";

export default defineConfig({
  db: async () => (await import("./cms")).db,
  server: {
    cms: async () => (await import("./cms")).cms,
    appName: "Acme",
    trustProxy: true, // behind HTTPS
    auth: { sendMail: async (m) => { /* your mail service */ } },
  },
});
```

```bash
npx @mainsoft/agent-cms migrate apply && npx @mainsoft/agent-cms serve --port 3000
```

Or from code: `import { startServer } from "@mainsoft/agent-cms/serve"; await startServer({ cms, port: 3000 })`.

## What the server does

- `/admin`: the admin, with a strict Content Security Policy (`frame-ancestors 'none'`, no inline scripts except one by its hash).
- `/api/cms`: REST, MCP (`/api/cms/mcp`) and the sign-in.
- `GET /healthz` for load balancers; a graceful stop on SIGTERM (requests in flight finish, up to 10 seconds).
- The scheduler every minute: publishing at a time, webhook deliveries, automations, retention.
- Built files are cached for a year; the page is never cached.

## Docker

`examples/server` in the repository has a `Dockerfile` and a `compose.yaml` with Postgres and MinIO:

```bash
export CMS_PREVIEW_SECRET=$(openssl rand -base64 32) CMS_SECRETS_KEY=$(openssl rand -base64 32)
docker compose up --build
docker compose logs cms | grep "setup code"
```

See [Sign-in](/docs/sign-in) for passkeys, two-step codes, single sign-on and invitations.
