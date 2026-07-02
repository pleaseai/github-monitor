//! Frame handling — turn one relay WebSocket text frame into channel
//! notifications plus the new replay cursor. Ported from the TS `frames.ts`;
//! kept free of I/O so it stays unit-testable.
//!
//! Protocol: one JSON RelayEvent per text frame, emitted by
//! workers/github-relay (see its src/types.ts). Each frame carries `v: 1`.

use std::collections::BTreeMap;

use serde_json::Value;

/// One `notifications/claude/channel` emission.
#[derive(Debug, PartialEq, Eq)]
pub struct Notification {
    pub content: String,
    /// Keys are identifier-safe (letters, digits, underscores).
    pub meta: BTreeMap<String, String>,
}

/// Result of handling one frame.
#[derive(Debug, PartialEq, Eq)]
pub struct FrameResult {
    pub notifications: Vec<Notification>,
    /// Highest seq seen (unchanged if the frame carried none).
    pub cursor: i64,
    pub error: Option<String>,
}

fn seq_of(event: &Value) -> Option<i64> {
    event.get("seq").and_then(Value::as_i64)
}

fn max_seq(cursor: i64, events: &[&Value]) -> i64 {
    events
        .iter()
        .filter_map(|e| seq_of(e))
        .fold(cursor, i64::max)
}

