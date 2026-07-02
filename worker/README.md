# github-relay worker

GitHub webhook → WebSocket relay on Cloudflare Workers. Feeds real-time GitHub
events (push/branch, PR, issue, review, check_run, workflow_run, …) to consumers
over a WebSocket, replacing slow `gh` CLI polling with sub-second push delivery.
The primary consumer is the [`github-monitor` channel](../README.md) (the Rust
binary in this repo), which bridges these frames into a Claude Code session;
Claude Code's [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool)
`ws` source can also consume it directly.

## Architecture

```
GitHub webhook ──POST /hook/<channel>──▶ Worker ──▶ RelayServer (Durable Object, 1/channel)
  (HMAC verify → compact summary)                      │  SQLite ring buffer (last 200, replay)
                                                       ▼  WebSocket fan-out (hibernation)
channel / Monitor ◀──wss /ws/<channel>?token=…────────┘
```

- **[PartyServer](https://github.com/cloudflare/partykit)** (Cloudflare's
  PartyKit library) with `hibernate: true` — idle connections cost zero DO
  duration; outgoing frames are free. Fits the Workers **free plan** (SQLite DOs).
- **Compact summaries, never raw payloads** — one text frame per event; the
  Monitor `ws` source turns each into one notification and kills watches on
  frames > 1 MiB, so frames stay small.
