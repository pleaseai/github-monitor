/**
 * Shared types for the GitHub webhook → WebSocket relay.
 */

import type { RelayServer } from './relay-server.ts'

export interface Env {
  RELAY: DurableObjectNamespace<RelayServer>
  /** GitHub webhook HMAC secret (verifies X-Hub-Signature-256). */
  WEBHOOK_SECRET: string
  /** Master secret for deriving per-channel WebSocket tokens. */
  TOKEN_SECRET: string
  /** Quiet window (ms) before a ci_rollup frame is emitted. Default 30000. */
  ROLLUP_QUIET_MS?: string
  /**
   * Comma-separated case-insensitive regexes overriding the default AI
   * reviewer check-name patterns (see DEFAULT_AI_REVIEWER_PATTERNS).
   */
  AI_REVIEWER_PATTERNS?: string
  /** GitHub API base for /auth token exchange. Default https://api.github.com. */
  GITHUB_API_URL?: string
  /** TTL (seconds) of tokens issued by /auth. Default 86400 (24h). */
  AUTH_TOKEN_TTL_SECONDS?: string
}

/**
 * Compact event summary broadcast to WebSocket clients — one JSON text frame
 * per event. Kept small on purpose: Claude Code's Monitor tool turns each
 * text frame into one notification and kills the watch on frames > 1 MiB.
 */
export interface RelayEvent {
  v: 1
  /** Monotonic per-channel sequence for reconnect replay (?since=<seq>). */
  seq?: number
  /** X-GitHub-Event header (push, pull_request, issues, check_run, …). */
  event: string
  /** Payload action (opened, closed, created, completed, …). */
  action?: string
  /** repository.full_name (owner/repo). */
  repo?: string
  /** sender.login. */
  sender?: string
  /** X-GitHub-Delivery header (GUID). */
  delivery?: string
  /** ISO timestamp assigned by the relay on receipt. */
  ts: string
  /** PR / issue number. */
  number?: number
  /** PR / issue / check title or name. */
  title?: string
  /** Branch or ref (push, create, delete, workflow_run head_branch). */
  ref?: string
  /** Head commit SHA where meaningful. */
  sha?: string
  /** Terminal-ish state: check conclusion, review state, PR merged, … */
  state?: string
  /** Check run / workflow / status context name. */
  name?: string
  /** html_url of the most specific entity. */
  url?: string
  /** Truncated comment / review body. */
  preview?: string
  /**
   * Check counts — present only on derived `ci_rollup` frames, which the
   * relay emits once the raw check_run/status stream for a SHA has been
   * quiet for ROLLUP_QUIET_MS. `state` carries the overall verdict
   * (failure | pending | success).
   */
  ci?: {
    passing: number
    failing: number
    pending: number
    /** Names of failing checks (sorted, capped). */
    failed: string[]
  }
  /**
   * AI code-review bot checks (coderabbit, cubic, gemini-code-assist,
   * copilot reviewer, greptile, …), split out of `ci` on ci_rollup frames.
   * pending = review running, done = comments ready to process, failed =
   * the bot errored (do not auto-retry). Absent when no reviewer checks.
   */
  reviewers?: {
    pending: string[]
    done: string[]
    failed: string[]
  }
  /**
   * Batched replay — present only on `relay`/`replay` frames sent right
   * after a `?since=<seq>` reconnect. All missed events arrive in one
   * WebSocket frame (one Monitor notification, one DO handler invocation)
   * instead of one frame each. Each entry carries its own `seq`.
   */
  events?: RelayEvent[]
}
