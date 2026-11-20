import { sql } from "drizzle-orm";
import { db, ready } from "@/lib/db";

interface Row {
  collection: string;
  query: string;
  count: number;
  last_seen_at: string;
}

/** The site's own screen: searches that found nothing (fed by `onSearchMiss`). */
export default async function Misses() {
  await ready();
  const d = await db();
  const rows = ((await d.execute(sql`select collection, query, count, last_seen_at from site_search_misses order by count desc, last_seen_at desc limit 200`)).rows ?? []) as Row[];
  return (
    <div className="p-4 md:p-6">
      <h1 className="text-[20px] font-semibold">Search misses</h1>
      <p className="mb-5 text-[var(--color-warm-gray)]">
        Searches on the site and over MCP that found nothing. The CMS only reports them (<code className="inline-code">onSearchMiss</code>); this table belongs to the site.
      </p>
      <div className="site-card overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[var(--color-rule-gray)]">
              <th className="label-mono px-3 py-2.5">Query</th>
              <th className="label-mono px-3 py-2.5">Collection</th>
              <th className="label-mono px-3 py-2.5 text-right">Times</th>
              <th className="label-mono px-3 py-2.5">Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.collection}/${r.query}`} className="border-b border-[var(--color-rule-gray)] last:border-0">
                <td className="px-3 py-2.5">{r.query}</td>
                <td className="mono px-3 py-2.5 text-[12px]">{r.collection}</td>
                <td className="mono px-3 py-2.5 text-right">{r.count}</td>
                <td className="px-3 py-2.5 text-[var(--color-warm-gray)]">{new Date(r.last_seen_at).toISOString().slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-[var(--color-warm-gray)]">
                  Nothing yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
