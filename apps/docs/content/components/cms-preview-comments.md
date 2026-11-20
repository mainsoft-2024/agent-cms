---
title: "Preview comments"
summary: "A comment box for your public page, shown behind a preview link made with \"Allow comments\". Someone without an account reads the open comments and adds one with their name."
order: 15
---
## Usage

```tsx
// app/posts/[slug]/page.tsx (your public page)
import { CmsPreviewComments } from "@/components/cms/cms-preview-comments";

const preview = token ? await cms.readPreview(token) : null;
// ...
{preview?.comments ? <CmsPreviewComments token={token} /> : null}
```

It needs no `CmsProvider`: the token is the permission. `baseUrl` is where the CMS route is mounted (`/api/cms` by default), and `messages` takes the Korean strings (`import { ko } from "@/components/cms/cms-messages"`). The link stops working when it expires, and so does the box.

> [!note]
> On npm from 0.10.0. This docs site uses it: a preview link from its own editor opens the draft page with this box under the text.
