// agent-cms registry: cms-shell (0.13.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The admin layout: a sidebar with the collections you may read, the
// operations screens (API keys, audit log, admins only) and `extraNav`, the
// place for your app's own screens. Under 768px the sidebar opens in a sheet.
"use client";

import { DIALOG, PersonMark } from "./cms-parts";
import * as React from "react";
import { ArrowLeftRight, BookOpen, ChevronsUpDown, ClipboardList, CornerDownRight, Settings2, Keyboard, LogIn, LogOut, Monitor, Moon, Sun, UserCog, Users, FileText, LayoutGrid, Shield, Workflow, HardDrive, Image as ImageIcon, KeyRound, Layers, Puzzle, ScrollText, Search, Trash2, Webhook } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isCmsRemoteError } from "@mainsoft/agent-cms/client";
import { applyTheme, modLabel, ShellNavContext, storedTheme, TRASH_CHANGED, useCms, useShortcut, type CmsTheme } from "./use-cms";

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

export type CmsShellTarget = { kind: "collection"; slug: string } | { kind: "media" } | { kind: "files" } | { kind: "releases" } | { kind: "trash" } | { kind: "keys" } | { kind: "audit" } | { kind: "webhooks" } | { kind: "redirects" } | { kind: "forms" } | { kind: "dashboard" } | { kind: "automations" } | { kind: "roles" } | { kind: "transfer" } | { kind: "plugins" } | { kind: "people" } | { kind: "account" } | { kind: "login" };

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
  /** Go to a page from a keyboard shortcut (g d, g m, g t). Default `window.location.assign`; pass your router's push. */
  onNavigate?: (href: string) => void;
  className?: string;
}

