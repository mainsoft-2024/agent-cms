// agent-cms registry: cms-plugins (0.24.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Plugins: the list (name, version, state, what each adds), and for the selected one its
// details, why it failed to start, the plugins switched off with it, its settings (a form
// drawn from the plugin's schema) and "Restart". Plugins are added in code
// (`createCms({ plugins })`); this screen only shows how they run. Admins only.
"use client";

import * as React from "react";
import { ArrowLeft, Puzzle, RotateCw, Settings } from "lucide-react";
import type { PluginInfo, PluginSettingsView, SettingField } from "@mainsoft/agent-cms/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, type T } from "./cms-messages";
import { DIALOG, EmptyState, NativeSelect, PageHeader, StatusText } from "./cms-parts";
import { useAsync, useCms, useIsMobile } from "./use-cms";

export interface CmsPluginsProps {
  className?: string;
  /** Open a plugin's page (default: go to its address). */
  onOpenPage?: (href: string) => void;
}

const REGISTERED = ["routes", "tools", "events", "jobs", "hooks", "collections", "fields", "actions", "filters", "access", "rankers", "nav"] as const;

/** "Routes 2 · Tools 1 · Pages 1" for what a plugin adds. */
export function addedText(p: PluginInfo, t: T, pages = 0): string {
  const parts = ([...REGISTERED, "me", "sql"] as const).filter((k) => (p.registered[k] ?? 0) > 0).map((k) => `${t(`plugin_reg_${k}`)} ${p.registered[k]}`);
  if (pages) parts.push(`${t("plugin_reg_pages")} ${pages}`);
  if (p.settings?.length) parts.push(t("plugin_settings"));
  return parts.length ? parts.join(" · ") : t("plugin_added_none");
}

/** The name people read: the admin plugin's label, the screen's name for a built-in one, else the name. */
export function pluginLabel(p: { name: string; builtin?: boolean }, t: T, label: (name: string) => string): string {
  if (p.builtin && (p.name === "webhooks" || p.name === "automations")) return t(p.name === "webhooks" ? "nav_webhooks" : "nav_automations");
  return label(p.name);
}

/** 0.24.1: what a plugin added, by name, kind by kind (older servers send counts only: null). */
export function addedRows(p: PluginInfo, t: T, pages: string[] = []): { kind: string; name: string }[] | null {
  if (!p.added) return null;
  const order = [...REGISTERED, "me", "sql"] as string[];
  const rows = [...p.added]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map((a) => ({ kind: t(`plugin_reg_${a.kind}`), name: a.kind === "sql" ? t("plugin_sql_count", { n: a.name }) : a.kind === "events" && a.name === "*" ? t("plugin_events_all") : a.name }));
  for (const href of pages) rows.push({ kind: t("plugin_reg_pages"), name: href });
  for (const f of p.settings ?? []) rows.push({ kind: t("plugin_settings"), name: f });
  return rows;
}

/** The plugins that need `name` and are off because of it. */
const dependents = (list: PluginInfo[], name: string) => list.filter((x) => x.requires.includes(name) && x.state === "off");

function stateLabel(p: PluginInfo, t: T): string {
  if (p.state === "off" && p.requires.length) return t("plugin_state_off_dep");
  return t(`plugin_state_${p.state}`);
}

function StateMark({ p }: { p: PluginInfo }) {
  const { t } = useCms();
  const tone = p.state === "running" ? "bg-emerald-500" : p.state === "failed" ? "bg-destructive" : p.state === "off" ? "bg-muted-foreground/50" : "bg-amber-500";
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-sm", p.state === "failed" && "font-medium text-destructive")}>
      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", tone)} />
      {stateLabel(p, t)}
    </span>
  );
}

