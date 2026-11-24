#!/usr/bin/env node
// The npm package must carry the README, the change log and the license. Run by `npm run check:pack`.
// (There are no separate upgrade guides before 1.0: breaking changes are listed in CHANGELOG.md.)
import { execFileSync } from "node:child_process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const [pack] = JSON.parse(out);
const inPack = new Set(pack.files.map((f) => f.path));
const want = ["README.md", "CHANGELOG.md", "LICENSE"];
const missing = want.filter((f) => !inPack.has(f));
if (missing.length) {
  console.error(`check-pack-files: not in the npm package (add them to package.json "files"): ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-pack-files: ${want.length} files present`);
