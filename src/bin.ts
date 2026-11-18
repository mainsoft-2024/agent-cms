/**
 * `agent-cms <check-coverage|deploy-sync> [options]` — see src/cli.ts.
 * Env: AGENT_CMS_URL (https://<host>/api/cms), AGENT_CMS_KEY (sgk_…), PR_BODY.
 * Without the URL or key it prints why and exits 0.
 */

import { runCli } from "./cli";

runCli(process.argv.slice(2), {
  url: process.env.AGENT_CMS_URL,
  key: process.env.AGENT_CMS_KEY,
  prBody: process.env.PR_BODY,
})
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[agent-cms]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
