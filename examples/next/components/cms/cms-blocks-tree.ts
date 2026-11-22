// agent-cms: block editor, blocks inside blocks.
// The editor keeps one flat list of blocks in reading order; a block inside
// another names it in `parent` and comes right after it (or after its earlier
// siblings). These functions move, nest and remove blocks while keeping that
// true, so every other part of the editor can keep working on a flat list.
// Pure functions: no React, no DOM (tested in node).

import { childrenOf, holdsBlocks, isText, newId, type EBlock, type TextBlock } from "./cms-blocks-convert";

export type Where = "before" | "after" | "first-child" | "last-child" | "left" | "right";

/** Blocks by id. */
export const byId = (list: readonly EBlock[]) => new Map(list.map((b) => [b.id, b]));

/** The blocks a block sits in, nearest first. */
export function ancestors(list: readonly EBlock[], id: string, map = byId(list)): EBlock[] {
  const out: EBlock[] = [];
  let cur = map.get(id);
  const seen = new Set<string>();
  while (cur?.parent && map.has(cur.parent) && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    cur = map.get(cur.parent)!;
    out.push(cur);
  }
  return out;
}

/** How deep a block sits (0 at the top level). */
export const depthOf = (list: readonly EBlock[], id: string) => ancestors(list, id).length;

/** Is `id` inside `of` (at any depth)? */
export function isInside(list: readonly EBlock[], id: string, of: string, map = byId(list)): boolean {
  return ancestors(list, id, map).some((a) => a.id === of);
}

/** A block and everything inside it, in order. */
export function subtree(list: readonly EBlock[], id: string): EBlock[] {
  const map = byId(list);
  return list.filter((b) => b.id === id || isInside(list, b.id, id, map));
}

