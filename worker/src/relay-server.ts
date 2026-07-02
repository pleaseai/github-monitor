/**
 * Per-channel Durable Object (PartyServer room, hibernation enabled).
 *
 * One instance per channel name. Buffers the last BUFFER_SIZE events in the
 * DO's SQLite storage for reconnect replay (?since=<seq>) and fans each
 * event out as one JSON text frame to every connected WebSocket whose
 * event filter matches.
 */

import type { Connection, ConnectionContext } from 'partyserver'
import type { ConnState } from './filter.ts'
import type { RollupChecks } from './rollup.ts'
import type { Env, RelayEvent } from './types.ts'
import { Server } from 'partyserver'
import { matchesFilter, parseListFilter, parseNumberListFilter } from './filter.ts'
import { buildRollupEvent, compileReviewerPatterns, DEFAULT_ROLLUP_QUIET_MS, isCiSourceEvent } from './rollup.ts'

const BUFFER_SIZE = 200

interface EventRow {
  seq: number
  body: string
}

interface RollupRow {
  sha: string
  repo: string | null
  number: number | null
  checks: string
  /** Next flush time; null = flushed, waiting for more CI events. */
  flush_at: number | null
  updated_at: number
}

const ROLLUP_MAX_AGE_MS = 24 * 60 * 60 * 1000

export class RelayServer extends Server<Env> {
  static options = { hibernate: true }

  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `
    this.sql`
      CREATE TABLE IF NOT EXISTS ci_rollups (
        sha TEXT PRIMARY KEY,
        repo TEXT,
        number INTEGER,
        checks TEXT NOT NULL,
        flush_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `
  }

  /**
   * RPC entry called by the worker for each verified webhook delivery.
   * Assigns a sequence number, persists, trims the buffer, fans out.
   * Granular CI events additionally feed the debounced ci_rollup.
   */
  async publish(eventJson: string): Promise<{ seq: number, delivered: number }> {
    const event = JSON.parse(eventJson) as RelayEvent
    const result = this.#store(event)
    if (isCiSourceEvent(event)) {
      await this.#trackCi(event)
    }
    return result
  }

  #store(event: RelayEvent): { seq: number, delivered: number } {
    const row = this.sql<{ next: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events
    `
    const seq = row[0]?.next ?? 1
    event.seq = seq
    const body = JSON.stringify(event)

    this.sql`INSERT INTO events (seq, ts, body) VALUES (${seq}, ${event.ts}, ${body})`
    this.sql`DELETE FROM events WHERE seq <= ${seq - BUFFER_SIZE}`

    let delivered = 0
    for (const conn of this.getConnections<ConnState>()) {
      if (!matchesFilter(conn.state, event)) {
        continue
      }
      conn.send(body)
      delivered++
    }
    return { seq, delivered }
  }

  /** Merge one granular CI event into its SHA's rollup and (re)arm the alarm. */
  async #trackCi(event: RelayEvent): Promise<void> {
    const sha = event.sha as string
    const existing = this.sql<RollupRow>`SELECT * FROM ci_rollups WHERE sha = ${sha}`[0]
    const checks: RollupChecks = existing ? JSON.parse(existing.checks) as RollupChecks : {}
    checks[event.name ?? 'unknown'] = event.state ?? ''

