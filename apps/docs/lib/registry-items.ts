import registry from "../../../registry/registry.json";

export interface Item {
  name: string;
  title: string;
  description: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files: { path: string; type: string }[];
}

/** The screens, in registry order (cms-lib is the shared helper, not a screen). */
export const ITEMS = (registry as { items: Item[] }).items;
export const SCREENS = ITEMS.filter((i) => i.name !== "cms-lib");
export const itemByName = (name: string) => ITEMS.find((i) => i.name === name);
/** Screens that run in the live demo. */
export const LIVE = new Set(["cms-shell", "cms-empty", "cms-doc-list", "cms-doc-editor", "cms-versions", "cms-keys", "cms-audit", "cms-command", "cms-media", "cms-files", "cms-trash", "cms-releases"]);
/** Why a screen has no demo of its own, and where to see it. */
export const NOT_LIVE: Record<string, string> = {
  "cms-merge": "This screen appears inside the editor when someone else saved first. Open the same document in two tabs of the editor demo, save in one, then save in the other.",
  "cms-media-picker": "This dialog opens from the editor. In the editor demo, press \"Insert media\" above the markdown.",
  "cms-preview-comments": "This box goes on your public page. In the editor demo, make a preview link with \"Allow comments\": the page behind that link is yours, so the demo has none.",
};
