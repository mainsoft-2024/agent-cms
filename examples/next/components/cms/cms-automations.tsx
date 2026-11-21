// agent-cms registry: cms-automations (0.13.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Automations: "when this happens, if these hold, do that". The list, and for the
// selected one the form (trigger, conditions, actions), a dry test against one
// document and the run history. Admins only. Runs happen on the next cron call.
"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import type { AutomationAction, AutomationCondition, AutomationRun, CmsAutomation } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, PageHeader, StatusText } from "./cms-parts";
import { relativeTime, useAsync, useCms } from "./use-cms";

const SELECT = "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const OPS: AutomationCondition["op"][] = ["is", "is_not", "contains", "empty", "not_empty"];
type Lists = { triggers: string[]; actions: string[]; actionLabels: Record<string, string>; functions: string[] };

export function CmsAutomations({ className }: { className?: string }) {
  const { client, t, locale } = useCms();
  const data = useAsync(() => client.automations(), [client]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const list = data.data?.automations ?? [];
  const open = list.find((a) => a.id === openId) ?? list[0] ?? null;
  const [error, setError] = React.useState<unknown>(null);

  const add = () =>
    client.createAutomation({ name: `${t("automation_new")} ${list.length + 1}`, enabled: false, trigger: { event: "doc.published", collection: null }, conditions: [], actions: [] }).then(
      (a) => (setOpenId(a.id), data.reload()),
      setError
    );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("automations_title")}>
        <Button type="button" className="gap-1.5" onClick={add}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("automation_new")}
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={t("automations_title")} className="shrink-0 border-b p-3 md:w-64 md:border-b-0 md:border-r">
          <StatusText tone={data.error || error ? "error" : "muted"} className="px-1 text-xs">
            {data.error || error ? errorMessage(data.error ?? error, t) : data.loading && !data.data ? t("loading") : ""}
          </StatusText>
          <ul className="flex flex-col gap-1">
            {list.map((a) => (
              <li key={a.id}>
                <button type="button" aria-current={a.id === open?.id ? "true" : undefined} onClick={() => setOpenId(a.id)} className={cn("flex w-full flex-col rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", a.id === open?.id && "bg-accent")}>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.enabled ? "bg-green-600" : "bg-muted-foreground/50")} />
                    <span className="truncate">{a.name}</span>
                  </span>
                  <span className="truncate pl-3.5 text-xs text-muted-foreground">
                    {t(`trigger.${a.trigger.event}` as never)}
                    {a.lastRun ? ` · ${t(`run.${a.lastRun.state}` as never)}, ${relativeTime(a.lastRun.at, t, locale)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 px-4 py-4 md:px-6">
          {data.data && !list.length ? <p className="max-w-prose text-sm text-muted-foreground">{t("automations_empty")}</p> : null}
          {open && data.data ? <AutomationForm key={open.id} auto={open} lists={data.data} onChanged={data.reload} onDeleted={() => (setOpenId(null), data.reload())} /> : null}
        </div>
      </div>
    </div>
  );
}

function AutomationForm({ auto, lists, onChanged, onDeleted }: { auto: CmsAutomation; lists: Lists; onChanged: () => void; onDeleted: () => void }) {
  const { client, t, me, locale } = useCms();
  const [name, setName] = React.useState(auto.name);
  const [enabled, setEnabled] = React.useState(auto.enabled);
  const [event, setEvent] = React.useState<string>(auto.trigger.event);
  const [collection, setCollection] = React.useState(auto.trigger.collection ?? "");
  const [conditions, setConditions] = React.useState<AutomationCondition[]>(auto.conditions);
  const [actions, setActions] = React.useState<AutomationAction[]>(auto.actions);
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" | "muted" }>({ text: "", tone: "muted" });
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [slug, setSlug] = React.useState("");
  const [testCol, setTestCol] = React.useState("");
  const runs = useAsync<AutomationRun[]>(() => client.automationRuns(auto.id, 20), [client, auto.id, auto.updatedAt]);
  const hooks = useAsync(() => (me?.webhooks ? client.webhooks().then((r) => r.webhooks) : Promise.resolve([])), [client, me?.webhooks]);
  const releases = useAsync(() => client.releases().then((r) => r.filter((x) => x.state !== "published"), () => []), [client]);
  const cols = me?.collections ?? [];

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    try {
      setStatus({ text: await fn(), tone: "ok" });
      onChanged();
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const input = () => ({ name, enabled, trigger: { event: event as CmsAutomation["trigger"]["event"], collection: collection || null }, conditions, actions });
  // The form as last saved (set on first render and after each save): the test runs that, not what is on screen.
  const savedForm = React.useRef<string | null>(null);
  if (savedForm.current === null) savedForm.current = JSON.stringify(input());
  const unsaved = JSON.stringify(input()) !== savedForm.current;
  const patchAt = <V,>(set: React.Dispatch<React.SetStateAction<V[]>>, i: number, p: Partial<V>) => set((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const actionLabel = (a: string) => lists.actionLabels[a] ?? t(`action.${a}` as never);
  const targets = (type: string): { id: string; label: string }[] | null =>
    type === "webhook" ? (hooks.data ?? []).map((w) => ({ id: w.id, label: w.name })) : type === "add_to_release" ? (releases.data ?? []).map((r) => ({ id: r.id, label: r.name })) : type === "call" ? lists.functions.map((f) => ({ id: f, label: f })) : null;

  return (
    <form className="flex max-w-3xl flex-col gap-5" onSubmit={(e) => (e.preventDefault(), void run(async () => (await client.updateAutomation(auto.id, input()), (savedForm.current = JSON.stringify(input())), t("automation_saved"))))}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 basis-full flex-col gap-1.5 sm:basis-0">
          <Label htmlFor="cms-auto-name">{t("automation_name")}</Label>
          <Input id="cms-auto-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} className="max-w-sm" />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(on) => setEnabled(on === true)} />
          {t("automation_enabled")}
        </label>
        <Button type="button" variant="outline" className="text-destructive" onClick={() => setConfirming(true)}>
          {t("action_delete")}
        </Button>
        <Button type="submit" disabled={busy}>
          {t("save")}
        </Button>
      </div>
      <StatusText tone={status.tone} className="text-xs">
        {status.text}
      </StatusText>
      <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t("automation_when")}</legend>
        <div className="flex flex-wrap gap-2">
          <select aria-label={t("automation_when")} className={SELECT} value={event} onChange={(e) => setEvent(e.target.value)}>
            {lists.triggers.map((x) => (
              <option key={x} value={x}>
                {t(`trigger.${x}` as never)}
              </option>
            ))}
          </select>
          {event.startsWith("schedule.") || event === "asset.uploaded" ? null : (
            <select aria-label={t("automation_collection")} className={SELECT} value={collection} onChange={(e) => setCollection(e.target.value)}>
              <option value="">{t("automation_any_collection")}</option>
              {cols.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t("automation_condition")}</legend>
        {conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={t("automation_field")} placeholder={t("automation_field")} className="w-56 font-mono text-xs" value={c.field} onChange={(e) => patchAt(setConditions, i, { field: e.target.value })} />
            <select aria-label={t("automation_condition")} className={SELECT} value={c.op} onChange={(e) => patchAt(setConditions, i, { op: e.target.value as AutomationCondition["op"] })}>
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {t(`cond.${o}` as never)}
                </option>
              ))}
            </select>
            {c.op === "empty" || c.op === "not_empty" ? null : <Input aria-label={t("automation_value")} placeholder={t("automation_value")} className="w-40" value={c.value ?? ""} onChange={(e) => patchAt(setConditions, i, { value: e.target.value })} />}
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("automation_remove_step")} onClick={() => setConditions((l) => l.filter((_, n) => n !== i))}>
              <X aria-hidden className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" className="gap-1.5 self-start" onClick={() => setConditions((l) => [...l, { field: "category", op: "is", value: "" }])}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          {t("automation_add_condition")}
        </Button>
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t("automation_action")}</legend>
        {actions.map((a, i) => {
          const opts = targets(a.type);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select aria-label={t("automation_action")} className={SELECT} value={a.type} onChange={(e) => patchAt(setActions, i, { type: e.target.value, target: undefined, name: undefined, value: undefined })}>
                {lists.actions.map((x) => (
                  <option key={x} value={x}>
                    {actionLabel(x)}
                  </option>
                ))}
              </select>
              {opts ? (
                <select aria-label={t("automation_target")} className={SELECT} value={a.target ?? ""} onChange={(e) => patchAt(setActions, i, { target: e.target.value })}>
                  <option value="">{t("automation_pick")}</option>
                  {opts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {a.type === "add_keyword" ? <Input aria-label={t("automation_keyword")} placeholder={t("automation_keyword")} className="w-40" value={a.name ?? ""} onChange={(e) => patchAt(setActions, i, { name: e.target.value })} /> : null}
              {a.type === "set_field" ? (
                <>
                  <Input aria-label={t("automation_field_path")} placeholder={t("automation_field_path")} className="w-48 font-mono text-xs" value={a.name ?? ""} onChange={(e) => patchAt(setActions, i, { name: e.target.value })} />
                  <Input aria-label={t("automation_value")} placeholder={t("automation_value")} className="w-32" value={a.value ?? ""} onChange={(e) => patchAt(setActions, i, { value: e.target.value })} />
                </>
              ) : null}
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("automation_remove_step")} onClick={() => setActions((l) => l.filter((_, n) => n !== i))}>
                <X aria-hidden className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="ghost" size="sm" className="gap-1.5 self-start" onClick={() => setActions((l) => [...l, { type: "add_keyword", name: "" }])}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          {t("automation_add_action")}
        </Button>
      </fieldset>
      <section className="flex flex-col gap-2" aria-labelledby="cms-auto-test">
        <h2 id="cms-auto-test" className="text-xs font-medium text-muted-foreground">
          {t("automation_test")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("automation_test_text")}</p>
        {/* The test runs the saved rule: with unsaved changes it would test something else than what is shown. */}
        {unsaved ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">{t("automation_test_save_first")}</p>
        ) : null}
        <div className="flex max-w-md flex-wrap items-center gap-2">
          {!collection && cols.length > 1 ? (
            <select aria-label={t("automation_test_collection")} className="h-9 rounded-md border bg-background px-2 text-sm" value={testCol} onChange={(e) => setTestCol(e.target.value)}>
              <option value="">{t("automation_test_collection")}</option>
              {cols.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : null}
          <Input aria-label={t("automation_test_slug")} placeholder={t("automation_test_slug")} value={slug} onChange={(e) => setSlug(e.target.value)} />
          <Button
            type="button"
            variant="outline"
            disabled={
              busy ||
              !slug.trim() ||
              !(collection || (cols.length === 1 ? cols[0] : testCol)) ||
              unsaved
            }
            onClick={() =>
              run(async () => {
                const r = await client.testAutomation(auto.id, { collection: collection || (cols.length === 1 ? cols[0].slug : testCol), slug: slug.trim() });
                return r.matches ? t("automation_test_match", { title: r.title, actions: r.actions.map((a) => actionLabel(a.type)).join(", ") || "—" }) : t("automation_test_nomatch", { title: r.title });
              })
            }
          >
            {t("automation_test")}
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-1.5" aria-labelledby="cms-auto-runs">
        <div className="flex items-center gap-2">
          <h2 id="cms-auto-runs" className="text-xs font-medium text-muted-foreground">
            {t("automation_runs")}
          </h2>
          {/* Runs happen on a cron call, not while this screen is open: a person asks for the new ones. */}
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => (runs.reload(), onChanged())}>
            {t("automation_refresh")}
          </Button>
        </div>
        <StatusText className="text-xs" tone={runs.error ? "error" : "muted"}>
          {runs.error ? errorMessage(runs.error, t) : runs.loading && !runs.data ? t("loading") : runs.data && !runs.data.length ? t("automation_runs_empty") : ""}
        </StatusText>
        <ul className="flex flex-col divide-y" aria-label={t("automation_runs")}>
          {(runs.data ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5 text-xs">
              <span className={cn("w-16 shrink-0 font-medium", r.state === "ok" ? "text-green-700" : r.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{t(`run.${r.state}` as never)}</span>
              <span className="min-w-0 flex-1 truncate" title={r.error ?? undefined}>
                {r.title ?? r.slug ?? t(`trigger.${r.event}` as never)}
                {r.error ? <span className="text-muted-foreground"> · {r.error}</span> : null}
              </span>
              <time className="shrink-0 text-muted-foreground" dateTime={r.at} title={new Date(r.at).toLocaleString(locale, { timeZoneName: "short" })}>
                {relativeTime(r.at, t, locale)}
              </time>
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={t("automation_delete_title", { name: auto.name })} description={t("automation_delete_text")} confirmLabel={t("action_delete")} destructive busy={busy} onConfirm={() => run(async () => (await client.removeAutomation(auto.id), onDeleted(), ""))} />
    </form>
  );
}
