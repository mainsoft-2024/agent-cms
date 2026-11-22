"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CmsSetup } from "@/components/cms/cms-login";

export default function Page() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? undefined;
  return <CmsSetup appName="Example" next={next} onDone={(to) => router.replace(to)} />;
}
