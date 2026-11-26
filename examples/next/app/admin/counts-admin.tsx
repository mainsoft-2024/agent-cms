"use client";

// The admin half of `lib/counts-plugin.ts` (0.24.0): a page at /admin/p/counts, given to
// <CmsProvider plugins> in admin-frame.tsx. 0.26.0: a panel beside the document editor too.
import { useEffect, useState } from "react";
import { defineAdminPlugin, useCmsAdmin, usePluginT, type EditorSideContext } from "@mainsoft/agent-cms/react";

type Row = { collection: string; label: string; all: number; published: number; draft: number };

function CountsPage() {
  const { client } = useCmsAdmin();
  const t = usePluginT("counts");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    client.request<{ rows: Row[] }>("GET", "/counts/summary").then(
      (r) => setRows(r.rows),
      (e: Error) => setError(e.message)
    );
  }, [client]);
  if (error) return <p className="px-4 py-4 text-sm text-destructive md:px-6">{error}</p>;
  if (!rows) return <p className="px-4 py-4 text-sm text-muted-foreground md:px-6">{t("loading")}</p>;
  return (
    <div className="px-4 py-4 md:px-6">
      <p className="mb-4 text-sm text-muted-foreground">{t("intro")}</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <li key={r.collection} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">{r.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{r.all}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("split", { published: r.published, draft: r.draft })}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 0.26.0 `slots.editorSide`: the open collection's counts beside the editor. */
function CountsSide({ ctx }: { ctx: EditorSideContext }) {
  const { client } = useCmsAdmin();
  const t = usePluginT("counts");
  const [row, setRow] = useState<Row | null>(null);
  useEffect(() => {
    client.request<{ rows: Row[] }>("GET", "/counts/summary").then((r) => setRow(r.rows.find((x) => x.collection === ctx.collection) ?? null), () => setRow(null));
  }, [client, ctx.collection, ctx.version]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <p className="flex-1 text-sm font-semibold">{t("side_title")}</p>
        <button type="button" className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent" onClick={ctx.close}>
          {t("close")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {row ? (
          <>
            <p className="text-muted-foreground">{row.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{row.all}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("split", { published: row.published, draft: row.draft })}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{t("loading")}</p>
        )}
        <button type="button" className="mt-4 rounded border px-3 py-1.5" onClick={() => void ctx.reload()}>
          {t("reload_doc")}
        </button>
      </div>
    </div>
  );
}

export const countsAdmin = defineAdminPlugin({
  name: "counts",
  label: { en: "Document counts", ko: "문서 수" },
  pages: { "": CountsPage },
  slots: { editorSide: { label: { en: "Counts", ko: "문서 수" }, render: (ctx) => <CountsSide ctx={ctx} /> } },
  messages: {
    en: { loading: "Loading…", intro: "Documents in each collection you can read.", split: "{published} published · {draft} drafts", side_title: "This collection", close: "Close", reload_doc: "Reload the document" },
    ko: { loading: "불러오는 중…", intro: "읽을 수 있는 컬렉션별 문서 수입니다.", split: "게시 {published} · 초안 {draft}", side_title: "이 컬렉션", close: "닫기", reload_doc: "문서 다시 불러오기" },
  },
});