export function CmsPlugins({ className, onOpenPage }: CmsPluginsProps) {
  const { client, t, runtime, locale, reloadMe } = useCms();
  const mobile = useIsMobile();
  const plugins = useAsync(() => client.plugins(), [client]);
  const [openName, setOpenName] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  // On a phone the list and the panel replace each other: put focus back on the row on "Back".
  const rows = React.useRef(new Map<string, HTMLButtonElement>());
  const returnTo = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (openName || !returnTo.current) return;
    rows.current.get(returnTo.current)?.focus();
    returnTo.current = null;
  }, [openName]);

  const list = plugins.data?.plugins ?? [];
  const open = list.find((p) => p.name === openName) ?? null;
  const failed = list.filter((p) => p.state === "failed").length;
  const pagesOf = (name: string) => Object.keys(runtime.plugins.find((p) => p.name === name)?.pages ?? {}).length;
  const label = (p: PluginInfo) => pluginLabel(p, t, (n) => runtime.label(n, locale));
  const changed = () => {
    plugins.reload();
    reloadMe();
  };

  const panel = open ? (
    <PluginPanel
      key={open.name}
      plugin={open}
      all={list}
      label={label(open)}
      pageHref={runtime.page(open.name, []) ? runtime.href(open.name) : null}
      onOpenPage={onOpenPage}
      onSettings={() => setEditing(open.name)}
      onChanged={changed}
      onBack={
        mobile
          ? () => {
              returnTo.current = open.name;
              setOpenName(null);
            }
          : undefined
      }
    />
  ) : null;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {mobile && panel ? (
        panel
      ) : (
        <>
          <PageHeader
            title={t("plugins_title")}
            after={plugins.data ? <span className={cn("text-sm", failed ? "text-destructive" : "text-muted-foreground")}>{failed ? t("plugins_count_failed", { n: list.length, failed }) : t("plugins_count", { n: list.length })}</span> : null}
          />
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="relative min-w-0 flex-1 overflow-x-auto px-4 py-4 md:px-6">
              <StatusText tone={plugins.error ? "error" : "muted"} className="mb-2 text-xs">
                {plugins.error ? errorMessage(plugins.error, t) : plugins.loading && !plugins.data ? t("loading") : ""}
              </StatusText>
              {plugins.error ? (
                <Button type="button" variant="outline" size="sm" className="mb-3" onClick={plugins.reload}>
                  {t("retry")}
                </Button>
              ) : null}
              {plugins.data && !list.length ? <EmptyState icon={Puzzle} title={t("plugins_empty")} text={t("plugins_empty_text")} /> : null}
              {list.length ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("plugin_col_name")}</TableHead>
                        <TableHead className="hidden sm:table-cell">{t("plugin_col_version")}</TableHead>
                        <TableHead>{t("plugin_col_state")}</TableHead>
                        <TableHead className="hidden lg:table-cell">{t("plugin_col_added")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((p) => (
                        <TableRow key={p.name} data-state={p.name === openName ? "selected" : undefined}>
                          <TableCell className="max-w-0 md:max-w-[18rem]">
                            <button
                              type="button"
                              ref={(el) => {
                                if (el) rows.current.set(p.name, el);
                                else rows.current.delete(p.name);
                              }}
                              className="block w-full truncate text-left font-medium outline-none hover:underline focus-visible:underline"
                              aria-expanded={mobile ? undefined : p.name === openName}
                              onClick={() => {
                                setOpenName(p.name === openName && !mobile ? null : p.name);
                                if (p.name !== openName) plugins.reload();
                              }}
                            >
                              <bdi>{label(p)}</bdi>
                            </button>
                            {label(p) !== p.name ? <div className="hidden truncate font-mono text-xs text-muted-foreground sm:block">{p.name}</div> : null}
                            {/* On a phone the version and "what it adds" columns are hidden: one line under the name instead. */}
                            <div className={cn("line-clamp-2 break-words text-xs sm:hidden", p.state === "failed" ? "font-mono text-foreground" : "text-muted-foreground")}>
                              {p.state === "failed" && p.error ? p.error : `${p.builtin ? t("plugin_builtin") : (p.version ?? "—")} · ${addedText(p, t, pagesOf(p.name))}`}
                            </div>
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap font-mono text-xs text-muted-foreground sm:table-cell">{p.builtin ? t("plugin_builtin") : (p.version ?? "—")}</TableCell>
                          <TableCell>
                            <StateMark p={p} />
                          </TableCell>
                          <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{addedText(p, t, pagesOf(p.name))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-4 text-xs text-muted-foreground">{t("plugins_note")}</p>
                </>
              ) : null}
            </div>
            {panel}
          </div>
        </>
      )}
      <PluginSettingsDialog
        name={editing}
        label={editing ? runtime.label(editing, locale) : ""}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          changed();
        }}
      />
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <dt className="w-20 shrink-0 text-muted-foreground">{k}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

