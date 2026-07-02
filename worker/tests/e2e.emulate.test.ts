/**
 * End-to-end integration test:
 *
 *   @emulators/github (stateful GitHub API, real webhook HTTP delivery)
 *     → wrangler dev (this relay, real workerd + Durable Object)
 *       → WebSocket consumer (what Claude Code's Monitor ws source sees)
 *
 * The emulator signs deliveries with X-Hub-Signature-256 exactly like
 * GitHub, so this exercises the relay's signature verification, summarize,
 * fan-out, and replay against production-shaped traffic.
 *
 * Docs: https://emulate.dev/docs/github
 */

import type { Subprocess } from 'bun'
import type { Emulator } from 'emulate'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createEmulator } from 'emulate'
import { deriveChannelToken } from '../src/auth.ts'
import { signBody } from '../src/signature.ts'

const RELAY_PORT = 8797
const GH_PORT = 4977
// Same values as .dev.vars so wrangler var precedence never matters.
const WEBHOOK_SECRET = 'dev-webhook-secret'
const TOKEN_SECRET = 'dev-token-secret'
// Unique per run: wrangler dev persists DO state under .wrangler/.
const CHANNEL = `e2e-${Date.now()}`
const OWNER = 'admin'
const REPO = 'widgets'

const GH_HEADERS = { 'Authorization': 'Bearer e2e-test', 'Content-Type': 'application/json' }

let github: Emulator
let wranglerProc: Subprocess
let ws: WebSocket
const frames: string[] = []

async function githubApi(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${github.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: GH_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok).toBe(true)
  return await response.json() as Record<string, unknown>
}

/** POST a signed webhook straight to the relay (bypasses the emulator). */
async function postSignedHook(eventName: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload)
  const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/hook/${CHANNEL}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': eventName,
      'X-Hub-Signature-256': await signBody(WEBHOOK_SECRET, body),
    },
    body,
  })
  expect(response.status).toBe(202)
}

async function waitForFrame(predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of frames) {
      const event = JSON.parse(frame) as Record<string, unknown>
      if (predicate(event)) {
        return event
      }
    }
    await Bun.sleep(100)
  }
  throw new Error(`no matching frame within ${timeoutMs}ms — got: ${frames.join(' | ')}`)
}

