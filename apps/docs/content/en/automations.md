---
title: Automations, roles and the dashboard
summary: Rules that run after something happens, who may write and publish in each collection, and the numbers of your content on one screen.
category: Guides
order: 10
---
> [!note]
> From 0.13.0. Coming from an older version? Read [Upgrade to 0.13](/docs/upgrade-0-13) first.

## Automations

An automation is a rule an admin makes on a screen: **when** something happens, **if** some conditions hold, **do** a list of actions.

| Part | Choices |
|---|---|
| When | A document is created, updated, published, unpublished or deleted. A review is asked for. A file is uploaded. Every day. Every Monday. |
| If | `category`, `actor` (`person` or `agent`), `title`, or a field such as `fields.tags`: is, is not, contains, is empty, is not empty |
| Do | Send a webhook. Add a keyword. Set a field. Put the document into a release. Call a function of your app. |

```ts
createCms({
  cronSecret: process.env.CRON_SECRET,        // automations run with the cron call
  automations: {
    actions: {
      // "Call an app function" on the screen lists these names.
      notifySales: async ({ automation, doc, event }) => {
        await slack.send(`${automation.name}: ${doc?.title}`);
      },
    },
  },
});
```

How they run:

- An event that matches becomes a background job. The work happens on the next `POST /_cron`, not inside the request that caused it. Without a cron service: `npx @mainsoft/agent-cms cron --watch`.
- What an automation changes is saved as a new version by "automation: <name>", so the history shows it.
- A change made by an automation never starts another automation.
- Each run is kept for 30 days as Done, Skipped (the conditions did not hold) or Failed, with a line per action.
- A new automation made on the screen starts switched off. One made through the API is on unless you send `enabled: false`.

"Try it" on the screen, or `POST /automations/:id/test` with `{ collection, slug }`, checks one document against the conditions and lists the actions that would run. Nothing is changed.

```sh
curl -X POST https://app.example.com/api/cms/automations \
  -H "authorization: Bearer $AGENT_CMS_KEY" -H "content-type: application/json" \
  -d '{"name":"News keyword","trigger":{"event":"doc.published","collection":"posts"},
       "conditions":[{"field":"category","op":"is","value":"News"}],
       "actions":[{"type":"add_keyword","name":"news"}]}'
```

Only admins (or a key with the `admin` scope) can make automations, and no agent tool makes one.

## Roles

A role says, for each collection, whether its people may **write**, **publish** and **delete**. An admin role may do everything, including keys, webhooks, automations and roles.

The CMS decides in this order:

1. The system (cron, automations).
2. The collection's own `access` functions in code. When code decides an operation, the roles screen shows "Set in code" and cannot change it.
3. Roles.
4. The default: admins only.

An app that never makes a role behaves exactly as it did before 0.13.

People are put into a role by the id your `resolveUser` returns. To let the screen find them by name:

```ts
createCms({
  users: {
    search: async (q) => (await findUsers(q)).map((u) => ({ id: u.id, label: u.name })),
    get: async (id) => { const u = await findUser(id); return u ? { id: u.id, label: u.name } : null; },
  },
});
```

Without `users` a person is added by typing their id. A role name can be used once; the second one answers `name_taken`. You cannot delete, leave, or take the admin box off the role that makes you an admin (`role_last_admin`): it would lock you out of this screen.

API keys are outside roles: a key has its own scopes and collections.

## The dashboard

`GET /_stats?days=7|14|30` and the `cms-dashboard` screen:

- **Documents, Published, Waiting for review, Scheduled**: the same numbers as the lists.
- **Changes**: versions saved per day, split into people and agents.
- **Most read**: needs hit counting (`cms.recordHits`, see [Search](/docs/search)).
- **Recent activity**: publishes, schedules, deletes, reviews, uploads.

A caller sees only collections they may read, and only admins see who did what.
