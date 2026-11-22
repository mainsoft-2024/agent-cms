// agent-cms registry: cms-empty (0.11.1). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// What an empty collection shows: what goes here and "New document" first,
// then, folded, how to write with an agent instead (the CLI one-liner, the
// MCP URL, a link to make an API key).
"use client";

import * as React from "react";
import { Bot, ChevronDown, FileText, KeyRound, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CodeBox } from "./cms-parts";
import { cmsUrl, useCms } from "./use-cms";

export interface CmsEmptyProps {
  collection: string;
  /** Called by "New document"; hidden when missing or when you cannot write. */
  onNewDocument?: (collection: string) => void;
  /** Where "Create an API key" goes (admins only). */
  keysHref?: string;
  /** Or a callback for it. */
  onCreateKey?: () => void;
  /** Override the icon on top. */
  icon?: React.ReactNode;
  className?: string;
}

export function CmsEmpty({ collection, onNewDocument, keysHref, onCreateKey, icon, className }: CmsEmptyProps) {
  const { t, me, appUrl, baseUrl } = useCms();
  const col = me?.collections.find((c) => c.slug === collection);
  const canWrite = col ? col.canWrite : true;
  const mcp = `${cmsUrl(appUrl, baseUrl)}/mcp`;
  const cli = `npx @mainsoft/agent-cms put ${collection} ./post.md`;
  return (
    <div className={cn("grid flex-1 place-items-center px-4 py-10", className)}>
      <div className="flex w-full max-w-[560px] flex-col items-center gap-2.5 text-center">
        <div aria-hidden className="grid h-11 w-11 place-items-center rounded-xl bg-muted">
          {icon ?? <FileText className="h-5 w-5" />}
        </div>
        <h2 className="font-semibold">{col ? t("empty_title_in", { name: col.label }) : t("empty_title")}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{canWrite ? t("empty_text_writer") : t("empty_text_reader")}</p>
        {onNewDocument && canWrite ? (
          <Button type="button" onClick={() => onNewDocument(collection)} className="mt-1 gap-1.5">
            <Plus aria-hidden className="h-4 w-4" />
            {t("new_document")}
          </Button>
        ) : null}
        {/* For people first; setting up an agent is one click away, not the first thing on the page. */}
        {canWrite ? (
        <details className="group mt-4 w-full rounded-lg border text-left [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-3 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Bot aria-hidden className="h-4 w-4" />
            <span id="cms-empty-agent" className="flex-1">{t("agent_guide")}</span>
            <ChevronDown aria-hidden className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="px-3.5 pb-3.5">
          <p className="mb-2.5 text-xs text-muted-foreground">{t("agent_guide_text")}</p>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">CLI</span>
              <CodeBox value={cli} label="CLI" className="text-left [&>code]:whitespace-normal [&>code]:[overflow-wrap:anywhere]" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">MCP</span>
              <CodeBox value={mcp} label="MCP" />
            </div>
          </div>
          {me?.isAdmin && (keysHref || onCreateKey) ? (
            <div className="mt-3">
              {keysHref ? (
                <a href={keysHref} className={buttonVariants({ variant: "outline", size: "sm", className: "gap-1.5" })}>
                  <KeyRound aria-hidden className="h-4 w-4" />
                  {t("create_api_key")}
                </a>
              ) : (
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onCreateKey}>
                  <KeyRound aria-hidden className="h-4 w-4" />
                  {t("create_api_key")}
                </Button>
              )}
            </div>
          ) : null}
          </div>
        </details>
        ) : null}
      </div>
    </div>
  );
}
