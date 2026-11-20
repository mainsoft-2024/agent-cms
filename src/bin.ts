import { VERSION } from "./version";

const argv = process.argv.slice(2);

/** `drizzle-orm` or `zod` when that is the package Node could not find, else null. */
export function missingPeer(err: unknown): string | null {
  const e = err as { code?: string; message?: string } | null;
  if (!e || (e.code !== "ERR_MODULE_NOT_FOUND" && e.code !== "MODULE_NOT_FOUND")) return null;
  const m = /Cannot find (?:package|module) '((?:drizzle-orm|zod)(?:\/[^']*)?)'/.exec(e.message ?? "");
  return m ? m[1].split("/")[0] : null;
}

// Answered before the rest loads, so it works wherever the file itself runs.
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")) {
  console.log(VERSION);
  process.exit(0);
}

// The commands live in their own chunk: it imports the app's `drizzle-orm` and `zod`, and package
// managers that do not install peer dependencies by themselves (yarn 1, pnpm and npm with the setting
// off) would otherwise stop here with a bare Node stack trace.
import("./cli")
  .then(({ runCli }) => runCli(argv))
  .then((code) => process.exit(code))
  .catch((err) => {
    const peer = missingPeer(err);
    if (peer) {
      console.error(`[agent-cms] the package "${peer}" is not installed. The CLI needs drizzle-orm and zod next to @mainsoft/agent-cms:`);
      console.error("  npm i drizzle-orm zod      (or: yarn add, pnpm add, bun add)");
    } else {
      console.error("[agent-cms]", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  });
