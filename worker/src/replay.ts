import type { RelayEvent } from './types.ts'

export interface ReplayGap {
  from: number
  to: number
}

export function trimGap(since: number, minSeq: number | null): ReplayGap | undefined {
  const nextExpected = since + 1
  if (minSeq === null || minSeq <= nextExpected) {
    return undefined
  }
  return { from: nextExpected, to: minSeq - 1 }
}

export function replayFrame(
  since: number,
  missed: RelayEvent[],
  minSeq: number | null,
  ts: string,
): RelayEvent | undefined {
  const gap = trimGap(since, minSeq)
  if (missed.length === 0 && !gap) {
    return undefined
  }
  return {
    v: 1,
    event: 'relay',
    action: 'replay',
    ts,
    preview: gap
      ? `${missed.length} event(s) since seq ${since}; seq ${gap.from}-${gap.to} trimmed from the buffer`
      : `${missed.length} event(s) since seq ${since}`,
    events: missed,
    ...(gap ? { gap } : {}),
  }
}
