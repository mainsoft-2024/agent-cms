// The admin that `npx @mainsoft/agent-cms serve` and `dev` serve: the same
// screens the registry copies into apps, with a small router of its own.
// Built into dist/admin by scripts/build-admin.mjs; the server writes the
// settings below into the page (a JSON script, #agent-cms-settings).
import * as React from "react";
import { createRoot } from "react-dom/client";
import { CmsAccount } from "@/components/cms/cms-account";
import { CmsAudit } from "@/components/cms/cms-audit";
import { CmsAutomations } from "@/components/cms/cms-automations";
import { CmsCommand } from "@/components/cms/cms-command";
import { CmsDashboard } from "@/components/cms/cms-dashboard";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";
import { CmsDocList } from "@/components/cms/cms-doc-list";
import { CmsFiles } from "@/components/cms/cms-files";
import { CmsKeys } from "@/components/cms/cms-keys";
import { CmsInvite, CmsLogin, CmsReset, CmsSetup } from "@/components/cms/cms-login";
import { CmsMedia } from "@/components/cms/cms-media";
import { en, ko } from "@/components/cms/cms-messages";
import { CmsPeople } from "@/components/cms/cms-people";
import { CmsRedirects } from "@/components/cms/cms-redirects";
import { CmsForms, CmsFormEditor, type CmsFormTab } from "@/components/cms/cms-forms";
import { CmsRelease, CmsReleases } from "@/components/cms/cms-releases";
import { CmsRoles } from "@/components/cms/cms-roles";
import { CmsShell } from "@/components/cms/cms-shell";
import { CmsTransfer } from "@/components/cms/cms-transfer";
import { CmsTrash } from "@/components/cms/cms-trash";
import { CmsVersions } from "@/components/cms/cms-versions";
import { CmsWebhooks } from "@/components/cms/cms-webhooks";
import { CmsProvider, useCms } from "@/components/cms/use-cms";

const CmsBlockEditor = React.lazy(() => import("@/components/cms/cms-block-editor"));
const slots = { blockEditor: CmsBlockEditor };

interface Settings {
  basePath: string;
  adminPath: string;
  appName: string;
  locale?: "en" | "ko";
  publicUrl?: string | null;
}
const S: Settings = (() => {
  let given: Partial<Settings> = {};
  try {
    given = JSON.parse(document.getElementById("agent-cms-settings")?.textContent ?? "{}") as Partial<Settings>;
  } catch {
    /* defaults */
  }
  return { basePath: "/api/cms", adminPath: "/admin", appName: "agent-cms", ...given };
})();

function usePath(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = React.useState(() => window.location.pathname + window.location.search);
  React.useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = React.useCallback((to: string, replace = false) => {
    if (/^https?:/.test(to)) return window.location.assign(to);
    // Leaving a page with unsaved edits asks first, as a full page load would.
    const guard = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(guard);
    if (guard.defaultPrevented && !window.confirm(document.documentElement.lang === "ko" ? "저장하지 않은 변경이 있음. 나갈지 확인" : "You have unsaved changes. Leave anyway?")) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", to);
    setPath(to.split("#")[0]);
    if (!to.includes("#")) window.scrollTo(0, 0);
  }, []);
  return [path, go];
}

/** Links inside the admin move without reloading the page. */
function makeLink(go: (to: string) => void) {
  return function Link({ href, onClick, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
    return (
      <a
        href={href}
        {...rest}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === "_blank") return;
          e.preventDefault();
          go(href);
        }}
      />
    );
  };
}

function Home({ go }: { go: (to: string, replace?: boolean) => void }) {
  const { me } = useCms();
  React.useEffect(() => {
    if (!me) return;
    const first = me.collections[0]?.slug;
    go(me.dashboard ? `${S.adminPath}/dashboard` : first ? `${S.adminPath}/${first}` : `${S.adminPath}/account`, true);
  }, [me, go]);
  return null;
}

