// agent-cms registry: cms-shell (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The admin layout: a sidebar with the collections you may read, the
// operations screens (API keys, audit log, admins only) and `extraNav`, the
// place for your app's own screens. Under 768px the sidebar opens in a sheet.
"use client";

import * as React from "react";
import { BookOpen, KeyRound, ScrollText, Search, FileText } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ShellNavContext, useCms } from "./use-cms";

export interface CmsNavItem {
  label: string;
  href: string;
  badge?: React.ReactNode;
  icon?: React.ReactNode;
}

export interface CmsNavGroup {
  label: string;
  items: CmsNavItem[];
}

export interface CmsLinkProps {
  href: string;
  className?: string;
  children: React.ReactNode;
  "aria-current"?: "page" | undefined;
  onClick?: () => void;
}

export type CmsShellTarget = { kind: "collection"; slug: string } | { kind: "keys" } | { kind: "audit" };

export interface CmsShellProps {
  children?: React.ReactNode;
  /** Brand text on top of the sidebar. Default "Admin". */
  title?: React.ReactNode;
  /** Brand mark (logo) before the title. */
  logo?: React.ReactNode;
  /** The collection shown now (highlighted). */
  activeCollection?: string;
  /** The current path; highlights the ops or `extraNav` link with this href. */
  activeHref?: string;
  /** Where the admin pages live, for the default links. Default "/admin". */
  basePath?: string;
  /** Override the link of a sidebar entry. Default `${basePath}/<collection>`, `${basePath}/keys`, `${basePath}/audit`. */
  hrefFor?: (target: CmsShellTarget) => string;
  /** Your app's own screens, shown under the operations section. */
  extraNav?: CmsNavGroup[];
  /** Show the search button (pair it with <CmsCommand>). */
  onSearch?: () => void;
  /** Render links with your router, e.g. `LinkComponent={Link}` from next/link. Default `<a>`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LinkComponent?: React.ComponentType<CmsLinkProps> | React.ComponentType<any>;
  /** Full control over links (wins over LinkComponent). */
  renderLink?: (props: CmsLinkProps) => React.ReactNode;
  /** Item counts beside collections; default: the "all" count from `counts()` for collections you can edit. */
  counts?: Record<string, number>;
  className?: string;
}

export function CmsShell({ children, title, logo, activeCollection, activeHref, basePath = "/admin", hrefFor, extraNav, onSearch, LinkComponent, renderLink, counts, className }: CmsShellProps) {
  const { t, me, client } = useCms();
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    if (counts || !me) return;
    let live = true;
    void Promise.all(
      me.collections
        .filter((c) => c.canWrite)
        .map((c) =>
          client.counts(c.slug).then(
            (n) => [c.slug, n.all] as const,
            () => null
          )
        )
    ).then((rows) => {
      if (live) setLoaded(Object.fromEntries(rows.filter((r): r is readonly [string, number] => !!r)));
    });
    return () => {
      live = false;
    };
  }, [client, me, counts]);
  const shown = counts ?? loaded;

  const href = (target: CmsShellTarget) =>
    hrefFor?.(target) ?? (target.kind === "collection" ? `${basePath}/${encodeURIComponent(target.slug)}` : `${basePath}/${target.kind}`);

  const link = (p: CmsLinkProps) => {
    if (renderLink) return renderLink(p);
    const L = LinkComponent;
    if (L) return <L {...p} />;
    return (
      <a href={p.href} className={p.className} aria-current={p["aria-current"]} onClick={p.onClick}>
        {p.children}
      </a>
    );
  };

  const navClass = (active: boolean) =>
    cn(
      "flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground/80 outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
      active && "bg-accent font-medium text-accent-foreground"
    );

  const close = () => setOpen(false);

  const nav = (
    <nav aria-label={t("nav_label")} className="flex flex-col gap-0.5 text-sm">
      {onSearch ? (
        <button
          type="button"
          onClick={() => {
            close();
            onSearch();
          }}
          className="mb-3 flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search aria-hidden className="h-4 w-4" />
          <span className="flex-1 text-left">{t("search")}</span>
          <kbd className="rounded border border-b-2 px-1 font-mono text-[11px]">⌘K</kbd>
        </button>
      ) : null}
      <h2 className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{t("nav_collections")}</h2>
      <ul className="flex flex-col gap-0.5">
        {(me?.collections ?? []).map((c) => {
          const active = c.slug === activeCollection;
          return (
            <li key={c.slug}>
              {link({
                href: href({ kind: "collection", slug: c.slug }),
                className: navClass(active),
                "aria-current": active ? "page" : undefined,
                onClick: close,
                children: (
                  <>
                    <BookOpen aria-hidden className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{c.label}</span>
                    {shown[c.slug] !== undefined ? <span className="text-xs tabular-nums text-muted-foreground">{shown[c.slug]}</span> : null}
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>
      {me?.isAdmin ? (
        <>
          <h2 className="px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground">{t("nav_ops")}</h2>
          <ul className="flex flex-col gap-0.5">
            {(
              [
                { kind: "keys", label: t("nav_keys"), Icon: KeyRound },
                { kind: "audit", label: t("nav_audit"), Icon: ScrollText },
              ] as const
            ).map(({ kind, label, Icon }) => {
              const h = href({ kind });
              const active = activeHref === h;
              return (
                <li key={kind}>
                  {link({
                    href: h,
                    className: navClass(active),
                    "aria-current": active ? "page" : undefined,
                    onClick: close,
                    children: (
                      <>
                        <Icon aria-hidden className="h-4 w-4 shrink-0" />
                        <span className="flex-1 truncate">{label}</span>
                      </>
                    ),
                  })}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {(extraNav ?? []).map((g, gi) => (
        <div key={gi} data-cms-extra-nav="">
          <h2 className="px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground">{g.label}</h2>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((it) => {
              const active = activeHref === it.href;
              return (
                <li key={it.href}>
                  {link({
                    href: it.href,
                    className: navClass(active),
                    "aria-current": active ? "page" : undefined,
                    onClick: close,
                    children: (
                      <>
                        {it.icon ?? <FileText aria-hidden className="h-4 w-4 shrink-0" />}
                        <span className="flex-1 truncate">{it.label}</span>
                        {it.badge !== undefined && it.badge !== null ? <span className="text-xs tabular-nums text-muted-foreground">{it.badge}</span> : null}
                      </>
                    ),
                  })}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <div className="mb-4 flex items-center gap-2 px-2 font-semibold">
      {logo}
      <span className="truncate">{title ?? t("shell_title")}</span>
    </div>
  );

  const navCtx = React.useMemo(() => ({ openNav: () => setOpen(true) }), []);

  return (
    <ShellNavContext.Provider value={navCtx}>
      <div className={cn("flex min-h-screen bg-background text-foreground", className)}>
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-r bg-muted/30 p-3 md:block">
          {brand}
          {nav}
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 overflow-y-auto p-3">
            <SheetTitle className="sr-only">{t("menu")}</SheetTitle>
            <SheetDescription className="sr-only">{t("nav_label")}</SheetDescription>
            {brand}
            {nav}
          </SheetContent>
        </Sheet>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </ShellNavContext.Provider>
  );
}
