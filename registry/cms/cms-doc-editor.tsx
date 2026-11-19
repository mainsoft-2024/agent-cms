// agent-cms registry: cms-doc-editor (0.6.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// One document: the info form (from `_schema`), the markdown body with a
// live preview, autosave, problems from `diagnose()`, agents' changes to
// accept or revert, save / publish, preview links, and a merge screen when
// someone saved first.
"use client";

import * as React from "react";
import { Bot, Check, ChevronDown, ChevronLeft, CircleAlert, CircleCheck, Cloud, ExternalLink, FileText, History, Eye, Link as LinkIcon, MoreHorizontal } from "lucide-react";
import { isCmsRemoteError, type CollectionSchema } from "@mainsoft-2024/agent-cms/client";
import { splitLines } from "@mainsoft-2024/agent-cms/diff";
import { docState, type CmsDoc, type AutosaveState } from "@mainsoft-2024/agent-cms/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { CmsFieldForm, problemKey, type FieldProblem } from "./cms-field-form";
import { CmsMerge } from "./cms-merge";
import { CodeBox, MarkdownPreview, ModifiedMark, PageHeader, Segmented, StateBadge, StatusText } from "./cms-parts";
import { contentOf, formatTime, formatUntil, relativeTime, sameContent, toInput, useAsync, useCms, useDebounced, useIsMobile, type DocContent } from "./use-cms";

type AgentChange = Awaited<ReturnType<import("@mainsoft-2024/agent-cms/client").RestClient["changes"]>>[number];
type PreviewTtl = NonNullable<Parameters<import("@mainsoft-2024/agent-cms/client").RestClient["previewLink"]>[2]>;
type Diagnostic = FieldProblem & { code: string };

export interface CmsDocEditorProps {
  collection: string;
  /** The document to edit; leave out for a new document. */
  slug?: string | null;
  /** Back to the list (mobile header, after delete). */
  onBack?: () => void;
  /** A new document was created (navigate to its editor). */
  onCreated?: (collection: string, slug: string) => void;
  /** After every save or publish. */
  onSaved?: (doc: CmsDoc) => void;
  /** Open the version history. */
  onOpenVersions?: (collection: string, slug: string) => void;
  /** The public page of a published document (shown as "Public page" when the collection has a URL). */
  publicUrlFor?: (collection: string, slug: string) => string;
  /** Text before the slug field, e.g. "/guide/". */
  slugPrefix?: string;
  /** Milliseconds of quiet before an autosave. Default 1500. */
  autosaveDelay?: number;
  className?: string;
}

const EMPTY: DocContent = { slug: "", title: "", summary: "", body: "", category: null, keywords: [], fields: {} };

/**
 * Undo one agent change in `body`: the added lines go, the removed lines
 * come back (after the line that preceded them). Null when the change can no
 * longer be found.
 */
export function revertChange(body: string, ch: Pick<AgentChange, "added" | "removed" | "before">): string | null {
  const lines = splitLines(body);
  if (ch.added.length) {
    for (let i = 0; i + ch.added.length <= lines.length; i++) {
      if (ch.added.every((l, k) => lines[i + k] === l)) {
        lines.splice(i, ch.added.length, ...ch.removed);
        return lines.join("\n");
      }
    }
    return null;
  }
  if (ch.before === null) {
    lines.splice(0, 0, ...ch.removed);
    return lines.join("\n");
  }
  const at = lines.indexOf(ch.before);
  if (at < 0) return null;
  lines.splice(at + 1, 0, ...ch.removed);
  return lines.join("\n");
}

/** 1-based line where an agent change sits in `body` (null if gone). */
function lineOf(body: string, ch: AgentChange): number | null {
  const lines = splitLines(body);
  if (ch.added.length) {
    for (let i = 0; i + ch.added.length <= lines.length; i++) if (ch.added.every((l, k) => lines[i + k] === l)) return i + 1;
    return null;
  }
  if (ch.before === null) return 1;
  const at = lines.indexOf(ch.before);
  return at < 0 ? null : at + 2;
}

