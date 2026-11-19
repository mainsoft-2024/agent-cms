"use client";

import { CmsMedia } from "@/components/cms/cms-media";

/** The media library. The sidebar links here only when the deployment has a bucket (lib/cms.ts). */
export default function MediaPage() {
  return <CmsMedia />;
}