export function CmsShell({ children, title, logo, activeCollection, activeHref, basePath = "/admin", hrefFor, extraNav, onSearch, LinkComponent, renderLink, counts, onNavigate, className }: CmsShellProps) {
  const { t, me, client, meError, reloadMe, runtime, locale } = useCms();
  const [open, setOpen] = React.useState(false);
  const [help, setHelp] = React.useState(false);
  useShortcut("shift+?", () => setHelp(true));
  // "g" then a letter within a second: go to a screen.
  const gAt = React.useRef(0);
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=textbox]")) return;
      const k = e.key.toLowerCase();
      if (k === "g") {
        gAt.current = Date.now();
        return;
      }
      if (Date.now() - gAt.current > 1000) return;
      gAt.current = 0;
      const target = k === "d" && me?.dashboard ? href({ kind: "dashboard" }) : k === "m" && me?.media ? href({ kind: "media" }) : k === "t" ? href({ kind: "trash" }) : null;
      if (!target) return;
      e.preventDefault();
      (onNavigate ?? ((h: string) => window.location.assign(h)))(target);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  });
  const [loaded, setLoaded] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    if (counts || !me) return;
    let live = true;
    void Promise.all(
      me.collections
        .filter((c) => c.canWrite && !c.single)
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

  // Releases and the trash are for people who can change something.
  const editor = !!me?.collections.some((c) => c.canWrite);
  const hasTrash = editor && (me?.trashDays ?? 0) > 0;
  const [inTrash, setInTrash] = React.useState<number | null>(null);
  // Counted once, then again only when a screen says the trash changed (not on every page change).
  const [trashTick, setTrashTick] = React.useState(0);
  React.useEffect(() => {
    const on = () => setTrashTick((n) => n + 1);
    window.addEventListener(TRASH_CHANGED, on);
    return () => window.removeEventListener(TRASH_CHANGED, on);
  }, []);
  React.useEffect(() => {
    if (!hasTrash) return;
    let live = true;
    client.trash().then(
      (r) => live && setInTrash(r.items.length),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [client, hasTrash, trashTick]);

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

  // A link in the phone menu: the menu closes and focus goes to the new page, not back to the menu button.
  const mainRef = React.useRef<HTMLElement>(null);
  const navigated = React.useRef(false);
  const close = () => {
    navigated.current = true;
    setOpen(false);
  };

  // Admin plugins' own entries (their labels follow the admin's language), then the server's
  // (a missing href opens the plugin's page), once per address.
  const pluginNavId = React.useId();
  const pluginNav = React.useMemo(() => {
    const out: { plugin: string; label: string; href: string }[] = [];
    const seen = new Set<string>();
    for (const n of [...runtime.nav({ locale, isAdmin: !!me?.isAdmin }), ...(me?.nav ?? []).map((n) => ({ ...n, href: n.href || runtime.href(n.plugin) }))])
      if (!seen.has(n.href)) (seen.add(n.href), out.push(n));
    return me ? out : [];
  }, [me, runtime, locale]);

  const pluginActive = React.useMemo(() => {
    if (!activeHref) return null;
    if (pluginNav.some((n) => n.href === activeHref)) return activeHref;
    let best: string | null = null;
    for (const n of pluginNav) if (activeHref.startsWith(`${n.href}/`) && (!best || n.href.length > best.length)) best = n.href;
    return best;
  }, [pluginNav, activeHref]);

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
      {me?.dashboard ? (
        <div className="mb-1">
          {link({
            href: href({ kind: "dashboard" }),
            className: navClass(activeHref === href({ kind: "dashboard" })),
            "aria-current": activeHref === href({ kind: "dashboard" }) ? "page" : undefined,
            onClick: close,
            children: (
              <>
                <LayoutGrid aria-hidden className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{t("nav_dashboard")}</span>
              </>
            ),
          })}
        </div>
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
                    {/* A single (one document) opens its editor straight away: a different mark, no count. */}
                    {c.single ? <Settings2 aria-hidden className="h-4 w-4 shrink-0" /> : <BookOpen aria-hidden className="h-4 w-4 shrink-0" />}
                    <bdi className="flex-1 truncate">{c.label}</bdi>
                    {c.single ? <span className="sr-only">{` (${t("single_badge")})`}</span> : shown[c.slug] !== undefined ? <span className="text-xs tabular-nums text-muted-foreground">{shown[c.slug]}</span> : null}
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>
      {me?.media ? (
        <ul className="mt-3 flex flex-col gap-0.5">
          <li>
            {link({
              href: href({ kind: "media" }),
              className: navClass(activeHref === href({ kind: "media" })),
              "aria-current": activeHref === href({ kind: "media" }) ? "page" : undefined,
              onClick: close,
              children: (
                <>
                  <ImageIcon aria-hidden className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{t("nav_media")}</span>
                </>
              ),
            })}
          </li>
          {me.media.stores.some((s) => s.can.browse) ? (
            <li>
              {link({
                href: href({ kind: "files" }),
                className: navClass(activeHref === href({ kind: "files" })),
                "aria-current": activeHref === href({ kind: "files" }) ? "page" : undefined,
                onClick: close,
                children: (
                  <>
                    <HardDrive aria-hidden className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{t("nav_files")}</span>
                  </>
                ),
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
      {editor ? (
        <ul className={cn("flex flex-col gap-0.5", me?.media ? "mt-0.5" : "mt-3")}>
          {(
            [
              { kind: "releases", label: t("nav_releases"), Icon: Layers, n: null, show: true },
              { kind: "forms", label: t("nav_forms"), Icon: ClipboardList, n: null, show: !!me?.forms },
              { kind: "trash", label: t("nav_trash"), Icon: Trash2, n: inTrash, show: hasTrash },
            ] as const
          )
            .filter((x) => x.show)
            .map(({ kind, label, Icon, n }) => {
              const h = href({ kind });
              const active = activeHref === h || ((kind === "releases" || kind === "forms") && !!activeHref?.startsWith(`${h}/`));
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
                        {n ? <span className="text-xs tabular-nums text-muted-foreground">{n}</span> : null}
                      </>
                    ),
                  })}
                </li>
              );
            })}
        </ul>
      ) : null}
      {me?.isAdmin ? (
        <>
          <h2 className="px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground">{t("nav_ops")}</h2>
          <ul className="flex flex-col gap-0.5">
            {(
              [
                { kind: "keys", label: t("nav_keys"), Icon: KeyRound },
                { kind: "audit", label: t("nav_audit"), Icon: ScrollText },
                ...(me.webhooks ? [{ kind: "webhooks", label: t("nav_webhooks"), Icon: Webhook } as const] : []),
                ...(me.automations ? [{ kind: "automations", label: t("nav_automations"), Icon: Workflow } as const] : []),
                ...(me.auth?.people ? [{ kind: "people", label: t("nav_people"), Icon: Users } as const] : []),
                ...(me.roles ? [{ kind: "roles", label: t("nav_roles"), Icon: Shield } as const] : []),
                ...(me.redirects ? [{ kind: "redirects", label: t("nav_redirects"), Icon: CornerDownRight } as const] : []),
                ...(me.roles ? [{ kind: "transfer", label: t("nav_transfer"), Icon: ArrowLeftRight } as const] : []),
                // 0.24.0: the plugins screen, with how many failed to start.
                { kind: "plugins", label: t("nav_plugin_list"), Icon: Puzzle, failed: me.pluginsFailed ?? 0 },
              ] as const
            ).map(({ kind, label, Icon, ...rest }) => {
              const failed = "failed" in rest ? rest.failed : 0;
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
                        {failed ? (
                          <span className="rounded-full bg-destructive px-1.5 text-xs font-medium tabular-nums text-destructive-foreground">
                            {failed}
                            <span className="sr-only">{` ${t("plugins_failed_badge")}`}</span>
                          </span>
                        ) : null}
                      </>
                    ),
                  })}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {/* What plugins add: the server's `ctx.nav()` and admin plugins' pages, after the CMS's own entries. */}
      {pluginNav.length ? (
        <>
          <h2 id={pluginNavId} className="px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground">{t("nav_plugins")}</h2>
          <ul aria-labelledby={pluginNavId} className="flex flex-col gap-0.5">
            {pluginNav.map((n) => {
              // One current entry: the exact address, else the longest one the page is under.
              const active = n.href === pluginActive;
              return (
                <li key={n.plugin + n.href}>
                  {link({
                    href: n.href,
                    className: navClass(active),
                    "aria-current": active ? "page" : undefined,
                    onClick: close,
                    children: (
                      <>
                        <Puzzle aria-hidden className="h-4 w-4 shrink-0" />
                        <bdi className="flex-1 truncate">{n.label}</bdi>
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
                        <bdi className="flex-1 truncate">{it.label}</bdi>
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
  const go = onNavigate ?? ((h: string) => window.location.assign(h));
  // Signed out (or the session ended): to the sign-in page when the CMS has one.
  // With the CMS's own sign-in, an answer for nobody in particular also means signed out.
  const signedOut = (isCmsRemoteError(meError) && (meError.status === 401 || meError.code === "unauthorized")) || (!!me?.auth && me.actor.kind !== "user" && me.actor.kind !== "key");
  const loginHref = `${hrefFor?.({ kind: "login" }) ?? `${basePath}/login`}?next=${encodeURIComponent(typeof window === "undefined" ? basePath : window.location.pathname + window.location.search)}`;
  const [theme, setTheme] = React.useState<CmsTheme>("system");
  React.useEffect(() => setTheme(storedTheme()), []);
  const pickTheme = (v: CmsTheme) => {
    setTheme(v);
    applyTheme(v);
    if (me?.auth) void client.auth.updateAccount({ prefs: { theme: v } }).catch(() => undefined);
  };
  const actor = me?.actor as { kind: string; id?: string | null; label?: string; email?: string | null } | undefined;
  const user = actor?.kind === "user" ? { id: actor.id ?? "me", label: actor.label || actor.email || t("account_title"), email: actor.email ?? null } : null;
  const account = user ? (
    // Opaque and flush with the bottom edge: nothing in the sidebar shows through or under it.
    <div data-cms-account className="sticky bottom-0 z-10 -mx-3 mt-auto bg-background">
      <div className="border-t bg-muted/30 px-3 pb-3 pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("account_menu", { name: user.label })}>
            <PersonMark id={user.id} label={user.label} />
            <span className="flex min-w-0 flex-1 flex-col">
              <bdi className="truncate font-medium">{user.label}</bdi>
              {user.email ? <span className="truncate text-xs text-muted-foreground">{user.email}</span> : null}
            </span>
            <ChevronsUpDown aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          {me?.auth ? (
            <DropdownMenuItem onClick={() => (close(), go(href({ kind: "account" })))}>
              <UserCog aria-hidden className="mr-2 h-4 w-4" />
              {t("account_title")}
            </DropdownMenuItem>
          ) : null}
          {/* A label must sit inside a group (Base UI throws otherwise). */}
          <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("account_theme")}</DropdownMenuLabel>
          {(
            [
              ["light", Sun, t("theme_light")],
              ["dark", Moon, t("theme_dark")],
              ["system", Monitor, t("theme_system")],
            ] as const
          ).map(([v, Icon, label]) => (
            <DropdownMenuItem key={v} onClick={() => pickTheme(v)} aria-checked={theme === v} role="menuitemradio">
              <Icon aria-hidden className="mr-2 h-4 w-4" />
              <span className="flex-1">{label}</span>
              {theme === v ? <span aria-hidden className="text-xs">✓</span> : null}
            </DropdownMenuItem>
          ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setHelp(true)}>
            <Keyboard aria-hidden className="mr-2 h-4 w-4" />
            {t("shortcuts")}
          </DropdownMenuItem>
          {me?.auth ? (
            <DropdownMenuItem
              onClick={() =>
                void client.auth.logout().then(
                  () => window.location.assign(`${hrefFor?.({ kind: "login" }) ?? `${basePath}/login`}`),
                  () => window.location.reload()
                )
              }
            >
              <LogOut aria-hidden className="mr-2 h-4 w-4" />
              {t("account_sign_out")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </div>
  ) : null;

  if (signedOut)
    return (
      <div className="cms-root grid min-h-screen place-items-center bg-muted/40 px-4">
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border bg-background p-8 text-center shadow-sm">
          <LogIn aria-hidden className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("shell_signed_out")}</h1>
          <p className="text-sm text-muted-foreground">{t("shell_signed_out_text")}</p>
          <a href={loginHref} className="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            {t("auth_sign_in")}
          </a>
        </div>
      </div>
    );

  return (
    <ShellNavContext.Provider value={navCtx}>
      {/* cms-root: where the admin fonts apply (cms-fonts.css, 0.22.2). */}
      <div className={cn("cms-root flex min-h-screen bg-background text-foreground", className)}>
        <aside className={cn("sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r bg-muted/30 px-3 pt-3 md:flex", user ? "pb-0" : "pb-3")}>
          {brand}
          {nav}
          {!me && !meError ? (
            <ul aria-hidden className="flex flex-col gap-1.5 px-2 pt-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <li key={i} className="h-6 animate-pulse rounded bg-muted" />
              ))}
            </ul>
          ) : null}
          {meError && !signedOut ? (
            <div className="flex flex-col items-start gap-2 px-2 pt-3 text-xs text-destructive">
              {t("shell_me_failed")}
              <button type="button" className="rounded border px-2 py-1 text-foreground hover:bg-accent" onClick={reloadMe}>
                {t("retry")}
              </button>
            </div>
          ) : null}
          {account}
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="left"
            className={cn("flex w-[min(18rem,85vw)] flex-col overflow-y-auto px-3 pt-3", user ? "pb-0" : "pb-3")}
            {...({
              // Radix sheets: where focus goes when the sheet closes.
              onCloseAutoFocus: (e: Event) => {
                if (!navigated.current) return;
                navigated.current = false;
                e.preventDefault();
                const h = mainRef.current?.querySelector<HTMLElement>("h1");
                if (h && !h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
                (h ?? mainRef.current)?.focus({ preventScroll: true });
              },
            } as object)}
          >
            <SheetTitle className="sr-only">{t("menu")}</SheetTitle>
            <SheetDescription className="sr-only">{t("nav_label")}</SheetDescription>
            {brand}
            {nav}
            {account}
          </SheetContent>
        </Sheet>
        <main ref={mainRef} tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          {children}
        </main>
      </div>
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </ShellNavContext.Provider>
  );
}

/** Every shortcut the admin knows, in one place (opened with "?"). */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useCms();
  const mod = modLabel();
  const groups: { title: string; rows: [string[], string][] }[] = [
    {
      title: t("sc_group_global"),
      rows: [
        [["?"], t("sc_help")],
        [[mod, "K"], t("sc_search")],
        [["G", "D"], t("sc_go_dashboard")],
        [["G", "M"], t("sc_go_media")],
        [["G", "T"], t("sc_go_trash")],
        [["Esc"], t("sc_escape")],
      ],
    },
    {
      title: t("sc_group_list"),
      rows: [
        [["/"], t("sc_find")],
        [["N"], t("sc_new")],
        [[mod, "A"], t("sc_select_all")],
      ],
    },
    {
      title: t("sc_group_editor"),
      rows: [
        [[mod, "S"], t("sc_save")],
        [[mod, "Shift", "P"], t("sc_publish")],
        [[mod, "Shift", "F"], t("sc_focus")],
        [[mod, "B"], t("sc_bold")],
        [[mod, "I"], t("sc_italic")],
        [[mod, "K"], t("sc_link")],
        [["/"], t("sc_slash")],
      ],
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG.lg}>
        <DialogHeader>
          <DialogTitle>{t("shortcuts")}</DialogTitle>
          <DialogDescription>{t("shortcuts_hint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g.title} className={g.rows.length > 4 ? "sm:col-span-2" : undefined}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{g.title}</h3>
              <dl className={cn("grid gap-1.5 text-sm", g.rows.length > 4 && "sm:grid-cols-2 sm:gap-x-6")}>
                {g.rows.map(([keys, label]) => (
                  <div key={label + keys.join()} className="flex items-center justify-between gap-3">
                    <dt className="text-foreground/80">{label}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {keys.map((k) => (
                        <kbd key={k} className="min-w-6 rounded border border-b-2 bg-muted px-1.5 text-center font-mono text-[11px] leading-5">
                          {k}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
