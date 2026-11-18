// agent-cms registry: cms-audit (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// The audit log: key changes, publishes, deletes, denied access and failed
// sign-ins, filtered by action, who and result, with "Load more".
"use client";

import * as React from "react";
import { UserX } from "lucide-react";
import type { AuditEntry } from "@mainsoft-2024/agent-cms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage, type MessageKey } from "./cms-messages";
import { PageHeader, StatusText, Who } from "./cms-parts";
import { formatDateTime, useCms } from "./use-cms";

const ACTIONS = ["doc.publish", "doc.unpublish", "doc.archive", "doc.unarchive", "doc.delete", "doc.restore", "preview.create", "key.create", "key.revoke", "access.denied", "auth.failed"] as const;
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
  const [entries, setEntries] = React.useState<AuditEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const q = React.useMemo(() => ({ action: action === "__all" ? undefined : action, outcome: outcome === "__all" ? undefined : outcome, limit: pageSize }), [action, outcome, pageSize]);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    client.audit(q).then(
      (r) => {
        if (!live) return;
        setEntries(r.entries);
        setCursor(r.nextCursor);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
  }, [client, q]);

  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await client.audit({ ...q, cursor });
      setEntries((x) => [...x, ...r.entries]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  // The REST route filters by action and outcome; "who" filters what is loaded.
  const shown = actor === "__all" ? entries : entries.filter((e) => e.actorKind === actor);

  const actionLabel = (a: string) => t(`audit.${a}` as MessageKey);
  const actorLabel = (k: string) => t(`actor_${k}` as MessageKey);
  const outcomeLabel = (o: string) => t(`outcome_${o}` as MessageKey);

  const filter = (id: string, labelKey: MessageKey, fmtKey: MessageKey, value: string, set: (v: string) => void, options: { value: string; label: string }[]) => (
    <Select value={value} onValueChange={set}>
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
          {filter("cms-audit-action", "audit_action_label", "audit_action", action, setAction, ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })))}
          {filter("cms-audit-actor", "audit_actor_label", "audit_actor", actor, (v) => setActor(v as ActorFilter), (["user", "key", "system", "anonymous"] as const).map((k) => ({ value: k, label: actorLabel(k) })))}
          {filter("cms-audit-outcome", "audit_outcome_label", "audit_outcome", outcome, setOutcome, (["ok", "denied", "failed"] as const).map((o) => ({ value: o, label: outcomeLabel(o) })))}
        </div>
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
                    <Who kind={e.actorKind} label={e.actorLabel} />
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
                    <Badge variant="outline" className="rounded-full border-red-200 bg-red-50 px-2 py-0 text-[11.5px] text-red-700">
                      {outcomeLabel(e.outcome)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{e.via ? t(`via_${e.via}` as MessageKey) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="mt-3 flex flex-col items-center gap-2">
          <StatusText tone={error ? "error" : "muted"} className="text-xs">
            {error ? errorMessage(error, t) : loading ? t("loading") : !shown.length ? t("audit_empty") : ""}
          </StatusText>
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
