// A small plugin of the example (0.24.0): how many documents each collection has.
// The server half: one route, `GET /api/cms/counts/summary`. The admin half is
// `app/admin/counts-admin.tsx`; together they show a page under /admin/p/counts.
// Bigger examples live in `examples/plugins/`.
import { definePlugin } from "@mainsoft/agent-cms";

export const countsPlugin = definePlugin({
  name: "counts",
  version: "0.1.0",
  engine: ">=0.24",
  setup(ctx) {
    ctx.route("GET", "summary", async ({ actor, cms }) => {
      const rows = await Promise.all(
        cms
          .collections()
          // Counts include drafts, so they need write access (like the collection list).
          .filter((c: { slug: string }) => cms.can(actor, c.slug, "write"))
          .map(async (c: { slug: string; label: string }) => ({ collection: c.slug, label: c.label, ...(await cms.counts(actor, c.slug)) }))
      );
      return Response.json({ rows });
    });
    // A menu entry without `href`: it opens the plugin's own admin page.
    ctx.nav({ label: "Document counts" });
  },
});
