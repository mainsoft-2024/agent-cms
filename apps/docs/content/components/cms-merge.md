---
title: "Merge after a conflict"
summary: "Three-way merge when someone saved first: what merged automatically, and theirs, mine or both for each conflict."
order: 4
---
## Usage

```tsx
// Rendered by CmsDocEditor when a save returns conflict_version.
<CmsMerge collection="posts" slug="hello" base={base} baseVersion={3} mine={mine} theirs={current} onSaved={setDoc} onCancel={close} />
```

You rarely mount it yourself: the editor opens it when someone else saved first. Lines that only one side changed merge by themselves; for each overlap you pick theirs, mine or both.

## Install

```sh
npx @mainsoft/agent-cms add cms-merge
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
