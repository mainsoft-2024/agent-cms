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

const DOC_KEYS = new Set(["slug", "title", "summary", "category", "keywords"]);

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => scalar(x)) : [];
  }
  return v;
}

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { data: {}, body: src.trim() };
  const data: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const t = line.replace(/\s+#.*$/, "");
    if (!t.trim() || t.trimStart().startsWith("#")) continue;
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