type Mode = { kind: "edit" } | { kind: "merge"; base: DocContent; baseVersion: number; mine: DocContent; theirs: CmsDoc };

export function CmsDocEditor({ collection, slug, onBack, onCreated, onSaved, onOpenVersions, publicUrlFor, slugPrefix, autosaveDelay = 1500, className }: CmsDocEditorProps) {
  const { client, t, locale, me } = useCms();
  const mobile = useIsMobile();
  const schemaQ = useAsync(() => client.schema(collection), [client, collection]);
  const schema = schemaQ.data;

  const [doc, setDoc] = React.useState<CmsDoc | null>(null);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(!!slug);
  const [content, setContentRaw] = React.useState<DocContent>(EMPTY);
  const [saved, setSaved] = React.useState<DocContent>(EMPTY);
  const [baseVersion, setBaseVersion] = React.useState(0);
  const [restoreOffer, setRestoreOffer] = React.useState<AutosaveState | null>(null);
  const [changes, setChanges] = React.useState<AgentChange[]>([]);
  const [reviewed, setReviewed] = React.useState<Record<string, { action: "accepted" | "reverted"; by: string }>>({});
  const [problems, setProblems] = React.useState<Diagnostic[]>([]);
  const [auto, setAuto] = React.useState<{ state: "idle" | "saving" | "saved" | "failed"; at?: string }>({ state: "idle" });
  const [status, setStatus] = React.useState<{ text: string; tone: "muted" | "error" | "ok" } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>({ kind: "edit" });
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [infoOpen, setInfoOpen] = React.useState(false);
  const [mobileTab, setMobileTab] = React.useState("edit");
  const [width, setWidth] = React.useState<"375" | "768" | "full">("full");
  const [showProblems, setShowProblems] = React.useState(false);
  const edited = React.useRef(false);

  const isNew = !slug;
  const currentSlug = doc?.slug ?? slug ?? "";
  const myLabel = me?.actor.label ?? "";

  const applyDoc = React.useCallback((d: CmsDoc) => {
    const c = contentOf(d);
    setDoc(d);
    setContentRaw(c);
    setSaved(c);
    setBaseVersion(d.version);
    edited.current = false;
  }, []);

  const loadChanges = React.useCallback(
    async (s: string) => {
      try {
        setChanges(await client.changes(collection, s));
      } catch {
        setChanges([]);
      }
    },
    [client, collection]
  );

  React.useEffect(() => {
    if (!slug) {
      setDoc(null);
      setContentRaw(EMPTY);
      setSaved(EMPTY);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    Promise.all([client.get(collection, slug, { draft: true }), client.changes(collection, slug).catch(() => [] as AgentChange[])]).then(
      ([d, ch]) => {
        if (!live) return;
        applyDoc(d);
        setChanges(ch);
        setReviewed({});
        setRestoreOffer(d.autosave && !sameContent(d.autosave.content, d) ? d.autosave : null);
        setLoadError(null);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setLoadError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
  }, [client, collection, slug, applyDoc]);

  // ── diagnose and autosave ──
  const diagnose = useDebounced(async (c: DocContent) => {
    try {
      const d = await client.diagnose(collection, toInput(c, doc?.fields), doc?.slug);
      setProblems(d as Diagnostic[]);
    } catch {
      /* the save will tell */
    }
  }, 400);

  const autosave = useDebounced(async (c: DocContent, base: number, s: string) => {
    setAuto({ state: "saving" });
    try {
      const a = await client.autosave(collection, s, toInput(c, doc?.fields), base);
      setAuto({ state: "saved", at: a.at });
    } catch {
      setAuto({ state: "failed" });
    }
  }, autosaveDelay);

  const setContent = (next: DocContent) => {
    edited.current = true;
    setContentRaw(next);
  };

  React.useEffect(() => {
    if (!schema?.canWrite) return;
    if (loading) return;
    void diagnose(content);
    if (edited.current && doc && !sameContent(content, saved)) autosave(content, baseVersion, doc.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, schema?.canWrite, loading]);

  React.useEffect(() => () => autosave.cancel(), [autosave]);

  const byField = React.useMemo(() => {
    const out: Record<string, FieldProblem[]> = {};
    for (const p of problems) (out[problemKey(p.path)] ??= []).push(p);
    return out;
  }, [problems]);

  // ── agent changes ──
  const pending = changes.filter((c) => !reviewed[c.id]);
  const revertedIds = Object.entries(reviewed)
    .filter(([, r]) => r.action === "reverted")
    .map(([id]) => id);

  const accept = async (ids: string[]) => {
    if (!doc || !ids.length) return;
    try {
      await client.review(collection, doc.slug, ids, "accepted");
      setReviewed((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, { action: "accepted" as const, by: myLabel }])) }));
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    }
  };

  const revert = (ch: AgentChange) => {
    const next = revertChange(content.body, ch);
    if (next === null) return;
    setContent({ ...content, body: next });
    setReviewed((r) => ({ ...r, [ch.id]: { action: "reverted", by: myLabel } }));
  };

  // ── save ──
  const dirty = !sameContent(content, saved) || revertedIds.length > 0;

  const save = async (publish: boolean) => {
    setBusy(true);
    setStatus(null);
    autosave.cancel();
    try {
      let d: CmsDoc;
      if (isNew && !doc) {
        d = await client.create(collection, toInput(content), { publish });
        applyDoc(d);
        setStatus({ text: publish ? t("published_v", { version: d.version }) : t("saved", { version: d.version }), tone: "ok" });
        onSaved?.(d);
        onCreated?.(collection, d.slug);
        return;
      }
      if (!doc) return;
      if (revertedIds.length) await client.review(collection, doc.slug, revertedIds, "reverted").catch(() => undefined);
      if (!sameContent(content, saved) || !publish) d = await client.update(collection, doc.slug, toInput(content, doc.fields), { expectedVersion: baseVersion, publish });
      else d = await client.publish(collection, doc.slug, { expectedVersion: baseVersion });
      applyDoc(d);
      setRestoreOffer(null);
      setAuto({ state: "idle" });
      setReviewed((r) => Object.fromEntries(Object.entries(r).filter(([, x]) => x.action === "accepted")));
      await loadChanges(d.slug);
      setStatus({ text: publish ? t("published_v", { version: d.publishedVersion ?? d.version }) : t("saved", { version: d.version }), tone: "ok" });
      onSaved?.(d);
    } catch (e) {
      if (isCmsRemoteError(e) && e.code === "conflict_version" && doc) {
        if (!e.current) {
          setStatus({ text: t("merge_no_current"), tone: "error" });
          return;
        }
        try {
          const base = baseVersion === doc.version ? contentOf(doc) : (await client.version(collection, doc.slug, baseVersion)).snapshot;
          setMode({ kind: "merge", base, baseVersion, mine: content, theirs: e.current as CmsDoc });
        } catch (e2) {
          setStatus({ text: errorMessage(e2, t), tone: "error" });
        }
        return;
      }
      if (isCmsRemoteError(e) && e.diagnostics?.length) setProblems(e.diagnostics as Diagnostic[]);
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const restore = () => {
    if (!restoreOffer) return;
    setContent(contentOf(restoreOffer.content));
    setBaseVersion(restoreOffer.baseVersion);
    setRestoreOffer(null);
  };
  const discard = async () => {
    setRestoreOffer(null);
    if (doc) await client.discardAutosave(collection, doc.slug).catch(() => undefined);
  };

  // ── render ──
  if (mode.kind === "merge" && doc)
    return (
      <CmsMerge
        collection={collection}
        slug={doc.slug}
        base={mode.base}
        baseVersion={mode.baseVersion}
        mine={mode.mine}
        theirs={mode.theirs}
        crumbs={[schema?.label ?? collection, content.title || doc.slug]}
        className={className}
        onCancel={() => setMode({ kind: "edit" })}
        onSaved={(d) => {
          setMode({ kind: "edit" });
          setReviewed({});
          applyDoc(d);
          void loadChanges(d.slug);
          setStatus({ text: t("saved", { version: d.version }), tone: "ok" });
          onSaved?.(d);
        }}
      />
    );

  if (loadError)
    return (
      <div className={cn("p-6", className)}>
        <StatusText tone="error">{errorMessage(loadError, t)}</StatusText>
      </div>
    );
  if (loading || !schema)
    return (
      <div className={cn("p-6", className)}>
        <StatusText>{t("loading")}</StatusText>
      </div>
    );

  const st = doc ? docState(doc) : null;
  const canWrite = schema.canWrite;
  const canPublish = schema.canPublish;
  const published = !!doc && doc.publishedVersion !== null && doc.status !== "archived";
  const publicUrl = published && schema.hasUrl && publicUrlFor && doc ? publicUrlFor(collection, doc.slug) : null;
  const previewAllowed = !!doc && !!me?.previewLinks && schema.hasUrl;
  const title = content.title || (isNew ? t("new_doc_title") : currentSlug);
  const fieldCount = Object.keys(((schema.fields ?? {}) as { properties?: object }).properties ?? {}).length;

  const stateBits = st ? (
    <>
      <StateBadge state={st.state} />
      {st.modifiedSincePublish ? <ModifiedMark /> : null}
    </>
  ) : null;

  const saveButtons = (cls?: string) =>
    canWrite ? (
      <>
        <Button type="button" variant="outline" className={cls} disabled={busy || (!dirty && !isNew)} onClick={() => void save(false)}>
          {t("save")}
        </Button>
        {canPublish ? (
          <Button type="button" className={cls} disabled={busy || (!dirty && !!st && st.state === "published" && !st.modifiedSincePublish)} onClick={() => void save(true)}>
            {t("publish")}
          </Button>
        ) : null}
      </>
    ) : null;

  const agentBanner = changes.length ? (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950">
      <Bot aria-hidden className="h-4 w-4 shrink-0" />
      <span>
        {new Set(changes.map((c) => `${c.author}|${c.version}`)).size === 1
          ? t("agent_banner", { who: changes[0].author, version: changes[0].version, n: changes.length, done: changes.length - pending.length, total: changes.length })
          : t("agent_banner_many", { n: changes.length, done: changes.length - pending.length, total: changes.length })}
      </span>
      <span className="flex-1" />
      {pending.length && canWrite ? (
        <Button type="button" variant="outline" size="sm" className="h-7 bg-background" onClick={() => void accept(pending.map((c) => c.id))}>
          {t("accept_all")}
        </Button>
      ) : null}
    </div>
  ) : null;

  const restoreBanner = restoreOffer ? (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <Cloud aria-hidden className="h-4 w-4 shrink-0" />
      <span>{t("restore_title", { time: relativeTime(restoreOffer.at, t, locale), who: restoreOffer.by ?? "" })}</span>
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => void discard()}>
        {t("discard")}
      </Button>
      <Button type="button" variant="outline" size="sm" className="h-7 bg-background" onClick={restore}>
        {t("restore")}
      </Button>
    </div>
  ) : null;

  const blocks = changes.length ? (
    <ul aria-label={t("agent_changes")} className="flex flex-col gap-2 border-b p-2">
      {changes.map((ch) => {
        const r = reviewed[ch.id];
        const line = lineOf(content.body, ch);
        return (
          <li key={ch.id} className={cn("overflow-hidden rounded-lg border", r ? "border-border" : "border-blue-200")}>
            <div className={cn("flex items-center gap-1.5 px-2 py-1 text-xs", r ? "bg-muted/50 text-muted-foreground" : "bg-blue-50 text-blue-950")}>
              {r ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Bot aria-hidden className="h-3.5 w-3.5" />}
              <span>{r ? t(r.action === "accepted" ? "accepted_by" : "reverted_by", { who: ch.author }) : ch.author}</span>
              {line !== null ? <span className="text-muted-foreground">{t("change_at_line", { n: line })}</span> : null}
              <span className="flex-1" />
              {!r && canWrite ? (
                <>
                  <Button type="button" variant="outline" size="sm" className="h-6 bg-background px-2 text-xs" aria-label={`${t("revert")}: ${t("change_at_line", { n: line ?? "?" })}`} onClick={() => revert(ch)}>
                    {t("revert")}
                  </Button>
                  <Button type="button" size="sm" className="h-6 px-2 text-xs" aria-label={`${t("accept")}: ${t("change_at_line", { n: line ?? "?" })}`} onClick={() => void accept([ch.id])}>
                    {t("accept")}
                  </Button>
                </>
              ) : null}
            </div>
            {r?.action === "accepted" ? (
              <pre className="whitespace-pre-wrap px-2 py-1 font-mono text-xs">{ch.added.join("\n")}</pre>
            ) : r?.action === "reverted" ? (
              <pre className="whitespace-pre-wrap px-2 py-1 font-mono text-xs">{ch.removed.join("\n")}</pre>
            ) : (
              <div className="font-mono text-xs">
                {ch.removed.map((l, i) => (
                  <div key={`r${i}`} className="whitespace-pre-wrap bg-red-50 px-2 text-red-800 line-through decoration-red-300">
                    <span className="sr-only">- </span>
                    {l || " "}
                  </div>
                ))}
                {ch.added.map((l, i) => (
                  <div key={`a${i}`} className="whitespace-pre-wrap bg-green-50 px-2 text-green-900">
                    <span className="sr-only">+ </span>
                    {l || " "}
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  ) : null;

  const bodyId = "cms-editor-body";
  const bodyErr = byField.body;
  const bodyInvalid = bodyErr?.some((e) => e.severity === "error");
  const bodyPane = (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
        <FileText aria-hidden className="h-3.5 w-3.5" />
        <Label htmlFor={bodyId} className="text-xs font-medium text-muted-foreground">
          {t("field_body")}
        </Label>
        <span className="flex-1" />
        <span>{t("chars", { n: content.body.length.toLocaleString(locale) })}</span>
      </div>
      {blocks}
      <Textarea
        id={bodyId}
        value={content.body}
        readOnly={!canWrite}
        spellCheck={false}
        aria-invalid={bodyInvalid || undefined}
        aria-describedby={bodyErr?.length ? `${bodyId}-err` : undefined}
        className="min-h-[360px] flex-1 resize-none rounded-none border-0 font-mono text-[13px] leading-6 shadow-none focus-visible:ring-0"
        onChange={(e) => setContent({ ...content, body: e.target.value })}
      />
      {bodyErr?.length ? (
        <p id={`${bodyId}-err`} className="border-t px-3 py-1.5 text-xs text-destructive">
          {bodyErr.map((e) => e.message).join(" ")}
        </p>
      ) : null}
    </section>
  );

  const previewPane = (withHead: boolean) => (
    <section aria-label={t("preview")} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {withHead ? (
        <div className="flex items-center gap-1.5 border-b px-3 py-1 text-xs text-muted-foreground">
          <Eye aria-hidden className="h-3.5 w-3.5" />
          <span className="font-medium">{t("preview")}</span>
          <span className="flex-1" />
          <Segmented
            label={t("preview_width")}
            value={width}
            onChange={setWidth}
            options={[
              { value: "375", label: "375" },
              { value: "768", label: "768" },
              { value: "full", label: t("width_full") },
            ]}
            itemClassName="h-6 px-2 text-xs"
          />
        </div>
      ) : null}
      <div className="flex-1 overflow-auto">
        <MarkdownPreview title={content.title} summary={content.summary} body={content.body} className={cn("mx-auto px-5 py-4", width === "375" ? "max-w-[375px]" : width === "768" ? "max-w-[768px]" : "max-w-none")} />
      </div>
    </section>
  );

  const form = (
    <CmsFieldForm schema={schema} value={content} onChange={setContent} problems={byField} slugLocked={!!doc && doc.publishedVersion !== null} slugPrefix={slugPrefix} idPrefix="cms-editor" />
  );

  const autosaveText =
    auto.state === "saving" ? t("autosaving") : auto.state === "saved" && auto.at ? t("autosaved_at", { time: formatTime(auto.at, locale) }) : auto.state === "failed" ? t("autosave_failed") : dirty ? t("unsaved") : "";

  const problemsFoot = (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-1.5 text-xs text-muted-foreground md:px-6">
        {problems.length ? (
          <button type="button" className="inline-flex items-center gap-1.5 text-destructive hover:underline" aria-expanded={showProblems} aria-controls="cms-editor-problems" onClick={() => setShowProblems((v) => !v)}>
            <CircleAlert aria-hidden className="h-3.5 w-3.5" />
            {t("problems_n", { n: problems.length })}
            <ChevronDown aria-hidden className={cn("h-3 w-3 transition-transform", showProblems && "rotate-180")} />
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <CircleCheck aria-hidden className="h-3.5 w-3.5" />
            {t("problems_none")}
          </span>
        )}
        <span className="flex-1" />
        <span role="status" className={cn(status?.tone === "error" && "text-destructive", status?.tone === "ok" && "text-green-700")}>
          {status?.text ?? ""}
        </span>
        <span role="status" className="inline-flex items-center gap-1.5">
          {autosaveText ? <Cloud aria-hidden className="h-3.5 w-3.5" /> : null}
          {autosaveText}
        </span>
      </div>
      {problems.length && showProblems ? (
        <ul id="cms-editor-problems" aria-label={t("problems_list")} className="border-t px-4 py-2 text-xs md:px-6">
          {problems.map((p, i) => (
            <li key={i} className={cn("py-0.5", p.severity === "error" ? "text-destructive" : "text-amber-700")}>
              <span className="font-mono">{p.path}</span>: {p.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const previewDialog =
    previewAllowed && doc ? <CmsPreviewLinkDialog open={previewOpen} onOpenChange={setPreviewOpen} collection={collection} slug={doc.slug} version={doc.version} /> : null;

  if (mobile)
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <PageHeader
          title={title}
          back={
            onBack ? (
              <Button type="button" variant="ghost" size="icon" className="-ml-2 h-8 w-8" aria-label={t("back")} onClick={onBack}>
                <ChevronLeft aria-hidden className="h-4 w-4" />
              </Button>
            ) : undefined
          }
        >
          {doc && onOpenVersions ? (
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("versions")} onClick={() => onOpenVersions(collection, doc.slug)}>
              <History aria-hidden className="h-4 w-4" />
            </Button>
          ) : null}
          {publicUrl || previewAllowed ? (
            <DropdownMenu>
              <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon", className: "h-8 w-8" })} aria-label={t("more")}>
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {publicUrl ? <DropdownMenuItem onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}>{t("public_page")}</DropdownMenuItem> : null}
                {previewAllowed ? <DropdownMenuItem onClick={() => setPreviewOpen(true)}>{t("preview_link")}</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </PageHeader>
        <Tabs value={mobileTab} onValueChange={(v) => setMobileTab(String(v))} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b px-4 py-2">
            {stateBits}
            <span className="flex-1" />
            <TabsList className="h-8">
              <TabsTrigger value="edit" className="h-6 text-xs">
                {t("edit")}
              </TabsTrigger>
              <TabsTrigger value="preview" className="h-6 text-xs">
                {t("preview")}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="edit" className="mt-0 flex min-h-0 flex-1 flex-col">
            {agentBanner || restoreBanner ? (
              <div className="flex flex-col gap-2 px-4 pt-2.5">
                {restoreBanner}
                {agentBanner}
              </div>
            ) : null}
            <div className="border-b px-4 py-3">
              <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={infoOpen} aria-controls="cms-editor-info" onClick={() => setInfoOpen((v) => !v)}>
                <span className="text-xs font-medium">{t("doc_info")}</span>
                <span className="truncate text-xs text-muted-foreground">{t("doc_info_summary", { n: fieldCount })}</span>
                <span className="flex-1" />
                <ChevronDown aria-hidden className={cn("h-4 w-4 transition-transform", infoOpen && "rotate-180")} />
              </button>
              <div id="cms-editor-info" hidden={!infoOpen} className="pt-3">
                {form}
              </div>
            </div>
            {bodyPane}
          </TabsContent>
          <TabsContent value="preview" className="mt-0 flex min-h-0 flex-1 flex-col">
            {previewPane(false)}
          </TabsContent>
        </Tabs>
        {problemsFoot}
        <div className="sticky bottom-0 flex gap-2 border-t bg-background p-2">{saveButtons("flex-1")}</div>
        {previewDialog}
      </div>
    );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={title} crumbs={[schema.label]} after={stateBits}>
        {publicUrl ? (
          <a href={publicUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 px-2 text-sm underline-offset-2 hover:underline">
            <ExternalLink aria-hidden className="h-4 w-4" />
            {t("public_page")}
          </a>
        ) : null}
        {previewAllowed ? (
          <Button type="button" variant="ghost" className="gap-1.5" onClick={() => setPreviewOpen(true)}>
            <LinkIcon aria-hidden className="h-4 w-4" />
            {t("preview_link")}
          </Button>
        ) : null}
        {doc && onOpenVersions ? (
          <Button type="button" variant="ghost" className="gap-1.5" onClick={() => onOpenVersions(collection, doc.slug)}>
            <History aria-hidden className="h-4 w-4" />
            {t("versions")}
          </Button>
        ) : null}
        {saveButtons()}
      </PageHeader>
      {agentBanner || restoreBanner ? (
        <div className="flex flex-col gap-2 px-6 pt-2.5">
          {restoreBanner}
          {agentBanner}
        </div>
      ) : null}
      <div className="border-b px-6 py-3.5">{form}</div>
      <div className="flex min-h-0 flex-1 divide-x">
        {bodyPane}
        {previewPane(true)}
      </div>
      {problemsFoot}
      {previewDialog}
    </div>
  );
}

// ── preview link ─────────────────────────────────────────────────────────────

export interface CmsPreviewLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection: string;
  slug: string;
  /** The version the link shows (the current draft). */
  version: number;
  /** Default "24h". */
  defaultTtl?: PreviewTtl;
}

/** Makes a signed link to the current draft; anyone with it can read it until it expires. */
export function CmsPreviewLinkDialog({ open, onOpenChange, collection, slug, version, defaultTtl = "24h" }: CmsPreviewLinkDialogProps) {
  const { client, t, locale, appUrl } = useCms();
  const [ttl, setTtl] = React.useState<PreviewTtl>(defaultTtl);
  const [link, setLink] = React.useState<{ url: string; expiresAt: string; version: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    client.previewLink(collection, slug, ttl).then(
      (l) => {
        if (!live) return;
        setLink(l);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setLink(null);
        setError(errorMessage(e, t));
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
  }, [open, ttl, client, collection, slug, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("preview_link")}</DialogTitle>
          <DialogDescription className="sr-only">{t("pl_current", { version })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t("pl_version")}</span>
            <span className="text-sm">{t("pl_current", { version: link?.version ?? version })}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span id="cms-pl-ttl" className="text-xs font-medium text-muted-foreground">
              {t("pl_expiry")}
            </span>
            <Segmented
              labelledBy="cms-pl-ttl"
              value={ttl}
              onChange={setTtl}
              options={[
                { value: "1h", label: t("ttl_1h") },
                { value: "24h", label: t("ttl_24h") },
                { value: "7d", label: t("ttl_7d") },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("pl_link")}</span>
            {link ? <CodeBox value={/^\//.test(link.url) ? `${appUrl}${link.url}` : link.url} label={t("pl_link")} /> : null}
            <StatusText className="text-xs" tone={error ? "error" : "muted"}>
              {error ?? (loading ? t("pl_making") : link ? t("pl_until", { time: formatUntil(link.expiresAt, locale) }) : "")}
            </StatusText>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { CollectionSchema };
