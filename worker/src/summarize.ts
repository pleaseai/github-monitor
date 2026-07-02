/**
 * Collapse a GitHub webhook payload into a compact one-line RelayEvent.
 *
 * The consumer is Claude Code's Monitor tool: each WebSocket text frame
 * becomes one notification, frames over 1 MiB kill the watch, and noisy
 * feeds get rate-limit suppressed — so the relay ships a summary, never
 * the raw payload.
 *
 * Payload shapes come from @octokit/webhooks-types (type-only dependency,
 * generated from GitHub's official webhook schemas). Runtime access still
 * uses optional chaining throughout: real deliveries can be partial and
 * the summarizer must never throw.
 */

import type {
  CheckRunEvent,
  CheckSuiteEvent,
  CreateEvent,
  DeleteEvent,
  DeploymentStatusEvent,
  IssueCommentEvent,
  IssuesEvent,
  PingEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
  PullRequestReviewThreadEvent,
  PushEvent,
  ReleaseEvent,
  StatusEvent,
  WorkflowJobEvent,
  WorkflowRunEvent,
} from '@octokit/webhooks-types'
import type { RelayEvent } from './types.ts'

const PREVIEW_LIMIT = 140

/** Untyped incoming JSON — narrowed per event via @octokit/webhooks-types. */
export type WebhookPayload = Record<string, unknown>

/** Fields shared by (nearly) every webhook payload. */
interface CommonFields {
  action?: string
  repository?: { full_name?: string }
  sender?: { login?: string }
}

