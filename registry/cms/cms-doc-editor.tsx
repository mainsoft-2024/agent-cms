// agent-cms registry: cms-doc-editor (0.11.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// One document: the info form (from `_schema`), the markdown body with a
// live preview that follows the text (and finds its lines when clicked),
// the order of the sections, autosave, problems from `diagnose()`, agents' changes to
// accept or revert, save / publish (now or at a set time), review requests,
// comments, who else has it open, preview links, and a merge screen when
// someone saved first and the two edits overlap.
"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, ChevronLeft, CircleAlert, CircleCheck, Cloud, ExternalLink, History, Eye, Layers, Link as LinkIcon, MessageSquare, Minimize2, MoreHorizontal, Monitor, SlidersHorizontal } from "lucide-react";
import { isCmsRemoteError, type CollectionSchema, type CommentThread, type DocRelease } from "@mainsoft/agent-cms/client";
import { mergeDocs, resolveDocMerge, splitLines } from "@mainsoft/agent-cms/diff";
import { docState, type CmsDoc, type AutosaveState, type Presence } from "@mainsoft/agent-cms/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RelatedLabels, type RelatedLabel } from "./cms-fields-more";
import { contentFromTemplate, fitsSchema, ReferencedDialog, SaveTemplateDialog, SeoPanel, SlugChangeDialog, SnippetUses, takeTemplate } from "./cms-structure";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { CmsFieldForm, FieldGate, problemKey, type FieldProblem } from "./cms-field-form";
import { AddToReleaseDialog, BodyBackdrop, CommentsPanel, offsetOf, placeOf, PublishButton, ReviewStrip, ScheduleStrip, type BodyCursor } from "./cms-flow";
import { assetMarkdown, CmsMediaPicker } from "./cms-media-picker";
import { createUploader } from "./cms-upload";
import { SectionsOrder, bodySections, lineAt, usePreviewSync } from "./cms-body-tools";
import { pasteAsMarkdown } from "./cms-paste";
import { bodyStats, EditorToolbar, FindBar, markdownCommands, TipButton } from "./cms-editor-toolbar";
import { CmsMerge } from "./cms-merge";
import { CodeBox, ConfirmDialog, MarkdownPreview, ModifiedMark, PageHeader, People, Segmented, StateBadge, StatusText, DIALOG } from "./cms-parts";
import { contentOf, formatTime, formatUntil, formatZoned as formatZonedTime, personColor, relativeTime, sameContent, toInput, useAsync, useCms, useDebounced, useIsMobile, useLocalStorage, useShortcut, modLabel, type BlockEditorCommands, type DocContent, type EditorSlotContext } from "./use-cms";

type AgentChange = Awaited<ReturnType<import("@mainsoft/agent-cms/client").RestClient["changes"]>>[number];
type PreviewTtl = NonNullable<Parameters<import("@mainsoft/agent-cms/client").RestClient["previewLink"]>[2]>;
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
  /**
   * The document got a new address (published under a changed slug): replace the page's address with
   * the new one, so reloading or going back does not open the old slug. Falls back to `onCreated`.
   */
  onRenamed?: (collection: string, slug: string) => void;
  /** Open the version history. */
  onOpenVersions?: (collection: string, slug: string) => void;
  /** The public page of a published document (shown as "Public page" when the collection has a URL). */
  publicUrlFor?: (collection: string, slug: string) => string;
  /** Text before the slug field, e.g. "/guide/". */
  slugPrefix?: string;
  /** Milliseconds of quiet before an autosave. Default 1500. */
  autosaveDelay?: number;
  /** Open a release (the "in the release ..." strip). */
  onOpenRelease?: (id: string) => void;
  /** How often this screen says "I am here" and looks for other people's saves, in ms. Default 15000 (3000 while someone else is here); 0 turns it off. */
  presenceMs?: number;
  className?: string;
  /** 0.21.0: open another document (the documents that use a snippet). */
  onOpenDocument?: (collection: string, slug: string) => void;
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

/**
 * "Saved v1" for a new document has to outlive the editor that made it: most apps
 * answer `onCreated` by moving to the document's own address, which mounts a new
 * editor. The line waits in sessionStorage for that editor, for a few seconds.
 */
const KEPT_STATUS_MS = 15000;
const keptStatusKey = (collection: string, slug: string) => `agent-cms:saved:${collection}/${slug}`;

function keepStatus(collection: string, slug: string, text: string) {
  try {
    window.sessionStorage.setItem(keptStatusKey(collection, slug), JSON.stringify({ text, at: Date.now() }));
  } catch {
    /* no storage: the line is simply not carried over */
  }
}

function takeStatus(collection: string, slug: string): string | null {
  try {
    const key = keptStatusKey(collection, slug);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    const v = JSON.parse(raw) as { text?: unknown; at?: unknown };
    return typeof v.text === "string" && typeof v.at === "number" && Date.now() - v.at < KEPT_STATUS_MS ? v.text : null;
  } catch {
    return null;
  }
}

