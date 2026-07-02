/**
 * CI rollup — debounced aggregation of granular CI events into one derived
 * `ci_rollup` frame per head SHA.
 *
 * Raw check_run / status deliveries arrive one per check (a 10-check CI run
 * means 10 webhook deliveries → 10 Monitor notifications). The relay
 * accumulates them per SHA and, once the stream has been quiet for
 * ROLLUP_QUIET_MS, emits a single summary frame. Consumers subscribe to
 * `events=ci_rollup` and skip the raw CI events entirely.
 *
 * Pure helpers — no Workers imports, unit-testable under bun. The Durable
 * Object owns storage and alarm scheduling (see relay-server.ts).
 */

import type { RelayEvent } from './types.ts'

export const DEFAULT_ROLLUP_QUIET_MS = 30_000

/** Raw events that feed the rollup (granular, one delivery per check). */
const CI_SOURCE_EVENTS = new Set(['check_run', 'status'])

/** Cap the failed-check name list so rollup frames stay small. */
const MAX_FAILED_NAMES = 20

export type CheckState = 'failing' | 'pending' | 'passing'

/** Latest raw state per check name for one SHA. */
export type RollupChecks = Record<string, string>

export interface RollupInput {
  sha: string
  repo?: string
  number?: number
  checks: RollupChecks
}

const FAILING_STATES = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'error',
])

const PASSING_STATES = new Set(['success', 'neutral', 'skipped'])

/**
 * AI code-review bots report progress as status checks too. They are split
 * out of the `ci` counts into `reviewers`, because they mean something
 * different to a consumer: pending = review still running (comments not
 * ready yet), done = review comments are ready to process, failed = the
 * bot itself errored (never auto-retry/patch — see classify-ci.ts in
 * packages/watchers for the same policy).
 *
 * Kept in sync with AI_REVIEWER_PATTERNS in packages/watchers
 * (conservative, word-anchored regexes) plus greptile. Override with the
 * AI_REVIEWER_PATTERNS env var (comma-separated regexes, case-insensitive).
 */
export const DEFAULT_AI_REVIEWER_PATTERNS: readonly string[] = [
  String.raw`\b(cubic|cubic[-_]dev[-_]ai)\b`,
  String.raw`\b(gemini[-_]code[-_]assist|gemini[-_]review(er)?)\b`,
  String.raw`\b(coderabbit(ai)?)\b`,
  String.raw`\b(copilot[-_](pull[-_]request[-_]reviewer|review(er)?)|github[-_]copilot[-_]review(er)?)\b`,
  String.raw`\bgreptile\b`,
]

/** Compile the env override (comma-separated regexes) or the defaults. Invalid entries are skipped. */
export function compileReviewerPatterns(raw?: string): RegExp[] {
  const sources = raw
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_AI_REVIEWER_PATTERNS
  const compiled: RegExp[] = []
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, 'i'))
    }
    catch {
      // skip invalid pattern
    }
  }
  return compiled
}

export function isAiReviewerCheck(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(name))
}

export function isCiSourceEvent(event: RelayEvent): boolean {
  return CI_SOURCE_EVENTS.has(event.event) && typeof event.sha === 'string' && event.sha.length > 0
}

/** Unknown states count as pending — never report a false green. */
export function classifyCheckState(state: string | undefined): CheckState {
  const normalized = (state ?? '').toLowerCase()
  if (FAILING_STATES.has(normalized)) {
    return 'failing'
  }
  if (PASSING_STATES.has(normalized)) {
    return 'passing'
  }
  return 'pending'
}

export function buildRollupEvent(
  input: RollupInput,
  now: Date,
  reviewerPatterns: readonly RegExp[] = compileReviewerPatterns(),
): RelayEvent {
  let passing = 0
  let pending = 0
  const failed: string[] = []
  const reviewers = { pending: [] as string[], done: [] as string[], failed: [] as string[] }

  for (const [name, state] of Object.entries(input.checks)) {
    const classified = classifyCheckState(state)
    if (isAiReviewerCheck(name, reviewerPatterns)) {
      const bucket = classified === 'failing' ? 'failed' : classified === 'pending' ? 'pending' : 'done'
      reviewers[bucket].push(name)
      continue
    }
    if (classified === 'failing') {
      failed.push(name)
    }
    else if (classified === 'pending') {
      pending++
    }
    else {
      passing++
    }
  }
  failed.sort()
  reviewers.pending.sort()
  reviewers.done.sort()
  reviewers.failed.sort()

  // `state` reflects real CI only — an AI reviewer still analyzing must not
  // read as "CI pending", and a bot's policy failure is not a broken build.
  const out: RelayEvent = {
    v: 1,
    event: 'ci_rollup',
    ts: now.toISOString(),
    sha: input.sha,
    state: failed.length > 0 ? 'failure' : pending > 0 ? 'pending' : 'success',
    ci: {
      passing,
      failing: failed.length,
      pending,
      failed: failed.slice(0, MAX_FAILED_NAMES),
    },
  }
  if (reviewers.pending.length > 0 || reviewers.done.length > 0 || reviewers.failed.length > 0) {
    out.reviewers = reviewers
  }
  if (input.repo !== undefined) {
    out.repo = input.repo
  }
  if (input.number !== undefined) {
    out.number = input.number
  }
  return out
}
