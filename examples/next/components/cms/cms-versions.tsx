// agent-cms registry: cms-versions (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Version history of one document: who saved what (agent or person, note,
// published marker, changed fields), a compare of any two versions (side by
// side or unified, word-level highlight), restore and publish a version.
"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, RotateCcw } from "lucide-react";
import { diffWords, type Hunk, type HunkLine } from "@mainsoft/agent-cms/diff";
import type { CmsDoc, VersionSummary } from "@mainsoft/agent-cms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { errorMessage, type MessageKey } from "./cms-messages";
import { ConfirmDialog, PageHeader, Segmented, StateBadge, StatusText, Who } from "./cms-parts";
import { relativeTime, useAsync, useCms, useIsMobile, useLocalStorage } from "./use-cms";

type DocDiff = Awaited<ReturnType<import("@mainsoft/agent-cms/client").RestClient["diff"]>>;

export interface CmsVersionsProps {
  collection: string;
  slug: string;
  /** "Back to editing". */
  onBack?: () => void;
  /** After a restore or publish. */
  onChanged?: (doc: CmsDoc) => void;
  className?: string;
}

const FIELD_LABEL: Record<string, MessageKey> = { title: "field_title", slug: "field_slug", summary: "field_summary", category: "field_category", keywords: "field_keywords", body: "field_body" };
const show = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Pair the removed and added lines of a hunk row by row (for side by side and word highlight). */
type Row = { t: "ctx"; a: HunkLine; b: HunkLine } | { t: "chg"; a: HunkLine | null; b: HunkLine | null };
function rowsOf(h: Hunk): Row[] {
  const out: Row[] = [];
  let dels: HunkLine[] = [];
  let adds: HunkLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ t: "chg", a: dels[i] ?? null, b: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.t === "-") dels.push(l);
    else if (l.t === "+") adds.push(l);
    else {
      flush();
      out.push({ t: "ctx", a: l, b: l });
    }
  }
  flush();
  return out;
}

function Words({ a, b, side }: { a: string; b: string; side: "a" | "b" }) {
  return (
    <>
      {diffWords(a, b).map((p, i) =>
        p.t === "eq" ? (
          <React.Fragment key={i}>{p.v}</React.Fragment>
        ) : p.t === "del" && side === "a" ? (
          <del key={i} className="bg-red-200 no-underline">
            {p.v}
          </del>
        ) : p.t === "ins" && side === "b" ? (
          <ins key={i} className="bg-green-200 no-underline">
            {p.v}
          </ins>
        ) : null
      )}
    </>
  );
}