function PluginPanel({ plugin: p, all, label, pageHref, onOpenPage, onSettings, onChanged, onBack }: {
  plugin: PluginInfo;
  all: PluginInfo[];
  label: string;
  pageHref: string | null;
  onOpenPage?: (href: string) => void;
  onSettings: () => void;
  onChanged: () => void;
  onBack?: () => void;
}) {
  const { client, t, runtime, toast, locale } = useCms();
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" | "muted" }>({ text: "", tone: "muted" });
  const offWithIt = dependents(all, p.name);
  const needs = p.requires.filter((r) => all.find((x) => x.name === r)?.state !== "running");
  const pageKeys = Object.keys(runtime.plugins.find((x) => x.name === p.name)?.pages ?? {});
  const pages = pageKeys.length;
  const named = addedRows(p, t, pageKeys.map((k) => (k ? `${runtime.href(p.name)}/${k}` : runtime.href(p.name))));
  const heading = React.useRef<HTMLSpanElement>(null);
  const mobileView = !!onBack;
  React.useEffect(() => {
    // The panel took the list's place on a phone: start reading it from its title.
    if (mobileView) heading.current?.focus();
  }, [mobileView]);

  async function restart() {
    setBusy(true);
    setStatus({ text: "", tone: "muted" });
    try {
      const { plugin } = await client.restartPlugin(p.name);
      if (plugin.state === "failed") setStatus({ text: t("plugin_restart_failed", { error: plugin.error ?? "" }), tone: "error" });
      else if (plugin.state === "off") setStatus({ text: t("plugin_restart_still_off", { names: plugin.requires.join(", ") }), tone: "error" });
      else {
        setStatus({ text: "", tone: "muted" });
        toast(t("plugin_restarted"), { tone: "ok" });
      }
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const body = (
    <>
      {p.state === "failed" ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">{t("plugin_failed_title")}</p>
          {p.error ? <p className="mt-1 break-words font-mono text-xs">{p.error}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{t("plugin_failed_blocked")}</p>
        </div>
      ) : null}
      {p.state === "off" && needs.length ? <p className="rounded-md border p-3 text-sm text-muted-foreground">{t("plugin_off_needs", { names: needs.join(", ") })}</p> : null}
      {offWithIt.length ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">{t("plugin_dependents_off", { names: offWithIt.map((x) => pluginLabel(x, t, (n) => runtime.label(n, locale))).join(", ") })}</p>
      ) : null}
      <dl>
        <Row k={t("plugin_name")}>
          <span className="font-mono text-xs">{p.name}</span>
        </Row>
        <Row k={t("plugin_version")}>{p.builtin ? t("plugin_builtin") : (p.version ?? "—")}</Row>
        {p.engine ? <Row k={t("plugin_engine")}>{p.engine}</Row> : null}
        <Row k={t("plugin_requires")}>{p.requires.length ? p.requires.join(", ") : t("plugin_requires_none")}</Row>
        {p.startedMs !== null ? <Row k={t("plugin_started")}>{t("plugin_started_ms", { ms: Math.round(p.startedMs) })}</Row> : null}
        {p.required ? <Row k={t("plugin_required")}>{t("plugin_required_text")}</Row> : null}
      </dl>
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t("plugin_attached")}</h3>
        {named ? (
          named.length ? (
            <ul role="list" className="divide-y rounded-md border text-sm">
              {named.map((r, i) => (
                <li key={i} className="flex gap-3 px-3 py-1.5">
                  <span className="w-20 shrink-0 text-muted-foreground">{r.kind}</span>
                  <span className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{r.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("plugin_added_none")}</p>
          )
        ) : (
          <p className="text-sm">{addedText(p, t, pages)}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {p.settings?.length ? (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onSettings}>
            <Settings aria-hidden className="h-4 w-4" />
            {t("plugin_settings")}
          </Button>
        ) : null}
        {pageHref && p.state !== "failed" && p.state !== "off" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => (onOpenPage ?? ((h: string) => window.location.assign(h)))(pageHref)}>
            {t("plugin_open_page")}
          </Button>
        ) : null}
        {p.state === "failed" || p.state === "off" ? (
          <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={restart}>
            <RotateCw aria-hidden className={cn("h-4 w-4", busy && "motion-safe:animate-spin")} />
            {t("plugin_restart")}
          </Button>
        ) : null}
      </div>
      <StatusText tone={status.tone} className="text-xs">
        {status.text}
      </StatusText>
    </>
  );

  if (onBack)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader
          title={
            <span ref={heading} tabIndex={-1} className="outline-none">
              <bdi>{label}</bdi>
            </span>
          }
          after={<StateMark p={p} />}
          back={
            <Button type="button" variant="ghost" size="icon" className="-ml-2 h-8 w-8" aria-label={t("plugins_title")} onClick={onBack}>
              <ArrowLeft aria-hidden className="h-4 w-4" />
            </Button>
          }
        />
        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">{body}</div>
      </div>
    );
  return (
    <aside aria-label={label} className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t px-4 py-4 md:w-[22rem] md:border-l md:border-t-0">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          <bdi>{label}</bdi>
        </h2>
        <StateMark p={p} />
      </div>
      {body}
    </aside>
  );
}

// ── settings ─────────────────────────────────────────────────────────────────

/** What the form keeps for each field (text for inputs, a boolean for checkboxes). */
type Draft = Record<string, string | boolean>;

function draftOf(view: PluginSettingsView): Draft {
  const d: Draft = {};
  for (const f of view.fields) {
    const v = view.values[f.key] ?? f.default;
    if (f.type === "secret") d[f.key] = "";
    else if (f.type === "boolean") d[f.key] = v === true;
    else if (f.type === "json") d[f.key] = v === undefined ? "" : JSON.stringify(v, null, 2);
    else if (f.type === "enum") {
      const i = (f.choices ?? f.options ?? []).findIndex((c) => c === v);
      d[f.key] = i < 0 ? "" : String(i);
    } else d[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return d;
}

/**
 * The values to send, or the first problem to show. A secret left empty keeps what is stored.
 * A field the user did not touch is sent back exactly as stored (`keep`), so saving one field
 * never changes another (`null` stays `null`, `1` stays a number).
 */
export function settingsValues(fields: SettingField[], draft: Draft, t: T, keep: { values: Record<string, unknown>; touched: ReadonlySet<string> } | null = null): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = draft[f.key];
    if (keep && f.type !== "secret" && !keep.touched.has(f.key)) {
      if (keep.values[f.key] !== undefined) values[f.key] = keep.values[f.key];
      continue;
    }
    if (f.type === "boolean") {
      values[f.key] = raw === true;
      continue;
    }
    const rawText = typeof raw === "string" ? raw : "";
    const text = rawText.trim();
    // Text fields keep what was typed, spaces too; an empty one is left unset.
    if (f.type === "string" || f.type === "url" || f.type === "secret") {
      if (rawText !== "") values[f.key] = f.type === "url" ? text : rawText;
      continue;
    }
    if (!text) continue;
    if (f.type === "enum") {
      const list = f.choices ?? f.options ?? [];
      const i = Number(text);
      if (Number.isInteger(i) && i >= 0 && i < list.length) values[f.key] = list[i];
      continue;
    }
    if (f.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) return { error: t("plugin_number_invalid", { field: f.label }) };
      values[f.key] = n;
    } else if (f.type === "json") {
      try {
        values[f.key] = JSON.parse(text);
      } catch {
        return { error: t("plugin_json_invalid", { field: f.label }) };
      }
    } else values[f.key] = rawText;
  }
  return { values };
}

