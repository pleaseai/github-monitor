# github-monitor

Real-time GitHub events inside a Claude Code session. A Cloudflare Worker
receives GitHub webhooks and relays them over a WebSocket to a small local
[Claude Code channel](https://code.claude.com/docs/en/channels-reference)
server, which forwards each event into the session as a
`notifications/claude/channel` event — one-way push, no polling.

```
GitHub webhook  ──▶  github-relay (Cloudflare Worker + Durable Object)  ──▶  ws  ──▶  github-monitor-channel  ──▶  Claude Code session
   PR / CI /                verify · summarize · filter ·                          (MCP stdio subprocess,
   issue / …                ci_rollup debounce · seq replay                         reconnect + cursor)
```

The relay does the heavy lifting (signature verification, event summarization,
per-connection filters, CI roll-up debouncing, and seq-cursor replay). The
channel binary is a thin bridge that holds the WebSocket, survives reconnects,
and injects events into Claude.

## Why

Claude Code's built-in Monitor `ws` source ends its watch when the socket
closes and cannot replay missed events. This project adds automatic reconnect
with exponential backoff, `?since=` cursor persistence (no missed events across
reconnects), a GitHub-token → relay-token exchange so no long-lived secret sits
in the URL, and event semantics injected into Claude's system prompt so it
knows how to react to a `ci_rollup` or an AI-reviewer status.

## Install

The channel binary is distributed via Homebrew:

```bash
brew install pleaseai/tap/github-monitor
github-monitor-channel --version
```

This installs the `github-monitor-channel` binary onto your `PATH`. The Claude
Code plugin (`.claude-plugin/plugin.json`) spawns it as a channel server.

Prebuilt binaries are attached to each [GitHub release](https://github.com/pleaseai/github-monitor/releases)
for macOS (arm64/x64), Linux (arm64/x64), and Windows (x64).

## Use

1. Deploy the relay (see [worker/](worker/)) and register a GitHub webhook
   pointing at `https://<your-relay>/hook/<owner>--<repo>`.
2. Point the channel at your relay and load it as a development channel:

   ```bash
   export GITHUB_RELAY_WS_URL="wss://<your-relay>/ws/<owner>--<repo>?events=pull_request,ci_rollup,issue_comment"
   claude --dangerously-load-development-channels plugin:github-monitor
   ```

   Without a `?token=` in the URL, the channel exchanges a GitHub token
   (`GITHUB_TOKEN` or `gh auth token`) at the relay's `POST /auth/<channel>`
   for a short-lived WebSocket token, refreshed automatically. The GitHub token
   is verified against the GitHub API and discarded — the relay never stores it.

### Configuration (environment)

| Variable                 | Required | Description                                                          |
| ------------------------ | -------- | -------------------------------------------------------------------- |
| `GITHUB_RELAY_WS_URL`    | Yes      | `ws://` or `wss://` relay URL with optional `events`/`prs` filters   |
| `GITHUB_TOKEN`           | No       | GitHub token for the `/auth` exchange (falls back to `gh auth token`) |
| `GITHUB_RELAY_STATE_DIR` | No       | Cursor directory (default `~/.claude/github-relay`)                  |

The cursor file is keyed by a hash of the URL, so tokens never touch disk.

## Event kinds

- **`ci_rollup`** — CI settled for a head SHA. `state` is the CI verdict
  (`failure`/`pending`/`success`, AI reviewers excluded); `ci` has check counts
  and failing names; `reviewers` tracks AI review bots (pending / done / failed).
- **`replay`** — a batch of events missed while disconnected, one JSON event
  per line, oldest first.
- Everything else mirrors GitHub webhooks (`pull_request`,
  `pull_request_review`, `issues`, `issue_comment`, `push`, `workflow_run`, …).

## Performance

The channel is a native Rust binary because Claude Code spawns it on every
session start. Measured over 15 warm trials (spawn → `initialize` response;
peak RSS while connecting):

| Metric            | Rust (native) | Reference TS/bun server |
| ----------------- | ------------- | ----------------------- |
| Startup (median)  | ~5 ms         | ~98 ms                  |
| Resident memory   | ~28 MB        | ~46 MB                  |

## Development

```bash
cargo test                 # Rust unit tests (frames, exchange)
cargo build --release      # → target/release/github-monitor-channel
mise run check             # fmt + clippy + Rust tests + worker typecheck/tests
```

The relay worker lives in [worker/](worker/) (bun + wrangler); see its README
for deploy and webhook-setup steps.

## Releases

Versioning and releases are automated with
[release-please](https://github.com/googleapis/release-please) driven by
[Conventional Commits](https://www.conventionalcommits.org/). Merging the
release PR tags a version, cross-compiles the binaries into a GitHub Release,
and updates the Homebrew formula in
[pleaseai/homebrew-tap](https://github.com/pleaseai/homebrew-tap).

## License

[MIT](LICENSE) © PassionFactory
