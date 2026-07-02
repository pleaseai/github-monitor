import { describe, expect, test } from 'bun:test'
import { matchesFilter, parseListFilter, parseNumberListFilter } from '../src/filter.ts'

describe('parseListFilter', () => {
  test('splits, trims, lowercases, and drops empties', () => {
    expect(parseListFilter('pull_request, Check_Run,,  issues ')).toEqual([
      'pull_request',
      'check_run',
      'issues',
    ])
  })

  test('null or empty input means no filter', () => {
    expect(parseListFilter(null)).toEqual([])
    expect(parseListFilter('')).toEqual([])
  })
})

describe('matchesFilter', () => {
  test('no filter delivers everything', () => {
    expect(matchesFilter(null, { event: 'push' })).toBe(true)
    expect(matchesFilter({}, { event: 'push' })).toBe(true)
    expect(matchesFilter({ events: [] }, { event: 'push' })).toBe(true)
  })

  test('events filter restricts to listed events, case-insensitively', () => {
    const state = { events: ['pull_request', 'check_run'] }
    expect(matchesFilter(state, { event: 'pull_request' })).toBe(true)
    expect(matchesFilter(state, { event: 'Check_Run' })).toBe(true)
    expect(matchesFilter(state, { event: 'push' })).toBe(false)
  })

  test('repos filter restricts to listed repos (org-webhook channels)', () => {
    const state = { repos: ['acme/widgets'] }
    expect(matchesFilter(state, { event: 'push', repo: 'acme/widgets' })).toBe(true)
    expect(matchesFilter(state, { event: 'push', repo: 'Acme/Widgets' })).toBe(true)
    expect(matchesFilter(state, { event: 'push', repo: 'acme/other' })).toBe(false)
    // Events without a repo do not match a repo-filtered connection.
    expect(matchesFilter(state, { event: 'push' })).toBe(false)
  })

  test('events and repos filters combine with AND', () => {
    const state = { events: ['pull_request'], repos: ['acme/widgets'] }
    expect(matchesFilter(state, { event: 'pull_request', repo: 'acme/widgets' })).toBe(true)
    expect(matchesFilter(state, { event: 'push', repo: 'acme/widgets' })).toBe(false)
    expect(matchesFilter(state, { event: 'pull_request', repo: 'acme/other' })).toBe(false)
  })

  test('prs filter scopes to PR/issue numbers', () => {
    const state = { prs: [42] }
    expect(matchesFilter(state, { event: 'pull_request', number: 42 })).toBe(true)
    expect(matchesFilter(state, { event: 'pull_request', number: 7 })).toBe(false)
    // Events without a number are suppressed when prs is set.
    expect(matchesFilter(state, { event: 'push' })).toBe(false)
  })

  test('relay meta events always pass', () => {
    expect(matchesFilter({ events: ['push'], repos: ['acme/widgets'], prs: [42] }, { event: 'relay' })).toBe(true)
  })
})

describe('parseNumberListFilter', () => {
  test('parses positive integers and drops junk', () => {
    expect(parseNumberListFilter('42, 7 ,abc,-1,0,3.5')).toEqual([42, 7])
    expect(parseNumberListFilter(null)).toEqual([])
  })
})
