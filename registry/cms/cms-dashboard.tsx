// agent-cms registry: cms-dashboard (0.13.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// The first screen: documents by state, changes per day by people and by agents,
// the most read documents and the latest activity, for 7, 14 or 30 days.
"use client";

import * as React from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { PageHeader, Segmented, StatusText } from "./cms-parts";
import { formatDate, relativeTime, useAsync, useCms } from "./use-cms";

export interface CmsDashboardProps {
  /** Where the admin pages live, for links to documents. Default "/admin". */
  basePath?: string;
  /** Link of a document. Default `${basePath}/<collection>/<slug>`. */
  docHref?: (collection: string, slug: string) => string;
  className?: string;
}

export function CmsDashboard({ basePath = "/admin", docHref, className }: CmsDashboardProps) {
  const { client, t, locale } = useCms();
  const [days, setDays] = React.useState<"7" | "14" | "30">("14");
  const stats = useAsync(() => client.stats(Number(days)), [client, days]);
  const s = stats.data;
  const href = (c: string, slug: string) => docHref?.(c, slug) ?? `${basePath}/${encodeURIComponent(c)}/${encodeURIComponent(slug)}`;
  const max = Math.max(1, ...(s?.changes ?? []).map((c) => c.people + c.agents));
  const cards = s ? ([["dash_documents", s.totals.documents], ["dash_published", s.totals.published], ["dash_review", s.totals.review], ["dash_scheduled", s.totals.scheduled]] as const) : [];

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("dashboard_title")}>
        <Segmented label={t("dash_period")} value={days} onChange={setDays} options={(["7", "14", "30"] as const).map((n) => ({ value: n, label: t("dash_days", { n }) }))} />
      </PageHeader>
      <div className="flex flex-col gap-6 px-4 py-4 md:px-6">
        <StatusText tone={stats.error ? "error" : "muted"} className="text-xs">
          {stats.error ? errorMessage(stats.error, t) : stats.loading && !s ? t("loading") : ""}
        </StatusText>
        {s ? (
          <>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {cards.map(([key, n]) => (
                <div key={key} className="min-w-0 rounded-lg border px-4 py-3">
                  <dt className="truncate text-xs text-muted-foreground">{t(key)}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            <section aria-labelledby="cms-dash-changes" className="rounded-lg border px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <h2 id="cms-dash-changes" className="text-sm font-medium">
                  {t("dash_changes")}
                </h2>
                <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span aria-hidden className="h-2 w-2 rounded-sm bg-foreground" />
                  {t("dash_people")}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span aria-hidden className="h-2 w-2 rounded-sm bg-foreground/35" />
                  {t("dash_agents")}
                </span>
              </div>
              <ol className="mt-3 flex h-36 items-end gap-1" aria-label={t("dash_changes")}>
                {s.changes.map((c) => (
                  <li key={c.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={t("dash_day", { day: formatDate(c.day, locale), people: c.people, agents: c.agents })}>
                    <span className="sr-only">{t("dash_day", { day: formatDate(c.day, locale), people: c.people, agents: c.agents })}</span>
                    <span aria-hidden className="block w-full rounded-t-sm bg-foreground/35" style={{ height: `${(c.agents / max) * 100}%` }} />
                    <span aria-hidden className={cn("block w-full bg-foreground", c.agents ? "" : "rounded-t-sm")} style={{ height: `${(c.people / max) * 100}%`, minHeight: c.people + c.agents ? 0 : 1 }} />
                  </li>
                ))}
              </ol>
              <div aria-hidden className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span>{formatDate(s.changes[0].day, locale)}</span>
                <span>{formatDate(s.changes[s.changes.length - 1].day, locale)}</span>
              </div>
            </section>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section aria-labelledby="cms-dash-top" className="min-w-0">
                <h2 id="cms-dash-top" className="mb-2 text-sm font-medium">
                  {t("dash_top")}
                </h2>
                <StatusText className="text-xs">{s.top.length ? "" : t("dash_top_empty")}</StatusText>
                <ol className="flex flex-col divide-y">
                  {s.top.map((d) => (
                    <li key={`${d.collection}/${d.slug}`} className="flex items-center gap-3 py-2 text-sm">
                      <a href={href(d.collection, d.slug)} className="min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline">
                        {d.title}
                      </a>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{d.hits}</span>
                    </li>
                  ))}
                </ol>
              </section>
              <section aria-labelledby="cms-dash-recent" className="min-w-0">
                <h2 id="cms-dash-recent" className="mb-2 text-sm font-medium">
                  {t("dash_recent")}
                </h2>
                <StatusText className="text-xs">{s.recent.length ? "" : t("dash_recent_empty")}</StatusText>
                <ul className="flex flex-col divide-y">
                  {s.recent.map((r, i) => (
                    <li key={i} className="flex items-center gap-2 py-2 text-sm">
                      {r.agent ? <Bot aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="min-w-0 flex-1 truncate">
                        {r.collection && r.slug && r.action !== "doc.delete" ? (
                          <a href={href(r.collection, r.slug)} className="outline-none hover:underline focus-visible:underline">
                            {t(`activity.${r.action}` as never, { who: r.who, title: r.title ?? r.slug })}
                          </a>
                        ) : (
                          t(`activity.${r.action}` as never, { who: r.who, title: r.title ?? r.slug ?? "" })
                        )}
                      </span>
                      <time className="shrink-0 text-xs text-muted-foreground" dateTime={r.at}>
                        {relativeTime(r.at, t, locale)}
                      </time>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
