/**
 * A document as one text file, the way coding agents edit code (0.15.0).
 *
 *   ---
 *   slug: new-dashboard
 *   title: The new dashboard
 *   category: News
 *   cover: asset:a8f2c0d1e2f3/banner.jpg     ← fields are frontmatter lines
 *   ---
 *   Body (markdown; HTML blocks as :::html … ::: — or HTML for HTML documents)
 *
 * `read_document` shows it with line numbers, `grep_documents` searches many,
 * `edit_document` replaces unique text with new text (like an editor's
 * Find and Replace, all edits or none), `write_document` replaces the file.
 * Pure helpers here; the CMS methods live in `cms.ts`.
 */
import { docFromMarkdown, docToMarkdown, parseFrontmatter } from "./frontmatter";
import { merge3, splitLines, type MergeResult } from "./diff";
import { parseMarkdown } from "./markdown";

export interface FileDoc {
  slug: string;
  title: string;
  summary?: string;
  body?: string;
  format?: "markdown" | "html";
  category?: string | null;
  keywords?: string[];
  fields?: Record<string, unknown>;
}

/** The text of a document as a file. */
export function docFile(doc: FileDoc): string {
  const md = docToMarkdown(doc);
  return doc.format === "html" ? md.replace(/\n---\n/, "\nformat: html\n---\n") : md;
}

/** Where the document lives as a file: `guide/new-dashboard.md` (`.html` for HTML documents). */
export const docPath = (collection: string, slug: string, format?: "markdown" | "html") => `${collection}/${slug}.${format === "html" ? "html" : "md"}`;

export class FileError extends Error {
  constructor(
    readonly line: number,
    readonly reason: string
  ) {
    super(`line ${line}: ${reason}`);
  }
}

/**
 * Read a file back to document input. Fields missing from the frontmatter
 * become null in `fields` (so they are removed), given the current fields.
 */
export function fileToInput(text: string, curFields: Record<string, unknown> = {}): ReturnType<typeof docFromMarkdown> & { format?: "markdown" | "html" } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) throw new FileError(1, "the file must start with a frontmatter block (---)");
  const end = src.indexOf("\n---", 4);
  if (end < 0) throw new FileError(1, "the frontmatter block is not closed (---)");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(src);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const bad = /cannot read line "(.*)"/.exec(msg)?.[1];
    const line = bad !== undefined ? src.split("\n").indexOf(bad) + 1 : 1;
    throw new FileError(Math.max(1, line), msg.replace(/^frontmatter: /, ""));
  }
  const fmt = parsed.data.format;
  const input = docFromMarkdown(src) as ReturnType<typeof docFromMarkdown> & { format?: "markdown" | "html"; fields?: Record<string, unknown> };
  if (input.fields) delete input.fields.format;
  if (fmt !== undefined && fmt !== "html" && fmt !== "markdown") throw new FileError(lineOfKey(src, "format"), `format must be "markdown" or "html"`);
  input.format = fmt === "html" ? "html" : "markdown";
  const fields: Record<string, unknown> = { ...(input.fields ?? {}) };
  for (const k of Object.keys(curFields)) if (!(k in fields)) fields[k] = null;
  if (Object.keys(fields).length) input.fields = fields;
  else delete input.fields;
  return input;
}

/** 1-based line of a frontmatter key, or 1. */
export function lineOfKey(text: string, key: string): number {
  const lines = text.split("\n");
  const i = lines.findIndex((l, k) => k > 0 && new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l));
  return i >= 0 ? i + 1 : 1;
}

/** Lines `from`…`to` (1-based) as `N→text`, long lines cut at 2000 characters. */
export function numberLines(text: string, offset = 1, limit = 400): { content: string; from: number; to: number; total: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  const from = Math.max(1, Math.floor(offset));
  const to = Math.min(lines.length, from + Math.max(1, Math.floor(limit)) - 1);
  const width = String(to).length;
  const content = lines
    .slice(from - 1, to)
    .map((l, k) => `${String(from + k).padStart(width, " ")}→${l.length > 2000 ? `${l.slice(0, 2000)}… (${l.length - 2000} more characters)` : l}`)
    .join("\n");
  return { content, from, to, total: lines.length };
}

