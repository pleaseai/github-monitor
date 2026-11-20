/**
 * Replay gap detection for `?since=<seq>` reconnects.
 */

/** Inclusive seq range a reconnecting client asked for but the buffer no longer holds. */
export interface ReplayGap {
  from: number
  to: number
}

/**
 * The buffer only ever drops its oldest rows, so the seqs it holds are
 * `minSeq..lastSeq` with no holes. A client resuming from `since` is owed
 * `since + 1` onward; anything below `minSeq` in that range was trimmed.
 *
 * The comparison is strict: `minSeq === since + 1` means the replay starts
 * exactly where the client left off, and reporting a gap there would tell
 * the session it lost events it is about to receive.
 */
export function trimGap(since: number, minSeq: number | null): ReplayGap | undefined {
  if (minSeq === null || minSeq <= since + 1) {
    return undefined
  }
  return { from: since + 1, to: minSeq - 1 }
}
