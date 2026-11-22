// agent-cms registry: cms-audit (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The audit log: key changes, publishes, deletes, denied access and failed
// sign-ins, filtered on the server by kind of action, who (by name), collection,
// period and result, with "Load more". A timeline of cards on a phone.
"use client";

import * as React from "react";
import { Search, UserX } from "lucide-react";
import { AUDIT_ACTIONS, type AuditEntry } from "@mainsoft/agent-cms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage, type MessageKey } from "./cms-messages";
import { EmptyState, PageHeader, StatusText, Who } from "./cms-parts";
import { formatDateTime, useCms, useDebounced } from "./use-cms";

/** Actions by what they are about: the filter offers the group first ("Documents"), then one action. */
const GROUPS = [...new Set(AUDIT_ACTIONS.map((a) => a.split(".")[0]))];
const PERIODS = { day: 24, week: 24 * 7, month: 24 * 30 } as const;
type Period = "__all" | keyof typeof PERIODS;
type ActorFilter = "__all" | "user" | "key" | "system" | "anonymous";

export interface CmsAuditProps {
  /** Entries per page. Default 50. */
  pageSize?: number;
  className?: string;
}

export function CmsAudit({ pageSize = 50, className }: CmsAuditProps) {
  const { client, t, locale } = useCms();
  const [action, setAction] = React.useState<string>("__all");
  const [actor, setActor] = React.useState<ActorFilter>("__all");
  const [outcome, setOutcome] = React.useState<string>("__all");
  const [group, setGroup] = React.useState<string>("__all");
  const [period, setPeriod] = React.useState<Period>("__all");
  const [collection, setCollection] = React.useState<string>("__all");
  const [whoText, setWhoText] = React.useState("");
  const [who, setWho] = React.useState("");
  const [tick, setTick] = React.useState(0);
  const typedWho = useDebounced((v: string) => setWho(v.trim()), 300);
  const { me } = useCms();
  const [entries, setEntries] = React.useState<AuditEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const q = React.useMemo(
    () => ({
      action: action === "__all" ? undefined : action,
      group: group === "__all" || action !== "__all" ? undefined : group,
      outcome: outcome === "__all" ? undefined : outcome,
      actorKind: actor === "__all" ? undefined : (actor as "user" | "key" | "system" | "anonymous"),
      who: who || undefined,
      collection: collection === "__all" ? undefined : collection,
      // Rounded to the minute so the query (and the request) does not change on every render.
      since: period === "__all" ? undefined : new Date(Math.floor(Date.now() / 60_000) * 60_000 - PERIODS[period] * 3600_000).toISOString(),
      limit: pageSize,
      tick,
    }),
    [action, group, outcome, actor, who, collection, period, pageSize, tick]
  );
  const filtered = action !== "__all" || group !== "__all" || outcome !== "__all" || actor !== "__all" || !!who || collection !== "__all" || period !== "__all";
  const clear = () => {
    typedWho.cancel();
    setAction("__all");
    setGroup("__all");
    setOutcome("__all");
    setActor("__all");
    setWho("");
    setWhoText("");
    setCollection("__all");
    setPeriod("__all");
  };
  const gen = React.useRef(0);

  React.useEffect(() => {
    let live = true;
    gen.current++;
    setLoading(true);
    const { tick: _t, ...query } = q;
    client.audit(query).then(
      (r) => {
        if (!live) return;
        setEntries(r.entries);
        setCursor(r.nextCursor);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        // Rows and "Load more" belonged to the filters before: do not show them as this answer.
        setEntries([]);
        setCursor(null);
        setError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
  }, [client, q]);

  const more = async () => {
    if (!cursor || loading) return;
    const mine = gen.current;
    setLoading(true);
    try {
      const { tick: _t, ...query } = q;
      const r = await client.audit({ ...query, cursor });
      // A page for filters that changed meanwhile is dropped.
      if (mine !== gen.current) return;
      setEntries((x) => [...x, ...r.entries]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (mine === gen.current) setError(e);
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  };

  // The server filters by action, outcome and who.
  const shown = entries;

  // An action without its own label still reads as words, not a message key.
  const actionLabel = (a: string) => {
    const v = t(`audit.${a}` as MessageKey);
    return v === `audit.${a}` ? a.replace(/[._]/g, " ") : v;
  };
  const groupLabel = (g: string) => {
    const v = t(`audit_group.${g}` as MessageKey);
    return v === `audit_group.${g}` ? g : v;
  };
  const actorLabel = (k: string) => t(`actor_${k}` as MessageKey);
  const outcomeLabel = (o: string) => t(`outcome_${o}` as MessageKey);

  const filter = (id: string, labelKey: MessageKey, fmtKey: MessageKey, value: string, set: (v: string) => void, options: { value: string; label: string }[]) => (
    <Select value={value} onValueChange={(v: string | null) => set(v ?? "__all")}>
      <SelectTrigger id={id} className="h-8 w-auto gap-1.5 text-[13px]" aria-label={t(labelKey)}>
        <SelectValue>{t(fmtKey, { value: value === "__all" ? t("all") : (options.find((o) => o.value === value)?.label ?? value) })}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">{t("all")}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const target = (e: AuditEntry) => {
    if (e.collection || e.slug)
      return (
        <>
          <span className="font-mono text-xs">{[e.collection, e.slug].filter(Boolean).join("/")}</span>
          {e.version ? <span className="ml-1.5 text-xs text-muted-foreground">v{e.version}</span> : null}
        </>
      );
    const d = e.detail as { name?: string; scopes?: string[]; key?: string };
    if (d.name)
      return (
        <>
          {d.name}
          {d.scopes?.length ? <span className="ml-1.5 text-xs text-muted-foreground">{d.scopes.join(", ")}</span> : null}
        </>
      );
    if (d.key) return <span className="font-mono text-xs">{d.key}</span>;
    return null;
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("audit_title")} />
      <div className="flex-1 overflow-x-auto px-4 py-4 md:px-6">
        <div className="mb-3.5 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={whoText} onChange={(e) => (setWhoText(e.target.value), typedWho(e.target.value))} placeholder={t("audit_who_search")} aria-label={t("audit_who_search")} className="h-8 pl-8 text-[13px]" />
          </div>
          {filter("cms-audit-period", "audit_period_label", "audit_period", period, (v) => setPeriod(v as Period), (["day", "week", "month"] as const).map((k) => ({ value: k, label: t(`audit_period_${k}` as MessageKey) })))}
          {filter("cms-audit-group", "audit_group_label", "audit_group", group, (v) => (setGroup(v), setAction("__all")), GROUPS.map((g) => ({ value: g, label: groupLabel(g) })))}
          {group !== "__all" ? filter("cms-audit-action", "audit_action_label", "audit_action", action, setAction, AUDIT_ACTIONS.filter((a) => a.startsWith(`${group}.`)).map((a) => ({ value: a, label: actionLabel(a) }))) : null}
          {me?.collections.length ? filter("cms-audit-collection", "audit_collection_label", "audit_collection", collection, setCollection, me.collections.map((c) => ({ value: c.slug, label: c.label }))) : null}
          {filter("cms-audit-actor", "audit_actor_label", "audit_actor", actor, (v) => setActor(v as ActorFilter), (["user", "key", "system", "anonymous"] as const).map((k) => ({ value: k, label: actorLabel(k) })))}
          {filter("cms-audit-outcome", "audit_outcome_label", "audit_outcome", outcome, setOutcome, (["ok", "denied", "failed"] as const).map((o) => ({ value: o, label: outcomeLabel(o) })))}
          {filtered ? (
            <Button type="button" variant="ghost" size="sm" className="h-8 text-[13px]" onClick={clear}>
              {t("clear_filters")}
            </Button>
          ) : null}
        </div>
        {/* On a phone: a timeline of cards, time on top, nothing cut off. */}
        {/* While new filters load, the rows below are the previous answer: dimmed and marked busy. */}
        <ol className={cn("flex flex-col gap-2 transition-opacity md:hidden", loading && shown.length > 0 && "opacity-50")} aria-busy={loading} aria-label={t("audit_title")}>
          {shown.map((e) => (
            <li key={e.id} className="flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-[13.5px]">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <time dateTime={e.at} className="tabular-nums">{formatDateTime(e.at, locale)}</time>
                {e.outcome === "ok" ? <span>{outcomeLabel("ok")}</span> : <span className="font-medium text-red-700 dark:text-red-400">{outcomeLabel(e.outcome)}</span>}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                {e.actorKind === "anonymous" ? <span className="text-muted-foreground">{e.action === "auth.failed" ? t("unknown_key") : actorLabel("anonymous")}</span> : <Who kind={e.actorKind} label={e.actorLabel} agent={e.actorAgent} />}
                <span className="font-medium">{actionLabel(e.action)}</span>
              </div>
              {target(e) ? <div className="min-w-0 [overflow-wrap:anywhere]">{target(e)}</div> : null}
            </li>
          ))}
        </ol>
        <div className={cn("hidden transition-opacity md:block", loading && shown.length > 0 && "opacity-50")} aria-busy={loading}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("audit_time")}</TableHead>
              <TableHead>{t("audit_who")}</TableHead>
              <TableHead>{t("audit_what")}</TableHead>
              <TableHead>{t("audit_target")}</TableHead>
              <TableHead>{t("audit_result")}</TableHead>
              <TableHead>{t("audit_via")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatDateTime(e.at, locale)}</TableCell>
                <TableCell className="text-[13.5px]">
                  {e.actorKind === "anonymous" ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span aria-hidden className="inline-grid h-5 w-5 place-items-center rounded-full bg-muted">
                        <UserX className="h-3 w-3" />
                      </span>
                      {e.action === "auth.failed" ? t("unknown_key") : actorLabel("anonymous")}
                    </span>
                  ) : (
                    <Who kind={e.actorKind} label={e.actorLabel} agent={e.actorAgent} />
                  )}
                </TableCell>
                <TableCell className="text-[13.5px]">{actionLabel(e.action)}</TableCell>
                <TableCell className="text-[13.5px]">{target(e)}</TableCell>
                <TableCell>
                  {e.outcome === "ok" ? (
                    <Badge variant="outline" className="gap-1.5 rounded-full px-2 py-0 text-[11.5px] font-medium">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green-600" />
                      {outcomeLabel("ok")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="rounded-full border-red-200 bg-red-50 px-2 py-0 text-[11.5px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                      {outcomeLabel(e.outcome)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{e.via ? t(`via_${e.via}` as MessageKey) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        {!loading && !error && !shown.length ? (
          filtered ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("audit_no_match")}{" "}
              <button type="button" className="underline underline-offset-2" onClick={clear}>
                {t("clear_filters")}
              </button>
            </p>
          ) : (
            <EmptyState title={t("audit_empty")} text={t("audit_empty_text")} />
          )
        ) : null}
        <div className="mt-3 flex flex-col items-center gap-2">
          <StatusText tone={error ? "error" : "muted"} className="text-xs">
            {error ? errorMessage(error, t) : loading ? t("loading") : ""}
          </StatusText>
          {error ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setTick((n) => n + 1)}>
              {t("retry")}
            </Button>
          ) : null}
          {cursor ? (
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void more()}>
              {t("load_more")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
