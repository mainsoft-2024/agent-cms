/**
 * Line and word diffs, hunks, unified diff text and a line-level 3-way merge
 * (diff3). No dependencies and no Node APIs, so the admin UI runs the same
 * code in the browser (`@mainsoft-2024/agent-cms/diff`).
 */

export type DiffOp<T = string> = { t: "eq" | "del" | "ins"; a: number; b: number; v: T };

/** Shortest edit script between two sequences (Myers, O((N+M)D)). */
export function diffSeq<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is): DiffOp<T>[] {
  // Trim the common prefix and suffix first: most edits are small.
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && eq(A[x], B[y])) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk the trace back to the start.
  const mid: DiffOp<T>[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      mid.push({ t: "eq", a: x, b: y, v: A[x] });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        mid.push({ t: "ins", a: x, b: y, v: B[y] });
      } else {
        x--;
        mid.push({ t: "del", a: x, b: y, v: A[x] });
      }
    }
  }
  mid.reverse();
  const out: DiffOp<T>[] = [];
  for (let i = 0; i < start; i++) out.push({ t: "eq", a: i, b: i, v: a[i] });
  for (const o of mid) out.push({ ...o, a: o.a + start, b: o.b + start });
  for (let i = 0; i < a.length - endA; i++) out.push({ t: "eq", a: endA + i, b: endB + i, v: a[endA + i] });
  return out;
}

export const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\r\n?/g, "\n").split("\n"));

/** Line diff of two texts. */
export function diffLines(a: string, b: string): DiffOp[] {
  return diffSeq(splitLines(a), splitLines(b));
}

/** Word diff (words and the spaces between them), for highlighting inside a changed line. */
export function diffWords(a: string, b: string): { t: "eq" | "del" | "ins"; v: string }[] {
  const tok = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const ops = diffSeq(tok(a), tok(b));
  const out: { t: "eq" | "del" | "ins"; v: string }[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last && last.t === o.t) last.v += o.v;
    else out.push({ t: o.t, v: o.v });
  }
  return out;
}

export interface HunkLine {
  t: " " | "-" | "+";
  v: string;
  /** 1-based line in the old text (for " " and "-"). */
  a?: number;
  /** 1-based line in the new text (for " " and "+"). */
  b?: number;
}

export interface Hunk {
  /** 1-based start and length in the old and new text (unified diff header). */
  aStart: number;
  aLines: number;
  bStart: number;
  bLines: number;
  lines: HunkLine[];
  /** Lines removed and added in this hunk (no context). */
  removed: string[];
  added: string[];
}

