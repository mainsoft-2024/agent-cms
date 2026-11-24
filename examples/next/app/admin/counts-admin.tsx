"use client";

// The admin half of `lib/counts-plugin.ts` (0.24.0): a page at /admin/p/counts, given to
// <CmsProvider plugins> in admin-frame.tsx.
import { useEffect, useState } from "react";
import { defineAdminPlugin, useCmsAdmin, usePluginT } from "@mainsoft/agent-cms/react";

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

export const countsAdmin = defineAdminPlugin({
  name: "counts",
  label: { en: "Document counts", ko: "문서 수" },
  pages: { "": CountsPage },
  messages: {
    en: { loading: "Loading…", intro: "Documents in each collection you can read.", split: "{published} published · {draft} drafts" },
    ko: { loading: "불러오는 중…", intro: "읽을 수 있는 컬렉션마다 문서가 몇 개인지 보여 줌.", split: "게시 {published} · 초안 {draft}" },
  },
});
