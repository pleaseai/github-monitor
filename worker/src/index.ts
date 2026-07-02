/**
 * Worker entry — routes:
 *
 *   POST /hook/<channel>   GitHub webhook receiver. Verifies
 *                          X-Hub-Signature-256, summarizes the payload,
 *                          publishes to the channel's Durable Object.
 *   GET  /ws/<channel>     WebSocket upgrade for consumers (Claude Code
 *                          Monitor ws source). Auth via ?token=<token> or
 *                          subprotocols ["github-relay.v1", "<token>"].
 *   POST /auth/<channel>   Token exchange: a GitHub token in the
 *                          Authorization header that can access the
 *                          channel's repo/org yields a short-lived WS token.
 *   GET  /health           Liveness probe.
 *
 * Channel names are free-form slugs (e.g. "amondnet--my-repo"); tokens are
 * derived per channel from TOKEN_SECRET, see src/auth.ts.
 */

import type { Env } from './types.ts'
import { getServerByName } from 'partyserver'
import { deriveExpiringToken, extractPresentedAuth, isAuthorized, RELAY_SUBPROTOCOL } from './auth.ts'
import { checkGitHubAccess, DEFAULT_GITHUB_API_URL } from './github-access.ts'
import { verifyGitHubSignature } from './signature.ts'
import { summarizeGitHubEvent } from './summarize.ts'

export { RelayServer } from './relay-server.ts'

const CHANNEL_PATTERN = /^[\w.-]{1,64}$/
const DEFAULT_AUTH_TOKEN_TTL_SECONDS = 24 * 60 * 60

function parseRoute(pathname: string): { kind: 'hook' | 'ws' | 'auth', channel: string } | null {
  const match = pathname.match(/^\/(hook|ws|auth)\/([^/]+)$/)
  if (!match) {
    return null
  }
  const channel = decodeURIComponent(match[2] ?? '')
  if (!CHANNEL_PATTERN.test(channel)) {
    return null
  }
  return { kind: match[1] as 'hook' | 'ws' | 'auth', channel }
}

async function handleWebhook(request: Request, env: Env, channel: string): Promise<Response> {
  const eventName = request.headers.get('X-GitHub-Event')
  if (!eventName) {
    return Response.json({ error: 'missing X-GitHub-Event header' }, { status: 400 })
  }

  const body = await request.text()
  const signature = request.headers.get('X-Hub-Signature-256')
  if (!(await verifyGitHubSignature(env.WEBHOOK_SECRET, body, signature))) {
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(body) as Record<string, unknown>
  }
  catch {
    return Response.json({ error: 'invalid JSON payload' }, { status: 400 })
  }

  const event = summarizeGitHubEvent(eventName, payload, request.headers.get('X-GitHub-Delivery'))
  const stub = await getServerByName(env.RELAY, channel)
  const result = await stub.publish(JSON.stringify(event))
  return Response.json({ ok: true, ...result }, { status: 202 })
}

/**
 * Exchange a GitHub token for a short-lived channel token. The GitHub token
 * is verified against the GitHub API (repo read access, or active org
 * membership for org channels) and then discarded — never stored or logged.
 */
async function handleAuth(request: Request, env: Env, channel: string): Promise<Response> {
  const authorization = request.headers.get('Authorization') ?? ''
  const githubToken = authorization.replace(/^(?:Bearer|token)\s+/i, '').trim()
  if (!githubToken || githubToken === authorization) {
    return Response.json({ error: 'expected Authorization: Bearer <github token>' }, { status: 401 })
  }

  const access = await checkGitHubAccess(
    env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL,
    githubToken,
    channel,
  )
  if (!access.ok) {
    return Response.json({ error: `github access check failed: ${access.reason}` }, { status: 403 })
  }

  const ttl = Number(env.AUTH_TOKEN_TTL_SECONDS ?? '') || DEFAULT_AUTH_TOKEN_TTL_SECONDS
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const token = await deriveExpiringToken(env.TOKEN_SECRET, channel, expiresAt)
  return Response.json({ token, expiresAt, channel })
}

async function handleWebSocket(request: Request, env: Env, channel: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'expected WebSocket upgrade' }, { status: 426 })
  }

  const url = new URL(request.url)
  const presented = extractPresentedAuth(url, request.headers.get('Sec-WebSocket-Protocol'))
  if (!(await isAuthorized(env.TOKEN_SECRET, channel, presented.token))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const stub = await getServerByName(env.RELAY, channel)
  const response = await stub.fetch(request)

  // RFC 6455: a client that offered subprotocols rejects a 101 that selects
  // none. PartyServer doesn't echo, so wrap the response and select ours.
  if (response.status === 101 && response.webSocket && request.headers.get('Sec-WebSocket-Protocol')) {
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL },
    })
  }
  return response
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }

    const route = parseRoute(url.pathname)
    if (!route) {
      return Response.json({ error: 'not found' }, { status: 404 })
    }

    if (route.kind === 'hook' || route.kind === 'auth') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'method not allowed' }, { status: 405 })
      }
      return route.kind === 'hook'
        ? handleWebhook(request, env, route.channel)
        : handleAuth(request, env, route.channel)
    }

    return handleWebSocket(request, env, route.channel)
  },
} satisfies ExportedHandler<Env>
