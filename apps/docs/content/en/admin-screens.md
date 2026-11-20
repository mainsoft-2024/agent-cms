---
title: Admin screens
summary: Copy the screens into your app, theme them, and keep them up to date.
category: Admin screens
order: 1
---
The screens are source files you copy into your app and then own, like shadcn/ui. They use your shadcn/ui parts and talk to the CMS through `createRestClient` from `@mainsoft/agent-cms/client`.

## Add them

With the shadcn CLI, from this site's registry:

```sh
npx shadcn add https://agent-cms-docs.vercel.app/r/cms-doc-editor.json
```

Or with the agent-cms CLI:

```sh
npx @mainsoft/agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command
npx @mainsoft/agent-cms add cms-media cms-files   # with a media library (0.10.0 and later)
npx @mainsoft/agent-cms add cms-trash cms-releases cms-preview-comments   # trash, releases, comments on preview links (0.10.0 and later)
```

Files go to `<components>/cms/`. The shadcn parts and the screens an item needs come along. Browse every screen with a live demo in [Components](/components).

## Wire them

```tsx
<CmsProvider baseUrl="/api/cms">
  <CmsShell title="Admin" LinkComponent={Link} extraNav={[{ label: "App", items: [{ label: "Reports", href: "/admin/reports" }] }]}>
    <CmsDocList collection="posts" hrefFor={(c, s) => `/admin/${c}/${s}`} />
  </CmsShell>
</CmsProvider>
```

`extraNav` adds your app's own screens to the sidebar. UI text is English; pass `messages={ko}` from `cms-messages` for Korean.

## Theme them

The screens use the shadcn variables (`--background`, `--primary`, `--radius`, fonts). Change those and the screens follow. This site's admin is the same screens with its own variables; the gallery switches between the two looks.

## Update them

```sh
npx @mainsoft/agent-cms add --diff      # what a new release would change in your copies
npx @mainsoft/agent-cms add --update    # update files you did not edit; yours get a .new copy
```

`agent-cms.json` records what was copied. `--diff` and `--update` only know about copies made with `agent-cms add`.
