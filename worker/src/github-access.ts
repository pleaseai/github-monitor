/**
 * GitHub-token → channel authorization for POST /auth/<channel>.
 *
 * The caller proves it may consume a channel by presenting a GitHub token
 * that can read the corresponding repo (or is an active member of the
 * corresponding org). The relay verifies against the GitHub API and then
 * discards the token — nothing is stored.
 *
 * Channel naming contract:
 *   "<owner>--<repo>"  → repo channel.  GitHub owner logins cannot contain
 *                        consecutive hyphens, so splitting on the FIRST
 *                        "--" is unambiguous (repo names may contain "--").
 *   "<org>"            → org channel (org webhook): requires active org
 *                        membership.
 */

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com'

export type ChannelTarget
  = | { kind: 'repo', owner: string, repo: string }
    | { kind: 'org', org: string }

export function parseChannelTarget(channel: string): ChannelTarget {
  const separator = channel.indexOf('--')
  if (separator > 0 && separator < channel.length - 2) {
    return { kind: 'repo', owner: channel.slice(0, separator), repo: channel.slice(separator + 2) }
  }
  return { kind: 'org', org: channel }
}

export interface AccessCheckResult {
  ok: boolean
  reason: string
}

/**
 * Verify the GitHub token can access the channel's target.
 * `fetchImpl` is injectable for tests.
 */
export async function checkGitHubAccess(
  apiBaseUrl: string,
  githubToken: string,
  channel: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessCheckResult> {
  const base = apiBaseUrl.replace(/\/$/, '')
  const headers = {
    'Authorization': `Bearer ${githubToken}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'github-relay-auth',
  }
  const target = parseChannelTarget(channel)

  if (target.kind === 'repo') {
    const response = await fetchImpl(
      `${base}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`,
      { headers },
    )
    if (response.status === 200) {
      return { ok: true, reason: `token can read ${target.owner}/${target.repo}` }
    }
    return { ok: false, reason: `GitHub returned ${response.status} for ${target.owner}/${target.repo}` }
  }

  const response = await fetchImpl(
    `${base}/user/memberships/orgs/${encodeURIComponent(target.org)}`,
    { headers },
  )
  if (response.status === 200) {
    const membership = await response.json() as { state?: string }
    if (membership.state === 'active') {
      return { ok: true, reason: `active member of ${target.org}` }
    }
    return { ok: false, reason: `org membership state is ${membership.state ?? 'unknown'}` }
  }
  return { ok: false, reason: `GitHub returned ${response.status} for org ${target.org} membership` }
}
