# agent-cms as a server of its own

The admin, the REST API, MCP and the CMS's own sign-in (passkeys, two-step codes,
invitations) on one port, without a Next.js app.

```bash
# Try it: a "Posts" collection, nothing to set up
npx @mainsoft/agent-cms dev

# This folder: Postgres + MinIO + the CMS
export CMS_PREVIEW_SECRET=$(openssl rand -base64 32) CMS_SECRETS_KEY=$(openssl rand -base64 32)
docker compose up --build
docker compose logs cms | grep "setup code"   # the first admin signs up with it
open http://localhost:3000/admin
```

- `cms.ts` is your `createCms` (collections, database, storage).
- `agent-cms.config.ts` has `server`: what `agent-cms serve` runs.
- Health: `GET /healthz`. Stops gracefully on SIGTERM.
- Behind HTTPS: set `TRUST_PROXY=1` so the secure cookie and HSTS are used.