function PluginSettingsDialog({ name, label, onClose, onSaved }: { name: string | null; label: string; onClose: () => void; onSaved: () => void }) {
  const { client, t, toast } = useCms();
  const view = useAsync(() => (name ? client.pluginSettings(name).then((r) => r.settings) : Promise.resolve(null)), [client, name]);
  const [draft, setDraft] = React.useState<Draft>({});
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const id = React.useId();
  React.useEffect(() => {
    if (view.data) setDraft(draftOf(view.data));
    setTouched(new Set());
    setError("");
  }, [view.data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !view.data) return;
    const out = settingsValues(view.data.fields, draft, t, { values: view.data.values, touched });
    if ("error" in out) return setError(out.error);
    setBusy(true);
    setError("");
    try {
      const { plugin } = await client.savePluginSettings(name, out.values);
      if (plugin.state === "failed") toast(t("plugin_saved_failed", { error: plugin.error ?? "" }), { tone: "error" });
      else if (plugin.state === "off") toast(t("plugin_saved_off"), { tone: "info" });
      else toast(t("plugin_saved"), { tone: "ok" });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const fields = view.data?.fields ?? [];
  const set = (k: string, v: string | boolean) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setTouched((s) => (s.has(k) ? s : new Set([...s, k])));
  };
  return (
    <Dialog open={!!name} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className={DIALOG.md}>
        <DialogHeader>
          <DialogTitle>{t("plugin_settings_title", { name: label })}</DialogTitle>
          <DialogDescription>{t("plugin_settings_text")}</DialogDescription>
        </DialogHeader>
        {view.loading && !view.data ? <StatusText className="text-sm">{t("loading")}</StatusText> : null}
        {view.error ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusText tone="error" className="text-sm">
              {errorMessage(view.error, t)}
            </StatusText>
            <Button type="button" variant="outline" size="sm" onClick={view.reload}>
              {t("retry")}
            </Button>
          </div>
        ) : null}
        {view.data ? (
          <form id={`${id}-form`} onSubmit={save} className="flex flex-col gap-4">
            {fields.map((f) => {
              const fid = `${id}-${f.key}`;
              const help = `${fid}-help`;
              const stored = f.type === "secret" && view.data!.values[f.key] !== null && view.data!.values[f.key] !== undefined;
              if (f.type === "boolean")
                return (
                  <div key={f.key} className="flex items-center gap-2">
                    <Checkbox id={fid} checked={draft[f.key] === true} onCheckedChange={(c) => set(f.key, c === true)} />
                    <Label htmlFor={fid} className="font-normal">
                      {f.label}
                    </Label>
                  </div>
                );
              return (
                <div key={f.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={fid} className="flex items-center gap-2">
                    {f.label}
                    {f.type === "secret" ? <Badge variant="secondary">{t("plugin_secret")}</Badge> : null}
                  </Label>
                  {f.type === "enum" ? (
                    <NativeSelect id={fid} value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                      {f.optional && f.default === undefined ? <option value="">—</option> : null}
                      {(f.options ?? []).map((o, i) => (
                        <option key={`${i}-${o}`} value={String(i)}>
                          {o}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : f.type === "json" ? (
                    <Textarea id={fid} aria-describedby={help} className="min-h-24 font-mono text-xs" value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
                  ) : (
                    <Input
                      id={fid}
                      aria-describedby={help}
                      type={f.type === "secret" ? "password" : f.type === "url" ? "url" : f.type === "number" ? "number" : "text"}
                      autoComplete={f.type === "secret" ? "new-password" : undefined}
                      step={f.type === "number" ? "any" : undefined}
                      inputMode={f.type === "number" ? "decimal" : undefined}
                      placeholder={stored ? "••••••••" : f.default !== undefined ? String(f.default) : undefined}
                      className={f.type === "url" || f.type === "secret" ? "font-mono text-sm" : undefined}
                      value={String(draft[f.key] ?? "")}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  )}
                  <p id={help} className="text-xs text-muted-foreground">
                    {f.type === "secret" ? (stored ? t("plugin_secret_stored") : t("plugin_secret_new")) : f.type === "json" ? t("plugin_json_help") : f.default !== undefined && f.type !== "enum" ? t("plugin_default", { value: String(f.default) }) : ""}
                  </p>
                </div>
              );
            })}
          </form>
        ) : null}
        <StatusText tone="error" className="text-sm">
          {error}
        </StatusText>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={busy || !view.data}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
