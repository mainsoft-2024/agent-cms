// The admin's own router: the address, moving to another page, and Back / Forward. A page with
// unsaved edits is asked first (see `mayLeave` in main.tsx); when the person stays, Back / Forward
// is undone by going the same number of steps the other way, so the history keeps its entries
// (the forward ones too) and their state.
import * as React from "react";

export type Go = (to: string, replace?: boolean, o?: { guard?: boolean }) => void;

/** Where in the session history an entry of the admin sits (kept in `history.state.cmsIdx`). */
function indexOf(state: unknown): number | null {
  const i = (state as { cmsIdx?: unknown } | null)?.cmsIdx;
  return typeof i === "number" && Number.isInteger(i) ? i : null;
}

function withIndex(state: unknown, cmsIdx: number): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? (state as Record<string, unknown>) : {}), cmsIdx };
}

const current = () => window.location.pathname + window.location.search;

/**
 * The address shown and a way to move. `mayLeave` is asked before each move (Back and Forward too);
 * `go(to, replace, { guard: false })` moves without asking (tabs of one editing session).
 */
export function usePath(mayLeave: () => boolean): [string, Go] {
  const [path, setPath] = React.useState(current);
  const here = React.useRef(path);
  const idx = React.useRef(0);
  /** While a refused Back / Forward is undone: the index it goes back to (that popstate is ours). */
  const undoing = React.useRef<number | null>(null);
  const ask = React.useRef(mayLeave);
  ask.current = mayLeave;

  React.useEffect(() => {
    // The entry the admin opened on gets an index (kept when the page is reloaded).
    const known = indexOf(window.history.state);
    if (known === null) window.history.replaceState(withIndex(window.history.state, 0), "");
    idx.current = known ?? 0;

    const on = (e: PopStateEvent) => {
      const to = current();
      const at = indexOf(e.state);
      if (undoing.current !== null) {
        const back = undoing.current === at;
        undoing.current = null;
        // Back where the person chose to stay.
        if (back && to === here.current) return;
      }
      if (to !== here.current && !ask.current()) {
        if (at !== null && at !== idx.current) {
          // Undo the step without a new entry: the forward entries stay as they were.
          undoing.current = idx.current;
          window.history.go(idx.current - at);
        } else {
          // An entry the admin did not make (no index): put the page on screen back on top.
          window.history.pushState(withIndex(null, idx.current + 1), "", here.current);
          idx.current += 1;
        }
        return;
      }
      if (at !== null) idx.current = at;
      here.current = to;
      setPath(to);
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);

  const go = React.useCallback<Go>((to, replace = false, o = {}) => {
    if (/^https?:/.test(to)) return window.location.assign(to);
    // Leaving a page with unsaved edits asks first. Moving inside one editing session (a tab of the
    // same form) does not: its draft stays on screen.
    if (o.guard !== false && !ask.current()) return;
    if (!replace) idx.current += 1;
    window.history[replace ? "replaceState" : "pushState"](withIndex(null, idx.current), "", to);
    here.current = to.split("#")[0];
    setPath(to.split("#")[0]);
    if (!to.includes("#")) window.scrollTo(0, 0);
  }, []);
  return [path, go];
}
