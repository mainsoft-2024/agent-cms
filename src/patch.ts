/**
 * Section patches: change one `## ` section of a body without resending the
 * whole document. Anchors are the ones `splitSections()` and the public page
 * use, so an agent can patch the section a search result pointed at.
 */

import { CmsError } from "./errors";
import { anchorOf, headingParts, inlineText, parseInline } from "./markdown";

export type PatchOp =
  /** Replace the text under the section's heading (the heading stays unless `heading` is given). */
  | { op: "replace"; anchor: string; markdown: string; heading?: string }
  /** Insert markdown (usually a new `## ` section) right after / before the section. */
  | { op: "insert_after"; anchor: string; markdown: string }
  | { op: "insert_before"; anchor: string; markdown: string }
  /** Remove the section with its heading. */
  | { op: "delete"; anchor: string }
  /** Add markdown at the end of the body. */
  | { op: "append"; markdown: string };

export interface SectionRange {
  /** "" = the text before the first heading. */
  anchor: string;
  heading: string;
  /** Line index of the heading (or 0 for the intro). */
  start: number;
  /** First line after the section (exclusive). */
  end: number;
  /** True when the section has a heading line. */
  hasHeading: boolean;
}

/** Where each section is, by line. Same anchors as `splitSections()`. */
export function sectionRanges(body: string): SectionRange[] {
  const lines = body.replace(/\r/g, "").split("\n");
  const out: SectionRange[] = [];
  const used = new Map<string, number>();
  let inFence = false;
  let cur: SectionRange = { anchor: "", heading: "", start: 0, end: 0, hasHeading: false };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      cur.end = i;
      out.push(cur);
      const parts = headingParts(h[1]);
      const text = inlineText(parseInline(parts.text));
      const base = parts.pinned ?? anchorOf(text);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      cur = { anchor: n && !parts.pinned ? `${base}-${n}` : base, heading: text, start: i, end: i + 1, hasHeading: true };
      continue;
    }
    // ### and #### headings take an anchor slot too, so ids match parseMarkdown().
    const h3 = !inFence ? /^#{3,4}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h3) {
      const p3 = headingParts(h3[1]);
      const base = p3.pinned ?? anchorOf(inlineText(parseInline(p3.text)));
      used.set(base, (used.get(base) ?? 0) + 1);
    }
  }
  cur.end = lines.length;
  out.push(cur);
  // Drop an empty intro so "" is only valid when there is intro text.
  return out.filter((s) => s.hasHeading || lines.slice(s.start, s.end).some((l) => l.trim()));
}

const trimBlank = (lines: string[]) => {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) s++;
  while (e > s && !lines[e - 1].trim()) e--;
  return lines.slice(s, e);
};

/** Apply ops in order. Throws `invalid_anchor` (with the valid anchors) for an unknown section. */
export function applyPatch(body: string, ops: PatchOp[]): string {
  let text = body.replace(/\r/g, "");
  for (const op of ops) {
    const lines = text.split("\n");
    if (op.op === "append") {
      const kept = trimBlank(lines);
      text = [...kept, ...(kept.length ? [""] : []), ...trimBlank(op.markdown.replace(/\r/g, "").split("\n"))].join("\n");
      continue;
    }
    const ranges = sectionRanges(text);
    const s = ranges.find((r) => r.anchor === op.anchor);
    if (!s) throw new CmsError("invalid_anchor", { anchor: op.anchor, valid: ranges.map((r) => r.anchor || '""') });
    const before = lines.slice(0, s.start);
    const after = lines.slice(s.end);
    const block = trimBlank((("markdown" in op ? op.markdown : "") ?? "").replace(/\r/g, "").split("\n"));
    let mid: string[];
    if (op.op === "delete") mid = [];
    else if (op.op === "replace") {
      const heading = s.hasHeading ? [op.heading ? lines[s.start].replace(/^(#{1,2}\s+).*$/, `$1${op.heading}`) : lines[s.start]] : [];
      mid = [...heading, ...(heading.length ? [""] : []), ...block, ""];
    } else {
      const section = lines.slice(s.start, s.end);
      mid = op.op === "insert_after" ? [...trimBlank(section), "", ...block, ""] : [...block, "", ...section];
    }
    // One blank line at each seam; untouched text keeps its own spacing.
    text = [before, mid, after]
      .map(trimBlank)
      .filter((p) => p.length)
      .map((p) => p.join("\n"))
      .join("\n\n");
  }
  return text;
}