/** The given blocks without the ones already inside another given block (in reading order). */
export function roots(list: readonly EBlock[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  const map = byId(list);
  return list.filter((b) => set.has(b.id) && !ancestors(list, b.id, map).some((a) => set.has(a.id))).map((b) => b.id);
}

/** Siblings of a block (same parent), in order. */
export function siblings(list: readonly EBlock[], id: string): EBlock[] {
  const b = list.find((x) => x.id === id);
  if (!b) return [];
  const kids = childrenOf(list);
  const ids = new Set(list.map((x) => x.id));
  return kids.get(b.parent && ids.has(b.parent) ? b.parent : "") ?? [];
}

/** Can `child` go inside `parent`? */
export function accepts(parent: EBlock, child: EBlock): boolean {
  if (parent.type === "columns") return child.type === "col";
  if (child.type === "col") return false;
  return ["col", "toggle", "bullet", "number", "todo"].includes(parent.type);
}

/**
 * Put the list back in shape: every block after its parent and its parent's
 * earlier children; blocks inside one that cannot hold blocks move out; empty
 * columns go away, and columns down to one column become plain blocks again.
 */
export function normalize(input: readonly EBlock[]): EBlock[] {
  let list = input.map((b) => b);
  for (let round = 0; round < 4; round++) {
    const map = byId(list);
    let changed = false;
    // Parents that are gone or cannot hold the block: up one level (or to the top).
    list = list.map((b) => {
      let p = b.parent ? map.get(b.parent) : undefined;
      let parent = b.parent;
      const seen = new Set<string>();
      while (parent && (!p || !accepts(p, b) || seen.has(parent))) {
        seen.add(parent);
        parent = p?.parent;
        p = parent ? map.get(parent) : undefined;
      }
      if (parent !== b.parent) {
        changed = true;
        return { ...b, parent } as EBlock;
      }
      return b;
    });
    // Columns: drop empty ones, unwrap a single one.
    const kids = childrenOf(list);
    const drop = new Set<string>();
    const lift = new Map<string, string | undefined>();
    for (const b of list) {
      if (b.type === "col" && !(kids.get(b.id) ?? []).length) drop.add(b.id);
    }
    for (const b of list) {
      if (b.type !== "columns") continue;
      const cols = (kids.get(b.id) ?? []).filter((c) => c.type === "col" && !drop.has(c.id));
      if (cols.length >= 2) continue;
      drop.add(b.id);
      for (const c of cols) {
        drop.add(c.id);
        for (const k of kids.get(c.id) ?? []) lift.set(k.id, b.parent);
      }
    }
    if (drop.size || lift.size) {
      changed = true;
      list = list.filter((b) => !drop.has(b.id)).map((b) => (lift.has(b.id) ? ({ ...b, parent: lift.get(b.id) } as EBlock) : b));
    }
    if (!changed) break;
  }
  // Reading order: each block right after its parent's earlier children.
  const kids = childrenOf(list);
  const out: EBlock[] = [];
  const walk = (p: string) => {
    for (const b of kids.get(p) ?? []) {
      out.push(b);
      walk(b.id);
    }
  };
  walk("");
  return out;
}

/** Copies of blocks (and what is inside them) with fresh ids, ready to insert. */
export function cloneBlocks(blocks: readonly EBlock[]): EBlock[] {
  const ids = new Map(blocks.map((b) => [b.id, newId()]));
  return blocks.map((b) => ({ ...b, id: ids.get(b.id)!, parent: b.parent && ids.has(b.parent) ? ids.get(b.parent) : b.parent, orig: undefined, gap: undefined }) as EBlock);
}

/**
 * Move blocks (with what is inside them) next to, into, or beside another
 * block. `left` / `right` put them in a column beside the block (making
 * columns when there were none). Returns null when the move makes no sense
 * (into itself, columns into columns).
 */
export function moveTo(input: readonly EBlock[], ids: readonly string[], target: string, where: Where, copy = false): EBlock[] | null {
  const list = [...input];
  const map = byId(list);
  const tgt = map.get(target);
  if (!tgt) return null;
  const top = roots(list, ids);
  if (!top.length) return null;
  // A block cannot move into itself; a copy can go anywhere.
  if (!copy && (top.includes(target) || top.some((r) => isInside(list, target, r, map)))) return null;
  const moving: EBlock[] = [];
  for (const r of top) moving.push(...subtree(list, r));
  let moved = copy ? cloneBlocks(moving) : moving;
  const movedIds = new Set(moved.map((b) => b.id));
  const rootIds = new Set(copy ? moved.filter((b) => !b.parent || !movedIds.has(b.parent)).map((b) => b.id) : top);
  const rest = copy ? list : list.filter((b) => !movedIds.has(b.id));
  const restMap = byId(rest);
  const t = restMap.get(target)!;
  const endOf = (id: string) => {
    let i = rest.findIndex((b) => b.id === id);
    while (i + 1 < rest.length && isInside(rest, rest[i + 1].id, id, restMap)) i++;
    return i + 1;
  };
  const setParent = (p: string | undefined) => (moved = moved.map((b) => (rootIds.has(b.id) ? ({ ...b, parent: p } as EBlock) : b)));

  if (where === "left" || where === "right") {
    if (moved.some((b) => b.type === "columns" || b.type === "col")) return null;
    const anc = ancestors(rest, target, restMap);
    const inCol = t.type === "col" ? t : anc.find((a) => a.type === "col");
    // Inside a column already: a new column next to that one (no columns in columns).
    if (inCol) {
      const colsBox = inCol.parent ? restMap.get(inCol.parent) : undefined;
      if (!colsBox || colsBox.type !== "columns") return null;
      // Only the block at the top of a column can put a column beside its own column.
      if (t.type !== "col" && t.parent !== inCol.id) return null;
      const col: EBlock = { id: newId(), parent: colsBox.id, type: "col" };
      setParent(col.id);
      const at = where === "left" ? rest.findIndex((b) => b.id === inCol.id) : endOf(inCol.id);
      return normalize([...rest.slice(0, at), col, ...moved, ...rest.slice(at)]);
    }
    if (anc.length) return null;
    const box: EBlock = { id: newId(), parent: t.parent, type: "columns" };
    const a: EBlock = { id: newId(), parent: box.id, type: "col" };
    const b: EBlock = { id: newId(), parent: box.id, type: "col" };
    const start = rest.findIndex((x) => x.id === target);
    const end = endOf(target);
    const targetTree = rest.slice(start, end).map((x) => (x.id === target ? ({ ...x, parent: a.id } as EBlock) : x));
    setParent(b.id);
    const pair = where === "left" ? [b, ...moved, a, ...targetTree] : [a, ...targetTree, b, ...moved];
    return normalize([...rest.slice(0, start), box, ...pair, ...rest.slice(end)]);
  }

  if (where === "first-child" || where === "last-child") {
    if (!moved.filter((b) => rootIds.has(b.id)).every((b) => accepts(t, b))) return null;
    setParent(t.id);
    const at = where === "first-child" ? rest.findIndex((b) => b.id === target) + 1 : endOf(target);
    return normalize([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
  }
  const parent = t.parent ? restMap.get(t.parent) : undefined;
  if (parent && !moved.filter((b) => rootIds.has(b.id)).every((b) => accepts(parent, b))) return null;
  if (!parent && moved.some((b) => rootIds.has(b.id) && b.type === "col")) return null;
  setParent(t.parent);
  const at = where === "before" ? rest.findIndex((b) => b.id === target) : endOf(target);
  return normalize([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
}

/** Tab: put the blocks inside the block above them (a list item or a toggle). */
export function indent(input: readonly EBlock[], ids: readonly string[]): EBlock[] | null {
  let list = [...input];
  let done = false;
  for (const id of roots(list, ids)) {
    const sibs = siblings(list, id);
    const i = sibs.findIndex((b) => b.id === id);
    const prev = sibs[i - 1];
    const b = sibs[i];
    if (!prev || !b || !["bullet", "number", "todo", "toggle"].includes(prev.type) || !accepts(prev, b)) continue;
    list = list.map((x) => (x.id === id ? ({ ...x, parent: prev.id } as EBlock) : x));
    done = true;
  }
  return done ? normalize(list) : null;
}

/**
 * Shift+Tab: take blocks out of the list item or toggle they sit in. The
 * blocks after them in there come along inside them, so nothing changes
 * place on the page (as in Notion).
 */
export function outdent(input: readonly EBlock[], ids: readonly string[]): EBlock[] | null {
  let list = [...input];
  let done = false;
  for (const id of roots(list, ids).reverse()) {
    const map = byId(list);
    const b = map.get(id);
    const p = b?.parent ? map.get(b.parent) : undefined;
    if (!b || !p || p.type === "col" || p.type === "columns") continue;
    const sibs = siblings(list, id);
    const after = sibs.slice(sibs.findIndex((x) => x.id === id) + 1);
    const takes = holdsBlocks(b) ? after.filter((x) => accepts(b, x)) : [];
    const keep = new Set(takes.map((x) => x.id));
    list = list.map((x) => (x.id === id ? ({ ...x, parent: p.parent } as EBlock) : keep.has(x.id) ? ({ ...x, parent: id } as EBlock) : x));
    // Blocks after it that it cannot hold go after it, at its new level.
    const left = after.filter((x) => !keep.has(x.id));
    if (left.length) {
      const leftIds = new Set(left.map((x) => x.id));
      list = list.map((x) => (leftIds.has(x.id) ? ({ ...x, parent: p.parent } as EBlock) : x));
    }
    done = true;
  }
  return done ? normalize(list) : null;
}

/** Remove blocks with what is inside them. */
export function removeBlocks(input: readonly EBlock[], ids: readonly string[]): EBlock[] {
  const map = byId(input);
  const gone = new Set(ids);
  return normalize(input.filter((b) => !gone.has(b.id) && !ancestors(input, b.id, map).some((a) => gone.has(a.id))));
}

/** Remove one block but keep what is inside it, in its place. */
export function unwrap(input: readonly EBlock[], id: string): EBlock[] {
  const b = input.find((x) => x.id === id);
  if (!b) return [...input];
  return normalize(input.filter((x) => x.id !== id).map((x) => (x.parent === id ? ({ ...x, parent: b.parent } as EBlock) : x)));
}

/** Blocks hidden inside closed toggles. */
export function hiddenIn(list: readonly EBlock[], open: ReadonlySet<string>): Set<string> {
  const map = byId(list);
  const out = new Set<string>();
  for (const b of list) if (ancestors(list, b.id, map).some((a) => a.type === "toggle" && !open.has(a.id))) out.add(b.id);
  return out;
}

/** The blocks a person can reach with the arrow keys, in order (not hidden, not columns). */
export function reachable(list: readonly EBlock[], open: ReadonlySet<string>): EBlock[] {
  const hidden = hiddenIn(list, open);
  return list.filter((b) => !hidden.has(b.id) && b.type !== "columns" && b.type !== "col");
}

/** Columns with a paragraph in each, for the / menu. */
export function makeColumns(n: number, parent?: string): EBlock[] {
  const box: EBlock = { id: newId(), parent, type: "columns" };
  const out: EBlock[] = [box];
  for (let k = 0; k < n; k++) {
    const col: EBlock = { id: newId(), parent: box.id, type: "col" };
    out.push(col, { id: newId(), parent: col.id, type: "p", spans: [] } as TextBlock);
  }
  return out;
}

/** Insert blocks after a block (after what is inside it), at its level. */
export function insertAfter(input: readonly EBlock[], refId: string | undefined, made: readonly EBlock[]): EBlock[] {
  const list = [...input];
  const map = byId(list);
  const ref = refId ? map.get(refId) : undefined;
  const madeIds = new Set(made.map((b) => b.id));
  const placed = made.map((b) => (!b.parent || !madeIds.has(b.parent) ? ({ ...b, parent: ref?.parent } as EBlock) : b));
  if (!ref) return normalize([...list, ...placed]);
  let i = list.findIndex((b) => b.id === ref.id);
  while (i + 1 < list.length && isInside(list, list[i + 1].id, ref.id, map)) i++;
  return normalize([...list.slice(0, i + 1), ...placed, ...list.slice(i + 1)]);
}

/** A text block of the given kind. */
export const textBlock = (type: TextBlock["type"], extra: Partial<TextBlock> = {}): TextBlock => ({ id: newId(), type, spans: [], ...extra });

export { isText };
