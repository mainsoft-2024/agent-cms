# Upgrading to 0.22

**Schema 11**: one new table for form submissions (`cms_form_submissions`, below), and three columns on the documents table (`locale`, `group_id`, `source_version`), one new index on `group_id`, and the unique index on addresses changes from `(collection, slug)` to `(collection, slug, locale)`, so a translation can have the same address as its source.

```sh
npx @mainsoft/agent-cms migrate check   # prints the SQL
npx @mainsoft/agent-cms migrate apply   # or run it yourself
```

The step is safe to run again (`IF NOT EXISTS`). Nothing is copied: every existing document gets `locale = ''`, no group and no source version. Apps that do not turn locales on keep working exactly as before (`''` everywhere, one document per address).

## The unique index swap on a big table

`migrate check` / `migrate apply` run the step as plain statements in this order:

1. `ALTER TABLE … ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT ''` (and the two nullable columns). On Postgres 11 and later a column with a constant default is added without rewriting the table: this is quick.
2. `CREATE UNIQUE INDEX IF NOT EXISTS cms_documents_collection_slug_locale_idx ON cms_documents (collection, slug, locale)`
3. `DROP INDEX IF EXISTS cms_documents_collection_slug_idx`
4. `CREATE INDEX IF NOT EXISTS cms_documents_group_idx ON cms_documents (group_id)`

The new index is built before the old one goes, so an address is never unguarded. Step 2 takes a lock that blocks writes to the documents table while the index is built. With up to a few hundred thousand documents that is a moment; on a bigger table build the indexes yourself first, without blocking writes. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so run these one at a time (psql, or a migration your tool runs outside a transaction):

```sql
ALTER TABLE "cms_documents" ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT '';
ALTER TABLE "cms_documents" ADD COLUMN IF NOT EXISTS "group_id" uuid;
ALTER TABLE "cms_documents" ADD COLUMN IF NOT EXISTS "source_version" integer;

-- Nothing may break the new index. With the old (collection, slug) index in place this is always
-- empty; check anyway if you dropped or changed indexes yourself:
SELECT "collection", "slug", "locale", count(*) FROM "cms_documents" GROUP BY 1, 2, 3 HAVING count(*) > 1;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "cms_documents_collection_slug_locale_idx" ON "cms_documents" ("collection", "slug", "locale");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cms_documents_group_idx" ON "cms_documents" ("group_id");
```

(`localeDuplicatesSql()` from the package prints the duplicate check with your prefix and schema.) If a concurrent build fails it leaves an `INVALID` index: `DROP INDEX` it and build it again. Then run `npx @mainsoft/agent-cms migrate apply`: the columns and indexes are found and skipped, only the old index is dropped and the schema version is set to 11. `npx @mainsoft/agent-cms doctor` fails while the old index is still there (a translation could not be saved), and `migrate check` offers the step again.

Use the prefix and schema of your `cmsTables()` options (`cms_` is the default prefix).

## Turning locales on

```ts
createCms({
  locales: ["ko", "en"],      // the first is the default unless you say otherwise
  defaultLocale: "ko",
  collections: [defineCollection({ slug: "guide", localized: true, url: (d) => `/${d.locale}/guide/${d.slug}`, ... })],
});
```

Documents written before keep `locale = ''`; the CMS reads them as the default language, so nothing has to be done right away. To write the default language into the rows for good (for your own SQL, exports, reports), run, in batches of 1000 rows by default:

```sh
npx @mainsoft/agent-cms migrate locales --default ko --collections guide,blog [--batch 1000]
```

It repeats `UPDATE … SET locale = 'ko' WHERE id IN (SELECT id … WHERE locale = '' AND collection IN (…) LIMIT 1000)` until nothing is left, so no statement holds many rows at once. `fillLocaleSql()` gives you the same statement to run elsewhere. Translations always get their language when they are made.

Turning `localized` off again later: translations stay in the table but are no longer listed or read; the source documents are what readers get.

If you write your own `CmsRepo`: `findDoc(collection, slug, { locale })` finds a translation, and without `locale` it must return the source (the row with no `groupId`, or `groupId === id`); `listDocs` takes `sources`, `locale` and `groupId`; `pageDocs` takes `locale`; documents carry `locale`, `groupId` and `sourceVersion`. Without locales none of this is asked for.

## What changes without you doing anything

Nothing, unless you set `locales`. With `locales` and a `localized` collection:

- **ETags of that collection's documents carry the language**: `"v3-ko"`, `"v3-en"`. `If-Match: "v3-en"` and `"v3"` both work.
- **Events, the change log, webhooks and the audit log** name the slug and say `locale` (the audit log in `detail.locale`).
- **`url(doc)`** of a localized collection gets `doc.locale` too.
- **Search** searches the default language unless you pass `locale`; collections that are not translated are searched whatever the language. Korean 2-grams are used for Korean text (and text with no language, as before), not for other languages.
- **Agent tools**: one new (`list_translations`). Document tools take `locale`; `list_collections` says which collections are translated and which fields every language shares (`sharedFields`).

## Forms

The same schema step adds one table (nothing else changes for apps that do not turn forms on):

```sql
CREATE TABLE IF NOT EXISTS "cms_form_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "form_id" text NOT NULL,
  "form_version" integer NOT NULL DEFAULT 1,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "files" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'new',
  "ip_hash" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "cms_form_submissions_list_idx" ON "cms_form_submissions" ("form_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "cms_form_submissions_created_idx" ON "cms_form_submissions" ("created_at");
```

The forms themselves are rows of `cms_records` (kind `form`), which exists since 0.13.

### Turning forms on

```ts
createCms({
  forms: {
    perMinute: 5,                                   // per address, all forms together (default 5)
    verify: async (req) => checkCaptcha(req),       // optional: false answers 403
    notify: async ({ form, to, lines }) => sendMail(to, form.title, lines), // optional: your mailer
  },
  media: { stores: { private: { visibility: "private", adapter: s3Storage({ … }) } } }, // for file fields
  retention: { submissionsDays: 180 },               // default 365 with forms on
});
```

Then add the screens and the public component:

```sh
npx @mainsoft/agent-cms add cms-forms cms-form
```

Put `<CmsForms>` / `<CmsFormEditor>` on `/admin/forms` and `/admin/forms/[slug]/[tab]` (the example app shows how), and `<CmsForm slug="contact" />` on your page. A new route segment `forms` is reserved: a collection may not be called `forms`.

People other than admins see forms through a role: the `forms` row in Roles (`read` to see submissions, `write` to build forms, `delete` to delete submissions).

### Privacy

- Submissions are personal data. The CMS keeps what the form asks for and nothing more: the sender's address only as a keyed hash (to count and to tell repeat senders apart; the key lives in `cms_meta`), and the user agent.
- Values of fields hidden by a condition are dropped by the server, whatever the browser sends.
- Files go to a **private** store; they are opened only through five-minute signed links, each noted in the audit log (`form.file_open`). Without a private store file fields refuse files (`form_uploads_off`).
- Events and webhooks carry ids, field names and file names, not the values, unless you set `forms.eventValues: true`.
- There are no agent tools for submissions. Exports (`form.export`) and deletions are audited.
- Retention deletes submissions and their files after `retention.submissionsDays` (365 by default) or a form's own `keepDays`; `0` keeps them, which you should only do with a reason.