fn str_field(event: &Value, key: &str) -> Option<String> {
    event.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Build the `<channel>` tag attributes for a normal event.
fn meta_of(event: &Value) -> BTreeMap<String, String> {
    let mut meta = BTreeMap::new();
    if let Some(v) = str_field(event, "event") {
        meta.insert("event".to_owned(), v);
    }
    if let Some(v) = str_field(event, "action") {
        meta.insert("action".to_owned(), v);
    }
    if let Some(v) = str_field(event, "repo") {
        meta.insert("repo".to_owned(), v);
    }
    if let Some(v) = event.get("number").and_then(Value::as_i64) {
        meta.insert("number".to_owned(), v.to_string());
    }
    if let Some(v) = str_field(event, "state") {
        meta.insert("state".to_owned(), v);
    }
    if let Some(v) = seq_of(event) {
        meta.insert("seq".to_owned(), v.to_string());
    }
    meta
}

/// Turn one WebSocket text frame into notifications plus the new cursor.
///
/// - `relay/connected` hello frames advance the cursor but emit nothing.
/// - `relay/replay` envelopes emit ONE notification carrying all missed
///   events (one JSON event per line), mirroring the relay's batching.
/// - Unparseable frames emit nothing and report an error; cursor unchanged.
pub fn handle_frame(frame_text: &str, cursor: i64) -> FrameResult {
    let event: Value = match serde_json::from_str(frame_text) {
        Ok(v) => v,
        Err(_) => {
            return FrameResult {
                notifications: vec![],
                cursor,
                error: Some("unparseable frame".to_owned()),
            }
        }
    };

    let event_name = match event.get("event").and_then(Value::as_str) {
        Some(name) => name,
        None => {
            return FrameResult {
                notifications: vec![],
                cursor,
                error: Some("frame without event field".to_owned()),
            }
        }
    };

    if event_name == "relay" {
        let action = event.get("action").and_then(Value::as_str);
        if action == Some("replay") {
            if let Some(inner) = event.get("events").and_then(Value::as_array) {
                let mut refs: Vec<&Value> = vec![&event];
                refs.extend(inner.iter());
                let new_cursor = max_seq(cursor, &refs);
                if inner.is_empty() {
                    return FrameResult {
                        notifications: vec![],
                        cursor: new_cursor,
                        error: None,
                    };
                }
                let content = inner
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut meta = BTreeMap::new();
                meta.insert("event".to_owned(), "replay".to_owned());
                meta.insert("count".to_owned(), inner.len().to_string());
                return FrameResult {
                    notifications: vec![Notification { content, meta }],
                    cursor: new_cursor,
                    error: None,
                };
            }
        }
        // connected hello (or future relay meta): cursor only, no notification.
        return FrameResult {
            notifications: vec![],
            cursor: max_seq(cursor, &[&event]),
            error: None,
        };
    }

    FrameResult {
        notifications: vec![Notification {
            content: frame_text.to_owned(),
            meta: meta_of(&event),
        }],
        cursor: max_seq(cursor, &[&event]),
        error: None,
    }
}

const BACKOFF_INITIAL_MS: u64 = 1000;
const BACKOFF_MAX_MS: u64 = 30_000;

/// Exponential reconnect backoff: 1s → 2s → … → 30s cap. Pass 0 to reset.
pub fn next_backoff(previous_ms: u64) -> u64 {
    if previous_ms == 0 {
        BACKOFF_INITIAL_MS
    } else {
        (previous_ms * 2).min(BACKOFF_MAX_MS)
    }
}

/// Rebuild the WS URL with the current cursor as `?since=` (replaces any).
pub fn build_ws_url(base_url: &str, cursor: Option<i64>) -> Result<String, url::ParseError> {
    let mut url = url::Url::parse(base_url)?;
    if let Some(seq) = cursor {
        if seq >= 0 {
            let others: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(k, _)| k != "since")
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.query_pairs_mut()
                .clear()
                .extend_pairs(&others)
                .append_pair("since", &seq.to_string());
        }
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn normal_event_one_notification_with_meta() {
        let frame = r#"{"v":1,"event":"ci_rollup","repo":"acme/widgets","number":42,"state":"failure","seq":17,"ci":{"passing":1}}"#;
        let result = handle_frame(frame, 3);
        assert_eq!(result.notifications.len(), 1);
        assert_eq!(result.notifications[0].content, frame);
        assert_eq!(
            result.notifications[0].meta,
            meta(&[
                ("event", "ci_rollup"),
                ("repo", "acme/widgets"),
                ("number", "42"),
                ("state", "failure"),
                ("seq", "17")
            ])
        );
        assert_eq!(result.cursor, 17);
    }

    #[test]
    fn hello_advances_cursor_without_notification() {
        let frame = r#"{"v":1,"event":"relay","action":"connected","seq":9}"#;
        let result = handle_frame(frame, 0);
        assert!(result.notifications.is_empty());
        assert_eq!(result.cursor, 9);
    }

    #[test]
    fn replay_envelope_one_batched_notification() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","events":[{"v":1,"event":"issues","seq":4},{"v":1,"event":"pull_request","seq":6}]}"#;
        let result = handle_frame(frame, 2);
        assert_eq!(result.notifications.len(), 1);
        assert_eq!(
            result.notifications[0].meta,
            meta(&[("event", "replay"), ("count", "2")])
        );
        assert_eq!(result.notifications[0].content.lines().count(), 2);
        assert_eq!(result.cursor, 6);
    }

    #[test]
    fn empty_replay_emits_nothing() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","events":[]}"#;
        assert!(handle_frame(frame, 5).notifications.is_empty());
    }

    #[test]
    fn garbage_frames_dropped_with_error() {
        let r = handle_frame("not json", 7);
        assert!(r.notifications.is_empty());
        assert_eq!(r.cursor, 7);
        assert!(r.error.is_some());
        assert!(handle_frame(r#"{"no":"event"}"#, 7).error.is_some());
    }

    #[test]
    fn cursor_never_goes_backwards() {
        let frame = r#"{"v":1,"event":"issues","seq":3}"#;
        assert_eq!(handle_frame(frame, 10).cursor, 10);
    }

    #[test]
    fn next_backoff_doubles_and_caps() {
        assert_eq!(next_backoff(0), 1000);
        assert_eq!(next_backoff(1000), 2000);
        assert_eq!(next_backoff(16_000), 30_000);
        assert_eq!(next_backoff(30_000), 30_000);
    }

    #[test]
    fn build_ws_url_sets_and_replaces_since() {
        let base = "wss://relay.test/ws/chan?token=t&events=ci_rollup";
        let with = build_ws_url(base, Some(17)).unwrap();
        assert!(with.contains("since=17"));
        assert!(with.contains("token=t"));
        assert!(with.contains("events=ci_rollup"));

        let replaced = build_ws_url("wss://relay.test/ws/chan?since=3&token=t", Some(17)).unwrap();
        assert!(replaced.contains("since=17"));
        assert!(!replaced.contains("since=3"));

        let none = build_ws_url("wss://relay.test/ws/chan?token=t", None).unwrap();
        assert!(!none.contains("since="));
    }
}
