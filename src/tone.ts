/**
 * Korean screen and error text is written in 입니다체 (0.26.0): sentences end in -습니다/-ㅂ니다,
 * short labels are noun phrases. Used by the tests that keep the catalogs that way.
 */

/** Words that end like 음슴체 but are plain nouns. */
const NOUNS = new Set([
  "다음", "처음", "묶음", "모음", "마음", "알림", "그림", "포함", "보관함", "편지함", "이름", "기본값", "숨김", "기울임",
  "없음", // a value ("none") on its own
]);

/** 음슴체 endings on the last word of a phrase. */
const EUMSEUM = /(?:했음|됐음|되었음|였음|었음|았음|겠음|있음|없음|않음|같음|많음|맞음|좋음|다름|모름|[함됨임짐김옴줌씀춤움뀜켬둠봄씀])$/;

/** Why `text` is not in the house style, or null. `${…}` parts are ignored. */
export function toneProblem(text: string): string | null {
  const t = text.replace(/\$\{[^}]*\}/g, "X").replace(/\{[^}]*\}/g, "X");
  if (!/[가-힣]/.test(t)) return null;
  if (/(?<!필)요[.!?]?(\s|$|:|\(|\))|까요\?/.test(t)) return "해요체";
  // Every sentence that ends with a period ends in -다 (or a formal request, -오).
  for (const m of t.matchAll(/([가-힣])\.(?=\s|$|["'”)\]])/g)) if (m[1] !== "다" && m[1] !== "오") return `sentence ends in "${m[1]}."`;
  // No phrase ends in 음슴체, with or without a period.
  for (const part of t.split(/[.!?:;,·()\[\]"“”]|\s[-–—]\s|\n/)) {
    const words = part.trim().split(/\s+/);
    const last = (words[words.length - 1] ?? "").replace(/[^가-힣]+$/, "");
    if (!last || NOUNS.has(last)) continue;
    if (EUMSEUM.test(last)) return `ends in 음슴체 ("${last}")`;
  }
  return null;
}

/** Every Hangul string literal ("…", '…', `…`) in `source`. */
export function koreanLiterals(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    if (/[가-힣]/.test(s)) out.push(s);
  }
  return out;
}
