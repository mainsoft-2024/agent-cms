/**
 * stats: the admin half. A page at /admin/p/stats with the numbers the server half keeps.
 *
 *   import statsAdmin from "./plugins/stats/admin";
 *   <CmsProvider plugins={[statsAdmin]}>…</CmsProvider>
 *
 * Plain elements with Tailwind classes (the admin screens' tokens: `text-muted-foreground`,
 * `border`, `bg-card`), so it needs no component kit of its own.
 */
import * as React from "react";
import { defineAdminPlugin, useCmsAdmin, usePluginT, type PluginPageProps } from "@mainsoft/agent-cms/react";
import type { StatsSummary } from "./index";

export function StatsPage(_props: PluginPageProps) {
  const { client } = useCmsAdmin();
  const t = usePluginT("stats");
  const [data, setData] = React.useState<StatsSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    setError(null);
    client
      .request<StatsSummary>("GET", "/stats/summary")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);
  React.useEffect(load, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <button type="button" onClick={load} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t("reload")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="text-sm text-muted-foreground">{t("loading")}</p> : null}
      {data ? (
        <>
          <div className="rounded-lg border bg-card p-4">
            <div className="text-sm text-muted-foreground">{t("total")}</div>
            <div className="text-3xl font-semibold tabular-nums">{data.total.toLocaleString()}</div>
          </div>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t("top")}</h2>
            {data.top.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("none")}</p>
            ) : (
              <ol className="divide-y rounded-lg border">
                {data.top.map((r) => (
                  <li key={`${r.collection}/${r.slug}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="text-muted-foreground">{r.collection}/</span>
                      {r.slug}
                    </span>
                    <span className="tabular-nums">{t("reads", { n: r.reads })}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {data.unread.length ? (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">{t("unread")}</h2>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {data.unread.map((r) => (
                  <li key={`${r.collection}/${r.slug}`}>
                    {r.collection}/{r.slug}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default defineAdminPlugin({
  name: "stats",
  label: { en: "Read counts", ko: "읽은 수 통계" },
  pages: { "": StatsPage },
  messages: {
    en: { title: "Read counts", reload: "Reload", loading: "Loading…", total: "Reads in all", top: "Most read", none: "Nothing read yet.", reads: "{n} reads", unread: "Published, not read yet" },
    ko: { title: "읽은 수 통계", reload: "새로 고침", loading: "불러오는 중", total: "전체 읽은 수", top: "많이 읽은 문서", none: "아직 읽은 문서 없음", reads: "{n}번", unread: "발행했지만 아직 안 읽음" },
  },
});
