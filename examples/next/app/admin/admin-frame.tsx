"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { lazy, useState, type ReactNode } from "react";
import { CmsCommand } from "@/components/cms/cms-command";
import { ko } from "@/components/cms/cms-messages";
import { CmsShell } from "@/components/cms/cms-shell";
import { CmsProvider } from "@/components/cms/use-cms";

// The block editor is the largest part: loaded only when a document opens.
const CmsBlockEditor = lazy(() => import("@/components/cms/cms-block-editor"));
const slots = { blockEditor: CmsBlockEditor };

/** The admin frame: provider, sidebar (with the app's own screen in extraNav) and ⌘K. */
export function AdminFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const collection = /^\/admin\/([^/]+)/.exec(path)?.[1];
  const lang = useSearchParams().get("lang") === "ko" ? ko : undefined;
  return (
    <CmsProvider baseUrl="/api/cms" messages={lang} slots={slots}>
      <CmsShell
        title="Example"
        activeCollection={collection}
        activeHref={path}
        LinkComponent={Link}
        onSearch={() => setOpen(true)}
        extraNav={[{ label: "Example app", items: [{ label: "Search misses", href: "/admin/misses" }] }]}
      >
        {children}
      </CmsShell>
      <CmsCommand
        open={open}
        onOpenChange={setOpen}
        collection={collection}
        onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)}
        onNewDocument={(c) => router.push(`/admin/${c}/new`)}
        onOpenVersions={(c, s) => router.push(`/admin/${c}/${s}/versions`)}
      />
    </CmsProvider>
  );
}
