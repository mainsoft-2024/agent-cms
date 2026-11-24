// agent-cms registry: cms-plugin-page (0.24.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// The frame of a plugin's admin page (`/admin/p/<plugin>/<...path>`): a header with the
// plugin's name, then the page the admin plugin gives for that path (`defineAdminPlugin({
// pages })`, handed to <CmsProvider plugins>). A page that throws shows an error here and
// leaves the rest of the admin working. `add cms-plugin-page` also writes the Next.js route
// `app/admin/p/[plugin]/[[...path]]/page.tsx`.
"use client";

import * as React from "react";
import { Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { T } from "./cms-messages";
import { EmptyState, PageHeader } from "./cms-parts";
import { useCms } from "./use-cms";

export interface CmsPluginPageProps {
  /** The plugin's name (the `[plugin]` part of the address). */
  plugin: string;
  /** The rest of the address, in parts. */
  path?: string[];
  className?: string;
}

class PageBoundary extends React.Component<{ t: T; children: React.ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error("[agent-cms] plugin page:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { t } = this.props;
    return (
      <EmptyState
        icon={Puzzle}
        title={t("plugin_page_error")}
        text={t("plugin_page_error_text")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
            {t("retry")}
          </Button>
        }
      />
    );
  }
}

export function CmsPluginPage({ plugin, path = [], className }: CmsPluginPageProps) {
  const { t, runtime, locale } = useCms();
  const match = runtime.page(plugin, path);
  const label = runtime.label(plugin, locale);
  const Page = match?.page;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={<bdi>{label}</bdi>} crumbs={[t("nav_plugins")]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {Page ? (
          <PageBoundary key={`${plugin}/${path.join("/")}`} t={t}>
            <Page plugin={plugin} path={path} params={match.params} />
          </PageBoundary>
        ) : (
          <EmptyState icon={Puzzle} title={t("plugin_page_missing")} text={t("plugin_page_missing_text")} />
        )}
      </div>
    </div>
  );
}
