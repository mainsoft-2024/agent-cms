# Example plugins

Small plugins that show the parts of a plugin and how to test one.

| Folder | What it shows |
| --- | --- |
| [`stats/`](stats) | an `afterRead` hook, an event listener (`doc.published`), a job (`rollup`), `ctx.store`, a route (`GET /api/cms/stats/summary`), a tool (`stats_summary`) and an admin page |
| [`slack-notify/`](slack-notify) | `settings` with a secret (sealed with `secretsKey`), a check in `start`, and an automation action (`slack-notify.post`) |
| [`synonym-ranker/`](synonym-ranker) | a search ranker (`ctx.search.ranker`) merged with the keyword search, and following the keyword index with `ctx.search.sections()` and events |

Start a new one with:

```sh
npx @mainsoft/agent-cms plugin init my-plugin
```

## Two halves

A plugin has a server half and, when it shows something in the admin, an admin half. Keep them in
separate files: the server half must not import React, and the admin half runs in the browser.

**Server** (`index.ts`): `definePlugin` from `@mainsoft/agent-cms`. Give it to `createCms({ plugins })`.

```ts
export default definePlugin({
  name: "stats",          // lowercase letters, digits, dashes; routes live at /api/cms/stats/...
  version: "1.0.0",
  engine: ">=0.24",       // the agent-cms versions it works with
  options: z.object({ top: z.number().default(10) }),   // what the app passes in code
  settings: z.object({ ... }),                          // what admins change on the Plugins screen
  setup(ctx, options) { /* ctx.route, ctx.tool, ctx.on, ctx.job, ctx.hook, ctx.store, ... */ },
  start(ctx, options) { /* runs before the first request; throw to show the plugin as failed */ },
});
```

`setup` only registers things. Read settings and call the CMS in `start` and in handlers.

**Admin** (`admin.tsx`): `defineAdminPlugin` from `@mainsoft/agent-cms/react`. Give it to the
admin's provider: `<CmsProvider plugins={[statsAdmin]}>`.

```tsx
export default defineAdminPlugin({
  name: "stats",                                   // the server half's name
  label: { en: "Read counts", ko: "읽은 수 통계" },
  pages: { "": StatsPage },                        // /admin/p/stats
  messages: { en: { title: "Read counts" }, ko: { title: "읽은 수 통계" } },
});
```

Inside a page, `useCmsAdmin()` gives the REST client (`client.request("GET", "/stats/summary")`
calls the plugin's own route), the signed-in person (`me`), the language and `toast`.
`usePluginT("stats")` gives the plugin's strings in the admin's language. Use plain elements with
Tailwind classes, as these examples do, and the page fits the admin without a component kit.

The app and the plugin must share one React: `npx @mainsoft/agent-cms doctor` checks it.

## Testing

`@mainsoft/agent-cms/testing` makes a CMS in memory with your plugins, and three people to call it as:

```ts
import { createTestCms } from "@mainsoft/agent-cms/testing";

const t = createTestCms({ plugins: [stats()] });     // one public collection, `pages`, by default
await t.ready();                                      // start the plugins
await t.fetch("/stats/summary", {}, { as: "writer" }); // the HTTP API, as admin (default), writer or anon
await t.tool("stats_summary", {}, { as: "writer" });  // an agent tool → { ok, value } or { ok: false, error }
await t.settings("slack-notify", { webhookUrl });     // save settings as the admin screen does, restart
await t.cron();                                       // schedules, jobs and automations, once
t.client("writer");                                   // the REST client the admin uses
t.errors;                                             // what listeners, jobs and hooks threw
await t.close();
```

Stub the network yourself: `slack-notify` takes a `fetch` option, and its test passes a fake one.

In this repository the examples import the package by name; `npm run test:examples` links the
built package, type-checks this folder and runs every `*/index.test.ts` (CI runs it after
`npm run build`).
