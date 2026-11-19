---
title: "Version history"
summary: "Versions with author, note and changed fields; compare any two side by side or unified with word highlights; restore or publish a version."
order: 6
---
## Usage

```tsx
<CmsVersions collection="posts" slug={slug} onBack={() => router.back()} />
```

Pick any two versions to compare. Restoring creates a new version; publishing an old one makes it public again.

## Install

```sh
npx agent-cms add cms-versions
```

It also needs `CmsProvider` from `cms-lib` around your admin:

```tsx
<CmsProvider baseUrl="/api/cms">{children}</CmsProvider>
```
