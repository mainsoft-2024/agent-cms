---
title: "Dashboard"
summary: "Documents by state, changes per day by people and by agents, the most read documents and recent activity."
order: 17
---
## Usage

```tsx
// app/admin/dashboard/page.tsx
"use client";
import { CmsDashboard } from "@/components/cms/cms-dashboard";

export default function Page() {
  return <CmsDashboard />;
}
```

The sidebar shows "Dashboard" to everyone who is signed in. The four cards are the same numbers as the lists; the bars split saved versions into people and agents; the period switches between 7, 14 and 30 days. A caller sees only the collections they may read, and only admins see who did what.

`basePath` (default `/admin`) is where the links to documents point. "Most read" stays empty until your public pages count reads with `cms.recordHits`.

See [Automations, roles and the dashboard](/docs/automations).

> [!note]
> From 0.13.0.
