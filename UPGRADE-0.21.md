# Upgrading to 0.21

**Schema 10**: three columns on the documents table (`parent_id`, `position`, `seo`), one index, and three new tables (`cms_doc_refs`, `cms_anchor_aliases`, `cms_redirects`). Run

```sh
npx @mainsoft/agent-cms migrate check   # prints the SQL
npx @mainsoft/agent-cms migrate apply   # or run it yourself
```

The step is safe to run again (`IF NOT EXISTS`). Nothing is copied or rewritten: existing documents get no parent, no position and no SEO details.

If you write your own `CmsRepo`, the new methods (`setDocRefs`, `listDocRefsTo`, `addAnchorAliases`, `listAnchorAliases`, `listRedirects`, `insertRedirect`, `updateRedirect`, `deleteRedirect`, `addRedirectHits`) are optional. Without them relations are still checked, but "who points here" is empty and redirects stay off.

## What changes without you doing anything

- **Readers get snippets filled in.** When a collection has `snippets: true`, a `[[snippet:key]]` in another body is replaced by that snippet's published body in public reads of a document (`cms.get`, `cms.single`, REST `GET /collections/<c>/<slug>`) and the search index. If you render a raw body yourself, call `cms.expandSnippets(body)` first. Editors (`draft`) and agent tools still see the token. `?snippets=raw` (REST) or `{ snippets: "raw" }` (`cms.get`) keeps it. Without a snippet collection nothing changes.
- **`## Title {#id}`** pins a heading's anchor; it no longer shows `{#id}` as text. A renamed heading's old anchor is remembered and still leads to it (`cms.anchorAliases()`, `markdownToHtml(body, { anchorAliases })`).
- **`:::steps`, `:::card` and `:::video`** are blocks now. Text that is not in their exact form stays as it was (a raw block), so old bodies render the same. A `:::video` from a site that is not allowed is refused on save (`video_host_blocked`); YouTube and Vimeo are allowed by default.
- **A published document's address changes only when you publish** (with redirects on): a draft save with a new address answers `slug_needs_publish`.
- **Deleting a document that relation fields point at** answers `409 doc_referenced` with the list. `DELETE …?force=1`, `cms.remove(…, { force: true })` or the tool's `force` deletes anyway. Collections without relation fields are not affected.
- **Agent tools**: six new (`get_tree`, `move_document`, `get_single`, `update_single`, `list_templates`, `list_redirects`). `list_collections` says which collections are trees, singles, snippets, have SEO, templates and relation fields.

## New, when you want it

| Option | What it does |
|---|---|
| `relation("people")`, `relation(["guides", "faq"], { many: true, max: 5 })` | A field pointing at other documents by id. Agents may send `{ collection, slug }`. Checked on save, recorded for "who points here", `?expand=author` fills in titles and addresses |
| `assetIds({ max: 12 })` | A gallery: several media library files in order |
| arrays of objects, objects | The admin shows rows and groups instead of JSON |
| `defineCollection({ tree: { maxDepth: 3 } })` | Documents nest. `cms.move()`, `cms.tree()`, `cms.ancestors()`, `POST /collections/<c>/_move`, tree view in the list |
| `defineSingle({ slug: "site", fields })` | One document (site settings). `cms.single()`, `cms.updateSingle()`, `/singles/<c>` |
| `templates: [{ key, label, title, body, fields }]` | Starting points for new documents; editors can save their own in the admin. `create(…, { template })` |
| `snippets: true` | A collection whose documents are snippets (`[[snippet:slug]]`) |
| `seo: true` | Search title, description, share image, canonical, noindex per document, with length warnings; `cms.seoFor()`, `GET …/_seo` |
| `createCms({ redirects: true })` | A published document's address may change; the old one redirects (301). Admins manage redirects (`/redirects`, admin screen). `cms.redirects.resolve(path)` for your 404 page |
| `createCms({ slugs: { hangul: "keep" } })` | Korean addresses. Default `"romanize"`: suggested addresses from Korean titles are romanized (`cms.suggestSlug()`) |
| `createCms({ video: { hosts: ["loom.com"] } })` | More sites for `:::video` |
| `handler({ publicOrigin })` | The site `GET /sitemap.xml` names (published public documents with `url()`, `noindex` left out). `cms.sitemap(origin)` |

### Using redirects in your app

```ts
// middleware.ts (Next.js): answer with the stored status (301 or 302)
export async function middleware(req: NextRequest) {
  const hit = await cms.redirects.resolve(req.nextUrl.pathname);
  if (hit) return NextResponse.redirect(new URL(hit.to, req.url), hit.status);
}
```

The table is kept in memory for 30 seconds (`redirects: { ttlMs }`) and refreshed at once on the server that changed it.

## Admin screens

Copy the screens again (`npx @mainsoft/agent-cms add cms-doc-editor cms-doc-list cms-redirects`). New files: `cms-fields-more.tsx`, `cms-structure.tsx`, `cms-editor-toolbar.tsx`, `cms-redirects.tsx`. The body editor's top bar is icons with tooltips now (undo, text style, insert, new blocks, find and replace, word count).
