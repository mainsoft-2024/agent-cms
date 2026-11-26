// agent-cms registry: cms-merge (0.26.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Someone saved first. Shows what merged by itself and, for each place both
// sides changed, lets you pick theirs, mine or both (body) / theirs or mine
// (other fields). "Save merged" saves on top of their version; if they saved
// yet again, the merge starts over with the newest copy.
"use client";

import * as React from "react";
import { GitMerge } from "lucide-react";
import type { CmsDoc, DocContent } from "@mainsoft/agent-cms/types";
import { diffWords, mergeDocs, resolveDocMerge, type DocLike, type MergeChoice } from "@mainsoft/agent-cms/diff";
import { isCmsRemoteError } from "@mainsoft/agent-cms/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage, type MessageKey } from "./cms-messages";
import { Avatar, PageHeader, StatusText, Who } from "./cms-parts";
import { contentOf, toInput, useCms } from "./use-cms";

export interface CmsMergeProps {
  collection: string;
  slug: string;
  /** The version both edits started from (`version(c, s, baseVersion).snapshot`). */
  base: DocLike;
  baseVersion: number;
  /** The editor's content. */
  mine: DocLike;
  /** The copy someone else saved (`CmsRemoteError.current` of the 409). */
  theirs: CmsDoc;
  /** Saved: the new document. */
  onSaved: (doc: CmsDoc, submitted?: DocContent) => void;
  /** Back to the editor without saving. */
  onCancel: () => void;
  /** Breadcrumb before the title (e.g. the collection and document). */
  crumbs?: React.ReactNode[];
  className?: string;
}

const FIELD_LABEL: Record<string, MessageKey> = { title: "field_title", slug: "field_slug", summary: "field_summary", category: "field_category", keywords: "field_keywords", body: "field_body" };

