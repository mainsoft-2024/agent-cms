import { sql } from "drizzle-orm";
import { PageHeader } from "./page-header";
import { db, ready } from "@/lib/db";

interface Row {
  collection: string;
  query: string;
  count: number;
  last_seen_at: string;
}

/**
 * The site's own screen: searches that found nothing (fed by `onSearchMiss`). It uses the
 * admin's page header, so on a phone the menu button is there like on every other screen.
 */
export default async function Misses() {
  await ready();
  const d = await db();
  const rows = ((await d.execute(sql`select collection, query, count, last_seen_at from site_search_misses order by count desc, last_seen_at desc limit 200`)).rows ?? []) as Row[];
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader title="Search misses" />
      <div className="grid min-w-0 gap-4 p-4 md:p-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Searches on the site and over MCP that found nothing, most asked first. Each one is a page the docs may be missing. The CMS only reports them (<code className="inline-code">onSearchMiss</code>); this table belongs to the site.
        </p>
        {rows.length ? (
          <ul className="min-w-0 divide-y rounded-lg border">
            {rows.map((r) => (
              <li key={`${r.collection}/${r.query}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3">
                <span className="min-w-0 break-words font-medium">{r.query}</span>
                <span className="row-span-2 text-right tabular-nums">
                  <span className="text-lg font-semibold">{r.count}</span>
                  <span className="block text-xs text-muted-foreground">{r.count === 1 ? "time" : "times"}</span>
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {r.collection} · last {new Date(r.last_seen_at).toISOString().slice(0, 16).replace("T", " ")} UTC
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">Nothing yet. Searches that find nothing show up here.</div>
        )}
      </div>
    </div>
  );
}
