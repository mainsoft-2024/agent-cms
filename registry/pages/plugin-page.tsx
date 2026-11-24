"use client";

// agent-cms registry: cms-plugin-page (0.24.0). The route of admin plugin pages:
// /admin/p/<plugin>/<...path>. Written by `npx @mainsoft/agent-cms add cms-plugin-page`.
import { useParams } from "next/navigation";
import { CmsPluginPage } from "@/components/cms/cms-plugin-page";

export default function PluginPage() {
  const p = useParams<{ plugin: string; path?: string[] }>();
  return <CmsPluginPage plugin={p.plugin} path={p.path ?? []} />;
}