export interface OutlineItem {
  line: number;
  kind: string;
  text: string;
}

/** Frontmatter keys, headings and block kinds with their lines: a map of a long document. */
export function outline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = text.split("\n");
  let bodyAt = 0;
  if (lines[0] === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        bodyAt = i + 1;
        break;
      }
      const k = /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i]);
      if (k) out.push({ line: i + 1, kind: "field", text: k[1] });
    }
  }
  const body = lines.slice(bodyAt).join("\n");
  if (/(^|\n)format:\s*html\b/.test(lines.slice(0, bodyAt).join("\n"))) {
    const tag = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = tag.exec(body))) out.push({ line: bodyAt + body.slice(0, m.index).split("\n").length, kind: m[1].toLowerCase(), text: m[2].replace(/<[^>]*>/g, "").trim().slice(0, 120) });
    return out;
  }
  for (const b of parseMarkdown(body, { lines: true })) {
    const line = bodyAt + (b.line ?? 1);
    if (b.t === "heading") out.push({ line, kind: `h${b.level}`, text: b.text });
    else out.push({ line, kind: b.t, text: b.t === "toggle" ? b.text : b.t === "media" ? b.alt || b.name : b.t === "code" ? b.lang : "" });
  }
  return out;
}

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export type EditFailure =
  | { code: "edit_not_found"; index: number; similar: { line: number; text: string }[]; hint: string }
  | { code: "edit_not_unique"; index: number; count: number; lines: number[] }
  | { code: "edit_invalid"; index: number; reason: string };

export interface EditSuccess {
  text: string;
  /** Changed line ranges in the new text (1-based, inclusive). */
  changed: { from: number; to: number }[];
  /** How many places each edit replaced. */
  counts: number[];
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

function indexesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Lines most like `needle`'s first line, for "not found" answers. */
export function similarLines(text: string, needle: string, n = 3): { line: number; text: string }[] {
  const want = (needle.split("\n").find((l) => l.trim()) ?? needle).trim();
  if (!want) return [];
  const grams = (s: string) => {
    const g = new Set<string>();
    const t = s.toLowerCase().replace(/\s+/g, " ");
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const w = grams(want);
  return text
    .split("\n")
    .map((l, i) => {
      const g = grams(l);
      let hit = 0;
      for (const x of w) if (g.has(x)) hit++;
      return { line: i + 1, text: l, score: (2 * hit) / (w.size + g.size || 1) };
    })
    .filter((x) => x.score > 0.3 && x.text.trim())
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(({ line, text }) => ({ line, text: text.length > 200 ? text.slice(0, 200) + "…" : text }));
}

/** What differs between the wanted text and a near line (spaces, quotes, dashes). */
function hintFor(needle: string, similar: { text: string }[]): string {
  const near = similar[0]?.text;
  if (!near) return "";
  const norm = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  const first = needle.split("\n").find((l) => l.trim()) ?? needle;
  if (norm(first) === norm(near)) {
    if (first.replace(/\s+/g, " ").trim() === near.replace(/\s+/g, " ").trim()) return "spaces differ";
    return "quotes or dashes differ";
  }
  return "";
}

/** Apply edits in order, all or none. */
export function applyEdits(text: string, edits: TextEdit[]): EditSuccess | EditFailure {
  if (!edits.length) return { code: "edit_invalid", index: 0, reason: "no edits" };
  let cur = text;
  const marks: { start: number; len: number }[] = [];
  const counts: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (typeof e.oldString !== "string" || typeof e.newString !== "string") return { code: "edit_invalid", index: i, reason: "oldString and newString are text" };
    if (!e.oldString) return { code: "edit_invalid", index: i, reason: "oldString is empty (use write_document for a whole file)" };
    if (e.oldString === e.newString) return { code: "edit_invalid", index: i, reason: "oldString and newString are the same" };
    const at = indexesOf(cur, e.oldString);
    if (!at.length) {
      const similar = similarLines(cur, e.oldString);
      return { code: "edit_not_found", index: i, similar, hint: hintFor(e.oldString, similar) };
    }
    if (at.length > 1 && !e.replaceAll) return { code: "edit_not_unique", index: i, count: at.length, lines: at.map((x) => lineAt(cur, x)) };
    // Replace from the end so earlier indexes stay right; shift earlier marks.
    for (const x of [...at].reverse()) {
      cur = cur.slice(0, x) + e.newString + cur.slice(x + e.oldString.length);
      const delta = e.newString.length - e.oldString.length;
      for (const m of marks) if (m.start > x) m.start += delta;
      marks.push({ start: x, len: e.newString.length });
    }
    counts.push(at.length);
  }
  const changed = marks
    .map((m) => ({ from: lineAt(cur, m.start), to: lineAt(cur, m.start + Math.max(0, m.len - 1)) }))
    .sort((a, b) => a.from - b.from)
    .reduce<{ from: number; to: number }[]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
      else acc.push({ ...r });
      return acc;
    }, []);
  return { text: cur, changed, counts };
}