beforeAll(async () => {
  // 1. Relay on real workerd via wrangler dev
  wranglerProc = Bun.spawn(
    [
      'bunx',
      'wrangler',
      'dev',
      '--port',
      String(RELAY_PORT),
      '--var',
      `WEBHOOK_SECRET:${WEBHOOK_SECRET}`,
      '--var',
      `TOKEN_SECRET:${TOKEN_SECRET}`,
      '--var',
      'ROLLUP_QUIET_MS:700',
      '--var',
      `GITHUB_API_URL:http://127.0.0.1:${GH_PORT}`,
      '--var',
      'AUTH_TOKEN_TTL_SECONDS:3600',
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'ignore', stderr: 'ignore' },
  )
  const deadline = Date.now() + 30_000
  let healthy = false
  while (!healthy && Date.now() < deadline) {
    try {
      healthy = (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).ok
    }
    catch {
      await Bun.sleep(300)
    }
  }
  if (!healthy) {
    throw new Error('wrangler dev did not become healthy within 30s')
  }

  // 2. GitHub emulator + repo + webhook pointing at the relay
  github = await createEmulator({ service: 'github', port: GH_PORT })
  await githubApi('/user/repos', { name: REPO })
  await githubApi(`/repos/${OWNER}/${REPO}/hooks`, {
    name: 'web',
    active: true,
    events: ['issues', 'issue_comment', 'pull_request', 'push'],
    config: {
      url: `http://127.0.0.1:${RELAY_PORT}/hook/${CHANNEL}`,
      content_type: 'json',
      secret: WEBHOOK_SECRET,
    },
  })

  // 3. WebSocket consumer (Monitor ws source shape: token in query string)
  const token = await deriveChannelToken(TOKEN_SECRET, CHANNEL)
  ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/${CHANNEL}?token=${token}`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('ws connect failed'))
  })
  ws.onmessage = (message) => {
    frames.push(String(message.data))
  }
}, 60_000)

afterAll(async () => {
  ws?.close()
  wranglerProc?.kill()
  await github?.close()
})

describe('e2e: github emulator → relay → websocket', () => {
  test('hello frame announces the resume cursor', async () => {
    const hello = await waitForFrame(e => e.event === 'relay' && e.action === 'connected')
    expect(hello.seq).toBeNumber()
  })

  test('issue opened via GitHub API arrives as a summarized frame', async () => {
    await githubApi(`/repos/${OWNER}/${REPO}/issues`, { title: 'E2E issue', body: 'from emulator' })
    const event = await waitForFrame(e => e.event === 'issues' && e.action === 'opened')
    expect(event.repo).toBe(`${OWNER}/${REPO}`)
    expect(event.number).toBe(1)
    expect(event.title).toBe('E2E issue')
    expect(event.seq).toBeNumber()
    expect(event.delivery).toBeString()
  })

  test('issue comment arrives with a body preview', async () => {
    await githubApi(`/repos/${OWNER}/${REPO}/issues/1/comments`, { body: 'looks good to me' })
    const event = await waitForFrame(e => e.event === 'issue_comment' && e.action === 'created')
    expect(event.number).toBe(1)
    expect(event.preview).toBe('looks good to me')
  })

  test('frames stay compact (Monitor 1 MiB frame limit)', () => {
    for (const frame of frames) {
      expect(frame.length).toBeLessThan(2000)
    }
  })

  test('reconnecting with ?since=0 replays missed events as one batched frame', async () => {
    const token = await deriveChannelToken(TOKEN_SECRET, CHANNEL)
    const replay = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/${CHANNEL}?token=${token}&since=0`)
    const replayFrames: string[] = []
    replay.onmessage = message => replayFrames.push(String(message.data))
    await new Promise<void>((resolve, reject) => {
      replay.onopen = () => resolve()
      replay.onerror = () => reject(new Error('replay ws connect failed'))
    })
    // Expect exactly two frames: the replay batch, then the hello.
    const deadline = Date.now() + 5000
    while (replayFrames.length < 2 && Date.now() < deadline) {
      await Bun.sleep(100)
    }
    replay.close()

    const frames2 = replayFrames.map(frame => JSON.parse(frame) as Record<string, unknown>)
    const batch = frames2.find(e => e.event === 'relay' && e.action === 'replay')
    expect(batch).toBeDefined()
    const missed = batch?.events as Record<string, unknown>[]
    expect(missed.filter(e => e.event === 'issues')).toHaveLength(1)
    expect(missed.filter(e => e.event === 'issue_comment')).toHaveLength(1)
    // Each replayed entry keeps its own seq for cursor tracking.
    expect(missed.every(e => typeof e.seq === 'number')).toBe(true)
  })

  test('granular check_run events debounce into one ci_rollup frame', async () => {
    const sha = 'e2e-rollup-sha'
    const repository = { full_name: `${OWNER}/${REPO}` }
    await postSignedHook('check_run', {
      action: 'completed',
      check_run: { name: 'ci/test', head_sha: sha, status: 'completed', conclusion: 'failure', pull_requests: [{ number: 42 }] },
      repository,
    })
    await postSignedHook('check_run', {
      action: 'completed',
      check_run: { name: 'lint', head_sha: sha, status: 'completed', conclusion: 'success', pull_requests: [{ number: 42 }] },
      repository,
    })
    await postSignedHook('check_run', {
      action: 'created',
      check_run: { name: 'coderabbitai', head_sha: sha, status: 'in_progress', conclusion: null, pull_requests: [{ number: 42 }] },
      repository,
    })

    const rollup = await waitForFrame(e => e.event === 'ci_rollup', 8000)
    expect(rollup.sha).toBe(sha)
    // AI reviewer still analyzing must not affect the CI verdict.
    expect(rollup.state).toBe('failure')
    expect(rollup.number).toBe(42)
    expect(rollup.ci).toEqual({ passing: 1, failing: 1, pending: 0, failed: ['ci/test'] })
    expect(rollup.reviewers).toEqual({ pending: ['coderabbitai'], done: [], failed: [] })

    // Debounce means exactly one rollup for the burst.
    await Bun.sleep(1200)
    const rollups = frames.map(f => JSON.parse(f) as Record<string, unknown>).filter(e => e.event === 'ci_rollup')
    expect(rollups).toHaveLength(1)
  }, 15_000)

  test('?prs= filter scopes a connection to one PR', async () => {
    const token = await deriveChannelToken(TOKEN_SECRET, CHANNEL)
    const scoped = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/${CHANNEL}?token=${token}&prs=42&events=pull_request`)
    const scopedFrames: string[] = []
    scoped.onmessage = message => scopedFrames.push(String(message.data))
    await new Promise<void>((resolve, reject) => {
      scoped.onopen = () => resolve()
      scoped.onerror = () => reject(new Error('scoped ws connect failed'))
    })

    const repository = { full_name: `${OWNER}/${REPO}` }
    await postSignedHook('pull_request', {
      action: 'synchronize',
      number: 42,
      pull_request: { number: 42, title: 'mine', state: 'open', head: { ref: 'feat', sha: 'x' } },
      repository,
    })
    await postSignedHook('pull_request', {
      action: 'synchronize',
      number: 7,
      pull_request: { number: 7, title: 'not mine', state: 'open', head: { ref: 'other', sha: 'y' } },
      repository,
    })
    await Bun.sleep(600)

    const events = scopedFrames.map(f => JSON.parse(f) as Record<string, unknown>)
    const prEvents = events.filter(e => e.event === 'pull_request')
    expect(prEvents).toHaveLength(1)
    expect(prEvents[0]?.number).toBe(42)
    scoped.close()
  }, 10_000)

  test('POST /auth exchanges a GitHub token for a working expiring WS token', async () => {
    // The relay verifies repo access against the (emulated) GitHub API.
    const authRes = await fetch(`http://127.0.0.1:${RELAY_PORT}/auth/${OWNER}--${REPO}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer e2e-test' },
    })
    expect(authRes.status).toBe(200)
    const { token: expiring, expiresAt } = await authRes.json() as { token: string, expiresAt: number }
    expect(expiring).toMatch(/^\d+\.[\w-]+$/)
    expect(expiresAt).toBeGreaterThan(Date.now() / 1000)

    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/${OWNER}--${REPO}?token=${expiring}`)
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onerror = () => resolve(false)
    })
    expect(opened).toBe(true)
    ws.close()
  }, 10_000)

  test('POST /auth denies channels the GitHub token cannot access', async () => {
    const denied = await fetch(`http://127.0.0.1:${RELAY_PORT}/auth/${OWNER}--no-such-repo`, {
      method: 'POST',
      headers: { Authorization: 'Bearer e2e-test' },
    })
    expect(denied.status).toBe(403)

    const missing = await fetch(`http://127.0.0.1:${RELAY_PORT}/auth/${OWNER}--${REPO}`, { method: 'POST' })
    expect(missing.status).toBe(401)
  }, 10_000)
})
