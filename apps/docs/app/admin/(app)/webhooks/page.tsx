"use client";

import { CmsWebhooks } from "@/components/cms/cms-webhooks";

/** Webhooks: where the site tells other services that something was published. Needs CMS_SECRETS_KEY. */
export default function WebhooksPage() {
  return <CmsWebhooks />;
}
