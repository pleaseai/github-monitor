//! github-relay channel server (Rust) — Claude Code channels research preview.
//!
//! Claude Code spawns this as an MCP stdio subprocess. It holds a WebSocket to
//! the github-relay Cloudflare worker and forwards each event into the session
//! as a `notifications/claude/channel` event. Adds over the Monitor ws source:
//! automatic reconnect with exponential backoff, `?since=` cursor persistence
//! (no missed events across reconnects), GitHub-token → relay-token exchange,
//! and event semantics injected into Claude's system prompt via `instructions`.
//!
//! Config (env):
//!   GITHUB_RELAY_WS_URL     required — wss URL with filters. Without `?token=`,
//!                           the server exchanges a GitHub token (GITHUB_TOKEN or
//!                           `gh auth token`) at POST /auth/<channel> for a
//!                           short-lived WS token, refreshed automatically.
//!   GITHUB_TOKEN            optional — GitHub token for the exchange.
//!   GITHUB_RELAY_STATE_DIR  optional — cursor dir (default ~/.claude/github-relay).
//!
//! Reference: https://code.claude.com/docs/en/channels-reference

mod exchange;
mod frames;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

use exchange::{
    auth_endpoint_for, has_static_token, resolve_env_token, should_refresh, with_token,
};
use frames::{build_ws_url, handle_frame, next_backoff};

const INSTRUCTIONS: &str = "\
Events from the github-relay channel arrive as <channel source=\"github-relay\" event=\"...\" ...> tags with a JSON body (one GitHub event summary). They are one-way: read them and act; no reply is expected or possible.

Key event kinds:
- ci_rollup: CI settled for a head SHA. \"state\" is the CI verdict (failure|pending|success, AI reviewers excluded). \"ci\" has check counts and failing names. \"reviewers\" tracks AI review bots: pending = still reviewing (wait), done = their review comments are ready to process now, failed = the bot itself errored (surface to the user; never auto-retry a bot).
- replay: a batch of events missed while disconnected — the body is one JSON event per line. Process each line as if it had arrived live, oldest first.
- Other kinds mirror GitHub webhooks (pull_request, pull_request_review, pull_request_review_comment, issues, issue_comment, push, workflow_run, ...) with fields: repo, number (PR/issue), action, state, sha, ref, title, preview (truncated body), url.

React proportionally: a ci_rollup failure or a new review comment on a PR you are babysitting usually warrants action; unrelated events usually need none.";

const PROTOCOL_VERSION: &str = "2025-06-18";

fn log(msg: &str) {
    eprintln!("github-relay channel: {msg}");
}

fn fail(msg: &str) -> ! {
    log(msg);
    std::process::exit(1);
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cursor_file(ws_url: &str) -> PathBuf {
    let state_dir = std::env::var("GITHUB_RELAY_STATE_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
            PathBuf::from(home).join(".claude").join("github-relay")
        });
    let hash = hex::encode(Sha256::digest(ws_url.as_bytes()));
    state_dir.join(format!("cursor-{}.json", &hash[..16]))
}

fn load_cursor(file: &PathBuf) -> Option<i64> {
    let text = std::fs::read_to_string(file).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed.get("seq").and_then(Value::as_i64)
}

fn save_cursor(file: &PathBuf, seq: i64) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = json!({ "seq": seq }).to_string();
    if let Err(e) = std::fs::write(file, body) {
        log(&format!("failed to save cursor: {e}"));
    }
}

/// Resolve a GitHub token: GITHUB_TOKEN env (ignoring placeholders), else `gh auth token`.
async fn github_token() -> String {
    if let Some(tok) = resolve_env_token(std::env::var("GITHUB_TOKEN").ok().as_deref()) {
        return tok;
    }
    match tokio::process::Command::new("gh").args(["auth", "token"]).output().await {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_owned(),
        _ => fail("no GitHub token — set GITHUB_TOKEN or log in with `gh auth login` (or put a static ?token= in GITHUB_RELAY_WS_URL)"),
    }
}

/// Exchange a GitHub token for a short-lived relay token via POST /auth/<channel>.
async fn exchange_token(ws_url: &str, client: &reqwest::Client) -> Result<(String, i64), String> {
    let endpoint = auth_endpoint_for(ws_url)?;
    let token = github_token().await;
    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("auth request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "token exchange failed ({}): {}",
            status.as_u16(),
            &body[..body.len().min(200)]
        ));
    }
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("bad /auth response: {e}"))?;
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .ok_or("no token in /auth response")?
        .to_owned();
    let expires_at = payload
        .get("expiresAt")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Ok((token, expires_at))
}

/// Build a `notifications/claude/channel` JSON-RPC line.
fn channel_notification(content: &str, meta: &BTreeMap<String, String>) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/claude/channel",
        "params": { "content": content, "meta": meta },
    })
    .to_string()
}

/// Handle one inbound JSON-RPC message; return an optional response line and
/// whether it was the `initialized` signal.
fn handle_rpc(line: &str) -> (Option<String>, bool) {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return (None, false),
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();

    // Notifications have no id and expect no response.
    if id.is_none() {
        return (None, method == "notifications/initialized");
    }
    let id = id.unwrap();

    let result: Value = match method {
        "initialize" => {
            let protocol = msg
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            json!({
                "protocolVersion": protocol,
                "capabilities": { "experimental": { "claude/channel": {} } },
                "serverInfo": { "name": "github-relay", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [] }),
        "prompts/list" => json!({ "prompts": [] }),
        "resources/list" => json!({ "resources": [] }),
        "resources/templates/list" => json!({ "resourceTemplates": [] }),
        _ => {
            return (
                Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } }).to_string()),
                false,
            );
        }
    };
    (
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()),
        false,
    )
}

