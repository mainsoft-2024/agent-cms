"use client";

// agent-cms registry: cms-plugins (0.24.0). The route of the plugins screen: /admin/plugins.
// Written by `npx @mainsoft/agent-cms add cms-plugins`.
import { useRouter } from "next/navigation";
import { CmsPlugins } from "@/components/cms/cms-plugins";

export default function PluginsPage() {
  const router = useRouter();
  return <CmsPlugins onOpenPage={(h) => router.push(h)} />;
}
