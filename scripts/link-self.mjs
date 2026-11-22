// The examples import "@mainsoft/agent-cms" by name. In this repository that is the
// package itself (as built in dist), so link node_modules/@mainsoft/agent-cms to the root.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const link = join(root, "node_modules/@mainsoft/agent-cms");
mkdirSync(dirname(link), { recursive: true });
if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
  if (lstatSync(link).isSymbolicLink()) process.exit(0);
  rmSync(link, { recursive: true, force: true });
}
symlinkSync(root, link, "dir");
