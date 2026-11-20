---
title: "Automations"
summary: "Rules made on a screen: when something happens and the conditions hold, run a list of actions on the next cron call. With run history and a dry run."
order: 18
---
## Usage

```tsx
// app/admin/automations/page.tsx
"use client";
import { CmsAutomations } from "@/components/cms/cms-automations";

export default function Page() {
  return <CmsAutomations />;
}
```

The sidebar shows "Automations" to admins. The list on the left, the form on the right: when, the collection, conditions, actions, and the on/off switch (a new one starts off). "Runs" lists the last runs as Done, Skipped or Failed; they happen on a cron call, so press "Refresh" to see new ones. "Try it" checks one document against the conditions and changes nothing.

"Call an app function" lists the names you gave in `createCms({ automations: { actions } })`.

See [Automations, roles and the dashboard](/docs/automations).

> [!note]
> From 0.13.0.