/** Group a line diff into hunks with `context` unchanged lines around each change. */
export function hunks(a: string, b: string, context = 3): Hunk[] {
  const ops = diffLines(a, b);
  const changed = ops.map((o, i) => (o.t === "eq" ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= context * 2 + 1) last[1] = i;
    else groups.push([i, i]);
  }
  return groups.map(([from, to]) => {
    const s = Math.max(0, from - context);
    const e = Math.min(ops.length - 1, to + context);
    const lines: HunkLine[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    for (let i = s; i <= e; i++) {
      const o = ops[i];
      if (o.t === "eq") lines.push({ t: " ", v: o.v, a: o.a + 1, b: o.b + 1 });
      else if (o.t === "del") {
        lines.push({ t: "-", v: o.v, a: o.a + 1 });
        removed.push(o.v);
      } else {
        lines.push({ t: "+", v: o.v, b: o.b + 1 });
        added.push(o.v);
      }
    }
    const first = ops[s];
    const aLines = lines.filter((l) => l.t !== "+").length;
    const bLines = lines.filter((l) => l.t !== "-").length;
    return { aStart: aLines ? first.a + 1 : first.a, aLines, bStart: bLines ? first.b + 1 : first.b, bLines, lines, removed, added };
  });
}

/** `git diff`-style text. */
export function unifiedDiff(a: string, b: string, o: { from?: string; to?: string; context?: number } = {}): string {
  const hs = hunks(a, b, o.context ?? 3);
  if (!hs.length) return "";
  const out = [`--- ${o.from ?? "a"}`, `+++ ${o.to ?? "b"}`];
  for (const h of hs) {
    out.push(`@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@`);
    for (const l of h.lines) out.push(l.t + l.v);
  }
  return out.join("\n");
}

// ── 3-way merge ──────────────────────────────────────────────────────────────

export type MergeChunk =
  | { t: "ok"; lines: string[]; from: "base" | "mine" | "theirs" | "both" }
  | { t: "conflict"; id: number; base: string[]; mine: string[]; theirs: string[] };

export interface MergeResult {
  chunks: MergeChunk[];
  /** Conflicting chunks only (same objects as in `chunks`). */
  conflicts: Extract<MergeChunk, { t: "conflict" }>[];
  /** The merged text when there is no conflict, else null. */
  text: string | null;
}

export type MergeChoice = "mine" | "theirs" | "both";

function matchMap(base: string[], other: string[]): number[] {
  const m = new Array<number>(base.length).fill(-1);
  for (const o of diffSeq(base, other)) if (o.t === "eq") m[o.a] = o.b;
  return m;
}

const sameLines = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

/**
 * Line-level diff3. Changes on different lines merge by themselves; a region
 * both sides changed differently is a conflict (unless they made the same
 * change). Two edits to the same line, even different words, conflict.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  const O = splitLines(base);
  const A = splitLines(mine);
  const B = splitLines(theirs);
  const ma = matchMap(O, A);
  const mb = matchMap(O, B);
  const chunks: MergeChunk[] = [];
  const conflicts: Extract<MergeChunk, { t: "conflict" }>[] = [];
  const pushOk = (lines: string[], from: "base" | "mine" | "theirs" | "both") => {
    if (!lines.length) return;
    const last = chunks[chunks.length - 1];
    if (last && last.t === "ok" && last.from === from) last.lines.push(...lines);
    else chunks.push({ t: "ok", lines: [...lines], from });
  };
  let io = 0;
  let ia = 0;
  let ib = 0;
  while (io < O.length || ia < A.length || ib < B.length) {
    if (io < O.length && ma[io] === ia && mb[io] === ib) {
      pushOk([O[io]], "base");
      io++;
      ia++;
      ib++;
      continue;
    }
    // Next line every side still agrees on (a sync point), or the end.
    let o = io;
    while (o < O.length && !(ma[o] >= ia && mb[o] >= ib)) o++;
    const ea = o < O.length ? ma[o] : A.length;
    const eb = o < O.length ? mb[o] : B.length;
    const oc = O.slice(io, o);
    const ac = A.slice(ia, ea);
    const bc = B.slice(ib, eb);
    if (sameLines(ac, oc)) pushOk(bc, "theirs");
    else if (sameLines(bc, oc)) pushOk(ac, "mine");
    else if (sameLines(ac, bc)) pushOk(ac, "both");
    else {
      const c = { t: "conflict" as const, id: conflicts.length, base: oc, mine: ac, theirs: bc };
      chunks.push(c);
      conflicts.push(c);
    }
    io = o;
    ia = ea;
    ib = eb;
  }
  return { chunks, conflicts, text: conflicts.length ? null : chunks.flatMap((c) => (c.t === "ok" ? c.lines : [])).join("\n") };
}

/** Build the text from a merge and a choice per conflict id. "both" = theirs first, then mine. */
export function resolveMerge(r: MergeResult, choices: Record<number, MergeChoice>): string {
  const out: string[] = [];
  for (const c of r.chunks) {
    if (c.t === "ok") out.push(...c.lines);
    else {
      const pick = choices[c.id];
      if (!pick) throw new Error(`conflict ${c.id} has no choice`);
      if (pick === "theirs") out.push(...c.theirs);
      else if (pick === "mine") out.push(...c.mine);
      else out.push(...c.theirs, ...c.mine);
    }
  }
  return out.join("\n");
}

// ── whole documents ──────────────────────────────────────────────────────────

export interface DocLike {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  keywords: string[];
  fields: Record<string, unknown>;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** Leaf paths of a fields object (`tags`, `seo.title`); arrays are leaves. */
export function flattenFields(v: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length) Object.assign(out, flattenFields(x as Record<string, unknown>, p));
    else out[p] = x;
  }
  return out;
}