function preview(text: string | null | undefined): string | undefined {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined
  }
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT)}…` : flat
}

function shortRef(ref: string | null | undefined): string | undefined {
  if (typeof ref !== 'string') {
    return undefined
  }
  return ref.replace(/^refs\/(heads|tags)\//, '')
}

/** Assign only defined values (exactOptionalPropertyTypes-safe). */
function put<K extends keyof RelayEvent>(target: RelayEvent, key: K, value: RelayEvent[K] | null | undefined): void {
  if (value !== undefined && value !== null && value !== '') {
    target[key] = value
  }
}

export function summarizeGitHubEvent(
  eventName: string,
  payload: WebhookPayload,
  delivery: string | null,
  now: Date = new Date(),
): RelayEvent {
  const out: RelayEvent = { v: 1, event: eventName, ts: now.toISOString() }
  const common = payload as CommonFields
  put(out, 'action', typeof common.action === 'string' ? common.action : undefined)
  put(out, 'repo', common.repository?.full_name)
  put(out, 'sender', common.sender?.login)
  put(out, 'delivery', delivery ?? undefined)

  switch (eventName) {
    case 'ping': {
      const p = payload as unknown as PingEvent
      put(out, 'preview', preview(p.zen))
      break
    }
    case 'push': {
      const p = payload as unknown as PushEvent
      put(out, 'ref', shortRef(p.ref))
      put(out, 'sha', p.after)
      put(out, 'preview', preview(p.head_commit?.message))
      put(out, 'url', p.compare)
      break
    }
    case 'create': {
      const p = payload as unknown as CreateEvent
      put(out, 'ref', p.ref)
      put(out, 'name', p.ref_type)
      break
    }
    case 'delete': {
      const p = payload as unknown as DeleteEvent
      put(out, 'ref', p.ref)
      put(out, 'name', p.ref_type)
      break
    }
    case 'pull_request': {
      const p = payload as unknown as PullRequestEvent
      const pr = p.pull_request
      put(out, 'number', p.number ?? pr?.number)
      put(out, 'title', pr?.title)
      put(out, 'ref', pr?.head?.ref)
      put(out, 'sha', pr?.head?.sha)
      put(out, 'state', pr && 'merged' in pr && pr.merged === true ? 'merged' : pr?.state)
      put(out, 'url', pr?.html_url)
      break
    }
    case 'issues': {
      const issue = (payload as unknown as IssuesEvent).issue
      put(out, 'number', issue?.number)
      put(out, 'title', issue?.title)
      put(out, 'state', issue?.state)
      put(out, 'url', issue?.html_url)
      break
    }
    case 'issue_comment': {
      const p = payload as unknown as IssueCommentEvent
      put(out, 'number', p.issue?.number)
      put(out, 'title', p.issue?.title)
      put(out, 'preview', preview(p.comment?.body))
      put(out, 'url', p.comment?.html_url)
      break
    }
    case 'pull_request_review': {
      const p = payload as unknown as PullRequestReviewEvent
      put(out, 'number', p.pull_request?.number)
      put(out, 'state', p.review?.state)
      put(out, 'preview', preview(p.review?.body))
      put(out, 'url', p.review?.html_url)
      break
    }
    case 'pull_request_review_comment': {
      const p = payload as unknown as PullRequestReviewCommentEvent
      put(out, 'number', p.pull_request?.number)
      put(out, 'preview', preview(p.comment?.body))
      put(out, 'url', p.comment?.html_url)
      break
    }
    case 'pull_request_review_thread': {
      const p = payload as unknown as PullRequestReviewThreadEvent
      put(out, 'number', p.pull_request?.number)
      put(out, 'url', p.thread?.comments?.[0]?.html_url)
      break
    }
    case 'check_run': {
      const run = (payload as unknown as CheckRunEvent).check_run
      put(out, 'name', run?.name)
      put(out, 'sha', run?.head_sha)
      put(out, 'state', run?.conclusion ?? run?.status)
      put(out, 'number', run?.pull_requests?.[0]?.number)
      put(out, 'url', run?.html_url)
      break
    }
    case 'check_suite': {
      const suite = (payload as unknown as CheckSuiteEvent).check_suite
      put(out, 'sha', suite?.head_sha)
      put(out, 'ref', suite?.head_branch)
      put(out, 'state', suite?.conclusion ?? suite?.status)
      put(out, 'number', suite?.pull_requests?.[0]?.number)
      break
    }
    case 'workflow_run': {
      const run = (payload as unknown as WorkflowRunEvent).workflow_run
      put(out, 'name', run?.name)
      put(out, 'ref', run?.head_branch)
      put(out, 'sha', run?.head_sha)
      put(out, 'state', run?.conclusion ?? run?.status)
      put(out, 'number', run?.pull_requests?.[0]?.number)
      put(out, 'url', run?.html_url)
      break
    }
    case 'workflow_job': {
      const job = (payload as unknown as WorkflowJobEvent).workflow_job
      put(out, 'name', job?.name)
      put(out, 'ref', job?.head_branch)
      put(out, 'sha', job?.head_sha)
      put(out, 'state', job?.conclusion ?? job?.status)
      put(out, 'url', job?.html_url)
      break
    }
    case 'status': {
      const p = payload as unknown as StatusEvent
      put(out, 'name', p.context)
      put(out, 'sha', p.sha)
      put(out, 'state', p.state)
      put(out, 'preview', preview(p.description))
      put(out, 'url', p.target_url)
      break
    }
    case 'deployment_status': {
      const p = payload as unknown as DeploymentStatusEvent
      put(out, 'state', p.deployment_status?.state)
      put(out, 'name', p.deployment?.environment)
      put(out, 'sha', p.deployment?.sha)
      break
    }
    case 'release': {
      const release = (payload as unknown as ReleaseEvent).release
      put(out, 'title', release?.name ?? release?.tag_name)
      put(out, 'ref', release?.tag_name)
      put(out, 'url', release?.html_url)
      break
    }
    default: {
      // Generic fallback: event + action + repo + sender is still actionable.
      const p = payload as { issue?: { number?: number }, pull_request?: { number?: number } }
      put(out, 'number', p.issue?.number ?? p.pull_request?.number)
      break
    }
  }

  return out
}
