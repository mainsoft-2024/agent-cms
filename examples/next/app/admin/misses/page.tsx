import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

// The app's own screen: search misses the app stored from onSearchMiss.
export default async function MissesPage() {
  await seed();
  const r = (await db.execute(sql`SELECT collection, query, count FROM app_search_misses ORDER BY count DESC, last_seen_at DESC LIMIT 100`)) as unknown as { rows: { collection: string; query: string; count: number }[] };
  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Search misses</h1>
      {r.rows.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">Question</th>
              <th>Collection</th>
              <th>Times</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((m) => (
              <tr key={`${m.collection}:${m.query}`} className="border-t">
                <td className="py-2">{m.query}</td>
                <td>{m.collection}</td>
                <td>{m.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-muted-foreground">Nothing yet. Searches that find nothing show up here.</p>
      )}
    </div>
  );
}
