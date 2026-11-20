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
  const event = (seq: number): RelayEvent => ({ v: 1, event: 'issues', ts, seq })

  test('carries the gap with an empty events array when the filter excluded every buffered event', () => {
    const frame = replayFrame(0, [], 3, ts)
    expect(frame?.gap).toEqual({ from: 1, to: 2 })
    expect(frame?.events).toEqual([])
  })

  test('carries both the gap and the matching events', () => {
    const frame = replayFrame(0, [event(3), event(4)], 3, ts)
    expect(frame?.gap).toEqual({ from: 1, to: 2 })
    expect(frame?.events?.map(e => e.seq)).toEqual([3, 4])
  })

  test('omits the gap field when nothing was trimmed', () => {
    const frame = replayFrame(2, [event(3)], 3, ts)
    expect(frame).toBeDefined()
    expect(frame && 'gap' in frame).toBe(false)
  })

  test('sends nothing when no event matches and nothing was trimmed', () => {
    expect(replayFrame(2, [], 3, ts)).toBeUndefined()
  })
})