export function CmsDocEditor({ collection, slug, onBack, onCreated, onSaved, onRenamed, onOpenVersions, publicUrlFor, slugPrefix, autosaveDelay = 1500, onOpenRelease, presenceMs = 15000, className, onOpenDocument }: CmsDocEditorProps) {
  const { client, t, locale, me, baseUrl, slots, toast } = useCms();
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  /** Where the cursor last was in the body (null: the person never put it there). */
  const caretRef = React.useRef<[number, number] | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [checks, setChecks] = React.useState<null | Awaited<ReturnType<typeof client.publishChecks>>>(null);
  const [view, setView] = useLocalStorage<"blocks" | "markdown">("cms-body-view", "blocks");
  // The markdown view can show the preview beside the text; the block view is one column (it looks like the page already).
  const [sidePreview, setSidePreview] = useLocalStorage<boolean>("cms-side-preview", true);
  const [previewWindow, setPreviewWindow] = React.useState(false);
  // Full screen editing: the editor covers the admin (sidebar, header, fields and comments step aside).
  const [focus, setFocusState] = React.useState(false);
  const [focusFields, setFocusFields] = React.useState(false);
  const [screenFull, setScreenFull] = React.useState(false);
  const [barQuiet, setBarQuiet] = React.useState(false);
  const focusButton = React.useRef<HTMLButtonElement | null>(null);
  const insertRef = React.useRef<((md: string) => void) | null>(null);
  // The toolbar asks the block editor for its commands through this; `tbTick` redraws its buttons.
  const blockCommandsRef = React.useRef<BlockEditorCommands | null>(null);
  const [tbTick, setTbTick] = React.useState(0);
  const tbFrame = React.useRef(0);
  const bumpToolbar = React.useCallback(() => {
    if (tbFrame.current) return;
    tbFrame.current = requestAnimationFrame(() => {
      tbFrame.current = 0;
      setTbTick((x) => x + 1);
    });
  }, []);
  React.useEffect(() => () => cancelAnimationFrame(tbFrame.current), []);
  /** Stands for the block editor's commands while it loads (and stays the same object). */
  const blockCommands = React.useMemo<BlockEditorCommands>(
    () => ({
      run: (c) => blockCommandsRef.current?.run(c) ?? false,
      state: (c) => blockCommandsRef.current?.state(c) ?? { enabled: false, active: false },
      find: (q, o) => blockCommandsRef.current?.find(q, o) ?? { count: 0, current: -1 },
      findStep: (d) => blockCommandsRef.current?.findStep(d) ?? { count: 0, current: -1 },
      replace: (x, all) => blockCommandsRef.current?.replace(x, all) ?? 0,
      findClear: () => blockCommandsRef.current?.findClear(),
      focus: () => blockCommandsRef.current?.focus(),
    }),
    []
  );
  const [finding, setFinding] = React.useState<{ n: number; replace: boolean; initial: string } | null>(null);
  const [findMarks, setFindMarks] = React.useState<{ start: number; end: number }[]>([]);
  const mdReadOnly = React.useRef(false);
  // `live` and `setContent` are declared further down; they are only read when a button is pressed.
  const mdCommands = React.useMemo(
    () =>
      markdownCommands({
        box: () => bodyRef.current,
        body: () => liveRef.current?.().content.body ?? "",
        setBody: (body) => liveRef.current?.().setBody(body),
        onMarks: setFindMarks,
        readOnly: () => mdReadOnly.current,
      }),
    []
  );
  const liveRef = React.useRef<(() => { content: DocContent; setBody: (b: string) => void }) | null>(null);
  const pickWaiter = React.useRef<((md: string | null) => void) | null>(null);
  const mobile = useIsMobile();
  // With the slug: field rules (`fieldAccess`) may depend on the document.
  const schemaQ = useAsync(() => client.schema(collection, { slug }), [client, collection, slug]);
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
  const [release, setRelease] = React.useState<DocRelease | null>(null);
  const [threads, setThreads] = React.useState<CommentThread[]>([]);
  const [commentsOpen, setCommentsOpen] = React.useState(false);
  const [releaseOpen, setReleaseOpen] = React.useState(false);
  const [others, setOthers] = React.useState<Presence[]>([]);

  /** The one document of a single that was never saved: edited as new, saved under its fixed slug. */
  const [singleNew, setSingleNew] = React.useState(false);
  const isNew = !slug || singleNew;
  const [tplDialog, setTplDialog] = React.useState(false);
  /** Hiding (archiving) was refused because other documents point here: ask before hiding anyway. */
  const [hideAsk, setHideAsk] = React.useState(false);
  const [seoOpen, setSeoOpen] = React.useState(false);
  const [slugAsk, setSlugAsk] = React.useState<{ publish: boolean } | null>(null);
  const [relLabels, setRelLabels] = React.useState<Record<string, RelatedLabel | null>>({});
  const relCtx = React.useMemo(() => ({ labels: relLabels, remember: (l: RelatedLabel) => setRelLabels((m) => ({ ...m, [l.id]: l })) }), [relLabels]);
  const currentSlug = doc?.slug ?? slug ?? "";
  const myLabel = me?.actor.label ?? "";

  /** Set when a write answered with only the document's state: this person may no longer edit it. */
  const [lostWrite, setLostWrite] = React.useState(false);
  const applyDoc = React.useCallback((d: CmsDoc) => {
    if (d.receipt) {
      // Only the state is real (title, body and fields are empty): keep what is on screen, take the
      // new state, and stop offering edits (the server now refuses them).
      setDoc((prev) => (prev ? { ...prev, status: d.status, version: d.version, publishedVersion: d.publishedVersion, publishedAt: d.publishedAt, republishedAt: d.republishedAt, updatedAt: d.updatedAt, schedule: d.schedule, review: d.review } : prev));
      setSaved(live.current.content);
      setBaseVersion(d.version);
      setLostWrite(true);
      edited.current = false;
      return;
    }
    setLostWrite(false);
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

  const loadComments = React.useCallback(
    async (s: string) => {
      try {
        setThreads(await client.comments(collection, s));
      } catch {
        /* readers do not see comments */
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
    Promise.all([client.getWithRelease(collection, slug), client.changes(collection, slug).catch(() => [] as AgentChange[]), client.comments(collection, slug).catch(() => [] as CommentThread[])]).then(
      ([r, ch, cm]) => {
        if (!live) return;
        const d = r.doc;
        applyDoc(d);
        setRelease(r.release ?? null);
        setThreads(cm);
        setChanges(ch);
        setReviewed({});
        setRestoreOffer(d.autosave && !sameContent(d.autosave.content, d) ? d.autosave : null);
        setLoadError(null);
        setLoading(false);
        const kept = takeStatus(collection, slug);
        if (kept) setStatus({ text: kept, tone: "ok" });
      },
      (e) => {
        if (!live) return;
        // A single that was never saved: start from the schema's defaults.
        if (isCmsRemoteError(e) && e.code === "not_found" && slug === "_single") {
          void client.single(collection, { draft: true }).then(
            (d) => {
              if (!live) return;
              const c = { ...EMPTY, ...contentOf(d), slug: "_single" };
              setSingleNew(true);
              setDoc(null);
              setContentRaw(c);
              setSaved(c);
              setLoadError(null);
              setLoading(false);
              setStatus({ text: t("single_not_saved"), tone: "muted" });
            },
            (e2) => live && (setLoadError(e2), setLoading(false))
          );
          return;
        }
        setLoadError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, collection, slug, applyDoc]);

  // A new document may start from the template picked in the list ("New document").
  const [tplFit, setTplFit] = React.useState<{ label: string; fields: Record<string, unknown> } | null>(null);
  React.useEffect(() => {
    if (slug) return;
    const tpl = takeTemplate(collection);
    if (!tpl) return;
    const c = { ...EMPTY, ...contentFromTemplate(tpl) };
    setContentRaw(c);
    setTplFit({ label: tpl.label, fields: { ...(c.fields ?? {}) } });
    setStatus({ text: t("tpl_applied", { name: tpl.label }), tone: "muted" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, slug]);
  // Once the schema is here: template values the fields no longer take (renamed, removed, another type) are left out.
  React.useEffect(() => {
    const props = ((schemaQ.data?.fields ?? null) as { properties?: Record<string, unknown> } | null)?.properties;
    if (!tplFit || !props) return;
    setTplFit(null);
    const dropped = Object.entries(tplFit.fields)
      .filter(([k, v]) => !fitsSchema(props[k], v, k in props))
      .map(([k]) => k);
    if (!dropped.length) return;
    setContentRaw((c) => {
      const fields = { ...(c.fields ?? {}) };
      // Only values still as the template left them (not something the person typed meanwhile).
      for (const k of dropped) if (fields[k] === tplFit.fields[k]) delete fields[k];
      return { ...c, fields };
    });
    setStatus({ text: `${t("tpl_applied", { name: tplFit.label })}. ${t("tpl_dropped", { fields: dropped.join(", ") })}`, tone: "muted" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tplFit, schemaQ.data]);

  // Relation fields show the titles of what they point at (one read with ?expand=).
  const relPaths = schemaQ.data?.relations?.map((r) => r.path) ?? [];
  const relKey = relPaths.join(",");
  React.useEffect(() => {
    if (!slug || singleNew || !relKey) return;
    let live = true;
    client.get(collection, slug, { draft: true, expand: relKey.split(",") }).then(
      (d) => {
        if (!live) return;
        const out: Record<string, RelatedLabel | null> = {};
        const raw = doc?.fields ?? {};
        for (const path of relKey.split(",")) {
          const got = (d.fields as Record<string, unknown>)[path];
          const ids = (raw as Record<string, unknown>)[path];
          const idList = Array.isArray(ids) ? ids : ids ? [ids] : [];
          const list = Array.isArray(got) ? got : got !== undefined ? [got] : [];
          idList.forEach((id, i) => {
            const x = list[i] as RelatedLabel | null | undefined;
            if (typeof id === "string") out[id] = x ? { id: x.id, collection: x.collection, slug: x.slug, title: x.title, status: x.status } : null;
          });
        }
        setRelLabels((m) => ({ ...out, ...m }));
      },
      () => undefined
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, collection, slug, relKey, doc?.version]);

  // A new document's address follows its title until someone types one (Korean titles are romanized on the server).
  const lastSuggested = React.useRef("");
  const suggest = useDebounced((title: string) => {
    if (!title.trim()) return;
    client.suggestSlug(collection, title).then(
      (sl) => {
        const c = live.current.content;
        if (c.slug && c.slug !== lastSuggested.current) return;
        lastSuggested.current = sl;
        setContentRaw({ ...c, slug: sl });
      },
      () => undefined
    );
  }, 350);

  // ── diagnose and autosave ──
  // Each check and autosave gets a number; an answer to an older one is dropped,
  // so a slow reply can neither bring back a fixed problem nor overwrite a newer save.
  const diagSeq = React.useRef(0);
  const autoSeq = React.useRef(0);
  const diagnose = useDebounced(async (c: DocContent) => {
    const mine = ++diagSeq.current;
    try {
      const d = await client.diagnose(collection, toInput(c, doc?.fields), doc?.slug);
      if (mine !== diagSeq.current) return;
      setProblems(d as Diagnostic[]);
    } catch {
      /* the save will tell */
    }
  }, 400);

  const autosaveRaw = useDebounced(async (c: DocContent, base: number, s: string) => {
    const mine = ++autoSeq.current;
    setAuto({ state: "saving" });
    try {
      const a = await client.autosave(collection, s, toInput(c, doc?.fields), base);
      if (mine === autoSeq.current) setAuto({ state: "saved", at: a.at });
    } catch {
      if (mine === autoSeq.current) setAuto({ state: "failed" });
    }
  }, autosaveDelay);
  const autosave = React.useMemo(() => {
    const run = (c: DocContent, base: number, s: string) => autosaveRaw(c, base, s);
    /** Stops the timer and makes an autosave already on its way not count. */
    run.cancel = () => {
      autosaveRaw.cancel();
      autoSeq.current++;
    };
    return run;
  }, [autosaveRaw]);

  const setContent = (next: DocContent) => {
    edited.current = true;
    if (!slug && next.title !== live.current.content.title && (!next.slug || next.slug === lastSuggested.current)) suggest(next.title);
    setContentRaw(next);
  };

  React.useEffect(() => {
    if (!schema?.canWrite || lostWrite) return;
    if (loading) return;
    void diagnose(content);
    if (edited.current && doc && !sameContent(content, saved) && !unparsedRef.current.length) autosave(content, baseVersion, doc.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, schema?.canWrite, lostWrite, loading]);

  React.useEffect(() => () => autosave.cancel(), [autosave]);

  // A new document starts empty: its required fields are not "wrong" yet. Their problems show once
  // the person has typed in that field or tried to save, not the moment the page opens.
  const [tried, setTried] = React.useState(false);
  const shownProblems = React.useMemo(() => {
    if (!isNew || tried) return problems;
    const at = (c: DocContent, key: string): unknown => {
      if (key.startsWith("fields.")) return (c.fields as Record<string, unknown> | undefined)?.[key.slice(7)];
      return (c as unknown as Record<string, unknown>)[key];
    };
    return problems.filter((p) => {
      const key = problemKey(p.path);
      return JSON.stringify(at(content, key) ?? null) !== JSON.stringify(at(EMPTY, key) ?? null);
    });
  }, [problems, isNew, tried, content]);
  const byField = React.useMemo(() => {
    const out: Record<string, FieldProblem[]> = {};
    for (const p of shownProblems) (out[problemKey(p.path)] ??= []).push(p);
    return out;
  }, [shownProblems]);

  // Field problems while the fields are folded away in full screen: a dot on the button, and the fields open
  // by themselves when a new error appears (the save that failed points at them).
  const fieldErrors = shownProblems.filter((p) => p.severity === "error" && problemKey(p.path) !== "body").length;
  const lastFieldErrors = React.useRef(0);
  React.useEffect(() => {
    if (focus && fieldErrors > lastFieldErrors.current) setFocusFields(true);
    lastFieldErrors.current = fieldErrors;
  }, [focus, fieldErrors]);

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
  // Fields whose text does not parse yet (JSON): nothing is saved until they do.
  const [unparsed, setUnparsed] = React.useState<string[]>([]);
  const fieldGate = React.useCallback((key: string, bad: boolean) => setUnparsed((u) => (bad ? (u.includes(key) ? u : [...u, key]) : u.filter((k) => k !== key))), []);
  const unparsedRef = React.useRef(unparsed);
  unparsedRef.current = unparsed;

  /** A published document under a new address: it changes only together with publishing (the server refuses it in a draft). */
  const slugMoved = !!doc && doc.publishedVersion !== null && content.slug !== doc.slug && !!schema?.redirects;
  const save = async (publish: boolean, confirmed = false): Promise<CmsDoc | null> => {
    setTried(true);
    // Saving a draft never publishes by itself: the dialog explains, and its button goes through Publish.
    if (slugMoved && !(publish && confirmed)) {
      setSlugAsk({ publish });
      return null;
    }
    if (unparsedRef.current.length) {
      setStatus({ text: t("fields_unparsed", { fields: unparsedRef.current.join(", ") }), tone: "error" });
      document.getElementById(`cms-editor-f-${unparsedRef.current[0]}`)?.focus();
      return null;
    }
    setBusy(true);
    setStatus(null);
    autosave.cancel();
    try {
      let d: CmsDoc;
      if (isNew && !doc) {
        d = await client.create(collection, toInput(content), { publish });
        applyDoc(d);
        if (singleNew) {
          setSingleNew(false);
          setStatus({ text: publish ? t("published_v", { version: d.version }) : t("saved", { version: d.version }), tone: "ok" });
          onSaved?.(d);
          return d;
        }
        const text = publish ? t("published_v", { version: d.version }) : t("saved", { version: d.version });
        setStatus({ text, tone: "ok" });
        onSaved?.(d);
        if (onCreated) keepStatus(collection, d.slug, text);
        onCreated?.(collection, d.slug);
        return d;
      }
      if (!doc) return null;
      const sent = content;
      // The server marks a reverted change against the version that made it, so this goes first.
      if (revertedIds.length) await client.review(collection, doc.slug, revertedIds, "reverted").catch(() => undefined);
      if (!sameContent(content, saved) || !publish) d = await client.update(collection, doc.slug, toInput(content, doc.fields), { expectedVersion: baseVersion, publish });
      else d = await client.publish(collection, doc.slug, { expectedVersion: baseVersion });
      // Typing that happened while the save was on its way stays (and stays unsaved).
      const typed = live.current.content;
      applyDoc(d);
      if (!sameContent(typed, sent)) {
        setContentRaw(typed);
        edited.current = true;
      }
      setRestoreOffer(null);
      setAuto({ state: "idle" });
      setReviewed((r) => Object.fromEntries(Object.entries(r).filter(([, x]) => x.action === "accepted")));
      await loadChanges(d.slug);
      const doneText = publish ? t("published_v", { version: d.publishedVersion ?? d.version }) : t("saved", { version: d.version });
      setStatus({ text: doneText, tone: "ok" });
      onSaved?.(d);
      // A new address: the page follows the document (replacing the old address in the history).
      const follow = onRenamed ?? onCreated;
      if (d.slug !== doc.slug && follow) {
        keepStatus(collection, d.slug, doneText);
        follow(collection, d.slug);
      }
      return d;
    } catch (e) {
      if (isCmsRemoteError(e) && e.code === "conflict_version" && doc) {
        if (!e.current) {
          setStatus({ text: t("merge_no_current"), tone: "error" });
          return null;
        }
        try {
          const base = baseVersion === doc.version ? contentOf(doc) : (await client.version(collection, doc.slug, baseVersion)).snapshot;
          setMode({ kind: "merge", base, baseVersion, mine: content, theirs: e.current as CmsDoc });
        } catch (e2) {
          setStatus({ text: errorMessage(e2, t), tone: "error" });
        }
        return null;
      }
      // The server knows better (the document was published meanwhile): explain as the dialog does.
      if (isCmsRemoteError(e) && e.code === "slug_needs_publish" && schema?.redirects) {
        setSlugAsk({ publish });
        return null;
      }
      if (isCmsRemoteError(e) && e.diagnostics?.length) setProblems(e.diagnostics as Diagnostic[]);
      setStatus({ text: errorMessage(e, t), tone: "error" });
      return null;
    } finally {
      setBusy(false);
    }
  };

  // ── schedule and review ──
  /** The saved document these actions apply to: unsaved edits are saved first. */
  const savedDoc = async (): Promise<CmsDoc> => {
    const d = dirty ? await save(false) : doc;
    if (!d) throw new Error("not saved");
    return d;
  };
  const flow = async (fn: (d: CmsDoc) => Promise<CmsDoc>, done: (d: CmsDoc) => string, rethrow = false) => {
    setBusy(true);
    setStatus(null);
    try {
      const d = await fn(await savedDoc());
      applyDoc(d);
      setStatus({ text: done(d), tone: "ok" });
      onSaved?.(d);
    } catch (e) {
      if (isCmsRemoteError(e)) setStatus({ text: errorMessage(e, t), tone: "error" });
      if (rethrow) throw e;
    } finally {
      setBusy(false);
    }
  };
  const zone = me?.timeZone;
  const scheduleAt = (when: { publishAt: string | null; unpublishAt: string | null }) =>
    flow(
      (d) => client.schedule(collection, d.slug, { ...when, expectedVersion: d.version }),
      (d) => (d.schedule?.publishAt ? t("sched_done", { version: d.schedule.version, time: formatZonedTime(d.schedule.publishAt, locale, zone) }) : t("sched_go")),
      true
    );
  const unschedule = () => flow((d) => client.unschedule(collection, d.slug), () => t("sched_cleared"), true);
  const requestReview = () => flow((d) => client.requestReview(collection, d.slug), () => t("review_requested_done"));
  const approve = () => flow((d) => client.approveReview(collection, d.slug, { publish: true }), (d) => t("published_v", { version: d.publishedVersion ?? d.version }));
  const reject = (note: string) => flow((d) => client.rejectReview(collection, d.slug, note || null), () => t("review_rejected_done"), true);

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

  // ── who else is here, and their saves ──
  const live = React.useRef({ content, saved, baseVersion, dirty, others: 0 });
  live.current = { content, saved, baseVersion, dirty, others: others.length };
  const slugNow = doc?.slug;
  React.useEffect(() => {
    if (!slugNow || !presenceMs || mode.kind !== "edit") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const point = (at: number) => {
      const before = live.current.content.body.slice(0, at).split("\n");
      return { line: before.length, ch: before[before.length - 1].length };
    };
    /** Someone else saved: take it when nothing is unsaved here, merge when the two edits do not overlap. */
    const catchUp = async () => {
      const latest = await client.get(collection, slugNow, { draft: true });
      const now = live.current;
      if (stop || latest.version <= now.baseVersion) return;
      const who = latest.updatedByAgent ?? latest.updatedBy ?? "";
      if (!now.dirty) {
        applyDoc(latest);
        void loadChanges(slugNow);
        setStatus({ text: t("other_saved", { who, version: latest.version }), tone: "muted" });
        return;
      }
      const m = mergeDocs(now.saved, now.content, contentOf(latest));
      if (m.body.conflicts.length || m.fieldConflicts.length) return; // saving opens the merge screen
      autosave.cancel();
      const merged = contentOf(resolveDocMerge(m, {}));
      // Keep the cursor where it was: text that arrived above it pushes it down.
      const el = bodyRef.current;
      const sel = caretRef.current;
      let same = 0;
      while (same < merged.body.length && merged.body[same] === now.content.body[same]) same++;
      const shift = (at: number) => (at <= same ? at : Math.max(same, at + merged.body.length - now.content.body.length));
      setDoc(latest);
      setSaved(contentOf(latest));
      setBaseVersion(latest.version);
      setContentRaw(merged);
      if (el && sel && document.activeElement === el)
        requestAnimationFrame(() => {
          el.setSelectionRange(shift(sel[0]), shift(sel[1]));
          caretRef.current = [shift(sel[0]), shift(sel[1])];
        });
      setStatus({ text: t("other_merged", { who, version: latest.version }), tone: "muted" });
    };
    const beat = async () => {
      try {
        if (document.visibilityState !== "hidden") {
          const sel = caretRef.current;
          const r = await client.presence(collection, slugNow, { cursor: sel ? point(sel[1]) : null, selection: sel && sel[0] !== sel[1] ? point(sel[0]) : null });
          if (stop) return;
          setOthers(r.others);
          if (r.version > live.current.baseVersion) await catchUp();
        }
      } catch {
        /* a reader, or offline: nobody is shown */
      }
      if (!stop) timer = setTimeout(() => void beat(), live.current.others ? Math.min(presenceMs, 3000) : presenceMs);
    };
    void beat();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      setOthers([]);
      void client.leave(collection, slugNow).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, collection, slugNow, presenceMs, mode.kind]);

  // ── render ──
  // The body beside its preview: scrolling together, a click in the preview finds the lines, and the section cards.
  const previewRef = React.useRef<HTMLDivElement>(null);
  const [outline, setOutline] = React.useState(false);
  const wide = !mobile && !loading && !!schema && !loadError && mode.kind !== "merge";
  const blocksView = !!slots.blockEditor && view === "blocks";
  const sideBySide = wide && !blocksView && sidePreview;
  const sync = usePreviewSync(bodyRef, previewRef, content.body, sideBySide, width);
  // Wide screens: the row with the text and the preview is as tall as the window minus the header and the
  // status line, which both stay in place. The info form scrolls away above it once you work in the body.
  const rootRef = React.useRef<HTMLDivElement>(null);
  const headRef = React.useRef<HTMLDivElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const footRef = React.useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = React.useState<number | null>(null);
  React.useEffect(() => {
    const [root, head, foot] = [rootRef.current, headRef.current, footRef.current];
    if (!wide || !root || !head || !foot) return;
    const fit = () => setRowHeight(Math.max(360, root.clientHeight - head.offsetHeight - foot.offsetHeight));
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    for (const el of [root, head, foot]) ro.observe(el);
    return () => ro.disconnect();
  }, [wide]);
  /** Scrolling or typing in the body: give it the whole window (the form is one scroll up). */
  const showBody = React.useCallback(() => {
    const [root, head, row] = [rootRef.current, headRef.current, rowRef.current];
    if (!root || !head || !row) return;
    const top = row.offsetTop - head.offsetHeight;
    if (root.scrollTop >= top - 1) return;
    if (typeof root.scrollTo === "function") root.scrollTo({ top, behavior: "smooth" });
    else root.scrollTop = top;
  }, []);
  const sectionCount = React.useMemo(() => bodySections(content.body).length, [content.body]);
  const pendingPick = React.useRef<[number, number] | null>(null);
  const pickLines = (line: number, endLine: number) => {
    setOutline(false);
    if (mobile && mobileTab !== "edit") {
      // The text box is on the other tab: go there first.
      pendingPick.current = [line, endLine];
      setMobileTab("edit");
    } else requestAnimationFrame(() => sync.select(line, endLine));
  };
  React.useEffect(() => {
    const p = pendingPick.current;
    if (!p || mobileTab !== "edit") return;
    pendingPick.current = null;
    const id = requestAnimationFrame(() => sync.select(p[0], p[1]));
    return () => cancelAnimationFrame(id);
  }, [mobileTab, sync]);

  // Publishing first asks the collection's checks; findings open a dialog (errors block, warnings may be accepted).
  // `confirmed`: the person already agreed to publish under a changed address (the slug dialog).
  const checksConfirmed = React.useRef(false);
  const publish = async (confirmed = false) => {
    if (slugMoved && !confirmed) return void setSlugAsk({ publish: true });
    if (isNew || !doc || !schema?.publishChecks) return void save(true, confirmed);
    setBusy(true);
    try {
      const r = await client.publishChecks(collection, doc.slug, toInput(content, doc.fields));
      setBusy(false);
      if (r.checks.length || r.blocking) {
        checksConfirmed.current = confirmed;
        return setChecks(r);
      }
    } catch {
      setBusy(false);
    }
    void save(true, confirmed);
  };
  // ── keyboard ──
  const publishRef = React.useRef(publish);
  publishRef.current = publish;
  const keys = React.useRef({ save, dirty, busy, isNew, canWrite: false, canPublish: false });
  keys.current = { save, dirty, busy, isNew, canWrite: !!schema?.canWrite && !lostWrite, canPublish: !!schema?.canPublish && !schema?.needsReview };
  useShortcut(mode.kind === "edit" && "mod+s", () => {
    const k = keys.current;
    if (k.canWrite && !k.busy && (k.dirty || k.isNew)) void k.save(false);
  });
  useShortcut(mode.kind === "edit" && "mod+shift+p", () => {
    const k = keys.current;
    // Publishing from the editor saves first: only for someone who may also edit.
    if (k.canPublish && k.canWrite && !k.busy) void publishRef.current();
  });

  const setFocus = React.useCallback(
    (on: boolean) => {
      setFocusState(on);
      setBarQuiet(false);
      if (on) toast(t("focus_entered", { keys: `${modLabel()}+Shift+F` }), { tone: "info", duration: 2500 });
      else {
        setFocusFields(false);
        if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        // Back where the person started (unless they are in the middle of the text).
        requestAnimationFrame(() => {
          const a = document.activeElement as HTMLElement | null;
          if (!a || a === document.body) focusButton.current?.focus();
        });
      }
    },
    [t, toast],
  );
  const focusRef = React.useRef(focus);
  focusRef.current = focus;
  useShortcut(mode.kind === "edit" && !mobile && "mod+shift+f", () => setFocus(!focusRef.current), { inFields: true });
  // Esc leaves full screen, but never while typing (inside the body Esc first clears the block selection,
  // closes the block menus and the find bar), and never when it closes a menu or a dialog first.
  // The hint says so: Mod+Shift+F works everywhere, Esc outside the text.
  useShortcut(focus && "escape", () => {
    if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
    setFocus(false);
  });
  React.useEffect(() => {
    if (!focus) return;
    // The page behind does not scroll under the editor.
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    const onFs = () => setScreenFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      html.style.overflow = before;
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [focus]);
  React.useEffect(() => {
    if (mobile && focus) setFocus(false);
  }, [mobile, focus, setFocus]);
  // While the person types, the bar fades so only the text is left; moving the mouse brings it back.
  React.useEffect(() => {
    if (!focus) return;
    const type = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === "Escape" || e.key === "Tab") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.(".cms-blocks, #cms-editor-body")) setBarQuiet(true);
    };
    let last = 0;
    const move = (e: MouseEvent) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return;
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      setBarQuiet(false);
    };
    document.addEventListener("keydown", type);
    document.addEventListener("mousemove", move);
    return () => {
      document.removeEventListener("keydown", type);
      document.removeEventListener("mousemove", move);
    };
  }, [focus]);
  const toggleScreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    // The whole page, not the editor box: dialogs and menus open on the page and must stay visible.
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  // ── a copy in this browser: survives a lost connection and a closed tab ──
  // Scoped by CMS mount and person: a shared browser never offers someone else's copy.
  const localKey = `agent-cms:draft:${baseUrl}:${me?.actor.id ?? "-"}:${collection}/${currentSlug || "_new"}`;
  // The copy is read once per key before anything may write or remove it.
  const localChecked = React.useRef<string | null>(null);
  const [localBroken, setLocalBroken] = React.useState(false);
  const writeLocal = useDebounced((c: DocContent, base: number) => {
    try {
      window.localStorage.setItem(localKey, JSON.stringify({ content: c, baseVersion: base, at: new Date().toISOString() }));
      setLocalBroken(false);
    } catch {
      // Private mode or a full disk: say that this browser keeps no copy.
      setLocalBroken(true);
    }
  }, 400);
  // On open: a copy left here that the server does not have becomes the restore offer.
  React.useEffect(() => {
    if (loading || !me || localChecked.current === localKey) return;
    localChecked.current = localKey;
    if (restoreOffer) return;
    try {
      const raw = window.localStorage.getItem(localKey);
      if (!raw) return;
      const kept = JSON.parse(raw) as { content: DocContent; baseVersion: number; at: string };
      const old = Date.now() - Date.parse(kept.at) > 14 * 864e5;
      const server = doc ? contentOf(doc) : saved;
      if (old || (doc && kept.baseVersion > doc.version) || sameContent(contentOf(kept.content as CmsDoc), server as CmsDoc)) return window.localStorage.removeItem(localKey);
      setRestoreOffer({ content: contentOf(kept.content as CmsDoc), baseVersion: kept.baseVersion, at: kept.at, by: t("restore_this_browser") });
    } catch {
      /* bad JSON: ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, doc?.slug, me?.actor.id, localKey]);
  React.useEffect(() => {
    if (loading || localChecked.current !== localKey) return;
    if (edited.current && !sameContent(content, saved)) writeLocal(content, baseVersion);
    else {
      writeLocal.cancel();
      try {
        window.localStorage.removeItem(localKey);
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, saved, loading, localKey]);
  // Leaving with edits the server has not got asks first.
  const unsaved = dirty && auto.state !== "saved";
  React.useEffect(() => {
    if (!unsaved) return;
    const on = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [unsaved]);
  // Offline: say so, and save when the connection is back.
  const [offline, setOffline] = React.useState(false);
  React.useEffect(() => {
    const sync = () => setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  React.useEffect(() => {
    if (!offline && auto.state === "failed" && doc && live.current.dirty) autosave(live.current.content, live.current.baseVersion, doc.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

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
        onSaved={(d, submitted) => {
          setMode({ kind: "edit" });
          setReviewed({});
          // A state-only answer: what is on screen becomes what was submitted.
          if (d.receipt && submitted) {
            setContentRaw(submitted);
            live.current.content = submitted;
          }
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
  const canWrite = schema.canWrite && !lostWrite;
  const canPublish = schema.canPublish;
  const published = !!doc && doc.publishedVersion !== null && doc.status !== "archived";
  const publicUrl = published && schema.hasUrl && publicUrlFor && doc ? publicUrlFor(collection, doc.slug) : null;
  const previewAllowed = !!doc && !!me?.previewLinks && schema.hasUrl;
  const title = content.title || (isNew ? t("new_doc_title") : currentSlug);
  // Hide (archive) a published document or show it again. Only the state changes, so what is being
  // edited stays as it is.
  const canHide = !!doc && canPublish && !schema.single && doc.publishedVersion !== null && doc.status !== "archived";
  const canUnhide = !!doc && canPublish && doc.status === "archived";
  const takeState = (d: CmsDoc) => setDoc((prev) => (prev ? { ...prev, status: d.status, publishedAt: d.publishedAt, republishedAt: d.republishedAt, updatedAt: d.updatedAt } : prev));
  const setHidden = (hide: boolean) => {
    if (!doc) return;
    (hide ? client.archive(collection, doc.slug) : client.unarchive(collection, doc.slug)).then(
      (d) => {
        takeState(d);
        toast(t(hide ? "done_archive" : "done_unarchive"), { tone: "ok" });
      },
      (e) => {
        if (hide && isCmsRemoteError(e) && e.code === "doc_referenced") setHideAsk(true);
        else toast(errorMessage(e, t), { tone: "error" });
      }
    );
  };
  const hideItems = (
    <>
      {canHide ? <DropdownMenuItem onClick={() => setHidden(true)}>{t("action_archive")}</DropdownMenuItem> : null}
      {canUnhide ? <DropdownMenuItem onClick={() => setHidden(false)}>{t("action_unarchive")}</DropdownMenuItem> : null}
    </>
  );
  const fieldCount = Object.keys(((schema.fields ?? {}) as { properties?: object }).properties ?? {}).length;

  const stateBits = st ? (
    <>
      <StateBadge state={doc?.review ? (doc.review.state === "requested" ? "review" : "changes") : st.state} />
      {doc?.schedule?.publishAt ? <StateBadge state="scheduled" /> : null}
      {st.modifiedSincePublish ? <ModifiedMark /> : null}
    </>
  ) : null;
  const mustReview = !!schema.needsReview;
  const openThreads = threads.filter((x) => !x.resolvedAt);
  /** Answering a request is for people who may publish, and never for the one who asked when everyone needs a review. */
  const mayAnswer = canPublish && me?.actor.kind === "user" && !(schema.review?.everyone === "required" && doc?.review?.byKind === "user" && !doc.review.byAgent && doc.review.byId === me.actor.id);
  const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);

  const saveButtons = (cls?: string, up?: boolean) =>
    canWrite ? (
      <>
        <Button type="button" variant="outline" className={cls} disabled={busy || (!dirty && !isNew)} onClick={() => void save(false)}>
          {t("save")}
        </Button>
        {canPublish && !mustReview ? (
          <PublishButton
            className={cls}
            up={up}
            busy={busy}
            disabled={!dirty && !!st && st.state === "published" && !st.modifiedSincePublish}
            canSchedule={!!doc}
            schedule={doc?.schedule ?? null}
            onPublish={() => void publish()}
            onSchedule={scheduleAt}
            onUnschedule={unschedule}
          />
        ) : doc && doc.review?.state !== "requested" ? (
          <Button type="button" className={cls} disabled={busy} title={mustReview ? t("review_needed") : undefined} onClick={() => void requestReview()}>
            {t("review_request")}
          </Button>
        ) : null}
      </>
    ) : null;

  const strips = doc ? (
    <>
      <ReviewStrip doc={doc} canAnswer={!!mayAnswer} canWrite={canWrite} busy={busy} onApprove={() => void approve()} onReject={reject} onRequest={() => void requestReview()} />
      <ScheduleStrip
        doc={doc}
        canPublish={canPublish}
        busy={busy}
        onAgain={() => doc.schedule && quiet(scheduleAt({ publishAt: doc.schedule.publishAt, unpublishAt: doc.schedule.unpublishAt }))}
        onUnschedule={() => quiet(unschedule())}
      />
      {release ? (
        <div role="status" className="flex flex-wrap items-center gap-2.5 border-b bg-muted/50 px-4 py-2 text-[13.5px] md:px-6">
          <Layers aria-hidden className="h-4 w-4 shrink-0" />
          <span>{t("release_in", { name: release.name })}</span>
          {release.publishAt ? <span className="text-xs tabular-nums text-muted-foreground">{formatZonedTime(release.publishAt, locale, zone)}</span> : null}
          <span className="flex-1" />
          {onOpenRelease ? (
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onOpenRelease(release.id)}>
              {t("open")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  ) : null;

  /** Select a part of the body and bring it into view (a comment was pressed). */
  const showInBody = (start: number, end: number) => {
    setMobileTab("edit");
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
      caretRef.current = [start, end];
      const line = content.body.slice(0, start).split("\n").length - 1;
      el.scrollTop = Math.max(0, line * (parseFloat(getComputedStyle(el).lineHeight) || 24) - el.clientHeight / 3);
    });
  };
  const comments = (onClose?: () => void) =>
    doc ? (
      <CommentsPanel collection={collection} slug={doc.slug} body={content.body} canWrite={canWrite} threads={threads} onChanged={() => void loadComments(doc.slug)} getSelection={() => (caretRef.current && bodyRef.current ? [bodyRef.current.selectionStart, bodyRef.current.selectionEnd] : caretRef.current)} onGo={showInBody} onClose={onClose} />
    ) : null;
  // Drawn behind the text: what open comments are attached to, and where the others are.
  const marks = [
    ...openThreads.map((th) => placeOf(content.body, th)).filter((x): x is NonNullable<typeof x> => !!x && x.end > x.start),
    ...others
      .filter((o) => o.cursor && o.selection)
      .map((o) => {
        const a = offsetOf(content.body, o.cursor!.line, o.cursor!.ch);
        const b = offsetOf(content.body, o.selection!.line, o.selection!.ch);
        return { start: Math.min(a, b), end: Math.max(a, b), tone: "select" as const };
      }),
  ];
  const cursors: BodyCursor[] = others
    .filter((o) => o.cursor)
    .map((o) => ({ id: o.actorId, at: offsetOf(content.body, o.cursor!.line, o.cursor!.ch), label: o.agent ?? o.label, color: personColor(o.actorId, o.kind !== "user" || !!o.agent) }));

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

  const lostBanner = lostWrite ? (
    <div role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {t("doc_no_longer_editable")}
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
  // ── block editor (when the app passes one in `slots.blockEditor`) ──
  const BlockEditor = slots.blockEditor;
  const blocksOn = !!BlockEditor && view === "blocks";
  const targetOf = (md: string) => /\]\(([^)\s]+)/.exec(md)?.[1] ?? "";
  const blockProps = {
    value: content.body,
    onChange: (body: string) => setContent({ ...live.current.content, body }),
    readOnly: !canWrite,
    id: bodyId,
    describedBy: byField.body?.length ? `${bodyId}-err` : undefined,
    insertRef,
    commandsRef: blockCommandsRef,
    onStateChange: bumpToolbar,
    snippetCollections: schema.snippetCollections,
    resolveFileUrl: (target: string) => {
      const m = /^asset:([a-z0-9]{12})(?:\/(.*))?$/.exec(target);
      return m ? client.fileUrl({ id: m[1], name: m[2] ? decodeURIComponent(m[2]) : "file" }) : target;
    },
    onPickMedia: me?.media && canWrite ? () => new Promise<string | null>((done) => ((pickWaiter.current = done), setPicking(true))) : undefined,
    uploadFile:
      me?.media && canWrite
        ? (file: File) =>
            new Promise<string>((ok, bad) => {
              const up = createUploader({
                client,
                memory: null,
                onDone: (a) => ok(targetOf(assetMarkdown(a))),
                onChange: (items) => {
                  const f = items.find((i) => i.state === "failed");
                  if (f) (bad(new Error(f.error ?? t("media_upload_failed"))), up.remove(f.key));
                },
              });
              up.add([file]);
            })
        : undefined,
  };
  /** Put a file at the cursor: media on a line of its own, other files as a link. */
  /** What editor slots (`slots.editorActions`, `editorPanel`, `fieldAddon`) get. */
  const slotCtx: EditorSlotContext = {
    collection,
    slug: doc?.slug ?? null,
    content,
    setContent: (patch) => setContent({ ...content, ...patch }),
    insertMarkdown: (md) => {
      if (blocksOn && insertRef.current) return insertRef.current(md);
      const [at, end] = caretRef.current ?? [content.body.length, content.body.length];
      setContent({ ...content, body: `${content.body.slice(0, at)}${md}${content.body.slice(end)}` });
    },
    version: doc?.version ?? null,
    published: !!doc && doc.publishedVersion !== null,
    readOnly: !canWrite,
  };
  const insertAsset = (a: Parameters<typeof assetMarkdown>[0]) => {
    // A video file goes into a `:::video` block (what the Video block writes for a library file).
    const video = a.kind === "video";
    const md = video ? `:::video\n${targetOf(assetMarkdown(a))}\n:::` : assetMarkdown(a);
    if (pickWaiter.current) {
      pickWaiter.current(md);
      pickWaiter.current = null;
      return;
    }
    if (blocksOn && insertRef.current) return insertRef.current(md);
    const el = bodyRef.current;
    const [at, end] = caretRef.current ?? [content.body.length, content.body.length];
    const before = content.body.slice(0, at);
    const after = content.body.slice(end);
    const block = video || md.startsWith("!");
    const lead = !block || !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const tail = !block || after.startsWith("\n\n") ? "" : after.startsWith("\n") || !after ? "\n" : "\n\n";
    setContent({ ...content, body: `${before}${lead}${md}${tail}${after}` });
    // An image without alt text: leave the cursor between the brackets; otherwise after what was put in.
    const caret = block && !video && !a.alt ? before.length + lead.length + 2 : before.length + lead.length + md.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };
  const bodyErr = byField.body;
  const bodyInvalid = bodyErr?.some((e) => e.severity === "error");
  // ── the toolbar: commands of the block editor, or of the text box ──
  mdReadOnly.current = !canWrite;
  liveRef.current = () => ({ content: live.current.content, setBody: (body) => setContent({ ...live.current.content, body }) });
  const toolbarCommands = blocksOn ? blockCommands : mdCommands;
  const openFind = (replace: boolean) => {
    const el = bodyRef.current;
    const picked = !blocksOn && el ? el.value.slice(el.selectionStart, el.selectionEnd) : typeof window !== "undefined" ? (window.getSelection()?.toString() ?? "") : "";
    setFinding((f) => ({ n: (f?.n ?? 0) + (f ? 0 : 1), replace: replace || !!f?.replace, initial: picked && !picked.includes("\n") ? picked : (f?.initial ?? "") }));
  };
  /** Ctrl/Cmd+F finds and Ctrl+H (Cmd+Shift+H) replaces, inside the body. */
  const onBodyKeys = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if ((e.target as HTMLElement).closest("[data-cms-findbar]")) return;
    const k = e.key.toLowerCase();
    if (k === "f" && !e.shiftKey) {
      e.preventDefault();
      openFind(false);
    } else if (k === "h" && (e.ctrlKey ? !e.metaKey : e.shiftKey)) {
      e.preventDefault();
      openFind(true);
    }
  };
  /** The formatting toolbar: over the body, or inside the full-screen header (`inline`). */
  const toolbar = (inline: boolean) => (
    <EditorToolbar
      commands={toolbarCommands}
      tick={tbTick}
      view={BlockEditor && !inline ? view : undefined}
      onView={BlockEditor && !inline ? setView : undefined}
      canWrite={canWrite}
      body={content.body}
      inline={inline}
      label={
        <Label htmlFor={bodyId} className={cn("shrink-0 text-xs font-medium text-muted-foreground", (BlockEditor || inline) && "sr-only")}>
          {blocksOn ? t("blk_body") : t("field_body")}
        </Label>
      }
      outline={canWrite && sectionCount > 1 && !blocksOn ? { on: outline, toggle: () => setOutline((v) => !v) } : null}
      onMedia={me?.media && canWrite ? () => setPicking(true) : null}
      sidePreview={!mobile && !blocksOn ? { on: sidePreview, toggle: () => setSidePreview(!sidePreview) } : null}
      previewWindow={!mobile ? { on: previewWindow, toggle: () => setPreviewWindow((v) => !v) } : null}
      fullscreen={!mobile && !focus ? { onEnter: () => setFocus(true), buttonRef: focusButton } : null}
      onFind={(replace) => openFind(replace)}
      findOpen={!!finding}
    />
  );
  const bodyPane = schema.hideBody ? null : (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onBodyKeys}>
      {doc && schema?.agentEdits === "suggest" ? <SuggestionCards collection={collection} slug={doc.slug} canWrite={canWrite} onApplied={() => void client.get(collection, doc.slug, { draft: true }).then((d) => (live.current.dirty ? setStatus({ text: t("sugg_applied_dirty"), tone: "muted" }) : applyDoc(d)))} /> : null}
      {focus ? null : toolbar(false)}
      {finding ? <FindBar key={finding.n} commands={toolbarCommands} replace={finding.replace} canWrite={canWrite} initial={finding.initial} onClose={() => setFinding(null)} className={focus ? "top-2" : undefined} /> : null}
      <ConfirmDialog
        open={!!checks}
        onOpenChange={(o) => !o && setChecks(null)}
        title={checks?.blocking ? t("checks_blocked_title") : t("checks_warn_title")}
        description={checks?.blocking ? t("checks_blocked_text") : t("checks_warn_text")}
        confirmLabel={checks?.blocking ? t("close") : t("checks_publish_anyway")}
        destructive={false}
        onConfirm={() => {
          const go = checks && !checks.blocking;
          setChecks(null);
          if (go) void save(true, checksConfirmed.current);
        }}
      >
        <ul className="grid max-h-72 gap-1.5 overflow-y-auto text-sm" aria-label={t("checks_list")}>
          {[...(checks?.diagnostics.filter((d) => d.severity === "error") ?? []).map((d) => ({ severity: "error" as const, message: d.message, where: d.path })), ...(checks?.checks ?? []).map((c) => ({ severity: c.severity, message: c.message, where: c.line ? t("checks_line", { n: c.line }) : c.path }))].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)).map((c, i) => (
            <li key={i} className="flex items-start gap-2 rounded-md border px-3 py-2">
              <span className={cn("mt-0.5 shrink-0 rounded px-1.5 text-[11px] font-medium", c.severity === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>{c.severity === "error" ? t("checks_error") : t("checks_warning")}</span>
              <span className="min-w-0 flex-1 break-words">{c.message}</span>
              {c.where ? <span className="shrink-0 text-xs text-muted-foreground">{c.where}</span> : null}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      <CmsMediaPicker
        open={picking}
        onOpenChange={(o) => {
          setPicking(o);
          if (!o && pickWaiter.current) (pickWaiter.current(null), (pickWaiter.current = null));
        }}
        onPick={insertAsset}
      />
      {blocks}
      {outline && sectionCount > 1 ? (
        <SectionsOrder
          body={content.body}
          className="min-h-[360px]"
          onChange={(body, m) => {
            setContent({ ...content, body });
            setStatus({ text: t("section_moved", { title: m.title, n: m.place, total: m.total }), tone: "muted" });
          }}
          onOpen={(s) => {
            const line = lineAt(content.body, s.start);
            pickLines(line, line);
          }}
        />
      ) : null}
      {blocksOn && BlockEditor ? (
        <div className="mx-auto flex w-full max-w-[780px] flex-1 flex-col px-5 sm:pl-12 sm:pr-8">
          <React.Suspense fallback={<p className="py-6 text-sm text-muted-foreground">{t("blk_loading")}</p>}>
            <BlockEditor key={`${collection}/${currentSlug}`} {...blockProps} />
          </React.Suspense>
        </div>
      ) : null}
      <div className={cn("relative flex min-h-[360px] flex-1 flex-col", ((outline && sectionCount > 1) || blocksOn) && "hidden")}>
        {marks.length || cursors.length || (finding && findMarks.length) ? <BodyBackdrop box={bodyRef} text={content.body} marks={finding ? [...marks, ...findMarks] : marks} cursors={cursors} /> : null}
        <Textarea
          ref={bodyRef}
          id={bodyId}
          onSelect={(e) => {
            caretRef.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd];
            sync.reveal(lineAt(e.currentTarget.value, e.currentTarget.selectionStart));
          }}
          value={content.body}
          readOnly={!canWrite}
          spellCheck={false}
          aria-invalid={bodyInvalid || undefined}
          aria-describedby={bodyErr?.length ? `${bodyId}-err` : undefined}
          className="relative min-h-[360px] flex-1 resize-none rounded-none border-0 bg-transparent font-mono text-[13px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => {
            setContent({ ...content, body: e.target.value });
            showBody();
          }}
          onScroll={showBody}
          onPaste={(e) => {
            if (!canWrite) return;
            const r = pasteAsMarkdown({ html: e.clipboardData.getData("text/html"), plain: e.clipboardData.getData("text/plain") });
            if (!r) return; // nothing to tidy: the browser pastes as usual
            e.preventDefault();
            const el = e.currentTarget;
            const [a, b] = [el.selectionStart, el.selectionEnd];
            // insertText keeps the browser's undo history; where it is missing, set the text directly.
            if (!(typeof document.execCommand === "function" && document.execCommand("insertText", false, r.text))) {
              setContent({ ...content, body: content.body.slice(0, a) + r.text + content.body.slice(b) });
              requestAnimationFrame(() => el.setSelectionRange(a + r.text.length, a + r.text.length));
            }
            if (r.dropped) setStatus({ text: t("paste_dropped"), tone: "muted" });
          }}
        />
      </div>
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
      <div ref={previewRef} className="flex-1 overflow-auto" onScroll={showBody}>
        <MarkdownPreview title={content.title} summary={content.summary} body={content.body} onPickLines={pickLines} className={cn("mx-auto px-5 py-4", width === "375" ? "max-w-[375px]" : width === "768" ? "max-w-[768px]" : "max-w-none")} />
      </div>
    </section>
  );

  const seoWarnings = shownProblems.filter((p) => p.path.startsWith("seo") || p.code?.startsWith?.("seo_")).length;
  const takenRedirect = isNew ? (shownProblems.find((p) => p.code === "redirect_taken") as (Diagnostic & { params?: Record<string, unknown> }) | undefined) : undefined;
  const redirectNote = takenRedirect ? (
    <span className="text-amber-700 dark:text-amber-400">
      {t("redirect_at_slug", { from: String(takenRedirect.params?.from ?? "") })}{" "}
      {me?.isAdmin && takenRedirect.params?.id ? (
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() =>
            client.removeRedirect(String(takenRedirect.params!.id)).then(
              () => void diagnose(live.current.content),
              (e) => setStatus({ text: errorMessage(e, t), tone: "error" })
            )
          }
        >
          {t("redirect_remove")}
        </button>
      ) : null}
    </span>
  ) : null;
  const form = (
    <FieldGate.Provider value={fieldGate}>
      <RelatedLabels.Provider value={relCtx}>
        <CmsFieldForm
          disabled={!canWrite}
          schema={schema}
          value={content}
          onChange={setContent}
          problems={byField}
          slugLocked={!!doc && doc.publishedVersion !== null && !schema.redirects}
          slugPrefix={slugPrefix}
          idPrefix="cms-editor"
          slotContext={slotCtx}
          hideSlug={!!schema.single}
          slugNote={redirectNote}
        />
      </RelatedLabels.Provider>
      {schema.seo ? (
        <details className="group mt-4 min-w-0 rounded-md border" open={seoOpen} onToggle={(e) => setSeoOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown aria-hidden className="h-4 w-4 -rotate-90 transition-transform duration-150 ease-out group-open:rotate-0" />
            {t("seo_title")}
            {seoWarnings ? <span className="ml-1 rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-700 dark:text-amber-400">{seoWarnings}</span> : null}
          </summary>
          <div className="border-t p-3">
            <SeoPanel
              value={content.seo}
              onChange={(seo) => setContent({ ...content, seo })}
              fallback={{ title: content.title, description: content.summary, image: /!\[[^\]]*\]\((asset:[^)\s]+|https:\/\/[^)\s]+)/.exec(content.body)?.[1] ?? null }}
              limits={schema.seo}
              url={publicUrlFor && content.slug ? publicUrlFor(collection, content.slug) : null}
              disabled={!canWrite}
              descriptionAddon={slots.fieldAddon && !!slotCtx ? slots.fieldAddon({ key: "seo.description", label: t("seo_field_description"), widget: "textarea" }, { ...slotCtx, value: content.seo?.description ?? "", setValue: (v) => setContent({ ...content, seo: { ...(content.seo ?? {}), description: typeof v === "string" ? v : null } }) }) : undefined}
            />
          </div>
        </details>
      ) : null}
      {schema.snippets && doc ? (
        <div className="mt-4 min-w-0">
          <SnippetUses collection={collection} slug={doc.slug} onOpen={onOpenDocument} />
        </div>
      ) : null}
      {slots.editorPanel ? <div className="mt-4 min-w-0">{slots.editorPanel(slotCtx)}</div> : null}
    </FieldGate.Provider>
  );

  const focusStats = (() => {
    if (!focus) return "";
    const s = bodyStats(content.body);
    const n = (x: number) => x.toLocaleString(locale);
    return s.words ? `${t("blk_words", { n: n(s.words) })} · ${t("blk_read_min", { n: n(s.minutes) })}` : t("blk_words", { n: n(0) });
  })();
  const autosaveText =
    offline && dirty ? t("offline_kept") : auto.state === "saving" ? t("autosaving") : auto.state === "saved" && auto.at ? t("autosaved_at", { time: formatTime(auto.at, locale) }) : auto.state === "failed" ? t("autosave_failed") : dirty ? (localBroken ? t("unsaved_no_copy") : t("unsaved")) : "";

  const problemsFoot = (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-1.5 text-xs text-muted-foreground md:px-6">
        {shownProblems.length ? (
          <button type="button" className="inline-flex items-center gap-1.5 text-destructive hover:underline" aria-expanded={showProblems} aria-controls="cms-editor-problems" onClick={() => setShowProblems((v) => !v)}>
            <CircleAlert aria-hidden className="h-3.5 w-3.5" />
            {t("problems_n", { n: shownProblems.length })}
            <ChevronDown aria-hidden className={cn("h-3 w-3 transition-transform", showProblems && "rotate-180")} />
          </button>
        ) : problems.length ? null : (
          <span className="inline-flex items-center gap-1.5">
            <CircleCheck aria-hidden className="h-3.5 w-3.5" />
            {t("problems_none")}
          </span>
        )}
        <span className="flex-1" />
        <span role="status" className={cn(status?.tone === "error" && "text-destructive", status?.tone === "ok" && "text-green-700 dark:text-green-400")}>
          {status?.text ?? ""}
        </span>
        <span role="status" className="inline-flex items-center gap-1.5">
          {autosaveText ? <Cloud aria-hidden className="h-3.5 w-3.5" /> : null}
          {autosaveText}
        </span>
        {/* In full screen the toolbar sits in the header without its word count: it shows here. */}
        {focus && !schema.hideBody ? <span className="tabular-nums">{focusStats}</span> : null}
      </div>
      {shownProblems.length && showProblems ? (
        <ul id="cms-editor-problems" aria-label={t("problems_list")} className="border-t px-4 py-2 text-xs md:px-6">
          {shownProblems.map((p, i) => (
            <li key={i} className={cn("py-0.5", p.severity === "error" ? "text-destructive" : "text-amber-700")}>
              <span className="font-mono">{p.path}</span>: {p.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const previewDialog = (
    <>
      {tplDialog ? <SaveTemplateDialog collection={collection} content={content} onClose={() => setTplDialog(false)} /> : null}
      {hideAsk && doc ? (
        <ReferencedDialog
          collection={collection}
          slug={doc.slug}
          title={content.title || doc.slug}
          action="archive"
          onClose={() => setHideAsk(false)}
          onDone={(d) => {
            setHideAsk(false);
            if (d) takeState(d);
            toast(t("done_archive"), { tone: "ok" });
          }}
        />
      ) : null}
      {slugAsk && doc ? (
        <SlugChangeDialog
          from={publicUrlFor ? publicUrlFor(collection, doc.slug) : `${slugPrefix ?? ""}${doc.slug}`}
          to={publicUrlFor ? publicUrlFor(collection, content.slug) : `${slugPrefix ?? ""}${content.slug}`}
          canPublish={!!schema?.canPublish && !schema?.needsReview}
          onClose={() => setSlugAsk(null)}
          onConfirm={() => {
            setSlugAsk(null);
            // The address changes together with publishing: the normal Publish path (checks first).
            void publish(true);
          }}
        />
      ) : null}
      {previewAllowed && doc ? <CmsPreviewLinkDialog open={previewOpen} onOpenChange={setPreviewOpen} collection={collection} slug={doc.slug} version={doc.version} /> : null}
      {doc ? (
        <AddToReleaseDialog
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
          collection={collection}
          slug={doc.slug}
          published={published}
          onAdded={(r) => {
            setRelease({ id: r.id, name: r.name, state: "open", publishAt: null });
            setStatus({ text: t("release_added", { name: r.name }), tone: "ok" });
          }}
        />
      ) : null}
    </>
  );
  const canRelease = !!doc && canWrite && !release;

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
          <People people={others} max={2} />
          {publicUrl || previewAllowed || canRelease || (canWrite && !schema.single) || canHide || canUnhide ? (
            <DropdownMenu>
              <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon", className: "h-8 w-8" })} aria-label={t("more")}>
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {publicUrl ? <DropdownMenuItem onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}>{t("public_page")}</DropdownMenuItem> : null}
                {previewAllowed ? <DropdownMenuItem onClick={() => setPreviewOpen(true)}>{t("preview_link")}</DropdownMenuItem> : null}
                {canRelease ? <DropdownMenuItem onClick={() => setReleaseOpen(true)}>{t("release_add_to")}</DropdownMenuItem> : null}
                {canWrite && !schema.single ? <DropdownMenuItem onClick={() => setTplDialog(true)}>{t("doc_more_template")}</DropdownMenuItem> : null}
                {hideItems}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </PageHeader>
        {strips}
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
              {doc && canWrite ? (
                <TabsTrigger value="comments" className="h-6 text-xs">
                  {openThreads.length ? t("comments_n", { n: openThreads.length }) : t("comments")}
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>
          <TabsContent value="edit" className="mt-0 flex min-h-0 flex-1 flex-col">
            {agentBanner || restoreBanner || lostBanner ? (
              <div className="flex flex-col gap-2 px-4 pt-2.5">
                {lostBanner}
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
          <TabsContent value="comments" className="mt-0 flex min-h-0 flex-1 flex-col">
            {comments()}
          </TabsContent>
        </Tabs>
        {problemsFoot}
        <div className="sticky bottom-0 z-10 flex gap-2 border-t bg-background p-2">{saveButtons("flex-1", true)}</div>
        {previewDialog}
      </div>
    );

  // Wide screens: the editor is as tall as the window, so the text and the preview scroll side by side
  // (and follow each other). Under a top bar of your own, pass e.g. className="h-[calc(100dvh-4rem)]".
  return (
    <div
      ref={rootRef}
      data-focus={focus ? "" : undefined}
      role={focus ? "region" : undefined}
      aria-label={focus ? t("focus_bar") : undefined}
      className={cn("relative flex h-dvh min-h-0 flex-none flex-col overflow-y-auto", className, focus && "fixed inset-0 z-40 h-dvh w-screen max-w-none bg-background")}
    >
      <div ref={headRef} className="sticky top-0 z-20 bg-background">
        {focus ? (
          <div
            className={cn(
              "flex h-12 items-center gap-1.5 border-b px-3 transition-opacity duration-300 ease-out motion-reduce:transition-none focus-within:opacity-100 hover:opacity-100",
              barQuiet && "opacity-0",
            )}
          >
            <TipButton label={t("focus_exit")} keys="Mod+Shift+F" tipAlign="start" onClick={() => setFocus(false)}>
              <Minimize2 aria-hidden className="size-4" />
            </TipButton>
            <span className="min-w-0 max-w-[16rem] shrink truncate text-sm font-medium" title={title}>
              <bdi>{title}</bdi>
            </span>
            {/* The save state (the status line below announces it). */}
            <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground sm:inline">{autosaveText}</span>
            {bodyPane ? toolbar(true) : <span className="flex-1" />}
            <TipButton label={focusFields ? t("focus_fields_hide") : t("focus_fields")} tipAlign="end" className={cn("relative", focusFields && "bg-muted text-foreground")} aria-pressed={focusFields} aria-controls="cms-focus-fields" onClick={() => setFocusFields((v) => !v)}>
              <SlidersHorizontal aria-hidden className="size-4" />
              {fieldErrors && !focusFields ? <span aria-label={t("problems_n", { n: fieldErrors })} className="absolute right-1 top-1 size-2 rounded-full bg-destructive" /> : null}
            </TipButton>
            {typeof document !== "undefined" && document.fullscreenEnabled ? (
              <TipButton label={screenFull ? t("focus_screen_off") : t("focus_screen")} tipAlign="end" aria-pressed={screenFull} onClick={toggleScreen}>
                <Monitor aria-hidden className="size-4" />
              </TipButton>
            ) : null}
            {canWrite ? <span aria-hidden className="mx-[3px] h-5 w-px shrink-0 bg-border" /> : null}
            {saveButtons()}
          </div>
        ) : (
        <PageHeader title={title} crumbs={[schema.label]} after={stateBits}>
          <People people={others} className="mr-1" />
          {doc && canWrite ? (
            <Button type="button" variant="ghost" className="gap-1.5" aria-pressed={commentsOpen} onClick={() => setCommentsOpen((v) => !v)}>
              <MessageSquare aria-hidden className="h-4 w-4" />
              {openThreads.length ? t("comments_n", { n: openThreads.length }) : t("comments")}
            </Button>
          ) : null}
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
          {canRelease || (canWrite && !schema.single) || canHide || canUnhide ? (
            <DropdownMenu>
              <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label={t("more")}>
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canRelease ? <DropdownMenuItem onClick={() => setReleaseOpen(true)}>{t("release_add_to")}</DropdownMenuItem> : null}
                {canWrite && !schema.single ? <DropdownMenuItem onClick={() => setTplDialog(true)}>{t("doc_more_template")}</DropdownMenuItem> : null}
                {hideItems}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {slots.editorActions?.(slotCtx)}
          {saveButtons()}
        </PageHeader>
        )}
      </div>
      {focus ? null : strips}
      {agentBanner || restoreBanner || lostBanner ? (
        <div className="flex flex-col gap-2 px-6 pt-2.5">
          {lostBanner}
                {restoreBanner}
          {agentBanner}
        </div>
      ) : null}
      {/* In full screen the fields fold away under the bar; they stay mounted so nothing typed is lost. */}
      <div id="cms-focus-fields" className={cn("border-b px-6 py-3.5", focus && "mx-auto w-full max-w-[780px] border-x-0", focus && !focusFields && "hidden")}>
        {form}
      </div>
      {sideBySide ? (
        <div ref={rowRef} className={cn("flex min-h-[360px] divide-x", rowHeight === null ? "flex-1" : "shrink-0")} style={rowHeight === null ? undefined : { height: rowHeight }}>
          {bodyPane}
          {previewPane(true)}
          {commentsOpen && !focus ? comments(() => setCommentsOpen(false)) : null}
        </div>
      ) : (
        // One column: the body grows with its text and the page scrolls (the header and the status line stay).
        <div ref={rowRef} className="flex min-h-[360px] flex-1 divide-x">
          {bodyPane}
          {commentsOpen && !focus ? <div className="sticky top-0 flex max-h-dvh w-80 shrink-0 flex-col self-start">{comments(() => setCommentsOpen(false))}</div> : null}
        </div>
      )}
      {previewWindow ? <PreviewWindow title={content.title} summary={content.summary} body={content.body} name={`cms-preview-${collection}-${currentSlug ?? "new"}`} onClosed={() => setPreviewWindow(false)} /> : null}
      <div ref={footRef} className="sticky bottom-0 z-10 bg-background">
        {problemsFoot}
      </div>
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
  const [comments, setComments] = React.useState(false);
  const [link, setLink] = React.useState<{ url: string; expiresAt: string; version: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const ttlId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    // A link made with the old settings is not offered while the new one is made.
    setLink(null);
    client.previewLink(collection, slug, ttl, { comments }).then(
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
  }, [open, ttl, comments, client, collection, slug, t, attempt]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG.md}>
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
            <span id={ttlId} className="text-xs font-medium text-muted-foreground">
              {t("pl_expiry")}
            </span>
            <Segmented
              labelledBy={ttlId}
              value={ttl}
              onChange={setTtl}
              options={[
                { value: "1h", label: t("ttl_1h") },
                { value: "24h", label: t("ttl_24h") },
                { value: "7d", label: t("ttl_7d") },
              ]}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={comments} onChange={(e) => setComments(e.target.checked)} />
            {t("pl_comments")}
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("pl_link")}</span>
            {link ? (
              <div className="flex min-w-0 items-start gap-2">
                <CodeBox className="flex-1" value={/^\//.test(link.url) ? `${appUrl}${link.url}` : link.url} label={t("pl_link")} />
                <a href={/^\//.test(link.url) ? `${appUrl}${link.url}` : link.url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm", className: "h-[38px] shrink-0 gap-1.5" })}>
                  <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                  {t("open")}
                </a>
              </div>
            ) : loading ? (
              <div aria-hidden className="h-[38px] animate-pulse rounded-md bg-muted" />
            ) : null}
            <StatusText className="text-xs" tone={error ? "error" : "muted"}>
              {error ?? (loading ? t("pl_making") : link ? t("pl_until", { time: formatUntil(link.expiresAt, locale) }) : "")}
            </StatusText>
            {error ? (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setAttempt((n) => n + 1)}>
                {t("retry")}
              </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">{comments ? t("pl_who_comments") : t("pl_who")}</p>
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

/** Agents' edits waiting for a person (collections with `agentEdits: "suggest"`): what changes, apply or reject. */
function SuggestionCards({ collection, slug, canWrite, onApplied }: { collection: string; slug: string; canWrite: boolean; onApplied: () => void }) {
  const { client, t, locale, toast } = useCms();
  const list = useAsync(() => client.suggestions(collection, slug), [client, collection, slug]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const items = list.data ?? [];
  if (!items.length) return null;
  const act = async (id: string, apply: boolean) => {
    setBusy(id);
    try {
      if (apply) await client.applySuggestion(collection, slug, id);
      else await client.rejectSuggestion(collection, slug, id);
      toast(apply ? t("sugg_applied") : t("sugg_rejected"), { tone: "ok" });
      list.reload();
      if (apply) onApplied();
    } catch (e) {
      toast(errorMessage(e, t), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2 border-b bg-muted/30 px-3 py-2" role="region" aria-label={t("sugg_title", { n: items.length })}>
      <p className="text-xs font-medium">{t("sugg_title", { n: items.length })}</p>
      {items.map((s) => (
        <article key={s.id} className="rounded-md border bg-background p-2.5 text-sm">
          <header className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{s.by.agent ? `${s.by.agent}, ${s.by.label}` : s.by.label}</span>
            <time dateTime={s.at} title={new Date(s.at).toLocaleString(locale)}>
              {relativeTime(s.at, t, locale)}
            </time>
            {s.lines.length ? <span>{t("sugg_lines", { from: s.lines[0].from, to: s.lines[s.lines.length - 1].to })}</span> : null}
          </header>
          {s.note ? <p className="mb-1.5">{s.note}</p> : null}
          <div className="grid gap-1 font-mono text-[12px] leading-5">
            {s.edits.slice(0, 3).map((e, i) => (
              <div key={i} className="grid gap-0.5">
                <del className="block whitespace-pre-wrap break-words rounded bg-destructive/10 px-1.5 no-underline">{e.oldString}</del>
                <ins className="block whitespace-pre-wrap break-words rounded bg-emerald-500/15 px-1.5 no-underline">{e.newString || "∅"}</ins>
              </div>
            ))}
            {s.edits.length > 3 ? <span className="text-xs text-muted-foreground">{t("sugg_more", { n: s.edits.length - 3 })}</span> : null}
          </div>
          {canWrite ? (
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" className="h-7" disabled={busy === s.id} onClick={() => void act(s.id, true)}>
                {t("sugg_apply")}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-7" disabled={busy === s.id} onClick={() => void act(s.id, false)}>
                {t("sugg_reject")}
              </Button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

// ── body length ───────────────────────────────────────────────────────────────

/** Words, characters and reading time of the body (markup left out). Lives with the toolbar that shows it. */
export { bodyStats } from "./cms-editor-toolbar";

// ── live preview in a window of its own ───────────────────────────────────────

/**
 * The preview in a separate browser window (put it on a second screen): it is
 * drawn by this page, so it follows every keystroke without saving. Closing it
 * or pressing the button again ends it.
 */
function PreviewWindow({ title, summary, body, name, onClosed }: { title: string; summary: string; body: string; name: string; onClosed: () => void }) {
  const { t, toast } = useCms();
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const [width, setWidth] = React.useState<"375" | "768" | "full">("full");
  const win = React.useRef<Window | null>(null);
  const closedRef = React.useRef(onClosed);
  closedRef.current = onClosed;
  React.useEffect(() => {
    const w = window.open("", name, "popup,width=920,height=1000");
    if (!w) {
      toast(t("blk_preview_blocked"), { tone: "error" });
      closedRef.current();
      return;
    }
    win.current = w;
    const d = w.document;
    d.title = t("preview");
    d.documentElement.lang = document.documentElement.lang;
    d.documentElement.className = document.documentElement.className;
    d.documentElement.style.cssText = document.documentElement.style.cssText;
    // The same styles as this page, so the preview looks the same.
    d.head.innerHTML = "";
    for (const el of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) d.head.appendChild(el.cloneNode(true));
    const base = d.createElement("base");
    base.href = document.baseURI;
    d.head.prepend(base);
    d.body.innerHTML = "";
    d.body.className = document.body.className;
    const root = d.createElement("div");
    d.body.appendChild(root);
    setHost(root);
    // Keep the theme in step with the admin.
    const mo = new MutationObserver(() => (d.documentElement.className = document.documentElement.className));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const timer = window.setInterval(() => {
      if (w.closed) {
        window.clearInterval(timer);
        closedRef.current();
      }
    }, 500);
    const closeWithUs = () => w.close();
    window.addEventListener("pagehide", closeWithUs);
    return () => {
      mo.disconnect();
      window.clearInterval(timer);
      window.removeEventListener("pagehide", closeWithUs);
      setHost(null);
      if (!w.closed) w.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  React.useEffect(() => {
    if (win.current && !win.current.closed) win.current.document.title = `${t("preview")} · ${title || t("new_doc_title")}`;
  }, [title, t]);
  if (!host) return null;
  return createPortal(
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <span>{t("blk_preview_live")}</span>
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
      <MarkdownPreview title={title} summary={summary} body={body} className={cn("mx-auto px-6 py-8", width === "375" ? "max-w-[375px]" : width === "768" ? "max-w-[768px]" : "max-w-3xl")} />
    </div>,
    host
  );
}
