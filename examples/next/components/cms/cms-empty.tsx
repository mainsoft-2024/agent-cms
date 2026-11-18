// agent-cms registry: cms-empty (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// What an empty collection shows: "New document" and how to write with an
// agent instead (the CLI one-liner, the MCP URL, a link to make an API key).
"use client";

import * as React from "react";
import { Bot, FileText, KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const cli = `npx agent-cms put ${collection} ./post.md`;
  return (
    <div className={cn("grid flex-1 place-items-center px-4 py-10", className)}>
      <div className="flex w-full max-w-[560px] flex-col items-center gap-2.5 text-center">
        <div aria-hidden className="grid h-11 w-11 place-items-center rounded-xl bg-muted">
          {icon ?? <FileText className="h-5 w-5" />}
        </div>
        <h2 className="font-semibold">{t("empty_title")}</h2>
        {onNewDocument && canWrite ? (
          <Button type="button" onClick={() => onNewDocument(collection)} className="gap-1.5">
            <Plus aria-hidden className="h-4 w-4" />
            {t("new_document")}
          </Button>
        ) : null}
        <section aria-labelledby="cms-empty-agent" className="mt-4 w-full rounded-lg border p-3.5 text-left">
          <h3 id="cms-empty-agent" className="mb-2.5 flex items-center gap-2 font-semibold">
            <Bot aria-hidden className="h-4 w-4" />
            {t("agent_guide")}
          </h3>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">CLI</span>
              <CodeBox value={cli} label="CLI" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">MCP</span>
              <CodeBox value={mcp} label="MCP" />
            </div>
          </div>
          {me?.isAdmin && (keysHref || onCreateKey) ? (
            <div className="mt-3">
              {keysHref ? (
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <a href={keysHref}>
                    <KeyRound aria-hidden className="h-4 w-4" />
                    {t("create_api_key")}
                  </a>
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onCreateKey}>
                  <KeyRound aria-hidden className="h-4 w-4" />
                  {t("create_api_key")}
                </Button>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