const show = (v: unknown, empty: string): string => (v === undefined || v === null || v === "" ? empty : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Where a conflict sits: the nearest heading above and the line in the merged text. */
function locate(chunks: ReturnType<typeof mergeDocs>["body"]["chunks"], id: number): { heading: string | null; line: number } {
  let line = 1;
  let heading: string | null = null;
  for (const c of chunks) {
    if (c.t === "conflict" && c.id === id) return { heading, line };
    const lines = c.t === "ok" ? c.lines : c.theirs;
    for (const l of lines) if (/^#{1,6}\s/.test(l)) heading = l;
    line += lines.length;
  }
  return { heading, line };
}

export function CmsMerge({ collection, slug, base: base0, baseVersion: baseVersion0, mine: mine0, theirs: theirs0, onSaved, onCancel, crumbs, className }: CmsMergeProps) {
  const { client, t } = useCms();
  const [round, setRound] = React.useState({ base: contentOf(base0), baseVersion: baseVersion0, mine: contentOf(mine0), theirs: theirs0, again: false });
  const m = React.useMemo(() => mergeDocs(round.base, round.mine, contentOf(round.theirs)), [round]);
  const [body, setBody] = React.useState<Record<number, MergeChoice>>({});
  const [fields, setFields] = React.useState<Record<string, "mine" | "theirs">>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const total = m.body.conflicts.length + m.fieldConflicts.length;
  const chosen = m.body.conflicts.filter((c) => body[c.id]).length + m.fieldConflicts.filter((f) => fields[f.path]).length;
  const theirsWho = round.theirs.updatedBy ?? "";
  const theirsKind = round.theirs.updatedByKind;

  const auto = React.useMemo(() => {
    const rows: { where: string; from: "mine" | "theirs" | "both"; content: React.ReactNode }[] = [];
    for (const a of m.autoMerged) {
      if (a.path === "body") continue;
      const label = FIELD_LABEL[a.path] ? t(FIELD_LABEL[a.path]) : a.path.replace(/^fields\./, "");
      const get = (d: DocLike) => (a.path.startsWith("fields.") ? a.path.slice(7).split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), d.fields) : (d as unknown as Record<string, unknown>)[a.path]);
      const before = show(get(round.base), "");
      const after = show(get(m.merged), t("merge_field_empty"));
      rows.push({ where: label, from: a.from, content: <WordIns a={before} b={after} /> });
    }
    let line = 1;
    let heading: string | null = null;
    for (const c of m.body.chunks) {
      const lines = c.t === "ok" ? c.lines : c.theirs;
      if (c.t === "ok" && c.from !== "base") {
        rows.push({
          where: heading ? t("merge_location", { heading, line }) : t("merge_line", { line }),
          from: c.from,
          content: <span className="whitespace-pre-wrap">{c.lines.join("\n")}</span>,
        });
      }
      for (const l of lines) if (/^#{1,6}\s/.test(l)) heading = l;
      line += lines.length;
    }
    return rows;
  }, [m, round.base, t]);

  const save = async () => {
    if (chosen < total) {
      setError(t("merge_pick_all"));
      return;
    }
    setBusy(true);
    setError(null);
    const merged = resolveDocMerge(m, { body, fields });
    // Search engine details are not in the line merge: an unsaved change of the person saving is kept.
    const seoOf = (d: { seo?: unknown }) => JSON.stringify(d.seo ?? null);
    if (seoOf(round.mine) !== seoOf(round.base)) (merged as { seo?: unknown }).seo = (round.mine as { seo?: unknown }).seo ?? null;
    try {
      const doc = await client.update(collection, slug, toInput(merged, round.theirs.fields), { expectedVersion: round.theirs.version });
      onSaved(doc, merged);
    } catch (e) {
      if (isCmsRemoteError(e) && e.code === "conflict_version" && e.current) {
        // They saved again: merge what we resolved against the newest copy.
        setRound({ base: contentOf(round.theirs), baseVersion: round.theirs.version, mine: merged, theirs: e.current as CmsDoc, again: true });
        setBody({});
        setFields({});
      } else setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  let index = 0;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("merge")} crumbs={crumbs}>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="button" onClick={() => void save()} disabled={busy}>
          {t("merge_save")}
        </Button>
      </PageHeader>
      <div className="flex max-w-4xl flex-col gap-3.5 px-4 py-4 md:px-6">
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <GitMerge aria-hidden className="h-4 w-4 shrink-0" />
          <span>{round.again ? t("merge_again", { who: theirsWho, version: round.theirs.version }) : t("merge_banner", { who: theirsWho, version: round.theirs.version })}</span>
          <span className="flex-1" />
          <span className="text-xs">{t("merge_counts", { auto: auto.length, conflicts: total })}</span>
        </div>
        {error ? <StatusText tone="error">{error}</StatusText> : null}

        {m.body.conflicts.map((c) => {
          index++;
          const loc = locate(m.body.chunks, c.id);
          const name = `cms-merge-body-${c.id}`;
          const titleId = `${name}-title`;
          return (
            <section key={`b${c.id}`} aria-labelledby={titleId} className="rounded-lg border p-3.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge id={titleId} variant="outline" className="border-red-200 bg-red-50 text-red-700">
                  {t("merge_choose", { i: index, n: total })}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">{loc.heading ? t("merge_location", { heading: loc.heading, line: loc.line }) : t("merge_line", { line: loc.line })}</span>
              </div>
              <div className="mb-1 text-xs text-muted-foreground">{t("merge_base", { version: round.baseVersion })}</div>
              <pre className="mb-3 whitespace-pre-wrap rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">{c.base.join("\n") || t("merge_field_empty")}</pre>
              <RadioGroup aria-labelledby={titleId} value={body[c.id] ?? ""} onValueChange={(v) => setBody((b) => ({ ...b, [c.id]: v as MergeChoice }))} className="grid gap-2 md:grid-cols-3">
                {(
                  [
                    { v: "theirs", head: <><Avatar kind={theirsKind} label={theirsWho} />{t("merge_theirs", { who: theirsWho, version: round.theirs.version })}</>, lines: c.theirs },
                    { v: "mine", head: <>{t("merge_mine")}</>, lines: c.mine },
                    { v: "both", head: <>{t("merge_both")}</>, lines: [...c.theirs, ...c.mine] },
                  ] as const
                ).map((o) => (
                  <Option key={o.v} id={`${name}-${o.v}`} value={o.v} selected={body[c.id] === o.v} head={o.head}>
                    {o.lines.join("\n") || t("merge_field_empty")}
                  </Option>
                ))}
              </RadioGroup>
            </section>
          );
        })}

        {m.fieldConflicts.map((f) => {
          index++;
          const name = `cms-merge-f-${f.path.replace(/[^a-z0-9_-]/gi, "-")}`;
          const titleId = `${name}-title`;
          const label = FIELD_LABEL[f.path] ? t(FIELD_LABEL[f.path]) : f.path.replace(/^fields\./, "");
          return (
            <section key={f.path} aria-labelledby={titleId} className="rounded-lg border p-3.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                  {t("merge_choose", { i: index, n: total })}
                </Badge>
                <span id={titleId} className="text-sm font-medium">
                  {label}
                </span>
              </div>
              <div className="mb-1 text-xs text-muted-foreground">{t("merge_base", { version: round.baseVersion })}</div>
              <div className="mb-3 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">{show(f.base, t("merge_field_empty"))}</div>
              <RadioGroup aria-labelledby={titleId} value={fields[f.path] ?? ""} onValueChange={(v) => setFields((x) => ({ ...x, [f.path]: v as "mine" | "theirs" }))} className="grid gap-2 md:grid-cols-2">
                <Option id={`${name}-theirs`} value="theirs" selected={fields[f.path] === "theirs"} head={<><Avatar kind={theirsKind} label={theirsWho} />{t("merge_theirs", { who: theirsWho, version: round.theirs.version })}</>}>
                  {show(f.theirs, t("merge_field_empty"))}
                </Option>
                <Option id={`${name}-mine`} value="mine" selected={fields[f.path] === "mine"} head={<>{t("merge_mine")}</>}>
                  {show(f.mine, t("merge_field_empty"))}
                </Option>
              </RadioGroup>
            </section>
          );
        })}

        {auto.length ? (
          <section aria-label={t("merge_auto")} className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("merge_auto")}</TableHead>
                  <TableHead>{t("merge_whose")}</TableHead>
                  <TableHead>{t("merge_content")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auto.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap align-top text-xs">{r.where}</TableCell>
                    <TableCell className="whitespace-nowrap align-top text-sm">
                      {r.from === "theirs" ? <Who kind={theirsKind} label={theirsWho} /> : r.from === "mine" ? t("merge_mine") : t("merge_from_both")}
                    </TableCell>
                    <TableCell className="align-top text-sm">{r.content}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Option({ id, value, selected, head, children }: { id: string; value: string; selected: boolean; head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-md border p-2.5", selected && "border-foreground ring-1 ring-foreground")}>
      <div className="flex items-center gap-2">
        <RadioGroupItem id={id} value={value} />
        <Label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium">
          {head}
        </Label>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-xs">{children}</pre>
    </div>
  );
}

function WordIns({ a, b }: { a: string; b: string }) {
  return (
    <>
      {diffWords(a, b).map((p, i) =>
        p.t === "del" ? null : p.t === "ins" ? (
          <ins key={i} className="bg-green-200 no-underline">
            {p.v}
          </ins>
        ) : (
          <React.Fragment key={i}>{p.v}</React.Fragment>
        )
      )}
    </>
  );
}