function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [p, v] of Object.entries(flat)) {
    if (v === undefined) continue;
    const parts = p.split(".");
    let cur = out;
    for (const part of parts.slice(0, -1)) cur = (cur[part] ??= {}) as Record<string, unknown>;
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

export interface FieldChange {
  /** `title`, `summary`, `category`, `keywords`, `slug` or `fields.<path>`. */
  path: string;
  from: unknown;
  to: unknown;
}

/** Field-by-field changes between two documents (the body is not included; diff it with `hunks`). */
export function fieldChanges(a: DocLike, b: DocLike): FieldChange[] {
  const out: FieldChange[] = [];
  for (const k of ["slug", "title", "summary", "category", "keywords"] as const) {
    if (stable(a[k]) !== stable(b[k])) out.push({ path: k, from: a[k], to: b[k] });
  }
  const fa = flattenFields(a.fields);
  const fb = flattenFields(b.fields);
  for (const p of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
    if (stable(fa[p]) !== stable(fb[p])) out.push({ path: `fields.${p}`, from: fa[p], to: fb[p] });
  }
  return out;
}

export interface FieldConflict {
  path: string;
  base: unknown;
  mine: unknown;
  theirs: unknown;
}

export interface DocMerge {
  /** The merged document; conflicting fields hold "theirs" until resolved. */
  merged: DocLike;
  body: MergeResult;
  fieldConflicts: FieldConflict[];
  /** Paths each side changed that merged by themselves. */
  autoMerged: { path: string; from: "mine" | "theirs" | "both" }[];
}

/** 3-way merge of whole documents: the body by lines, every other value by field path. */
export function mergeDocs(base: DocLike, mine: DocLike, theirs: DocLike): DocMerge {
  const fieldConflicts: FieldConflict[] = [];
  const autoMerged: DocMerge["autoMerged"] = [];
  const pick = (path: string, o: unknown, a: unknown, b: unknown): unknown => {
    const so = stable(o);
    const sa = stable(a);
    const sb = stable(b);
    if (sa === sb) {
      if (sa !== so) autoMerged.push({ path, from: "both" });
      return a;
    }
    if (sa === so) {
      autoMerged.push({ path, from: "theirs" });
      return b;
    }
    if (sb === so) {
      autoMerged.push({ path, from: "mine" });
      return a;
    }
    fieldConflicts.push({ path, base: o, mine: a, theirs: b });
    return b;
  };
  const merged: DocLike = { ...theirs };
  for (const k of ["slug", "title", "summary", "category", "keywords"] as const) (merged as unknown as Record<string, unknown>)[k] = pick(k, base[k], mine[k], theirs[k]);
  const fo = flattenFields(base.fields);
  const fa = flattenFields(mine.fields);
  const fb = flattenFields(theirs.fields);
  const flat: Record<string, unknown> = {};
  for (const p of [...new Set([...Object.keys(fo), ...Object.keys(fa), ...Object.keys(fb)])].sort()) flat[p] = pick(`fields.${p}`, fo[p], fa[p], fb[p]);
  merged.fields = unflatten(flat);
  const body = merge3(base.body, mine.body, theirs.body);
  merged.body = body.text ?? theirs.body;
  for (const c of body.chunks) if (c.t === "ok" && c.from !== "base") autoMerged.push({ path: "body", from: c.from });
  return { merged, body, fieldConflicts, autoMerged };
}

/** Apply choices to a `mergeDocs` result: body conflicts by id, field conflicts by path. */
export function resolveDocMerge(m: DocMerge, choices: { body?: Record<number, MergeChoice>; fields?: Record<string, "mine" | "theirs"> }): DocLike {
  const out: DocLike = { ...m.merged, fields: structuredClone(m.merged.fields) };
  out.body = m.body.conflicts.length ? resolveMerge(m.body, choices.body ?? {}) : (m.body.text ?? out.body);
  for (const c of m.fieldConflicts) {
    const v = (choices.fields?.[c.path] ?? "theirs") === "mine" ? c.mine : c.theirs;
    if (c.path.startsWith("fields.")) {
      const flat = flattenFields(out.fields);
      flat[c.path.slice(7)] = v;
      out.fields = unflatten(flat);
    } else (out as unknown as Record<string, unknown>)[c.path] = v;
  }
  return out;
}
