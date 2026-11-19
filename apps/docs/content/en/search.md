---
title: Search
summary: Section-level search with citation ids, and search misses for your app.
category: Guides
order: 4
---
## How it works

The index is in memory and built from published documents. It understands Korean (particles, verb endings, 2-grams) and returns **sections**, each with a citation id such as `cms://docs/install#create-the-tables`.

```ts
const { hits } = await cms.search(actor, "install tables", { collections: ["docs"] });
```

Over REST: `GET /api/cms/search?q=…&collections=docs,guides`.

## Search misses

When a search finds nothing, agent-cms can tell your app, which decides what to store:

```ts
createCms({
  onSearchMiss: async (e) => {
    // { query, normalized, collections, actor, source, at, nearest }
    if (e.actor.kind === "anonymous") return;
    await saveMiss(e);
  },
});
```

It is called only when the caller asked (`search(…, { reportMiss: true })`, `GET /search?miss=1`, `read_for_answer`), never awaited, and its errors go to `onError`. `normalized` ignores particles and word order, so group by it.

> [!tip]
> This site keeps its misses in its own `site_search_misses` table and shows them on an admin screen added through `extraNav`.
