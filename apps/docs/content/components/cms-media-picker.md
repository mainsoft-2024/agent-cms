---
title: "Media picker"
summary: "A dialog to choose a file from the library or upload a new one. The editor's \"Insert media\" button and the image and file fields open it."
order: 11
---
## Usage

The editor and the field form use it already. In your own form:

```tsx
<CmsMediaPicker
  open={open}
  onOpenChange={setOpen}
  kinds={["image"]}
  accept={["image/png", "image/jpeg"]}
  onPick={(asset) => setCover(asset.id)}
/>
```

`kinds` limits what can be chosen, `accept` narrows what the upload button offers, `store` shows one store only. `onPick` gets the file with its id, name, kind and addresses; a body takes `![alt](asset:ID/name)`.

It comes with `cms-doc-editor`: `npx agent-cms add cms-doc-editor` brings it, also in apps without a media library (the button stays hidden there).