    const now = Date.now()
    const flushAt = now + this.#rollupQuietMs()
    this.sql`
      INSERT INTO ci_rollups (sha, repo, number, checks, flush_at, updated_at)
      VALUES (${sha}, ${event.repo ?? existing?.repo ?? null}, ${event.number ?? existing?.number ?? null}, ${JSON.stringify(checks)}, ${flushAt}, ${now})
      ON CONFLICT (sha) DO UPDATE SET
        repo = excluded.repo,
        number = excluded.number,
        checks = excluded.checks,
        flush_at = excluded.flush_at,
        updated_at = excluded.updated_at
    `
    this.sql`DELETE FROM ci_rollups WHERE updated_at < ${now - ROLLUP_MAX_AGE_MS}`
    await this.#armAlarm()
  }

  /**
   * Flush every rollup whose quiet window has elapsed, then re-arm.
   * Flushed rows keep their accumulated checks (flush_at → null) so a
   * late-finishing check triggers a follow-up rollup with the full picture.
   */
  async onAlarm(): Promise<void> {
    const due = this.sql<RollupRow>`
      SELECT * FROM ci_rollups WHERE flush_at IS NOT NULL AND flush_at <= ${Date.now()} ORDER BY flush_at ASC
    `
    const reviewerPatterns = compileReviewerPatterns(this.env.AI_REVIEWER_PATTERNS)
    for (const row of due) {
      const rollup = buildRollupEvent(
        {
          sha: row.sha,
          ...(row.repo === null ? {} : { repo: row.repo }),
          ...(row.number === null ? {} : { number: row.number }),
          checks: JSON.parse(row.checks) as RollupChecks,
        },
        new Date(),
        reviewerPatterns,
      )
      this.#store(rollup)
      this.sql`UPDATE ci_rollups SET flush_at = NULL WHERE sha = ${row.sha}`
    }
    await this.#armAlarm()
  }

  #rollupQuietMs(): number {
    const parsed = Number(this.env.ROLLUP_QUIET_MS ?? '')
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROLLUP_QUIET_MS
  }

  async #armAlarm(): Promise<void> {
    const next = this.sql<{ next: number | null }>`
      SELECT MIN(flush_at) AS next FROM ci_rollups WHERE flush_at IS NOT NULL
    `[0]?.next
    if (next !== null && next !== undefined) {
      await this.ctx.storage.setAlarm(next)
    }
  }

  onConnect(connection: Connection<ConnState>, ctx: ConnectionContext): void {
    const url = new URL(ctx.request.url)
    const state: ConnState = {}
    const events = parseListFilter(url.searchParams.get('events'))
    if (events.length > 0) {
      state.events = events
    }
    // ?repos= filters by repo full name — the useful shape on org-webhook
    // channels where one channel carries every repository in the org.
    const repos = parseListFilter(url.searchParams.get('repos'))
    if (repos.length > 0) {
      state.repos = repos
    }
    // ?prs= scopes a connection to specific PR/issue numbers — the shape a
    // babysit-pr session uses (`?prs=42&events=ci_rollup,pull_request,…`).
    const prs = parseNumberListFilter(url.searchParams.get('prs'))
    if (prs.length > 0) {
      state.prs = prs
    }
    connection.setState(state)

    const lastSeq = this.#lastSeq()
    const sinceParam = url.searchParams.get('since')

    if (sinceParam !== null && /^\d+$/.test(sinceParam)) {
      const since = Number(sinceParam)
      const rows = this.sql<EventRow>`
        SELECT seq, body FROM events WHERE seq > ${since} ORDER BY seq ASC
      `
      // Batched into one frame (one Monitor notification, one handler
      // invocation) per the DO WebSocket best practices. Well under the
      // 1 MiB frame limit: ≤200 buffered events × ~500 B.
      const missed = rows
        .map(row => parseStoredEvent(row.body))
        .filter(event => matchesFilter(connection.state, event))
      if (missed.length > 0) {
        const batch: RelayEvent = {
          v: 1,
          event: 'relay',
          action: 'replay',
          ts: new Date().toISOString(),
          preview: `${missed.length} event(s) since seq ${since}`,
          events: missed,
        }
        connection.send(JSON.stringify(batch))
      }
    }

    // Hello frame: tells the client the current cursor so it can resume
    // with ?since=<seq> after a disconnect even if no events arrive.
    const hello: RelayEvent = {
      v: 1,
      event: 'relay',
      action: 'connected',
      seq: lastSeq,
      ts: new Date().toISOString(),
      preview: `channel ${this.name} connected (resume with ?since=${lastSeq})`,
    }
    connection.send(JSON.stringify(hello))
  }

  onMessage(): void {
    // Clients are listen-only; ignore anything they send.
  }

  onRequest(): Response {
    return Response.json({ error: 'expected WebSocket upgrade or worker RPC' }, { status: 400 })
  }

  #lastSeq(): number {
    const row = this.sql<{ last: number }>`SELECT COALESCE(MAX(seq), 0) AS last FROM events`
    return row[0]?.last ?? 0
  }
}

function parseStoredEvent(body: string): RelayEvent {
  try {
    return JSON.parse(body) as RelayEvent
  }
  catch {
    return { v: 1, event: '', ts: '' }
  }
}