/** Lines around each changed range (for the answer to an edit). */
export function snippets(text: string, changed: { from: number; to: number }[], context = 3): string {
  const lines = text.split("\n");
  return changed
    .map((r) => {
      const a = Math.max(1, r.from - context);
      const b = Math.min(lines.length, r.to + context);
      return numberLines(text, a, b - a + 1).content;
    })
    .join("\n…\n");
}

/** A 3-way merge as file text with git-style markers where both sides changed the same lines. */
export function mergeFiles(base: string, mine: string, theirs: string): { text: string; conflicts: number; result: MergeResult } {
  const r = merge3(base, mine, theirs);
  if (r.text !== null) return { text: r.text, conflicts: 0, result: r };
  const out: string[] = [];
  for (const c of r.chunks) {
    if (c.t === "ok") out.push(...c.lines);
    else out.push("<<<<<<< yours", ...c.mine, "=======", ...c.theirs, ">>>>>>> cms");
  }
  return { text: out.join("\n"), conflicts: r.conflicts.length, result: r };
}

/** True when the text still has merge markers. */
export const hasConflictMarkers = (text: string) => /^<<<<<<< |^>>>>>>> /m.test(text);

export interface GrepOptions {
  pattern: string;
  regex?: boolean;
  ignoreCase?: boolean;
  /** Lines before and after each match (0–5). */
  context?: number;
}

export interface GrepLine {
  line: number;
  text: string;
  /** Context lines (`-` before, `+` after) when asked for. */
  before?: string[];
  after?: string[];
}

/** A matcher for one line. Throws on a bad or too long pattern. */
export function lineMatcher(o: GrepOptions): (line: string) => boolean {
  if (!o.pattern) throw new Error("the pattern is empty");
  if (o.regex) {
    if (o.pattern.length > 200) throw new Error("regular expressions are limited to 200 characters");
    const re = new RegExp(o.pattern, o.ignoreCase ? "iu" : "u");
    return (l) => re.test(l);
  }
  const p = o.ignoreCase ? o.pattern.toLowerCase() : o.pattern;
  return o.ignoreCase ? (l) => l.toLowerCase().includes(p) : (l) => l.includes(p);
}

/** Matching lines of one file. */
export function grepText(text: string, match: (line: string) => boolean, context = 0): GrepLine[] {
  const lines = splitLines(text);
  const c = Math.max(0, Math.min(5, Math.floor(context)));
  const out: GrepLine[] = [];
  lines.forEach((l, i) => {
    if (!match(l)) return;
    const hit: GrepLine = { line: i + 1, text: l.length > 500 ? l.slice(0, 500) + "…" : l };
    if (c) {
      hit.before = lines.slice(Math.max(0, i - c), i);
      hit.after = lines.slice(i + 1, i + 1 + c);
    }
    out.push(hit);
  });
  return out;
}

/** `guide/2026-*` → does a path `guide/2026-launch` match? `*` within a segment, `**` across. */
export function globMatch(glob: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      glob
        .split("**")
        .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
        .join(".*") +
      "$"
  );
  return re.test(path);
}
