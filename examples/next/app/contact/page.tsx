"use client";

import { CmsForm } from "@/components/cms/cms-form";

// A form built on /admin/forms with the address "contact" (make one there first).
export default function ContactPage() {
  return (
    <main className="mx-auto max-w-xl p-6 sm:p-8">
      <CmsForm slug="contact" />
    </main>
  );
}
