/**
 * Per-connection event filtering — pure helpers kept free of Workers
 * imports so they stay unit-testable under bun.
 */

export interface ConnState {
  /** Lowercase event names to deliver; empty/undefined = all events. */
  events?: readonly string[]
  /**
   * Lowercase repo full names (owner/repo) to deliver; empty/undefined =
   * all repos. Useful on org-webhook channels where one channel carries
   * every repository in the organization.
   */
  repos?: readonly string[]
  /**
   * PR / issue numbers to deliver; empty/undefined = all. Events that
   * carry no number (push, create, …) are suppressed when this is set —
   * combine with `events` to pick exactly what a PR-scoped session needs.
   */
  prs?: readonly number[]
}

/** Fields of a RelayEvent that filtering inspects. */
export interface FilterableEvent {
  event: string
  repo?: string
  number?: number
}

export function parseListFilter(raw: string | null): string[] {
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
}

export function parseNumberListFilter(raw: string | null): number[] {
  return parseListFilter(raw)
    .map(entry => Number(entry))
    .filter(n => Number.isInteger(n) && n > 0)
}

export function matchesFilter(state: Readonly<ConnState> | null | undefined, event: FilterableEvent): boolean {
  // The relay's own meta events always pass so clients see connect/replay markers.
  if (event.event === 'relay') {
    return true
  }

  const events = state?.events
  if (events && events.length > 0 && !events.includes(event.event.toLowerCase())) {
    return false
  }

  const repos = state?.repos
  if (repos && repos.length > 0) {
    if (!event.repo || !repos.includes(event.repo.toLowerCase())) {
      return false
    }
  }

  const prs = state?.prs
  if (prs && prs.length > 0) {
    if (event.number === undefined || !prs.includes(event.number)) {
      return false
    }
  }

  return true
}
