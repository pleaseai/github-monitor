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

export interface ReplayReset {
  epoch?: string
  since: number
}

export interface ReplayFrameInput {
  since: number
  missed: RelayEvent[]
  minSeq: number | null
  ts: string
  epoch: string
  reset?: ReplayReset
}

export function replayFrame({ since, missed, minSeq, ts, epoch, reset }: ReplayFrameInput): RelayEvent | undefined {
  const gap = trimGap(since, minSeq)
  if (missed.length === 0 && !gap && !reset) {
    return undefined
  }
  const parts = [`${missed.length} event(s) since seq ${since}`]
  if (reset) {
    const from = reset.epoch === undefined ? '' : ` in epoch ${reset.epoch}`
    parts.unshift(`relay storage reset; events after seq ${reset.since}${from} may be lost`)
  }
  if (gap) {
    parts.push(`seq ${gap.from}-${gap.to} trimmed from the buffer`)
  }
  return {
    v: 1,
    event: 'relay',
    action: 'replay',
    ts,
    preview: parts.join('; '),
    events: missed,
    ...(gap ? { gap } : {}),
    ...(reset ? { reset } : {}),
    epoch,
  }
}
