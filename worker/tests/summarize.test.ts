import { describe, expect, test } from 'bun:test'
import { summarizeGitHubEvent } from '../src/summarize.ts'

const NOW = new Date('2026-07-02T12:00:00.000Z')

const base = {
  repository: { full_name: 'acme/widgets' },
  sender: { login: 'octocat' },
}

describe('summarizeGitHubEvent', () => {
  test('pull_request opened', () => {
    const event = summarizeGitHubEvent('pull_request', {
      ...base,
      action: 'opened',
      number: 42,
      pull_request: {
        number: 42,
        title: 'Add relay',
        state: 'open',
        merged: false,
        head: { ref: 'feat/relay', sha: 'abc123' },
        html_url: 'https://github.com/acme/widgets/pull/42',
      },
    }, 'delivery-1', NOW)

    expect(event).toEqual({
      v: 1,
      event: 'pull_request',
      action: 'opened',
      repo: 'acme/widgets',
      sender: 'octocat',
      delivery: 'delivery-1',
      ts: '2026-07-02T12:00:00.000Z',
      number: 42,
      title: 'Add relay',
      ref: 'feat/relay',
      sha: 'abc123',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/42',
    })
  })

  test('pull_request closed+merged reports state merged', () => {
    const event = summarizeGitHubEvent('pull_request', {
      ...base,
      action: 'closed',
      pull_request: { number: 7, state: 'closed', merged: true },
    }, null, NOW)
    expect(event.state).toBe('merged')
    expect(event.number).toBe(7)
    expect(event.delivery).toBeUndefined()
  })

  test('push summarizes branch, sha, and head commit message', () => {
    const event = summarizeGitHubEvent('push', {
      ...base,
      ref: 'refs/heads/main',
      after: 'deadbeef',
      head_commit: { message: 'fix: relay\n\nlong body text' },
      compare: 'https://github.com/acme/widgets/compare/a...b',
    }, 'd2', NOW)
    expect(event.ref).toBe('main')
    expect(event.sha).toBe('deadbeef')
    expect(event.preview).toBe('fix: relay long body text')
    expect(event.url).toContain('/compare/')
  })

  test('issue_comment truncates long bodies', () => {
    const event = summarizeGitHubEvent('issue_comment', {
      ...base,
      action: 'created',
      issue: { number: 3, title: 'Bug' },
      comment: { body: 'x'.repeat(500), html_url: 'https://github.com/acme/widgets/issues/3#issuecomment-1' },
    }, null, NOW)
    expect(event.preview?.length).toBeLessThanOrEqual(141)
    expect(event.preview?.endsWith('…')).toBe(true)
    expect(event.number).toBe(3)
  })

  test('check_run prefers conclusion over status', () => {
    const done = summarizeGitHubEvent('check_run', {
      ...base,
      action: 'completed',
      check_run: {
        name: 'ci/test',
        head_sha: 'abc',
        status: 'completed',
        conclusion: 'failure',
        pull_requests: [{ number: 42 }],
        html_url: 'https://github.com/acme/widgets/runs/1',
      },
    }, null, NOW)
    expect(done.state).toBe('failure')
    expect(done.name).toBe('ci/test')
    expect(done.number).toBe(42)

    const pending = summarizeGitHubEvent('check_run', {
      ...base,
      action: 'created',
      check_run: { name: 'ci/test', status: 'queued', conclusion: null },
    }, null, NOW)
    expect(pending.state).toBe('queued')
  })

  test('issues / create / delete cover branch and issue events', () => {
    const issue = summarizeGitHubEvent('issues', {
      ...base,
      action: 'opened',
      issue: { number: 9, title: 'New issue', state: 'open', html_url: 'https://github.com/acme/widgets/issues/9' },
    }, null, NOW)
    expect(issue.number).toBe(9)
    expect(issue.title).toBe('New issue')

    const branch = summarizeGitHubEvent('create', {
      ...base,
      ref: 'feat/new-branch',
      ref_type: 'branch',
    }, null, NOW)
    expect(branch.ref).toBe('feat/new-branch')
    expect(branch.name).toBe('branch')
  })

  test('pull_request_review carries review state and preview', () => {
    const event = summarizeGitHubEvent('pull_request_review', {
      ...base,
      action: 'submitted',
      pull_request: { number: 42 },
      review: { state: 'changes_requested', body: 'Please fix X', html_url: 'https://github.com/r/1' },
    }, null, NOW)
    expect(event.state).toBe('changes_requested')
    expect(event.preview).toBe('Please fix X')
    expect(event.number).toBe(42)
  })

  test('workflow_run summarizes name, branch, and conclusion', () => {
    const event = summarizeGitHubEvent('workflow_run', {
      ...base,
      action: 'completed',
      workflow_run: {
        name: 'CI',
        head_branch: 'main',
        head_sha: 'abc',
        status: 'completed',
        conclusion: 'success',
        pull_requests: [],
        html_url: 'https://github.com/acme/widgets/actions/runs/1',
      },
    }, null, NOW)
    expect(event.name).toBe('CI')
    expect(event.state).toBe('success')
    expect(event.number).toBeUndefined()
  })

  test('unknown events fall back to a generic summary', () => {
    const event = summarizeGitHubEvent('star', { ...base, action: 'created' }, null, NOW)
    expect(event).toEqual({
      v: 1,
      event: 'star',
      action: 'created',
      repo: 'acme/widgets',
      sender: 'octocat',
      ts: '2026-07-02T12:00:00.000Z',
    })
  })

  test('summaries stay far below Monitor frame limits', () => {
    const event = summarizeGitHubEvent('issue_comment', {
      ...base,
      action: 'created',
      issue: { number: 3, title: 't'.repeat(1000) },
      comment: { body: 'b'.repeat(100_000) },
    }, null, NOW)
    expect(JSON.stringify(event).length).toBeLessThan(2000)
  })
})
