---
title: "Webhooks"
summary: "Webhooks with their events and state. For each one: a test delivery, the signing secret, the delivery history with Send again, edit and delete."
order: 16
---
## Usage

```tsx
// app/admin/webhooks/page.tsx
"use client";
import { CmsWebhooks } from "@/components/cms/cms-webhooks";

export default function WebhooksPage() {
  return <CmsWebhooks />;
}
```

The sidebar shows "Webhooks" to admins once `secretsKey` is set in `createCms`; without it the screen says what is missing. A row shows the state: Working, the count of failed deliveries in a row, or Off. Press a name to open its panel. A webhook the CMS switched off after 20 failures shows the reason and "Turn on".

Deliveries go out with the cron call, so "Send again" queues the event for the next one. "Send a test" sends a `ping` right away.

See [Webhooks, jobs and plugins](/docs/webhooks) for the events, the payload and the receiver's `verifyWebhook`.

> [!note]
> From 0.12.0.
