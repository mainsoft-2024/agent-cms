// Rules for the screen tests themselves. A failing `assert.equal(<DOM node>, …)` makes Node print
// the node, which leads through React's fiber to the whole app: the process then eats memory for
// minutes (on CI the runner is shut down with no log). Compare nodes with `assert.ok(a === b, …)`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("screen tests never compare DOM nodes with assert.equal / deepEqual", () => {
  const dir = join(import.meta.dirname, ".");
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.test\.tsx?$/.test(x) && x !== "test-rules.test.ts")) {
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (
          /assert\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual)\(\s*document\.activeElement\s*,/.test(line) ||
          /assert\.(equal|strictEqual|notEqual)\([^,]+,\s*(null|undefined)\s*\)/.test(line) && /(screen|within\([^)]*\))\.query/.test(line)
        )
          bad.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(bad, []);
});
