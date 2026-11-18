/**
 * Path globs for a document's `covers` (the code it documents).
 * `**` = any depth, `*` = within one segment, `?` = one character,
 * `{a,b}` = either. A pattern without a glob character matches that path or
 * anything under it (a folder).
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let p = pattern.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  const literal = !/[*?{]/.test(p);
  if (literal) p = p.replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + p.slice(i + 1, end).split(",").map(escape).join("|") + ")";
        i = end;
      }
    } else re += escape(c);
  }
  const out = new RegExp("^" + re + (literal ? "(?:/.*)?" : "") + "$");
  cache.set(pattern, out);
  return out;
}

function escape(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  const p = path.replace(/^\.\//, "");
  return patterns.some((g) => g.trim() && globToRegExp(g).test(p));
}
