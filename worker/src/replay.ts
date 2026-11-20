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
