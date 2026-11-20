"use client";

import { CmsTrash } from "@/components/cms/cms-trash";

/** Deleted pages and files, kept for 30 days: restore them or delete them for good. */
export default function TrashPage() {
  return <CmsTrash />;
}
