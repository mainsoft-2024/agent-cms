// agent-cms registry: cms-webhooks (0.12.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Webhooks: the list (name, address, events, state), and for the selected one a
// test delivery, the signing secret, the delivery history with "send again",
// edit and delete. Admins only; needs `secretsKey` in createCms.
"use client";

import * as React from "react";
import { Plus, RotateCw, Send, Webhook } from "lucide-react";
import type { WebhookDelivery, WebhookEvent, WebhookView } from "@mainsoft/agent-cms/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage, type T } from "./cms-messages";
import { CodeBox, ConfirmDialog, PageHeader, StatusText, DIALOG, EmptyState, Segmented } from "./cms-parts";
import { relativeTime, useAsync, useCms, useIsMobile } from "./use-cms";

export interface CmsWebhooksProps {
  className?: string;
}

/** Events by what they are about (`doc`, `review`, `asset`, …), in the order they come. */
export function groupEvents<E extends string>(events: readonly E[]): [string, E[]][] {
  const out = new Map<string, E[]>();
  for (const e of events) {
    const g = e.split(".")[0];
    out.set(g, [...(out.get(g) ?? []), e]);
  }
  return [...out];
}

/** "Publish, Unpublish" for a list of events; "All" for none. */
export function eventNames(events: readonly string[], t: T): string {
  return events.length ? events.map((e) => t(`event.${e}` as never)).join(", ") : t("webhook_all_events");
}

function StateDot({ w }: { w: WebhookView }) {
  const { t } = useCms();
  const [color, label] = !w.enabled ? ["bg-muted-foreground/50", t("webhook_off")] : w.failures ? ["bg-amber-600", t("webhook_failing", { n: w.failures })] : ["bg-green-600", t("webhook_ok")];
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap rounded-full px-2 py-0 text-[11.5px] font-medium">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", color)} />
      {label}
    </Badge>
  );
}