const HELP: &str = "\
github-monitor-channel — Claude Code channel server for GitHub events.

Claude Code spawns this as an MCP stdio subprocess; it is not a stand-alone CLI.
It holds a WebSocket to a github-relay worker and forwards each GitHub event into
the session as a notifications/claude/channel event.

Usage:
  github-monitor-channel            run the channel server (reads stdin/stdout)
  github-monitor-channel --version  print version and exit
  github-monitor-channel --help     print this help and exit

Environment:
  GITHUB_RELAY_WS_URL     required — ws:// or wss:// relay URL with filters
  GITHUB_TOKEN            optional — GitHub token for the /auth exchange
  GITHUB_RELAY_STATE_DIR  optional — cursor dir (default ~/.claude/github-relay)

Docs: https://github.com/pleaseai/github-monitor";

#[tokio::main]
async fn main() {
    // Minimal flag handling so `--version`/`--help` work without a relay URL
    // (release smoke tests and the Homebrew formula call `--version`).
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--version" | "-V" => {
                println!("github-monitor-channel {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--help" | "-h" => {
                println!("{HELP}");
                return;
            }
            _ => {}
        }
    }

    let ws_url = std::env::var("GITHUB_RELAY_WS_URL").unwrap_or_default();
    if !(ws_url.starts_with("ws://") || ws_url.starts_with("wss://")) {
        fail("GITHUB_RELAY_WS_URL is not set (expected a ws:// or wss:// URL)");
    }

    let cursor_path = cursor_file(&ws_url);
    let mut cursor = load_cursor(&cursor_path);

    // Outbox: every stdout line (responses + notifications) flows through here.
    let (outbox_tx, mut outbox_rx) = mpsc::unbounded_channel::<String>();
    let initialized = std::sync::Arc::new(Notify::new());

    // Writer task — owns stdout, newline-delimited, flush per line.
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = outbox_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });

    // Stdin reader task — MCP JSON-RPC requests.
    {
        let outbox = outbox_tx.clone();
        let initialized = initialized.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let (response, is_initialized) = handle_rpc(&line);
                if let Some(resp) = response {
                    let _ = outbox.send(resp);
                }
                if is_initialized {
                    initialized.notify_one();
                }
            }
        });
    }

    // WebSocket loop — start after the client signals `initialized` so no
    // notification is emitted before the handshake completes.
    initialized.notified().await;
    log("initialized — starting relay connection");

    let static_mode = has_static_token(&ws_url);
    let http = reqwest::Client::new();
    let mut relay_token: Option<String> = None;
    let mut relay_expires: Option<i64> = None;
    let mut backoff_ms: u64 = 0;

    // Ctrl-C / SIGTERM → exit. SIGTERM is unix-only; Windows has just Ctrl-C.
    tokio::spawn(async {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = async { if let Some(t) = term.as_mut() { t.recv().await; } } => {},
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        std::process::exit(0);
    });

    loop {
        // Resolve the connection URL (token exchange when not static).
        let connect_url = match build_ws_url(&ws_url, cursor) {
            Ok(u) => u,
            Err(e) => fail(&format!("invalid GITHUB_RELAY_WS_URL: {e}")),
        };
        let connect_url = if static_mode {
            connect_url
        } else {
            if relay_token.is_none() || should_refresh(relay_expires, now_secs(), 300) {
                match exchange_token(&ws_url, &http).await {
                    Ok((tok, exp)) => {
                        log(&format!(
                            "exchanged GitHub token for relay token (expires {exp})"
                        ));
                        relay_token = Some(tok);
                        relay_expires = Some(exp);
                    }
                    Err(e) => {
                        backoff_ms = next_backoff(backoff_ms);
                        log(&format!("{e}, retrying in {backoff_ms}ms"));
                        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                        continue;
                    }
                }
            }
            match with_token(&connect_url, relay_token.as_deref().unwrap_or("")) {
                Ok(u) => u,
                Err(e) => fail(&format!("failed to apply token: {e}")),
            }
        };

        match tokio_tungstenite::connect_async(&connect_url).await {
            Ok((mut ws, _)) => {
                backoff_ms = 0;
                log(&format!(
                    "connected (since={})",
                    cursor
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "none".to_owned())
                ));
                while let Some(msg) = ws.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            let result = handle_frame(&text, cursor.unwrap_or(0));
                            if let Some(err) = result.error {
                                log(&err);
                            }
                            for n in &result.notifications {
                                let _ = outbox_tx.send(channel_notification(&n.content, &n.meta));
                            }
                            if Some(result.cursor) != cursor {
                                cursor = Some(result.cursor);
                                save_cursor(&cursor_path, result.cursor);
                            }
                        }
                        Ok(Message::Ping(p)) => {
                            let _ = ws.send(Message::Pong(p)).await;
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
                backoff_ms = next_backoff(backoff_ms);
                log(&format!("socket closed, reconnecting in {backoff_ms}ms"));
            }
            Err(e) => {
                backoff_ms = next_backoff(backoff_ms);
                log(&format!("connect failed: {e}, retrying in {backoff_ms}ms"));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
    }
}
