/**
 * `agent-cms` CLI. Talks to a running app over REST with an API key, so CI
 * never needs database access.
 *
 *   agent-cms check-coverage --base origin/main [--pr 123] [--skip-token GUIDE-OK]
 *     Fails (exit 1) when the diff touches code a document covers and the PR
 *     carries no update for that document. Put the skip token in a commit
 *     message or the PR body (env PR_BODY) to pass; the docs are then flagged
 *     "확인 필요" on deploy instead.
 *
 *   agent-cms deploy-sync --from <sha> --to <sha>
 *     After a deploy: publishes documents waiting for the deployed PRs and
 *     flags the ones whose code changed without them.
 *
 * Env: AGENT_CMS_URL (e.g. https://app.example.com/api/cms), AGENT_CMS_KEY.
 * When either is missing the command prints why and exits 0, so forks and
 * local runs without secrets are not blocked.
 */

import { execFileSync } from "node:child_process";

export interface CliEnv {
  url?: string;
  key?: string;
  prBody?: string;
  /** For tests: replaces git. */
  git?: (args: string[]) => string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

const runGit = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** PR numbers named in commit subjects ("… (#123)", "Merge pull request #123"). */
export function prNumbersFromLog(log: string): number[] {
  const out = new Set<number>();
  for (const m of log.matchAll(/(?:\(#|pull request #)(\d+)\)?/g)) out.add(Number(m[1]));
  return [...out];
}

async function call(env: CliEnv, path: string, body: unknown): Promise<unknown> {
  const f = env.fetch ?? fetch;
  const res = await f(`${env.url!.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function runCli(argv: string[], env: CliEnv = {}): Promise<number> {
  const log = env.log ?? ((l: string) => console.log(l));
  const git = env.git ?? runGit;
  const cmd = argv[0];
  if (!env.url || !env.key) {
    log(`[agent-cms] ${cmd}: AGENT_CMS_URL or AGENT_CMS_KEY is not set, skipping.`);
    return 0;
  }

  if (cmd === "check-coverage") {
    const base = arg(argv, "base") ?? "origin/main";
    const head = arg(argv, "head") ?? "HEAD";
    const pr = arg(argv, "pr") ? Number(arg(argv, "pr")) : null;
    const token = arg(argv, "skip-token") ?? "GUIDE-OK";
    const files = git(["diff", "--name-only", `${base}...${head}`]).split("\n").map((s) => s.trim()).filter(Boolean);
    if (!files.length) {
      log("[agent-cms] no changed files.");
      return 0;
    }
    const r = (await call(env, "/coverage", { files, pr })) as { docs: { collection: string; slug: string; title: string; matched: string[]; updatedInPr: boolean }[] };
    const missing = r.docs.filter((d) => !d.updatedInPr);
    if (!missing.length) {
      log(r.docs.length ? `[agent-cms] ${r.docs.length} covered document(s), all updated in this PR.` : "[agent-cms] no document covers these files.");
      return 0;
    }
    const messages = git(["log", "--format=%B", `${base}..${head}`]) + "\n" + (env.prBody ?? "");
    const lines = missing.map((d) => `  - ${d.collection}/${d.slug} (${d.title})\n      ${d.matched.slice(0, 5).join("\n      ")}`);
    if (messages.includes(token)) {
      log(`[agent-cms] ${token} found: these documents will be flagged for review after deploy instead.\n${lines.join("\n")}`);
      return 0;
    }
    log(
      [
        `[agent-cms] This PR changes code that ${missing.length} document(s) explain:`,
        ...lines,
        "",
        pr
          ? `Update each one with pr=${pr} (MCP update_document, or PATCH /collections/<c>/<slug> with {"doc": {...}, "pr": ${pr}}).`
          : "Update each one with the PR number (pr=<n>).",
        `If no document needs to change, add "${token}" to a commit message or the PR body.`,
      ].join("\n")
    );
    return 1;
  }

  if (cmd === "deploy-sync") {
    const from = arg(argv, "from");
    const to = arg(argv, "to") ?? "HEAD";
    if (!from || /^0+$/.test(from)) {
      log("[agent-cms] deploy-sync: no previous deploy sha, skipping.");
      return 0;
    }
    const files = git(["diff", "--name-only", `${from}..${to}`]).split("\n").map((s) => s.trim()).filter(Boolean);
    const prs = prNumbersFromLog(git(["log", "--format=%s", `${from}..${to}`]));
    const r = (await call(env, "/deploy-sync", { prs, files, sha: to })) as { published: string[]; flagged: string[] };
    log(`[agent-cms] deploy-sync: PRs ${prs.join(", ") || "none"}; published ${r.published.length}, flagged ${r.flagged.length}.`);
    for (const p of r.published) log(`  published ${p}`);
    for (const f of r.flagged) log(`  needs review ${f}`);
    return 0;
  }

  log("usage: agent-cms <check-coverage|deploy-sync> [options]");
  return 2;
}
