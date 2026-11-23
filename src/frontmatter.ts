/**
 * Markdown file to document. The CLI's `put` reads a file like:
 *
 *   ---
 *   title: 새 기능이 나왔어요
 *   summary: 한 줄 요약
 *   category: 기능
 *   keywords: [release, 출시]
 *   tags: [가이드, 도움말]        # anything else goes into `fields`
 *   pinned: false
 *   ---
 *   본문 (markdown)
 *
 * Values: strings (quotes optional), numbers, true/false/null, and one-line
 * arrays `[a, b]`. No nesting: that is all a document's top level needs.
 */

import type { DocInput } from "./cms";

const DOC_KEYS = new Set(["slug", "title", "summary", "category", "keywords", "status", "updatedAt"]);

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
    try {
      return JSON.parse(v) as unknown; // escapes (\n, \") written by docToMarkdown
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1);
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]") && /[{"[]/.test(v.slice(1)))) {
    try {
      return JSON.parse(v) as unknown; // nested values, as docToMarkdown writes them
    } catch {
      // not JSON: read it the simple way below
    }
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitOutsideQuotes(inner, ",").map((x) => scalar(x)) : [];
  }
  return v;
}

/** Split on `sep` where it is not inside '…' or "…". */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === sep) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Drop a ` # comment` that is not inside quotes. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line;
}

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { data: {}, body: src.trim() };
  const data: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const t = stripComment(line);
    if (!t.trim()) continue;
    const i = t.indexOf(":");
    if (i < 1) throw new Error(`frontmatter: cannot read line "${line}"`);
    data[t.slice(0, i).trim()] = scalar(t.slice(i + 1));
  }
  return { data, body: src.slice(m[0].length).trim() };
}

/** A markdown file as document input. `slug` defaults to `fallbackSlug` (the file name). */
export function docFromMarkdown(text: string, fallbackSlug?: string): DocInput {
  const { data, body } = parseFrontmatter(text);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!DOC_KEYS.has(k)) fields[k] = v;
  const doc: DocInput = { body };
  const slug = (data.slug as string | undefined) ?? fallbackSlug;
  if (slug) doc.slug = String(slug);
  if (data.title !== undefined) doc.title = String(data.title);
  if (data.summary !== undefined) doc.summary = String(data.summary);
  if (data.category !== undefined) doc.category = data.category === null ? null : String(data.category);
  if (Array.isArray(data.keywords)) doc.keywords = data.keywords.map(String);
  if (Object.keys(fields).length) doc.fields = fields;
  return doc;
}

const PLAIN = /^[A-Za-z0-9가-힣_./ -]*$/;
function emit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    // Bare only when reading it back cannot turn it into something else.
    const bare = v !== "" && PLAIN.test(v) && v === v.trim() && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v) && !v.includes(" #");
    return bare ? v : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/**
 * A document as a markdown file that `docFromMarkdown` reads back to the same content.
 * `status` and `updatedAt` are written for `import` (which documents were public, which side is newer).
 */
export function docToMarkdown(doc: { slug: string; title: string; summary?: string; body?: string; category?: string | null; keywords?: string[]; fields?: Record<string, unknown> }, extra: { status?: string; updatedAt?: string; locale?: string; sourceVersion?: number | null; translationStatus?: string } = {}): string {
  const lines = [`slug: ${emit(doc.slug)}`, `title: ${emit(doc.title)}`];
  // 0.22.0: a translation says its language and the source version it was aligned with (`export`).
  if (extra.locale) lines.push(`locale: ${emit(extra.locale)}`);
  if (extra.sourceVersion != null) lines.push(`sourceVersion: ${extra.sourceVersion}`);
  if (extra.translationStatus) lines.push(`translationStatus: ${extra.translationStatus}`);
  if (doc.summary) lines.push(`summary: ${emit(doc.summary)}`);
  if (doc.category != null) lines.push(`category: ${emit(doc.category)}`);
  if (doc.keywords?.length) lines.push(`keywords: ${JSON.stringify(doc.keywords)}`);
  if (extra.status) lines.push(`status: ${extra.status}`);
  if (extra.updatedAt) lines.push(`updatedAt: ${JSON.stringify(extra.updatedAt)}`);
  for (const [k, v] of Object.entries(doc.fields ?? {})) if (v !== undefined && /^[A-Za-z_][\w-]*$/.test(k) && !DOC_KEYS.has(k)) lines.push(`${k}: ${emit(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${(doc.body ?? "").trim()}\n`;
}
