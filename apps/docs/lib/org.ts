/** People with write (push) access to this GitHub repository may edit the docs. */
export const DOCS_REPO = process.env.DOCS_GITHUB_REPO || "mainsoft-2024/agent-cms";

/** Re-check access this often (ms). */
export const RECHECK_MS = 60 * 60 * 1000;

/**
 * Whether the GitHub user behind `accessToken` can push to `repo` (owner,
 * maintainer or collaborator with write). Works for repositories owned by a
 * user or an organisation and needs no extra OAuth scope for a public
 * repository. Any error counts as "no access".
 */
export async function canEditDocs(accessToken: string, repo = DOCS_REPO, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f(`https://api.github.com/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } };
    const p = body.permissions;
    return !!(p && (p.push || p.maintain || p.admin));
  } catch {
    return false;
  }
}
