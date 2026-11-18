// Shared test setup: a jsdom window as globals (import this first), the
// browser APIs radix and cmdk expect, and an in-memory agent-cms server
// reached through a fake fetch.
import globalJsdom from "global-jsdom";

globalJsdom("<!doctype html><html lang=\"en\"><head><title>agent-cms admin</title></head><body></body></html>", { url: "http://localhost/admin", pretendToBeVisual: true });

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

// Node has its own Event and CustomEvent; jsdom elements only accept jsdom's.
for (const k of ["Event", "CustomEvent", "UIEvent", "FocusEvent", "MouseEvent", "PointerEvent", "KeyboardEvent", "InputEvent", "EventTarget"]) {
  const w = (window as unknown as Record<string, unknown>)[k];
  if (w) g[k] = w;
}

// Desktop unless a test says otherwise.
let mobile = false;
export function setMobile(on: boolean) {
  mobile = on;
}
window.matchMedia = ((query: string) => ({
  matches: /max-width:\s*767px/.test(query) ? mobile : false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
g.ResizeObserver ??= RO;
window.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= function () {};
proto.hasPointerCapture ??= function () {
  return false;
};
proto.releasePointerCapture ??= function () {};
proto.setPointerCapture ??= function () {};
g.DOMRect ??= window.DOMRect;
// axe probes canvas; jsdom has none.
window.HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

// Node 21+ has its own global navigator; use the window's.
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => window.navigator });

// Clipboard (copy buttons).
export const clipboard: string[] = [];
Object.defineProperty(window.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (s: string) => {
      clipboard.push(s);
    },
  },
});
