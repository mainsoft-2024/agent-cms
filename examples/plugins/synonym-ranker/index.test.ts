import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestCms } from "@mainsoft/agent-cms/testing";
import synonymRanker, { expand, parseGroups } from "./index";

test("synonym-ranker: parse groups and expand a query", () => {
  const groups = parseGroups("payment, card approval\n\nlonely; 결제, 카드 승인");
  assert.deepEqual(groups, [["payment", "card approval"], ["결제", "카드 승인"]]);
  assert.deepEqual(expand("Payment fails", groups).sort(), ["card approval", "fails", "payment"]);
});

test("synonym-ranker: finds a section by a synonym, and follows what is published", async () => {
  const t = createTestCms({ plugins: [synonymRanker] });
  try {
    await t.cms.create(t.admin, "pages", { slug: "cards", title: "Cards", body: "## Approval\nCard approval can take a minute.\n\n## Other\nNothing here.\n" }, { publish: true });
    await t.ready();
    await t.settings("synonym-ranker", { synonyms: "payment, card approval" });

    // No shared word with "payment": found through the synonym, in the right section.
    let r = await t.cms.search(t.anon, ["pages"], "payment");
    assert.deepEqual(r.hits.map((h) => [h.unit.slug, h.unit.anchor, h.matchedBy]), [["cards", "approval", ["synonym-ranker.synonyms"]]]);

    // A page published later is followed through its event.
    await t.cms.create(t.admin, "pages", { slug: "checkout", title: "Checkout", body: "Card approval at checkout.\n" }, { publish: true });
    await t.flush();
    r = await t.cms.search(t.anon, ["pages"], "payment");
    assert.deepEqual(r.hits.map((h) => h.unit.slug).sort(), ["cards", "checkout"]);

    // Unpublished: dropped from the plugin's index (and the CMS would drop it anyway).
    await t.cms.unpublish(t.admin, "pages", "checkout");
    await t.flush();
    r = await t.cms.search(t.anon, ["pages"], "payment");
    assert.deepEqual(r.hits.map((h) => h.unit.slug), ["cards"]);

    // Archived, then back: followed through search.stale.
    await t.cms.publish(t.admin, "pages", "checkout");
    await t.cms.archive(t.admin, "pages", "checkout");
    await t.flush();
    assert.deepEqual((await t.cms.search(t.anon, ["pages"], "payment")).hits.map((h) => h.unit.slug), ["cards"]);
    await t.cms.unarchive(t.admin, "pages", "checkout");
    await t.flush();
    assert.deepEqual((await t.cms.search(t.anon, ["pages"], "payment")).hits.map((h) => h.unit.slug).sort(), ["cards", "checkout"]);

    // Without synonyms it adds nothing.
    await t.settings("synonym-ranker", { synonyms: "" });
    assert.deepEqual((await t.cms.search(t.anon, ["pages"], "payment")).hits, []);
  } finally {
    await t.close();
  }
});
