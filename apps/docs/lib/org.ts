/** The GitHub organisation whose members may edit the docs. */
export const DOCS_ORG = process.env.DOCS_GITHUB_ORG || "mainsoft-2024";

/** Re-check membership this often (ms). */
export const RECHECK_MS = 60 * 60 * 1000;

/**
 * Whether the GitHub user behind `accessToken` is an active member of `org`.
 * Needs the `read:org` scope. Any error counts as "not a member".
 */
export async function isOrgMember(accessToken: string, org = DOCS_ORG, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { state?: string };
    return body.state === "active";
  } catch {
    return false;
  }
}
