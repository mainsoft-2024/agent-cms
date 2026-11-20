---
title: "Roles"
summary: "Who may write, publish and delete in each collection. People are found by name or added by id."
order: 19
---
## Usage

```tsx
// app/admin/roles/page.tsx
"use client";
import { CmsRoles } from "@/components/cms/cms-roles";

export default function Page() {
  return <CmsRoles />;
}
```

The sidebar shows "Roles" to admins. Each role has a table with one row per collection and a box for Write, Publish and Delete; an operation the collection decides in code shows "Set in code". An admin role hides the table: it may do everything. People are found by name when the app passes `createCms({ users })`, and added by id without it.

See [Automations, roles and the dashboard](/docs/automations).

> [!note]
> From 0.13.0.
