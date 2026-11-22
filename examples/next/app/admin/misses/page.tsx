import { sql } from "drizzle-orm";
import { PageHeader } from "./page-header";
import { db } from "@/lib/db";
import { seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

// The app's own screen: search misses the app stored from onSearchMiss. The admin's page
// header gives it the phone menu button like every other screen.
export default async function MissesPage() {
  await seed();
  const r = (await db.execute(sql`SELECT collection, query, count FROM app_search_misses ORDER BY count DESC, last_seen_at DESC LIMIT 100`)) as unknown as { rows: { collection: string; query: string; count: number }[] };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader title="Search misses" />
      <div className="grid min-w-0 gap-4 p-4 md:p-6">
        {r.rows.length ? (
          <ul className="min-w-0 divide-y rounded-lg border">
            {r.rows.map((m) => (
              <li key={`${m.collection}:${m.query}`} className="flex min-w-0 items-center gap-4 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1 break-words font-medium">{m.query}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{m.collection}</span>
                <span className="shrink-0 tabular-nums">{m.count}×</span>
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
