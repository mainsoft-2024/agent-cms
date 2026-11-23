#!/usr/bin/env node
// The npm package must carry every upgrade guide in the repository root (UPGRADE-*.md), the
// README, the change log and the license. Run by `npm run check:pack`.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const [pack] = JSON.parse(out);
const inPack = new Set(pack.files.map((f) => f.path));
const want = [...readdirSync(".").filter((f) => /^UPGRADE-[\d.]+\.md$/.test(f)), "README.md", "CHANGELOG.md", "LICENSE"];
for (const f of ["UPGRADE-0.21.md", "UPGRADE-0.22.md"]) if (!want.includes(f)) want.push(f);
const missing = want.filter((f) => !inPack.has(f));
if (missing.length) {
  console.error(`check-pack-files: not in the npm package (add them to package.json "files"): ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-pack-files: ${want.length} files present (${want.filter((f) => f.startsWith("UPGRADE")).join(", ")})`);
