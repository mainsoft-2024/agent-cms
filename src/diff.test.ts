import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffSeq, diffWords, fieldChanges, hunks, merge3, mergeDocs, resolveDocMerge, resolveMerge, unifiedDiff, type DocLike } from "./diff";
import { applyPatch, sectionRanges } from "./patch";
import { isCmsError } from "./errors";

test("diff: Myers finds the shortest edit and keeps order", () => {
  const ops = diffSeq("ABCABBA".split(""), "CBABAC".split(""));
  assert.equal(ops.filter((o) => o.t !== "eq").length, 5);
  const a = ops.filter((o) => o.t !== "ins").map((o) => o.v).join("");
  const b = ops.filter((o) => o.t !== "del").map((o) => o.v).join("");
  assert.equal(a, "ABCABBA");
  assert.equal(b, "CBABAC");
  assert.deepEqual(diffLines("", ""), []);
  assert.deepEqual(diffLines("a", "a").map((o) => o.t), ["eq"]);
});

test("diff: hunks, unified text and word highlights", () => {
  const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten";
  const b = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven";
  const hs = hunks(a, b, 1);
  assert.equal(hs.length, 2);
  assert.deepEqual(hs[0].removed, ["three"]);
  assert.deepEqual(hs[0].added, ["THREE"]);
  assert.deepEqual(hs[1].added, ["eleven"]);
  const u = unifiedDiff(a, b, { from: "v1", to: "v2", context: 1 });
  assert.match(u, /^--- v1\n\+\+\+ v2\n@@ -2,3 \+2,3 @@\n two\n-three\n\+THREE\n four/);
  assert.equal(unifiedDiff(a, a), "");
  const w = diffWords("Slack 연결을 눌러요", "Slack 연결 버튼을 눌러요");
  assert.ok(w.some((p) => p.t === "ins" && p.v.includes("버튼을")));
  assert.equal(w.filter((p) => p.t !== "ins").map((p) => p.v).join(""), "Slack 연결을 눌러요");
});

test("merge3: changes on different lines merge by themselves", () => {
  const base = "a\nb\nc\nd\ne";
  const r = merge3(base, "A\nb\nc\nd\ne", "a\nb\nc\nd\nE");
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.text, "A\nb\nc\nd\nE");
  // The same change on both sides is not a conflict.
  assert.equal(merge3(base, "a\nX\nc\nd\ne", "a\nX\nc\nd\ne").text, "a\nX\nc\nd\ne");
});

test("merge3: overlapping edits conflict; 'both' puts theirs first, then mine", () => {
  const r = merge3("a\nb\nc", "a\nmine\nc", "a\ntheirs\nc");
  assert.equal(r.text, null);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].base, ["b"]);
  assert.equal(resolveMerge(r, { 0: "both" }), "a\ntheirs\nmine\nc");
  assert.equal(resolveMerge(r, { 0: "mine" }), "a\nmine\nc");
  assert.equal(resolveMerge(r, { 0: "theirs" }), "a\ntheirs\nc");
  assert.throws(() => resolveMerge(r, {}));
  // Two different words on the same line are a line conflict (by design).
  assert.equal(merge3("x y z", "X y z", "x y Z").conflicts.length, 1);
  // Insertions at the end by both sides.
  const end = merge3("a", "a\nm", "a\nt");
  assert.equal(resolveMerge(end, { 0: "both" }), "a\nt\nm");
});

const doc = (o: Partial<DocLike>): DocLike => ({ slug: "s", title: "T", summary: "", body: "a\nb\nc\nd", category: null, keywords: [], fields: {}, ...o });

test("mergeDocs: fields merge by path, conflicts are reported and resolvable", () => {
  const base = doc({ fields: { seo: { title: "x", desc: "d" }, tags: ["a"] } });
  const mine = doc({ title: "Mine", body: "a\nB\nc\nd", fields: { seo: { title: "x", desc: "mine" }, tags: ["a"] } });
  const theirs = doc({ summary: "S", body: "a\nb\nc\nD", fields: { seo: { title: "y", desc: "theirs" }, tags: ["a"] } });
  const m = mergeDocs(base, mine, theirs);
  assert.equal(m.merged.title, "Mine");
  assert.equal(m.merged.summary, "S");
  assert.equal(m.merged.body, "a\nB\nc\nD");
  // Adjacent lines changed by both sides conflict, as in git.
  assert.equal(merge3("a\nb\nc", "a\nB\nc", "a\nb\nC").conflicts.length, 1);
  assert.deepEqual(m.fieldConflicts.map((c) => c.path), ["fields.seo.desc"]);
  const out = resolveDocMerge(m, { fields: { "fields.seo.desc": "mine" } });
  assert.deepEqual(out.fields, { seo: { title: "y", desc: "mine" }, tags: ["a"] });
  assert.deepEqual(
    fieldChanges(base, out).map((f) => f.path),
    ["title", "summary", "fields.seo.desc", "fields.seo.title"]
  );
});

test("patch: replace, insert, delete, append by anchor; wrong anchor lists the valid ones", () => {
  const body = "intro\n\n## 연결하기\n\n옛 내용\n\n## 끊기\n\n끊어요";
  assert.deepEqual(sectionRanges(body).map((s) => s.anchor), ["", "연결하기", "끊기"]);
  assert.equal(applyPatch(body, [{ op: "replace", anchor: "연결하기", markdown: "새 내용" }]), "intro\n\n## 연결하기\n\n새 내용\n\n## 끊기\n\n끊어요");
  assert.equal(applyPatch(body, [{ op: "delete", anchor: "끊기" }]), "intro\n\n## 연결하기\n\n옛 내용");
  assert.equal(applyPatch(body, [{ op: "insert_after", anchor: "연결하기", markdown: "## 확인\n\n됐어요" }]), "intro\n\n## 연결하기\n\n옛 내용\n\n## 확인\n\n됐어요\n\n## 끊기\n\n끊어요");
  assert.equal(applyPatch("## a\n\nx", [{ op: "append", markdown: "## b\n\ny" }]), "## a\n\nx\n\n## b\n\ny");
  assert.equal(applyPatch(body, [{ op: "replace", anchor: "", markdown: "새 소개" }]).split("\n")[0], "새 소개");
  assert.throws(
    () => applyPatch(body, [{ op: "replace", anchor: "nope", markdown: "x" }]),
    (e: unknown) => isCmsError(e) && e.code === "invalid_anchor" && (e.params.valid as string[]).includes("연결하기")
  );
});