- **Reconnect replay** — every frame carries `seq`; reconnect with
  `?since=<seq>` and missed events (buffer: last 200 per channel) arrive as
  **one batched `{"event":"relay","action":"replay","events":[…]}` frame**
  (per [DO WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#batch-messages-to-reduce-overhead)).
  A consumer that lost the socket re-arms with the last seen `seq`.
- **Stateless auth** — per-channel token = `base64url(HMAC-SHA256(TOKEN_SECRET, "ws:" + channel))`.
  No token storage; rotate `TOKEN_SECRET` to revoke all.

## Endpoints

| Route                  | Description                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /hook/<channel>` | GitHub webhook receiver. Verifies `X-Hub-Signature-256` against `WEBHOOK_SECRET`, summarizes, broadcasts.                                                                                                                                                                                                                      |
| `GET /ws/<channel>`    | WebSocket for consumers. Auth: `?token=<token>` **or** subprotocols `["github-relay.v1", "<token>"]`. Options: `?since=<seq>` (replay); server-side filters `?events=`, `?repos=`, `?prs=` (AND-combined).                                                                                                                     |
| `POST /auth/<channel>` | Token exchange. `Authorization: Bearer <github token>` that can read the channel's repo (`<owner>--<repo>`) or is an active member of the org (`<org>`) yields `{token, expiresAt}` — a short-lived WS token (TTL `AUTH_TOKEN_TTL_SECONDS`, default 24h). The GitHub token is verified against `GITHUB_API_URL` and discarded. |
| `GET /health`          | Liveness probe.                                                                                                                                                                                                                                                                                                                |

Channel names: `[A-Za-z0-9_.-]{1,64}` — convention: `<owner>--<repo>`.

## Deploy

```bash
cd worker
bunx wrangler login                     # once
bunx wrangler secret put WEBHOOK_SECRET # GitHub webhook secret
bunx wrangler secret put TOKEN_SECRET   # openssl rand -base64 32
bun run deploy
```

## Set up a repo webhook

```bash
gh api repos/<owner>/<repo>/hooks -f name=web \
  -F 'config[url]=https://github-relay.<account>.workers.dev/hook/<owner>--<repo>' \
  -F 'config[content_type]=json' \
  -F 'config[secret]=<WEBHOOK_SECRET>' \
  -F 'events[]=push' -F 'events[]=pull_request' -F 'events[]=issues' \
  -F 'events[]=issue_comment' -F 'events[]=pull_request_review' \
  -F 'events[]=pull_request_review_comment' -F 'events[]=check_run' \
  -F 'events[]=workflow_run' -F 'events[]=status'
```

## Set up an org webhook

One webhook covers every repository in the organization — no per-repo setup.
Requires org admin (token scope `admin:org_hook`). Convention: channel = org
name.

```bash
gh api orgs/<org>/hooks -f name=web \
  -F 'config[url]=https://github-relay.<account>.workers.dev/hook/<org>' \
  -F 'config[content_type]=json' \
  -F 'config[secret]=<WEBHOOK_SECRET>' \
  -F 'events[]=push' -F 'events[]=pull_request' -F 'events[]=issues' \
  -F 'events[]=issue_comment' -F 'events[]=pull_request_review' \
  -F 'events[]=pull_request_review_comment' -F 'events[]=check_run' \
  -F 'events[]=workflow_run' -F 'events[]=status'
```

Verify and inspect deliveries:

```bash
gh api orgs/<org>/hooks                        # list hooks
gh api orgs/<org>/hooks/<hook_id>/deliveries   # recent deliveries + status
gh api -X POST orgs/<org>/hooks/<hook_id>/pings  # send a ping event
```

Every consumer then connects to the same org channel and narrows with the
`repos` filter (plus `events` as usual):

```
wss://…/ws/<org>?token=<org-channel-token>&repos=<org>/<repo>&events=pull_request,check_run
```

Notes:

- The org channel token is derived from the channel name (`<org>`), so all
  repos share one consumer token — anyone holding it can see events from
  every repo in the org. For internal single-team orgs that is usually fine;
  for tighter isolation, keep per-repo webhooks/channels instead.
- Repo-level and org-level webhooks can coexist; a repo covered by both will
  deliver duplicate events to their respective channels (the relay does not
  dedupe across channels).
- GitHub Enterprise Cloud also supports the same shape at the enterprise
  level (`/enterprises/<slug>/hooks`) if ever needed.

## Consume from Claude Code

Get a WS token either way:

**GitHub-token exchange (recommended)** — authorization follows actual
GitHub access; no secret distribution. Owner logins can't contain `--`, so
`<owner>--<repo>` channels map unambiguously to repos:

```bash
curl -X POST -H "Authorization: Bearer $(gh auth token)" \
  https://github-relay.<account>.workers.dev/auth/<owner>--<repo>
# → {"token":"<exp>.<sig>","expiresAt":…}   (24h TTL)
```

The [`github-monitor` channel](../README.md) does this exchange (and refresh)
automatically.

**Static token (fallback)** — derive locally from the worker's `TOKEN_SECRET`
(for Monitor ws without gh, CI, etc.):

```bash
TOKEN_SECRET=… bun run token <owner>--<repo>
```

Then arm the Monitor ws source (requires Claude Code v2.1.195+):

```
Monitor({
  ws: { url: 'wss://github-relay.<account>.workers.dev/ws/<owner>--<repo>?token=<token>&events=pull_request,check_run,pull_request_review' },
  description: 'GitHub events for <owner>/<repo>',
  persistent: true,
})
```

Each event arrives as one JSON frame:

```json
{"v":1,"event":"check_run","action":"completed","repo":"acme/widgets","name":"ci/test","state":"failure","number":42,"seq":17,"ts":"…"}
```

The first frame after connect is `{"event":"relay","action":"connected","seq":<cursor>}` —
store `seq` and reconnect with `?since=<seq>` to catch up after a disconnect.

## CI rollup (derived `ci_rollup` event)

Granular CI deliveries are noisy — a 10-check run means 10 `check_run`
webhooks, i.e. 10 Monitor notifications. The relay therefore accumulates
`check_run` and `status` events per head SHA and, once that SHA's stream has
been **quiet for `ROLLUP_QUIET_MS`** (default 30s, Durable Object alarm),
emits one derived frame:

```json
{"v":1,"event":"ci_rollup","sha":"abc123","repo":"acme/widgets","number":42,
 "state":"failure","ci":{"passing":8,"failing":1,"pending":1,"failed":["ci/test"]},
 "reviewers":{"pending":["coderabbitai"],"done":["greptile"],"failed":[]},"seq":18,"ts":"…"}
```

- `state`: `failure` | `pending` | `success` (unknown check states count as
  pending — never a false green)
- **AI reviewer checks are split out into `reviewers`** — coderabbit, cubic,
  gemini-code-assist, copilot reviewer, greptile report progress as status
  checks, but they mean something different: `pending` = review still
  running, `done` = review comments ready to process, `failed` = the bot
  errored (never auto-retry). They never affect the CI `state`. Override the
  name patterns with the `AI_REVIEWER_PATTERNS` var (comma-separated
  case-insensitive regexes; see `src/rollup.ts` for the defaults)
- Checks that finish after a flush trigger a follow-up rollup with the full
  accumulated picture
- Raw `check_run`/`status` frames are still stored and broadcast — a
  PR-scoped session simply excludes them:
  `?prs=42&events=ci_rollup,pull_request,pull_request_review,issue_comment`

This is the recommended subscription shape for PR-babysitting consumers: one
notification when CI settles, not one per check.

## Event summary fields

`event` (X-GitHub-Event) / `action` / `repo` / `sender` / `number` (PR·issue) /
`title` / `ref` (branch) / `sha` / `state` (check conclusion, review state,
`merged`, …) / `name` (check·workflow name) / `url` / `preview` (truncated
comment body) / `ci` (rollup counts, `ci_rollup` only) / `seq` / `delivery` /
`ts`. Unknown event types fall back to `event+action+repo+sender`.

## Development

```bash
bun test            # unit tests + emulator e2e (see below)
bun run typecheck
bun run dev         # wrangler dev (secrets from .dev.vars)
```

`tests/e2e.emulate.test.ts` runs the full chain against production-shaped
traffic using [emulate.dev](https://emulate.dev/docs/github): it boots a
stateful GitHub API emulator (`emulate` package) plus this relay on real
workerd (`wrangler dev`), registers a repo webhook via the emulated GitHub
API, then creates issues/comments and asserts the signed deliveries
(`X-Hub-Signature-256`) come out of the WebSocket as summarized frames —
including the `?since=` replay path. Everything runs on localhost; no
network or GitHub account needed.