function headingBefore(body: string | undefined, line: number): string | null {
  if (!body) return null;
  const lines = body.split("\n").slice(0, Math.max(0, line - 1));
  for (let i = lines.length - 1; i >= 0; i--) if (/^#{1,6}\s/.test(lines[i])) return lines[i];
  return null;
}

export function CmsVersions({ collection, slug, onBack, onChanged, className }: CmsVersionsProps) {
  const { client, t, locale } = useCms();
  const mobile = useIsMobile();
  const schema = useAsync(() => client.schema(collection), [client, collection]);
  const list = useAsync(() => client.versions(collection, slug), [client, collection, slug]);
  const versions = list.data ?? [];
  const latest = versions[0]?.version ?? 0;
  const publishedV = versions.find((v) => v.published)?.version ?? null;

  const [to, setTo] = React.useState<number | null>(null);
  const [from, setFrom] = React.useState<number | null>(null);
  const [savedView, setView] = useLocalStorage<"split" | "unified">("agent-cms:diff-view", "split");
  const view = mobile ? "unified" : savedView;
  const [confirm, setConfirm] = React.useState<"restore" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" } | null>(null);

  // Default: latest against the published version (or the one before).
  React.useEffect(() => {
    if (!versions.length || to !== null) return;
    const b = versions[0].version;
    const a = publishedV !== null && publishedV !== b ? publishedV : (versions[1]?.version ?? b);
    setTo(b);
    setFrom(a);
  }, [versions, to, publishedV]);

  const diff = useAsync<{ d: DocDiff; body?: string } | null>(
    async () => {
      if (from === null || to === null) return null;
      const [d, v] = await Promise.all([client.diff(collection, slug, from, to), client.version(collection, slug, to).catch(() => null)]);
      return { d, body: v?.snapshot.body };
    },
    [client, collection, slug, from, to]
  );

  const pick = (v: VersionSummary) => {
    setTo(v.version);
    const idx = versions.findIndex((x) => x.version === v.version);
    const prev = versions[idx + 1]?.version;
    setFrom(publishedV !== null && publishedV < v.version ? publishedV : (prev ?? v.version));
  };

  const run = async (what: "restore" | "publish") => {
    if (from === null || to === null) return;
    setBusy(true);
    setStatus(null);
    try {
      const d = what === "restore" ? await client.restore(collection, slug, from, { expectedVersion: latest }) : await client.publish(collection, slug, { version: to, expectedVersion: latest });
      setStatus({ text: what === "restore" ? t("restored", { version: d.version }) : t("published_v", { version: to }), tone: "ok" });
      setConfirm(null);
      setTo(null);
      list.reload();
      onChanged?.(d);
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const canWrite = schema.data?.canWrite ?? false;
  const canPublish = schema.data?.canPublish ?? false;
  const label = (n: number) => (n === publishedV ? t("version_published_tag", { version: n }) : `v${n}`);
  const toInfo = versions.find((v) => v.version === to);

  const picker = (id: string, text: string, value: number | null, set: (n: number) => void) => (
    <div className={cn("flex flex-col gap-1", mobile && "flex-1")}>
      <Label htmlFor={id} className="sr-only">
        {text}
      </Label>
      <Select value={value === null ? undefined : String(value)} onValueChange={(v: string | null) => v && set(Number(v))}>
        <SelectTrigger id={id} className={cn("h-8 text-[13px]", mobile ? "w-full" : "w-40")}>
          <SelectValue>{value === null ? null : label(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.version} value={String(v.version)}>
              {label(v.version)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const compare = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`${t("compare_from")}, ${t("compare_to")}`}>
      {picker("cms-v-from", t("compare_from"), from, setFrom)}
      <ArrowRight aria-hidden className="h-4 w-4 text-muted-foreground" />
      {picker("cms-v-to", t("compare_to"), to, setTo)}
      {!mobile ? (
        <Segmented
          label={t("view_mode")}
          value={savedView}
          onChange={setView}
          options={[
            { value: "split", label: t("side_by_side") },
            { value: "unified", label: t("unified") },
          ]}
        />
      ) : null}
    </div>
  );

  const actions = (cls?: string) =>
    from !== null && to !== null ? (
      <>
        {canWrite && from !== latest ? (
          <Button type="button" variant="outline" className={cn("gap-1.5", cls)} disabled={busy} onClick={() => setConfirm("restore")}>
            <RotateCcw aria-hidden className="h-4 w-4" />
            {t("restore_version", { version: from })}
          </Button>
        ) : null}
        {canPublish && to !== publishedV ? (
          <Button type="button" className={cls} disabled={busy} onClick={() => void run("publish")}>
            {t("publish_version", { version: to })}
          </Button>
        ) : null}
      </>
    ) : null;

  const d = diff.data?.d;
  const body = diff.data?.body;

  const fieldTable = d && d.fields.length ? (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t("field")}</th>
            {!mobile ? <th className="px-3 py-2 font-medium">{label(d.a)}</th> : null}
            <th className="px-3 py-2 font-medium">{mobile ? `${label(d.a)} → v${d.b}` : `v${d.b}`}</th>
          </tr>
        </thead>
        <tbody>
          {d.fields.map((f) => {
            const name = FIELD_LABEL[f.path] ? t(FIELD_LABEL[f.path]) : f.path.replace(/^fields\./, "");
            const a = show(f.from);
            const b = show(f.to);
            return (
              <tr key={f.path} className="border-b last:border-b-0 align-top">
                <td className="px-3 py-2 text-xs">{name}</td>
                {!mobile ? (
                  <td className="px-3 py-2 font-mono text-xs">
                    <Words a={a} b={b} side="a" />
                  </td>
                ) : null}
                <td className="px-3 py-2 font-mono text-xs">
                  <Words a={a} b={b} side="b" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : null;

  const hunkHead = (h: Hunk) => {
    const head = headingBefore(body, h.bStart + 1);
    return `@@ ${head ?? `-${h.aStart},${h.aLines} +${h.bStart},${h.bLines}`}`;
  };

  const lineCls = (k: "del" | "add" | "ctx" | "pad") => cn("flex min-w-0 gap-2 px-2 font-mono text-xs leading-6", k === "del" && "bg-red-50", k === "add" && "bg-green-50", k === "pad" && "bg-muted/40");
  const num = (n?: number) => (
    <i aria-hidden className="w-8 shrink-0 select-none text-right not-italic text-muted-foreground">
      {n ?? ""}
    </i>
  );

  const split = d ? (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-2 border-b text-xs font-medium text-muted-foreground">
        <span className="px-3 py-1.5">{label(d.a)}</span>
        <span className="border-l px-3 py-1.5">v{d.b}</span>
      </div>
      {d.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="border-y bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground first:border-t-0">{hunkHead(h)}</div>
          <div className="grid grid-cols-2">
            {rowsOf(h).map((r, i) => (
              <React.Fragment key={i}>
                <div className={lineCls(r.t === "ctx" ? "ctx" : r.a ? "del" : "pad")}>
                  {num(r.a?.a)}
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {r.t === "chg" && r.a ? <span className="sr-only">- </span> : null}
                    {r.a ? r.t === "chg" && r.b ? <Words a={r.a.v} b={r.b.v} side="a" /> : r.a.v : ""}
                  </span>
                </div>
                <div className={cn(lineCls(r.t === "ctx" ? "ctx" : r.b ? "add" : "pad"), "border-l")}>
                  {num(r.b?.b)}
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {r.t === "chg" && r.b ? <span className="sr-only">+ </span> : null}
                    {r.b ? r.t === "chg" && r.a ? <Words a={r.a.v} b={r.b.v} side="b" /> : r.b.v : ""}
                  </span>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  ) : null;

  const unified = d ? (
    <div className={cn("overflow-hidden", mobile ? "border-t" : "rounded-lg border")}>
      {d.hunks.map((h, hi) => {
        const rows = rowsOf(h);
        const pairs = new Map<HunkLine, string>();
        for (const r of rows) if (r.t === "chg" && r.a && r.b) (pairs.set(r.a, r.b.v), pairs.set(r.b, r.a.v));
        return (
          <div key={hi}>
            <div className="border-b bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground">{hunkHead(h)}</div>
            {h.lines.map((l, i) => {
              const other = pairs.get(l);
              return (
                <div key={i} className={lineCls(l.t === "-" ? "del" : l.t === "+" ? "add" : "ctx")}>
                  <span aria-hidden className="w-3 shrink-0 select-none text-muted-foreground">
                    {l.t === "-" ? "−" : l.t === "+" ? "+" : " "}
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {l.t !== " " ? <span className="sr-only">{l.t} </span> : null}
                    {other !== undefined ? l.t === "-" ? <Words a={l.v} b={other} side="a" /> : <Words a={other} b={l.v} side="b" /> : l.v}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  ) : null;

  const diffArea = (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {diff.error ? <StatusText tone="error">{errorMessage(diff.error, t)}</StatusText> : null}
      {d && !d.fields.length && !d.hunks.length ? <p className="text-sm text-muted-foreground">{t("no_diff")}</p> : null}
      {fieldTable}
      {d && d.hunks.length ? (view === "unified" ? unified : split) : null}
    </div>
  );

  const confirmDialog = (
    <ConfirmDialog
      open={confirm === "restore"}
      onOpenChange={(o) => !o && setConfirm(null)}
      title={t("restore_confirm", { version: from ?? 0 })}
      description={t("restore_confirm_note", { version: from ?? 0 })}
      confirmLabel={t("restore_version", { version: from ?? 0 })}
      busy={busy}
      onConfirm={() => run("restore")}
    />
  );

  const statusLine = (
    <StatusText tone={status?.tone === "error" ? "error" : "ok"} className="text-xs">
      {status?.text ?? (list.loading && !versions.length ? t("loading") : "")}
    </StatusText>
  );

  if (mobile)
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <PageHeader
          title={t("versions")}
          back={
            onBack ? (
              <Button type="button" variant="ghost" size="icon" className="-ml-2 h-8 w-8" aria-label={t("versions_back")} onClick={onBack}>
                <ChevronLeft aria-hidden className="h-4 w-4" />
              </Button>
            ) : undefined
          }
        />
        <div className="border-b px-4 py-2.5">{compare}</div>
        <div className="flex-1">
          {toInfo ? (
            <div className="flex flex-col gap-0.5 px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2">
                <Who kind={toInfo.authorKind} label={toInfo.authorLabel} agent={toInfo.authorAgent} className="font-medium" />
                <span className="text-muted-foreground">{relativeTime(toInfo.createdAt, t, locale)}</span>
              </div>
              {toInfo.note ? <div className="text-muted-foreground">{toInfo.note}</div> : null}
            </div>
          ) : null}
          <div className="px-4 pb-2">{statusLine}</div>
          {diffArea}
        </div>
        <div className="sticky bottom-0 flex gap-2 border-t bg-background p-2">{actions("flex-1")}</div>
        {confirmDialog}
      </div>
    );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("versions")} crumbs={[schema.data?.label ?? collection, slug]}>
        {onBack ? (
          <Button type="button" variant="ghost" className="gap-1.5" onClick={onBack}>
            <ArrowLeft aria-hidden className="h-4 w-4" />
            {t("versions_back")}
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("versions_list")} className="w-64 shrink-0 overflow-y-auto border-r">
          <ul>
            {versions.map((v) => {
              const on = v.version === to;
              const cmp = v.version === from && !on;
              return (
                <li key={v.version}>
                  <button
                    type="button"
                    aria-current={on ? "true" : undefined}
                    onClick={() => pick(v)}
                    className={cn("flex w-full flex-col gap-1 border-b px-3.5 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted", on && "bg-muted", cmp && "bg-muted/40")}
                  >
                    <span className="flex w-full items-center gap-2 text-sm">
                      <b>v{v.version}</b>
                      {v.published ? <StateBadge state="published" /> : null}
                      <span className="flex-1" />
                      <span className="text-xs text-muted-foreground">{relativeTime(v.createdAt, t, locale)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-xs">
                      <Who kind={v.authorKind} label={v.authorLabel} agent={v.authorAgent} />
                      <Badge variant="outline" className={cn("h-4 rounded-full px-1.5 text-[10.5px] font-normal", (v.authorKind !== "user" || v.authorAgent) && "border-blue-200 bg-blue-50 text-blue-700")}>
                        {v.authorKind === "user" && !v.authorAgent ? t("kind_user") : t("kind_agent")}
                      </Badge>
                    </span>
                    {v.note ? <span className="text-xs text-muted-foreground">{v.note}</span> : null}
                    {v.changed?.fields.length ? (
                      <span className="text-[11px] text-muted-foreground">
                        {t("changed_fields", { fields: v.changed.fields.map((f) => (FIELD_LABEL[f] ? t(FIELD_LABEL[f]) : f.replace(/^fields\./, ""))).join(", ") })}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {compare}
            <span className="flex-1" />
            {actions()}
          </div>
          {statusLine}
          {diffArea}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
