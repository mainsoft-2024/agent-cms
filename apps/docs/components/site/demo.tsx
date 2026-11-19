"use client";

import { useState } from "react";
import { CmsAudit } from "@/components/cms/cms-audit";
import { CmsCommand } from "@/components/cms/cms-command";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";
import { CmsDocList } from "@/components/cms/cms-doc-list";
import { CmsEmpty } from "@/components/cms/cms-empty";
import { CmsKeys } from "@/components/cms/cms-keys";
import { CmsShell } from "@/components/cms/cms-shell";
import { CmsVersions } from "@/components/cms/cms-versions";
import { CmsProvider } from "@/components/cms/use-cms";

type View = { v: "list" } | { v: "edit"; slug?: string } | { v: "versions"; slug: string } | { v: "keys" } | { v: "audit" };

/** The screens wired to the demo CMS (/api/demo), with a small in-frame router. */
function Screens({ item, view, go }: { item: string; view: View; go: (v: View) => void }) {
  const list = <CmsDocList collection="posts" onOpenDocument={(_c, s) => go({ v: "edit", slug: s })} onNewDocument={() => go({ v: "edit" })} />;
  const editor = (slug?: string) => <CmsDocEditor collection="posts" slug={slug} onBack={() => go({ v: "list" })} onCreated={(_c, s) => go({ v: "edit", slug: s })} onOpenVersions={(_c, s) => go({ v: "versions", slug: s })} publicUrlFor={() => ""} />;
  const routed = () => {
    if (view.v === "edit") return editor(view.slug);
    if (view.v === "versions") return <CmsVersions collection="posts" slug={view.slug} onBack={() => go({ v: "edit", slug: view.slug })} />;
    if (view.v === "keys") return <CmsKeys mcpServerName="agent-cms-demo" />;
    if (view.v === "audit") return <CmsAudit />;
    return list;
  };
  switch (item) {
    case "cms-shell":
      return (
        <CmsShell
          title="Demo admin"
          activeCollection={view.v === "keys" || view.v === "audit" ? undefined : "posts"}
          activeHref={view.v === "keys" ? "/keys" : view.v === "audit" ? "/audit" : "/posts"}
          LinkComponent={({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
            <a
              {...rest}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                go(href.endsWith("keys") ? { v: "keys" } : href.endsWith("audit") ? { v: "audit" } : { v: "list" });
              }}
            >
              {children}
            </a>
          )}
          basePath=""
        >
          {routed()}
        </CmsShell>
      );
    case "cms-empty":
      return <CmsEmpty collection="posts" onNewDocument={() => undefined} keysHref="#" />;
    case "cms-doc-list":
      return view.v === "list" ? list : routed();
    case "cms-doc-editor":
      return view.v === "versions" ? routed() : editor(view.v === "edit" ? (view.slug ?? "install-guide") : "install-guide");
    case "cms-versions":
      return <CmsVersions collection="posts" slug="install-guide" />;
    case "cms-keys":
      return <CmsKeys mcpServerName="agent-cms-demo" />;
    case "cms-audit":
      return <CmsAudit />;
    default:
      return null;
  }
}

export function LiveDemo({ item }: { item: string }) {
  const [theme, setTheme] = useState<"site" | "shadcn">("site");
  const [width, setWidth] = useState<"full" | "phone">("full");
  const [view, setView] = useState<View>({ v: "list" });
  const [cmd, setCmd] = useState(false);
  const seg = (on: boolean) => `rounded-[4px] px-2.5 py-1 ${on ? "bg-black text-white" : "text-[var(--pencil-gray)]"}`;
  return (
    <section aria-label="Live demo" className="site-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-4 py-2.5 text-[13px]">
        <span className="label-mono">Live demo</span>
        <div role="group" aria-label="Theme" className="flex gap-0.5 rounded-[6px] bg-[var(--drafting-gray)] p-0.5">
          <button type="button" aria-pressed={theme === "site"} className={seg(theme === "site")} onClick={() => setTheme("site")}>
            This site
          </button>
          <button type="button" aria-pressed={theme === "shadcn"} className={seg(theme === "shadcn")} onClick={() => setTheme("shadcn")}>
            shadcn default
          </button>
        </div>
        <div role="group" aria-label="Width" className="flex gap-0.5 rounded-[6px] bg-[var(--drafting-gray)] p-0.5">
          <button type="button" aria-pressed={width === "full"} className={seg(width === "full")} onClick={() => setWidth("full")}>
            Desktop
          </button>
          <button type="button" aria-pressed={width === "phone"} className={seg(width === "phone")} onClick={() => setWidth("phone")}>
            Phone
          </button>
        </div>
        <span className="flex-1" />
        <span className="text-[12px] text-[var(--pencil-gray)]">Runs on a demo database that resets every 30 minutes.</span>
      </div>
      <div className="bg-[var(--drafting-gray)] p-3">
        <div className={`${theme === "shadcn" ? "theme-shadcn" : ""} mx-auto h-[640px] overflow-auto rounded-[8px] bg-background text-foreground shadow-[var(--hair)] ${width === "phone" ? "max-w-[390px]" : ""}`} style={{ containerType: "inline-size" }}>
          <CmsProvider baseUrl="/api/demo">
            {item === "cms-command" ? (
              <div className="grid h-full place-items-center">
                <button type="button" className="btn btn-primary" onClick={() => setCmd(true)}>
                  Open the command menu
                </button>
                <CmsCommand open={cmd} onOpenChange={setCmd} onOpenDocument={() => setCmd(false)} onNewDocument={() => setCmd(false)} />
              </div>
            ) : (
              <Screens item={item} view={view} go={setView} />
            )}
          </CmsProvider>
        </div>
      </div>
    </section>
  );
}