export function CmsWebhooks({ className }: CmsWebhooksProps) {
  const { client, t, me } = useCms();
  const mobile = useIsMobile();
  const hooks = useAsync(() => client.webhooks(), [client]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<WebhookView | "new" | null>(null);
  const [created, setCreated] = React.useState<{ name: string; secret: string } | null>(null);

  const list = hooks.data?.webhooks ?? [];
  const open = list.find((w) => w.id === openId) ?? null;
  const off = hooks.data && !hooks.data.enabled;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("webhooks_title")}>
        <Button type="button" className="gap-1.5" size={mobile ? "sm" : "default"} disabled={!!off} onClick={() => setEditing("new")}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("webhook_new")}
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-w-0 flex-1 overflow-x-auto px-4 py-4 md:px-6">
          <StatusText tone={hooks.error ? "error" : "muted"} className="mb-2 text-xs">
            {hooks.error ? errorMessage(hooks.error, t) : hooks.loading && !hooks.data ? t("loading") : ""}
          </StatusText>
          {hooks.error ? (
            <Button type="button" variant="outline" size="sm" className="mb-3" onClick={hooks.reload}>
              {t("retry")}
            </Button>
          ) : null}
          {/* Turned off on this server: say what it means for the person, the setting for whoever runs it. */}
          {off ? <EmptyState icon={Webhook} title={t("webhooks_off_title")} text={t("webhooks_off_text")} action={<span className="text-xs text-muted-foreground">{t("webhooks_need_key")}</span>} /> : null}
          {hooks.data && !off && !list.length ? (
            <EmptyState
              icon={Webhook}
              title={t("webhooks_empty")}
              text={t("webhooks_empty_text")}
              action={
                <Button type="button" size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
                  <Plus aria-hidden className="h-4 w-4" />
                  {t("webhook_new")}
                </Button>
              }
            />
          ) : null}
          {list.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("webhook_name")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("webhook_events")}</TableHead>
                  <TableHead>{t("webhook_state")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((w) => (
                  <TableRow key={w.id} data-state={w.id === openId ? "selected" : undefined}>
                    <TableCell className="max-w-0 md:max-w-[22rem]">
                      <button type="button" className="block w-full truncate text-left font-medium outline-none hover:underline focus-visible:underline" aria-expanded={w.id === openId}
                        onClick={() => {
                          setOpenId(w.id === openId ? null : w.id);
                          // The state can change behind the screen (a cron call switches a failing one off).
                          if (w.id !== openId) hooks.reload();
                        }}
                      >
                        {w.name}
                      </button>
                      <div className="truncate font-mono text-xs text-muted-foreground">{w.url}</div>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{eventNames(w.events, t)}</TableCell>
                    <TableCell>
                      <StateDot w={w} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </div>
        {open ? (
          <WebhookPanel
            key={open.id}
            hook={open}
            onEdit={() => setEditing(open)}
            onChanged={hooks.reload}
            onDeleted={() => {
              setOpenId(null);
              hooks.reload();
            }}
          />
        ) : null}
      </div>
      <WebhookDialog
        target={editing}
        events={hooks.data?.events ?? []}
        collections={(me?.collections ?? []).map((c) => ({ slug: c.slug, label: c.label }))}
        onClose={() => setEditing(null)}
        onSaved={(w, secret) => {
          setEditing(null);
          setOpenId(w.id);
          if (secret) setCreated({ name: w.name, secret });
          hooks.reload();
        }}
      />
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className={DIALOG.md}>
          <DialogHeader>
            <DialogTitle>{t("webhook_created", { name: created?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("webhook_created_text")}</DialogDescription>
          </DialogHeader>
          <CodeBox value={created?.secret ?? ""} secret={created?.secret} label={t("webhook_secret")} multiline />
          <CodeBox value={'const event = await verifyWebhook(req, process.env.CMS_WEBHOOK_SECRET);'} label="verifyWebhook" multiline />
          <DialogFooter>
            <Button type="button" onClick={() => setCreated(null)}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A failure whose message is already written for the person. */
class Failed extends Error {}

function WebhookPanel({ hook, onEdit, onChanged, onDeleted }: { hook: WebhookView; onEdit: () => void; onChanged: () => void; onDeleted: () => void }) {
  const { client, t, locale } = useCms();
  const log = useAsync(() => client.webhookDeliveries(hook.id, 50), [client, hook.id, hook.updatedAt]);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" | "muted" }>({ text: "", tone: "muted" });
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  /** `fn` returns the line to show; a `Failed` it throws is shown as written, anything else through errorMessage. */
  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setStatus({ text: "", tone: "muted" });
    try {
      setStatus({ text: await fn(), tone: "ok" });
    } catch (e) {
      if (e instanceof Failed) return setStatus({ text: e.message, tone: "error" });
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
      log.reload();
      onChanged();
    }
  }
  const result = (d: WebhookDelivery) => (d.status === null ? (d.error ?? t("webhook_no_answer")) : String(d.status));

  return (
    <aside aria-label={hook.name} className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t px-4 py-4 md:w-[22rem] md:border-l md:border-t-0">
      <div>
        <h2 className="truncate text-sm font-semibold">{hook.name}</h2>
        <p className="break-all font-mono text-xs text-muted-foreground">{hook.url}</p>
        {hook.disabledReason ? <p className="mt-2 text-xs text-amber-700">{t("webhook_auto_off", { reason: hook.disabledReason })}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const d = await client.testWebhook(hook.id);
              if (!d.ok) throw new Failed(t("webhook_test_failed", { result: result(d) }));
              return t("webhook_test_ok", { ms: d.responseMs ?? 0 });
            })
          }
        >
          <Send aria-hidden className="h-3.5 w-3.5" />
          {t("webhook_test")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          {t("edit")}
        </Button>
        {hook.enabled ? null : (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act(async () => (await client.updateWebhook(hook.id, { enabled: true }), t("webhook_turned_on")))}>
            {t("webhook_turn_on")}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setConfirming(true)}>
          {t("action_delete")}
        </Button>
      </div>
      <StatusText tone={status.tone} className="text-xs">
        {status.text}
      </StatusText>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">{t("webhook_secret")}</h3>
        {secret ? (
          <CodeBox value={secret} secret={secret} label={t("webhook_secret")} multiline />
        ) : (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">whsec_••••••••••••</code>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => client.webhookSecret(hook.id).then(setSecret, (e) => setStatus({ text: errorMessage(e, t), tone: "error" }))}>
              {t("webhook_show")}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">{t("webhook_history")}</h3>
        <StatusText className="text-xs">{log.error ? errorMessage(log.error, t) : log.data && !log.data.length ? t("webhook_history_empty") : ""}</StatusText>
        <ul className="flex flex-col divide-y" aria-label={t("webhook_history")}>
          {(log.data ?? []).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 text-xs">
              {/* In words first, the HTTP code after: "Delivered · 200", "Refused · 500", "No answer". */}
              <span className={cn("shrink-0 font-medium", d.ok ? "text-green-700 dark:text-green-400" : "text-destructive")} title={d.error ?? undefined}>
                {d.ok ? t("webhook_delivered") : d.status === null ? t("webhook_no_answer_short") : t("webhook_refused")}
                {d.status !== null ? <span className="ml-1 font-mono font-normal text-muted-foreground">{d.status}</span> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {d.event === "ping" ? t("webhook_ping") : t(`event.${d.event}` as never)}
                {typeof d.payload.slug === "string" ? <span className="text-muted-foreground">, {d.payload.slug}</span> : null}
                {d.attempt > 1 ? <span className="text-muted-foreground"> · {t("webhook_attempt", { n: d.attempt })}</span> : null}
              </span>
              {d.ok || d.event === "ping" ? (
                <time className="shrink-0 text-muted-foreground" dateTime={d.at} title={new Date(d.at).toLocaleString(locale, { timeZoneName: "short" })}>
                  {relativeTime(d.at, t, locale)}
                </time>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-xs" disabled={busy} onClick={() => act(async () => (await client.retryDelivery(d.id), t("webhook_resent")))}>
                  <RotateCw aria-hidden className="h-3 w-3" />
                  {t("webhook_resend")}
                </Button>
              )}
              {/* The reason is readable without hovering (phones): under the row. */}
              {!d.ok && d.error ? (
                <span className="basis-full break-words text-destructive">
                  {d.error}
                  <span className="text-muted-foreground"> · {new Date(d.at).toLocaleString(locale)}</span>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("webhook_delete_title", { name: hook.name })}
        description={t("webhook_delete_text")}
        confirmLabel={t("action_delete")}
        destructive
        busy={busy}
        onConfirm={() => act(async () => (await client.removeWebhook(hook.id), onDeleted(), ""))}
      />
    </aside>
  );
}

function WebhookDialog({ target, events, collections, onClose, onSaved }: { target: WebhookView | "new" | null; events: readonly WebhookEvent[]; collections: { slug: string; label: string }[]; onClose: () => void; onSaved: (w: WebhookView, secret?: string) => void }) {
  const { client, t } = useCms();
  const cur = target && target !== "new" ? target : null;
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [picked, setPicked] = React.useState<WebhookEvent[]>([]);
  // "Every event" is a choice of its own: unticking the last event must not quietly mean "all".
  const [every, setEvery] = React.useState(true);
  const [cols, setCols] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!target) return;
    setName(cur?.name ?? "");
    setUrl(cur?.url ?? "");
    setPicked(cur?.events ?? []);
    setEvery(!cur?.events?.length);
    setCols(cur?.collections ?? []);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { name, url, events: every ? [] : picked, collections: cols };
      if (cur) onSaved(await client.updateWebhook(cur.id, input));
      else {
        const r = await client.createWebhook(input);
        onSaved(r.webhook, r.secret);
      }
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  const toggle = <V extends string>(list: V[], v: V, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={DIALOG.lg}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{cur ? t("webhook_edit_title") : t("webhook_new")}</DialogTitle>
            <DialogDescription>{t("webhook_dialog_text")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cms-webhook-name">{t("webhook_name")}</Label>
            <Input id="cms-webhook-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cms-webhook-url">{t("webhook_url")}</Label>
            <Input id="cms-webhook-url" type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} required className="font-mono text-sm" />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t("webhook_events")}</legend>
            <Segmented
              label={t("webhook_events")}
              value={every ? "all" : "some"}
              onChange={(v) => setEvery(v === "all")}
              options={[
                { value: "all", label: t("webhook_every_event") },
                { value: "some", label: t("webhook_only_these") },
              ]}
            />
            {/* Grouped by what they are about, each group with its own "all". */}
            {every ? <p className="text-xs text-muted-foreground">{t("webhook_every_event_text")}</p> : null}
            {!every && !picked.length ? <p className="text-xs text-amber-700 dark:text-amber-400">{t("webhook_pick_one")}</p> : null}
            <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", every && "hidden")}>
              {groupEvents(events).map(([group, evs]) => {
                const on = evs.filter((ev) => picked.includes(ev)).length;
                return (
                  <div key={group} role="group" aria-label={t(`event_group.${group}` as never)} className="flex min-w-0 flex-col gap-1.5 rounded-md border p-2.5">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={on === evs.length}
                        aria-checked={on === evs.length ? "true" : on ? "mixed" : "false"}
                        onCheckedChange={(v) => setPicked((p) => (v === true ? [...new Set([...p, ...evs])] : p.filter((x) => !evs.includes(x))))}
                      />
                      {t(`event_group.${group}` as never)}
                    </label>
                    {evs.map((ev) => (
                      <label key={ev} className="ml-6 flex items-center gap-2 text-sm">
                        <Checkbox checked={picked.includes(ev)} onCheckedChange={(v) => setPicked((p) => toggle(p, ev, v === true))} />
                        {t(`event.${ev}` as never)}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </fieldset>
          {collections.length > 1 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t("webhook_collections")}</legend>
              <p className="text-xs text-muted-foreground">{t("webhook_collections_help")}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {collections.map((c) => (
                  <label key={c.slug} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={cols.includes(c.slug)} onCheckedChange={(on) => setCols((p) => toggle(p, c.slug, on === true))} />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <StatusText tone="error" className="text-xs">
            {error}
          </StatusText>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!every && !picked.length)}>
              {cur ? t("save") : t("webhook_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
