import { runCli } from "./cli";

runCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[agent-cms]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
