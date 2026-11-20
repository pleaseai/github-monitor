import { describe, expect, test } from 'bun:test'
import { trimGap } from '../src/replay.ts'

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
