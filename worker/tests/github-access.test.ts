import { describe, expect, test } from 'bun:test'
import { checkGitHubAccess, parseChannelTarget } from '../src/github-access.ts'

describe('parseChannelTarget', () => {
  test('owner--repo splits on the first double hyphen', () => {
    expect(parseChannelTarget('acme--widgets')).toEqual({ kind: 'repo', owner: 'acme', repo: 'widgets' })
    // repo names may themselves contain "--"; owner logins cannot
    expect(parseChannelTarget('chatbot-pf--my--repo')).toEqual({ kind: 'repo', owner: 'chatbot-pf', repo: 'my--repo' })
  })

  test('bare names are org channels', () => {
    expect(parseChannelTarget('chatbot-pf')).toEqual({ kind: 'org', org: 'chatbot-pf' })
  })
})

function fakeFetch(routes: Record<string, { status: number, body?: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    for (const [suffix, result] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return new Response(JSON.stringify(result.body ?? {}), { status: result.status })
      }
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

describe('checkGitHubAccess', () => {
  const API = 'https://api.test'

  test('repo channel: 200 → ok, 404 → denied', async () => {
    const ok = await checkGitHubAccess(API, 't', 'acme--widgets', fakeFetch({ '/repos/acme/widgets': { status: 200 } }))
    expect(ok.ok).toBe(true)

    const denied = await checkGitHubAccess(API, 't', 'acme--widgets', fakeFetch({ '/repos/acme/widgets': { status: 404 } }))
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('404')
  })

  test('org channel: active membership required', async () => {
    const active = await checkGitHubAccess(API, 't', 'acme', fakeFetch({
      '/user/memberships/orgs/acme': { status: 200, body: { state: 'active' } },
    }))
    expect(active.ok).toBe(true)

    const pending = await checkGitHubAccess(API, 't', 'acme', fakeFetch({
      '/user/memberships/orgs/acme': { status: 200, body: { state: 'pending' } },
    }))
    expect(pending.ok).toBe(false)

    const nonMember = await checkGitHubAccess(API, 't', 'acme', fakeFetch({
      '/user/memberships/orgs/acme': { status: 404 },
    }))
    expect(nonMember.ok).toBe(false)
  })
})
