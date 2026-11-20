"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CmsCommand } from "@/components/cms/cms-command";
import { ko } from "@/components/cms/cms-messages";
import { CmsShell } from "@/components/cms/cms-shell";
import { CmsProvider } from "@/components/cms/use-cms";
import { LogoMark } from "@/components/site/logo-mark";

/**
 * The admin: the copied screens as they are, themed only by the site's CSS
 * variables (app/globals.css). The site adds its own links. "Media" and "Files"
 * appear in the sidebar when the deployment has a bucket (lib/cms.ts); "Releases"
 * and "Trash" are there for everyone who may edit.
 */
export function AdminFrame({ children, user }: { children: ReactNode; user: string }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const collection = /^\/admin\/([^/]+)/.exec(path)?.[1];
  const known = collection && !["keys", "audit", "misses", "login", "media", "files", "releases", "trash"].includes(collection) ? collection : undefined;
  const lang = useSearchParams().get("lang") === "ko" ? ko : undefined;
  return (
    <CmsProvider baseUrl="/api/cms" messages={lang}>
      <CmsShell
        title="agent-cms docs"
        logo={<LogoMark className="size-[22px] shrink-0" />}
        activeCollection={known}
        activeHref={path}
        LinkComponent={Link}
        onSearch={() => setOpen(true)}
        extraNav={[
          {
            label: "Site",
            items: [
              { label: "Search misses", href: "/admin/misses" },
              { label: "View site", href: "/" },
              { label: `Sign out (${user})`, href: "/admin/logout" },
            ],
          },
        ]}
      >
        {children}
      </CmsShell>
      <CmsCommand
        open={open}
        onOpenChange={setOpen}
        collection={known}
        onOpenDocument={(c, s) => router.push(`/admin/${c}/${s}`)}
        onNewDocument={(c) => router.push(`/admin/${c}/new`)}
        onOpenVersions={(c, s) => router.push(`/admin/${c}/${s}/versions`)}
      />
    </CmsProvider>
  );
}
