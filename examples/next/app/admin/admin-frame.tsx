"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { lazy, useState, type ReactNode } from "react";
import { CmsCommand } from "@/components/cms/cms-command";
import { ko } from "@/components/cms/cms-messages";
import { CmsShell } from "@/components/cms/cms-shell";
import { CmsProvider } from "@/components/cms/use-cms";
import { countsAdmin } from "./counts-admin";

// The block editor is the largest part: loaded only when a document opens.
const CmsBlockEditor = lazy(() => import("@/components/cms/cms-block-editor"));
const slots = { blockEditor: CmsBlockEditor };
// 0.24.0: admin plugins (their pages open under /admin/p/<name>). Defined once, outside the component.
const plugins = [countsAdmin];

/** The admin frame: provider, sidebar (with the app's own screen in extraNav) and ⌘K. */
export function AdminFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const collection = /^\/admin\/([^/]+)/.exec(path)?.[1];
  const lang = useSearchParams().get("lang") === "ko" ? ko : undefined;
  // The sign-in pages stand alone, without the sidebar.
  if (/^\/admin\/(login|setup|invite|reset)(\/|$)/.test(path))
    return (
      <CmsProvider key="sign-in" baseUrl="/api/cms" messages={lang}>
        {children}
      </CmsProvider>
    );
  return (
    <CmsProvider baseUrl="/api/cms" messages={lang} slots={slots} plugins={plugins}>
      <CmsShell
        title="Example"
        activeCollection={collection}
        activeHref={path}
        LinkComponent={Link}
        onNavigate={(h) => router.push(h)}
        onSearch={() => setOpen(true)}
        extraNav={[{ label: "Example app", items: [{ label: "Search misses", href: "/admin/misses" }] }]}
      >
        {children}
      </CmsShell>
      <CmsCommand
        open={open}
        onOpenChange={setOpen}
        collection={collection}
        onOpenDocument={(c, s) => router.push(`/admin/${c}/${encodeURIComponent(s)}`)}
        onNewDocument={(c) => router.push(`/admin/${c}/new`)}
        onOpenVersions={(c, s) => router.push(`/admin/${c}/${encodeURIComponent(s)}/versions`)}
      />
    </CmsProvider>
  );
}
