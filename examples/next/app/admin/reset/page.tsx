"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CmsReset } from "@/components/cms/cms-login";

export default function Page() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? undefined;
  return <CmsReset appName="Example" next={next} onDone={(to) => router.replace(to)} />;
}
