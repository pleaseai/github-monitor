import { describe, expect, test } from 'bun:test'
import { buildRollupEvent, classifyCheckState, compileReviewerPatterns, isAiReviewerCheck, isCiSourceEvent } from '../src/rollup.ts'

const NOW = new Date('2026-07-02T12:00:00.000Z')

describe('isCiSourceEvent', () => {
  test('check_run and status with a sha feed the rollup', () => {
    expect(isCiSourceEvent({ v: 1, event: 'check_run', sha: 'abc', ts: '' })).toBe(true)
    expect(isCiSourceEvent({ v: 1, event: 'status', sha: 'abc', ts: '' })).toBe(true)
  })

  test('other events or missing sha do not', () => {
    expect(isCiSourceEvent({ v: 1, event: 'workflow_run', sha: 'abc', ts: '' })).toBe(false)
    expect(isCiSourceEvent({ v: 1, event: 'check_run', ts: '' })).toBe(false)
    expect(isCiSourceEvent({ v: 1, event: 'ci_rollup', sha: 'abc', ts: '' })).toBe(false)
  })
})

describe('classifyCheckState', () => {
  test('failing states', () => {
    for (const s of ['failure', 'cancelled', 'timed_out', 'action_required', 'error']) {
      expect(classifyCheckState(s)).toBe('failing')
    }
  })

  test('passing states', () => {
    for (const s of ['success', 'neutral', 'skipped']) {
      expect(classifyCheckState(s)).toBe('passing')
    }
  })

  test('pending and unknown states never report green', () => {
    for (const s of ['queued', 'in_progress', 'pending', 'stale', 'whatever', '', undefined]) {
      expect(classifyCheckState(s)).toBe('pending')
    }
  })
})

describe('isAiReviewerCheck', () => {
  const patterns = compileReviewerPatterns()

  test('matches known reviewer check names', () => {
    for (const name of [
      'coderabbitai',
      'CodeRabbit',
      'cubic-dev-ai',
      'gemini-code-assist',
      'Copilot-Pull-Request-Reviewer',
      'greptile / summary',
    ]) {
      expect(isAiReviewerCheck(name, patterns)).toBe(true)
    }
  })

  test('does not match ordinary CI names (word-anchored)', () => {
    for (const name of ['ci/test', 'gemini-vision-tests', 'lint', 'build (copilot-widgets)']) {
      expect(isAiReviewerCheck(name, patterns)).toBe(false)
    }
  })

  test('env override replaces defaults and skips invalid regexes', () => {
    const custom = compileReviewerPatterns(String.raw`\bmy-bot\b, [invalid`)
    expect(isAiReviewerCheck('my-bot', custom)).toBe(true)
    expect(isAiReviewerCheck('coderabbitai', custom)).toBe(false)
  })
})

describe('buildRollupEvent', () => {
  test('summarizes counts, verdict, and failed names', () => {
    const event = buildRollupEvent(
      {
        sha: 'abc123',
        repo: 'acme/widgets',
        number: 42,
        checks: {
          'ci/test': 'failure',
          'lint': 'success',
          'build': 'in_progress',
          'deploy': 'cancelled',
        },
      },
      NOW,
    )
    expect(event).toEqual({
      v: 1,
      event: 'ci_rollup',
      ts: '2026-07-02T12:00:00.000Z',
      sha: 'abc123',
      repo: 'acme/widgets',
      number: 42,
      state: 'failure',
      ci: { passing: 1, failing: 2, pending: 1, failed: ['ci/test', 'deploy'] },
    })
  })

  test('all green → success, any pending → pending', () => {
    const green = buildRollupEvent({ sha: 'a', checks: { x: 'success', y: 'skipped' } }, NOW)
    expect(green.state).toBe('success')
    expect(green.ci).toEqual({ passing: 2, failing: 0, pending: 0, failed: [] })

    const waiting = buildRollupEvent({ sha: 'a', checks: { x: 'success', y: 'queued' } }, NOW)
    expect(waiting.state).toBe('pending')
  })

  test('splits AI reviewer checks out of ci into reviewers', () => {
    const event = buildRollupEvent(
      {
        sha: 'abc',
        checks: {
          'ci/test': 'success',
          'coderabbitai': 'in_progress',
          'greptile-review': 'success',
          'cubic · AI code review': 'failure',
        },
      },
      NOW,
    )
    // AI reviewer states never affect the CI verdict.
    expect(event.state).toBe('success')
    expect(event.ci).toEqual({ passing: 1, failing: 0, pending: 0, failed: [] })
    expect(event.reviewers).toEqual({
      pending: ['coderabbitai'],
      done: ['greptile-review'],
      failed: ['cubic · AI code review'],
    })
  })

  test('reviewers field is absent without reviewer checks', () => {
    const event = buildRollupEvent({ sha: 'a', checks: { 'ci/test': 'success' } }, NOW)
    expect(event.reviewers).toBeUndefined()
  })

  test('omits repo/number when unknown and caps failed names', () => {
    const checks = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`check-${String(i).padStart(2, '0')}`, 'failure']))
    const event = buildRollupEvent({ sha: 'a', checks }, NOW)
    expect(event.repo).toBeUndefined()
    expect(event.number).toBeUndefined()
    expect(event.ci?.failing).toBe(30)
    expect(event.ci?.failed).toHaveLength(20)
  })
})
