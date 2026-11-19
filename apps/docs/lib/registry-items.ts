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
export const LIVE = new Set(["cms-shell", "cms-empty", "cms-doc-list", "cms-doc-editor", "cms-versions", "cms-keys", "cms-audit", "cms-command"]);