function Screen({ rest, go }: { rest: string[]; go: (to: string, replace?: boolean) => void }) {
  const { me } = useCms();
  const a = S.adminPath;
  const [p0, p1, p2] = rest.map(decodeURIComponent);
  switch (p0) {
    case undefined:
    case "":
      return <Home go={go} />;
    case "dashboard":
      return <CmsDashboard />;
    case "media":
      return <CmsMedia />;
    case "files":
      return <CmsFiles />;
    case "releases":
      return p1 ? <CmsRelease id={p1} onBack={() => go(`${a}/releases`)} onOpenDocument={(c, s) => go(`${a}/${c}/${s}`)} /> : <CmsReleases hrefFor={(id) => `${a}/releases/${id}`} onOpenRelease={(id) => go(`${a}/releases/${id}`)} />;
    case "trash":
      return <CmsTrash />;
    case "keys":
      return <CmsKeys mcpServerName={S.appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")} />;
    case "audit":
      return <CmsAudit />;
    case "webhooks":
      return <CmsWebhooks />;
    case "automations":
      return <CmsAutomations />;
    case "roles":
      return <CmsRoles />;
    case "transfer":
      return <CmsTransfer />;
    case "people":
      return <CmsPeople />;
    case "redirects":
      return <CmsRedirects />;
    case "forms":
      return p1 ? (
        <CmsFormEditor key={p1} slug={p1} tab={(p2 as CmsFormTab) || "fields"} onTab={(x) => go(`${a}/forms/${encodeURIComponent(p1)}${x === "fields" ? "" : `/${x}`}`, true)} onBack={() => go(`${a}/forms`)} onSlugChange={(s) => go(`${a}/forms/${encodeURIComponent(s)}/settings`, true)} />
      ) : (
        <CmsForms hrefFor={(s) => `${a}/forms/${encodeURIComponent(s)}`} onOpenForm={(s) => go(`${a}/forms/${encodeURIComponent(s)}`)} />
      );
    case "account":
      return <CmsAccount onLocale={() => window.location.reload()} />;
  }
  const c = p0;
  const open = (col: string, s: string) => go(`${a}/${col}/${encodeURIComponent(s)}`);
  // A single (one document): its address opens the editor, there is no list.
  const single = !!me?.collections.find((x) => x.slug === c)?.single;
  if (!p1 && !me) return null;
  if (!p1 && single)
    return <CmsDocEditor key={`${c}/_single`} collection={c} slug="_single" onOpenVersions={(col, s) => go(`${a}/${col}/${encodeURIComponent(s)}/versions`)} onOpenRelease={(id) => go(`${a}/releases/${id}`)} onOpenDocument={open} />;
  if (p1 === "new") return <CmsDocEditor key={`${c}/new`} collection={c} onBack={() => go(`${a}/${c}`)} onCreated={(col, s) => go(`${a}/${col}/${encodeURIComponent(s)}`, true)} />;
  if (p1 && p2 === "versions") return <CmsVersions collection={c} slug={p1} onBack={() => go(`${a}/${c}/${encodeURIComponent(p1)}`)} />;
  if (p1)
    return (
      <CmsDocEditor
        key={`${c}/${p1}`}
        collection={c}
        slug={p1}
        onBack={single ? undefined : () => go(`${a}/${c}`)}
        // Published under a new address: the URL follows, replacing the old one in the history.
        onRenamed={(col, s) => go(`${a}/${col}/${encodeURIComponent(s)}`, true)}
        onOpenVersions={(col, s) => go(`${a}/${col}/${encodeURIComponent(s)}/versions`)}
        onOpenRelease={(id) => go(`${a}/releases/${id}`)}
        onOpenDocument={open}
        publicUrlFor={S.publicUrl ? (col, s) => `${S.publicUrl}/${col}/${s}` : undefined}
      />
    );
  return <CmsDocList key={c} collection={c} hrefFor={(col, s) => `${a}/${col}/${encodeURIComponent(s)}`} onOpenDocument={(col, s) => go(`${a}/${col}/${encodeURIComponent(s)}`)} onNewDocument={(col) => go(`${a}/${col}/new`)} keysHref={`${a}/keys`} />;
}

/** With the CMS's own sign-in: nobody yet → first admin; signed out → sign in, then back here. */
function Gate({ children, go }: { children: React.ReactNode; go: (to: string, replace?: boolean) => void }) {
  const { client } = useCms();
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    client.auth.state().then(
      (st) => {
        const here = window.location.pathname + window.location.search;
        if (st.setup) go(`${S.adminPath}/setup`, true);
        else if (!st.user) go(`${S.adminPath}/login?next=${encodeURIComponent(here)}`, true);
        else setOk(true);
      },
      // No sign-in of the CMS's own (the app signs people in): just show the admin.
      () => setOk(true)
    );
  }, [client, go]);
  return ok ? <>{children}</> : null;
}

function App() {
  const [path, go] = usePath();
  const [search, setSearch] = React.useState(false);
  const Link = React.useMemo(() => makeLink(go), [go]);
  const locale = (() => {
    try {
      return window.localStorage.getItem("cms-locale") ?? S.locale ?? (navigator.language.startsWith("ko") ? "ko" : "en");
    } catch {
      return S.locale ?? "en";
    }
  })();
  const messages = locale === "ko" ? ko : en;
  React.useEffect(() => void (document.documentElement.lang = locale), [locale]);
  const pathname = path.split("?")[0];
  const rest = pathname.slice(S.adminPath.length).split("/").filter(Boolean);
  const next = new URLSearchParams(path.split("?")[1] ?? "").get("next") ?? undefined;
  const signIn = { appName: S.appName, next, onDone: (to: string) => go(to, true) };

  if (["login", "setup", "invite", "reset"].includes(rest[0] ?? ""))
    return (
      <CmsProvider key="sign-in" baseUrl={S.basePath} messages={messages}>
        {rest[0] === "login" ? <CmsLogin {...signIn} /> : rest[0] === "setup" ? <CmsSetup {...signIn} /> : rest[0] === "invite" ? <CmsInvite {...signIn} /> : <CmsReset {...signIn} />}
      </CmsProvider>
    );

  const active = rest[0] && !["dashboard", "media", "files", "releases", "trash", "keys", "audit", "webhooks", "automations", "roles", "transfer", "people", "redirects", "forms", "account"].includes(rest[0]) ? rest[0] : undefined;
  return (
    // A provider of its own: what the person may do is read again after signing in.
    <CmsProvider key="admin" baseUrl={S.basePath} messages={messages} slots={slots}>
      <Gate go={go}>
      <CmsShell title={S.appName} basePath={S.adminPath} activeCollection={active} activeHref={pathname} LinkComponent={Link} onSearch={() => setSearch(true)} onNavigate={go}>
        <React.Suspense fallback={null}>
          <Screen rest={rest} go={go} />
        </React.Suspense>
      </CmsShell>
      <CmsCommand
        open={search}
        onOpenChange={setSearch}
        collection={active}
        onOpenDocument={(c, s) => go(`${S.adminPath}/${c}/${encodeURIComponent(s)}`)}
        onNewDocument={(c) => go(`${S.adminPath}/${c}/new`)}
        onOpenVersions={(c, s) => go(`${S.adminPath}/${c}/${encodeURIComponent(s)}/versions`)}
      />
      </Gate>
    </CmsProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
