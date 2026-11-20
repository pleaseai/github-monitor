import { describe, expect, test } from 'bun:test'
import type { RelayEvent } from '../src/types.ts'
import { replayFrame, trimGap } from '../src/replay.ts'

describe('trimGap', () => {
  test('reports the trimmed range when the buffer starts after since + 1', () => {
    expect(trimGap(0, 3)).toEqual({ from: 1, to: 2 })
    expect(trimGap(10, 212)).toEqual({ from: 11, to: 211 })
  })

  test('no gap when the buffer starts exactly at since + 1', () => {
    expect(trimGap(2, 3)).toBeUndefined()
  })

  test('no gap when the buffer still holds seqs at or below since', () => {
    expect(trimGap(5, 1)).toBeUndefined()
    expect(trimGap(5, 5)).toBeUndefined()
  })

  test('no gap when the buffer is empty', () => {
    expect(trimGap(0, null)).toBeUndefined()
    expect(trimGap(7, null)).toBeUndefined()
  })
})

describe('replayFrame', () => {
  const ts = '2026-11-20T00:00:00.000Z'
  const epoch = 'epoch-b'
  const event = (seq: number): RelayEvent => ({ v: 1, event: 'issues', ts, seq })

  test('carries the gap with an empty events array when the filter excluded every buffered event', () => {
    const frame = replayFrame({ since: 0, missed: [], minSeq: 3, ts, epoch })
    expect(frame?.gap).toEqual({ from: 1, to: 2 })
    expect(frame?.events).toEqual([])
  })

  test('carries both the gap and the matching events', () => {
    const frame = replayFrame({ since: 0, missed: [event(3), event(4)], minSeq: 3, ts, epoch })
    expect(frame?.gap).toEqual({ from: 1, to: 2 })
    expect(frame?.events?.map(e => e.seq)).toEqual([3, 4])
  })

  test('omits the gap field when nothing was trimmed', () => {
    const frame = replayFrame({ since: 2, missed: [event(3)], minSeq: 3, ts, epoch })
    expect(frame).toBeDefined()
    expect(frame && 'gap' in frame).toBe(false)
  })

  test('sends nothing when no event matches and nothing was trimmed', () => {
    expect(replayFrame({ since: 2, missed: [], minSeq: 3, ts, epoch })).toBeUndefined()
  })

  test('a storage reset with no events still sends a frame carrying reset and epoch', () => {
    const reset = { epoch: 'epoch-a', since: 40 }
    const frame = replayFrame({ since: 0, missed: [], minSeq: null, ts, epoch, reset })
    expect(frame?.reset).toEqual(reset)
    expect(frame?.epoch).toBe(epoch)
    expect(frame?.events).toEqual([])
    expect(frame?.preview).toContain('reset')
  })

  test('a storage reset over a trimmed buffer carries both reset and gap', () => {
    const reset = { epoch: 'epoch-a', since: 40 }
    const frame = replayFrame({ since: 0, missed: [event(5)], minSeq: 5, ts, epoch, reset })
    expect(frame?.reset).toEqual(reset)
    expect(frame?.gap).toEqual({ from: 1, to: 4 })
    expect(frame?.events?.map(e => e.seq)).toEqual([5])
  })

  test('a reset for a client that sent no epoch omits the old epoch', () => {
    const frame = replayFrame({ since: 0, missed: [], minSeq: null, ts, epoch, reset: { since: 40 } })
    expect(frame?.reset).toEqual({ since: 40 })
    expect(frame?.preview).not.toContain('in epoch')
  })

  test('omits the reset field when the epoch matched', () => {
    const frame = replayFrame({ since: 2, missed: [event(3)], minSeq: 3, ts, epoch })
    expect(frame).toBeDefined()
    expect(frame && 'reset' in frame).toBe(false)
  })

  test('always carries the current epoch', () => {
    expect(replayFrame({ since: 2, missed: [event(3)], minSeq: 3, ts, epoch })?.epoch).toBe(epoch)
    expect(replayFrame({ since: 0, missed: [], minSeq: 3, ts, epoch })?.epoch).toBe(epoch)
  })
})
