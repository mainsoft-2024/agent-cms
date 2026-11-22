// agent-cms registry: cms-keys (0.14.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// API keys for agents and scripts: list (scopes, collections, last used,
// expiry), revoke, and create. A new key's secret is shown once, with the
// MCP config and the CLI .env lines to copy.
"use client";

import * as React from "react";
import { CircleCheck, Plus, KeyRound } from "lucide-react";
import type { CmsKey, KeyScope } from "@mainsoft/agent-cms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { CodeBox, ConfirmDialog, PageHeader, Segmented, StatusText, DIALOG, EmptyState } from "./cms-parts";
import { cmsUrl, formatDate, relativeTime, useAsync, useCms, useIsMobile } from "./use-cms";

const SCOPES: KeyScope[] = ["read", "write", "publish", "admin"];
type Expiry = "none" | "30" | "90" | "365" | "custom";

export interface CmsKeysProps {
  /** Name of the MCP server in the copied config. Default "agent-cms". */
  mcpServerName?: string;
  className?: string;
}

export function CmsKeys({ mcpServerName = "agent-cms", className }: CmsKeysProps) {
  const { client, t, locale, me } = useCms();
  const mobile = useIsMobile();
  const keys = useAsync(() => client.keys(), [client]);
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState<{ key: CmsKey; secret: string } | null>(null);
  const [revoking, setRevoking] = React.useState<CmsKey | null>(null);
  const [rotating, setRotating] = React.useState<CmsKey | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const colLabel = (slug: string) => me?.collections.find((c) => c.slug === slug)?.label ?? slug;
  const now = Date.now();

  // A new secret for the same key. The old one keeps working for an hour, so nothing breaks while people switch.
  const rotate = async () => {
    if (!rotating) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.rotateKey(rotating.id);
      setRotating(null);
      setCreated(r);
      keys.reload();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    try {
      await client.revokeKey(revoking.id);
      setRevoking(null);
      keys.reload();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const list = keys.data ?? [];

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("keys_title")}>
        <Button type="button" className="gap-1.5" size={mobile ? "sm" : "default"} onClick={() => setCreating(true)}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("new_key")}
        </Button>
      </PageHeader>
      <div className="relative min-w-0 flex-1 overflow-x-auto px-4 py-4 md:px-6">
        <StatusText tone={keys.error ? "error" : "muted"} className="mb-2 text-xs">
          {keys.error ? errorMessage(keys.error, t) : keys.loading && !keys.data ? t("loading") : ""}
        </StatusText>
        {keys.data && !list.length && !keys.error ? <EmptyState icon={KeyRound} title={t("no_keys")} text={t("keys_empty_text")} /> : null}
        {list.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("key_name")}</TableHead>
                <TableHead>{t("key_key")}</TableHead>
                <TableHead>{t("key_scopes")}</TableHead>
                <TableHead>{t("key_collections")}</TableHead>
                <TableHead>{t("key_last_used")}</TableHead>
                <TableHead>{t("key_expires")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("col_actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((k) => {
                const expired = !!k.expiresAt && Date.parse(k.expiresAt) <= now;
                // A rotated key has a revoke time in the future: it still works until then.
                const revoked = !!k.revokedAt && Date.parse(k.revokedAt) <= now;
                const leaving = !!k.revokedAt && !revoked;
                const dead = expired || revoked;
                const limits = [k.rateLimit ? t("key_per_minute", { n: k.rateLimit }) : null, ...(k.allowedIps ?? [])].filter(Boolean).join(" · ");
                return (
                  <TableRow key={k.id} className={cn(dead && "text-muted-foreground")}>
                    <TableCell className={cn(!dead && "font-medium")}>
                      {k.name}
                      {limits ? <span className="block text-xs font-normal text-muted-foreground">{limits}</span> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{k.prefix}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} variant="outline" className="rounded-full px-2 py-0 text-[11.5px] font-medium">
                            {s}
                          </Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell className="text-[13.5px]">{k.collections?.length ? k.collections.map(colLabel).join(", ") : t("key_all_collections")}</TableCell>
                    <TableCell className="text-xs">{k.lastUsedAt ? relativeTime(k.lastUsedAt, t, locale) : t("key_none")}</TableCell>
                    <TableCell className="text-xs">
                      {expired ? (
                        <Badge variant="outline" className="rounded-full border-red-200 bg-red-50 px-2 py-0 text-[11.5px] text-red-700">
                          {t("key_expired")}
                        </Badge>
                      ) : k.expiresAt ? (
                        formatDate(k.expiresAt, locale, true)
                      ) : (
                        <span className="text-muted-foreground">{t("key_never")}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {revoked ? (
                        <Badge variant="outline" className="rounded-full border-red-200 bg-red-50 px-2 py-0 text-[11.5px] text-red-700" title={k.revokedReason && k.revokedReason !== "rotated" ? k.revokedReason : undefined}>
                          {k.revokedReason === "rotated" ? t("key_replaced") : t("key_revoked")}
                        </Badge>
                      ) : (
                        <span className="flex items-center justify-end gap-1">
                          {leaving ? (
                            <span className="text-xs text-muted-foreground">{t("key_works_until", { time: new Date(k.revokedAt!).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</span>
                          ) : (
                            <Button type="button" variant="ghost" size="sm" className="h-7" aria-label={`${t("key_rotate")}: ${k.name}`} onClick={() => setRotating(k)}>
                              {t("key_rotate")}
                            </Button>
                          )}
                          <Button type="button" variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive" aria-label={`${t("revoke")}: ${k.name}`} onClick={() => setRevoking(k)}>
                            {t("revoke")}
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </div>

      <NewKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(r) => {
          setCreating(false);
          setCreated(r);
          keys.reload();
        }}
      />

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className={DIALOG.lg}>{created ? <KeyCreated name={created.key.name} secret={created.secret} mcpServerName={mcpServerName} onClose={() => setCreated(null)} /> : null}</DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(o) => {
          if (!o) {
            setRotating(null);
            setError(null);
          }
        }}
        title={t("key_rotate_confirm", { name: rotating?.name ?? "" })}
        description={t("key_rotate_note")}
        confirmLabel={t("key_rotate")}
        busy={busy}
        error={error}
        onConfirm={rotate}
      />

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => {
          if (!o) {
            setRevoking(null);
            setError(null);
          }
        }}
        title={t("revoke_confirm", { name: revoking?.name ?? "" })}
        description={t("revoke_note")}
        confirmLabel={t("revoke")}
        destructive
        busy={busy}
        error={error}
        onConfirm={revoke}
      />
    </div>
  );
}

function NewKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: { key: CmsKey; secret: string }) => void }) {
  const { client, t, me } = useCms();
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<KeyScope[]>(["read", "write"]);
  const [cols, setCols] = React.useState<string[]>([]);
  const [expiry, setExpiry] = React.useState<Expiry>("none");
  const [date, setDate] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [ips, setIps] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setScopes(["read", "write"]);
      setCols([]);
      setExpiry("none");
      setDate("");
      setRate("");
      setIps("");
      setError(null);
    }
  }, [open]);

  const expiresAt = (): string | null => {
    if (expiry === "none") return null;
    // The key works through the whole chosen day in this browser's time zone: it ends at the next midnight.
    if (expiry === "custom") {
      if (!date) return null;
      const end = new Date(`${date}T00:00:00`);
      end.setDate(end.getDate() + 1);
      return end.toISOString();
    }
    return new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const until = expiresAt();
    if (until && Date.parse(until) <= Date.now()) return setError(t("key_expiry_past"));
    setBusy(true);
    setError(null);
    try {
      const allowedIps = ips.split(/[\s,]+/).filter(Boolean);
      const r = await client.createKey({ name: name.trim(), scopes, collections: cols.length ? cols : null, expiresAt: expiresAt(), ...(rate.trim() ? { rateLimit: Number(rate) } : {}), ...(allowedIps.length ? { allowedIps } : {}) });
      onCreated(r);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG.md}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("new_key")}</DialogTitle>
            <DialogDescription className="sr-only">{t("scope_help")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cms-key-name" className="text-xs text-muted-foreground">
              {t("key_name")}
            </Label>
            <Input id="cms-key-name" value={name} required maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>
          <fieldset className="flex flex-col gap-1.5" aria-describedby="cms-key-scopes-help">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t("key_scopes")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {SCOPES.map((s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <Checkbox id={`cms-key-scope-${s}`} checked={scopes.includes(s)} onCheckedChange={(v) => setScopes((x) => toggle(x, s, v === true))} />
                  <Label htmlFor={`cms-key-scope-${s}`} className="font-normal">
                    {s}
                  </Label>
                </div>
              ))}
            </div>
            <p id="cms-key-scopes-help" className="text-xs text-muted-foreground">
              {t("scope_help")}
            </p>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5" aria-describedby="cms-key-cols-help">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t("key_collections")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {(me?.collections ?? []).map((c) => (
                <div key={c.slug} className="flex items-center gap-1.5">
                  <Checkbox id={`cms-key-col-${c.slug}`} checked={cols.includes(c.slug)} onCheckedChange={(v) => setCols((x) => toggle(x, c.slug, v === true))} />
                  <Label htmlFor={`cms-key-col-${c.slug}`} className="font-normal">
                    {c.label}
                  </Label>
                </div>
              ))}
            </div>
            <p id="cms-key-cols-help" className="text-xs text-muted-foreground">
              {t("collections_help")}
            </p>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <span id="cms-key-expiry" className="text-xs font-medium text-muted-foreground">
              {t("key_expires")}
            </span>
            <Segmented
              labelledBy="cms-key-expiry"
              value={expiry}
              onChange={setExpiry}
              options={[
                { value: "none", label: t("expiry_none") },
                { value: "30", label: t("expiry_30") },
                { value: "90", label: t("expiry_90") },
                { value: "365", label: t("expiry_365") },
                { value: "custom", label: t("expiry_custom") },
              ]}
            />
            {expiry === "custom" ? (
              <div className="mt-1 flex flex-col gap-1.5">
                <Label htmlFor="cms-key-date" className="text-xs text-muted-foreground">
                  {t("expiry_date")}
                </Label>
                <Input id="cms-key-date" type="date" required value={date} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[150px_1fr]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cms-key-rate" className="text-xs font-medium text-muted-foreground">
                {t("key_rate")}
              </Label>
              <Input id="cms-key-rate" type="number" inputMode="numeric" min={1} max={100000} step={1} placeholder={t("key_rate_hint")} value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="cms-key-ips" className="text-xs font-medium text-muted-foreground">
                {t("key_ips")}
              </Label>
              <Input id="cms-key-ips" placeholder="203.0.113.0/24" aria-describedby="cms-key-ips-hint" value={ips} onChange={(e) => setIps(e.target.value)} />
            </div>
            <p id="cms-key-ips-hint" className="text-xs text-muted-foreground sm:col-span-2">
              {t("key_ips_hint")}
            </p>
          </div>
          {error ? <StatusText tone="error">{error}</StatusText> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The one time a secret is visible: the key and how to plug it into an agent. */
export function KeyCreated({ name, secret, mcpServerName = "agent-cms", onClose }: { name: string; secret: string; mcpServerName?: string; onClose: () => void }) {
  const { t, appUrl, baseUrl } = useCms();
  const url = cmsUrl(appUrl, baseUrl);
  const mcp = JSON.stringify({ mcpServers: { [mcpServerName]: { type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
  const env = `AGENT_CMS_URL=${url}\nAGENT_CMS_KEY=${secret}`;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CircleCheck aria-hidden className="h-5 w-5 text-green-600" />
          {name}
        </DialogTitle>
        <DialogDescription>{t("key_once")}</DialogDescription>
      </DialogHeader>
      <CodeBox value={secret} secret={secret} label={t("key_secret")} />
      <Tabs defaultValue="cli" className="mt-1">
        <TabsList aria-label={t("key_connect")}>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="cli">CLI (.env)</TabsTrigger>
        </TabsList>
        <TabsContent value="mcp">
          <CodeBox value={mcp} secret={secret} label="MCP" multiline />
        </TabsContent>
        <TabsContent value="cli" className="flex flex-col gap-2">
          <CodeBox value={env} secret={secret} label=".env" multiline />
          <CodeBox value="npx @mainsoft/agent-cms collections" label="CLI" className="[&>code]:whitespace-normal [&>code]:[overflow-wrap:anywhere]" />
        </TabsContent>
      </Tabs>
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t("close")}
        </Button>
      </DialogFooter>
    </>
  );
}
