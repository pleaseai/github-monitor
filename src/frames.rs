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
    /// Highest seq seen (unchanged if the frame carried none), or the highest
    /// seq in this frame when its storage epoch replaced the client's.
    pub cursor: i64,
    /// Storage epoch to persist alongside the cursor.
    pub epoch: Option<String>,
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

fn gap_notification(replay: &Value) -> Option<Notification> {
    let gap = replay.get("gap")?;
    let from = gap.get("from").and_then(Value::as_i64)?;
    let to = gap.get("to").and_then(Value::as_i64)?;
    let mut meta = BTreeMap::new();
    meta.insert("event".to_owned(), "gap".to_owned());
    meta.insert("from".to_owned(), from.to_string());
    meta.insert("to".to_owned(), to.to_string());
    Some(Notification {
        content: format!(
            "The relay buffer had already dropped seq {from}-{to} when this client reconnected. Those events were not delivered and cannot be replayed."
        ),
        meta,
    })
}

fn reset_notification(replay: &Value) -> Option<Notification> {
    let since = replay.get("reset")?.get("since").and_then(Value::as_i64)?;
    let mut meta = BTreeMap::new();
    meta.insert("event".to_owned(), "reset".to_owned());
    meta.insert("since".to_owned(), since.to_string());
    Some(Notification {
        content: format!(
            "The relay's storage was reset since this client last connected, so events after seq {since} in the previous storage may have been lost and cannot be replayed. The replay that follows starts over from the new storage."
        ),
        meta,
    })
}

/// Turn one WebSocket text frame into notifications plus the new cursor.
///
/// - `relay/connected` hello frames advance the cursor but emit nothing.
/// - `relay/replay` envelopes emit ONE notification carrying all missed
///   events (one JSON event per line), mirroring the relay's batching,
///   preceded by a `reset` notification when the relay's storage epoch
///   changed and a `gap` notification when the envelope reports trimmed seqs.
/// - A relay frame whose `epoch` differs from `epoch` restarts the cursor
///   from that frame's seqs instead of keeping the higher old one.
/// - Unparseable frames emit nothing and report an error; cursor unchanged.
pub fn handle_frame(frame_text: &str, cursor: i64, epoch: Option<&str>) -> FrameResult {
    let event: Value = match serde_json::from_str(frame_text) {
        Ok(v) => v,
        Err(_) => {
            return FrameResult {
                notifications: vec![],
                cursor,
                epoch: epoch.map(str::to_owned),
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
                epoch: epoch.map(str::to_owned),
                error: Some("frame without event field".to_owned()),
            }
        }
    };

    if event_name == "relay" {
        let frame_epoch = str_field(&event, "epoch");
        let action = event.get("action").and_then(Value::as_str);
        // A hello seq below the cursor can only follow a storage wipe.
        let hello_behind =
            action == Some("connected") && seq_of(&event).is_some_and(|s| s < cursor);
        let base = match (epoch, frame_epoch.as_deref()) {
            _ if event.get("reset").is_some() => 0,
            (Some(ours), Some(theirs)) if ours != theirs => 0,
            (None, _) if hello_behind => 0,
            _ => cursor,
        };
        let new_epoch = frame_epoch.or_else(|| epoch.map(str::to_owned));
        if action == Some("replay") {
            if let Some(inner) = event.get("events").and_then(Value::as_array) {
                let mut refs: Vec<&Value> = vec![&event];
                refs.extend(inner.iter());
                let new_cursor = max_seq(base, &refs);
                let mut notifications: Vec<Notification> = reset_notification(&event)
                    .into_iter()
                    .chain(gap_notification(&event))
                    .collect();
                if !inner.is_empty() {
                    let content = inner
                        .iter()
                        .map(|e| e.to_string())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let mut meta = BTreeMap::new();
                    meta.insert("event".to_owned(), "replay".to_owned());
                    meta.insert("count".to_owned(), inner.len().to_string());
                    notifications.push(Notification { content, meta });
                }
                return FrameResult {
                    notifications,
                    cursor: new_cursor,
                    epoch: new_epoch,
                    error: None,
                };
            }
        }
        // connected hello (or future relay meta): cursor only, no notification.
        return FrameResult {
            notifications: vec![],
            cursor: max_seq(base, &[&event]),
            epoch: new_epoch,
            error: None,
        };
    }

    FrameResult {
        notifications: vec![Notification {
            content: frame_text.to_owned(),
            meta: meta_of(&event),
        }],
        cursor: max_seq(cursor, &[&event]),
        epoch: epoch.map(str::to_owned),
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

pub fn reconnect_cursor(cursor: Option<i64>) -> Option<i64> {
    Some(cursor.unwrap_or(0).max(0))
}

/// Response header on the WebSocket upgrade that carries the relay's storage epoch.
pub const EPOCH_HEADER: &str = "x-relay-epoch";

/// The epoch to keep after a handshake. An epoch the client already holds wins,
/// because the relay detects a storage wipe by comparing it. Otherwise the
/// relay's epoch is adopted, so a socket that closes before its first frame
/// still reconnects with `?epoch=` and learns of a wipe in between.
pub fn handshake_epoch(current: Option<String>, header: Option<&str>) -> Option<String> {
    current.or_else(|| header.filter(|e| !e.is_empty()).map(str::to_owned))
}

/// Rebuild the WS URL with the current cursor as `?since=` and its storage
/// epoch as `?epoch=` (replacing any). A stale `epoch` is dropped when there
/// is no cursor or no epoch to send with it.
pub fn build_ws_url(
    base_url: &str,
    cursor: Option<i64>,
    epoch: Option<&str>,
) -> Result<String, url::ParseError> {
    let mut url = url::Url::parse(base_url)?;
    let since = cursor.filter(|seq| *seq >= 0);
    let has_epoch = url.query_pairs().any(|(k, _)| k == "epoch");
    if since.is_none() && !has_epoch {
        return Ok(url.to_string());
    }
    let others: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "epoch" && (since.is_none() || k != "since"))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear().extend_pairs(&others);
        if let Some(seq) = since {
            pairs.append_pair("since", &seq.to_string());
            if let Some(epoch) = epoch {
                pairs.append_pair("epoch", epoch);
            }
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
        let result = handle_frame(frame, 3, None);
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
        let result = handle_frame(frame, 0, None);
        assert!(result.notifications.is_empty());
        assert_eq!(result.cursor, 9);
    }

    #[test]
    fn replay_envelope_one_batched_notification() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","events":[{"v":1,"event":"issues","seq":4},{"v":1,"event":"pull_request","seq":6}]}"#;
        let result = handle_frame(frame, 2, None);
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
        assert!(handle_frame(frame, 5, None).notifications.is_empty());
    }

    #[test]
    fn replay_with_gap_notifies_gap_before_events() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","gap":{"from":1,"to":2},"events":[{"v":1,"event":"issues","seq":3},{"v":1,"event":"issues","seq":4}]}"#;
        let result = handle_frame(frame, 0, None);
        assert_eq!(result.notifications.len(), 2);
        assert_eq!(
            result.notifications[0].meta,
            meta(&[("event", "gap"), ("from", "1"), ("to", "2")])
        );
        assert_eq!(
            result.notifications[1].meta,
            meta(&[("event", "replay"), ("count", "2")])
        );
        assert_eq!(result.cursor, 4);
    }

    #[test]
    fn replay_with_gap_and_no_events_still_notifies_gap() {
        let frame =
            r#"{"v":1,"event":"relay","action":"replay","gap":{"from":6,"to":9},"events":[]}"#;
        let result = handle_frame(frame, 5, None);
        assert_eq!(result.notifications.len(), 1);
        assert_eq!(
            result.notifications[0].meta,
            meta(&[("event", "gap"), ("from", "6"), ("to", "9")])
        );
        assert_eq!(result.cursor, 5);
    }

    #[test]
    fn garbage_frames_dropped_with_error() {
        let r = handle_frame("not json", 7, None);
        assert!(r.notifications.is_empty());
        assert_eq!(r.cursor, 7);
        assert!(r.error.is_some());
        assert!(handle_frame(r#"{"no":"event"}"#, 7, None).error.is_some());
    }

    #[test]
    fn cursor_never_goes_backwards() {
        let frame = r#"{"v":1,"event":"issues","seq":3}"#;
        assert_eq!(handle_frame(frame, 10, None).cursor, 10);
    }

    #[test]
    fn next_backoff_doubles_and_caps() {
        assert_eq!(next_backoff(0), 1000);
        assert_eq!(next_backoff(1000), 2000);
        assert_eq!(next_backoff(16_000), 30_000);
        assert_eq!(next_backoff(30_000), 30_000);
    }

    #[test]
    fn reconnect_without_cursor_asks_for_whole_buffer() {
        assert_eq!(reconnect_cursor(None), Some(0));
        assert_eq!(reconnect_cursor(Some(17)), Some(17));
        assert_eq!(reconnect_cursor(Some(-3)), Some(0));
        let url = build_ws_url(
            "wss://relay.test/ws/chan?token=t",
            reconnect_cursor(None),
            None,
        )
        .unwrap();
        assert!(url.contains("since=0"));
        assert!(!url.contains("epoch="));
    }

    #[test]
    fn handshake_epoch_fills_only_a_missing_epoch() {
        assert_eq!(handshake_epoch(None, Some("e1")), Some("e1".to_owned()));
        assert_eq!(
            handshake_epoch(Some("e0".to_owned()), Some("e1")),
            Some("e0".to_owned())
        );
        assert_eq!(handshake_epoch(None, Some("")), None);
        assert_eq!(handshake_epoch(None, None), None);
        let url = build_ws_url(
            "wss://relay.test/ws/chan?token=t",
            reconnect_cursor(None),
            handshake_epoch(None, Some("e1")).as_deref(),
        )
        .unwrap();
        assert!(url.contains("since=0"));
        assert!(url.contains("epoch=e1"));
    }

    #[test]
    fn build_ws_url_sets_and_replaces_since() {
        let base = "wss://relay.test/ws/chan?token=t&events=ci_rollup";
        let with = build_ws_url(base, Some(17), None).unwrap();
        assert!(with.contains("since=17"));
        assert!(with.contains("token=t"));
        assert!(with.contains("events=ci_rollup"));

        let replaced =
            build_ws_url("wss://relay.test/ws/chan?since=3&token=t", Some(17), None).unwrap();
        assert!(replaced.contains("since=17"));
        assert!(!replaced.contains("since=3"));

        let none = build_ws_url("wss://relay.test/ws/chan?token=t", None, None).unwrap();
        assert!(!none.contains("since="));
    }

    #[test]
    fn epoch_mismatch_on_replay_resets_cursor_below_old_one() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","epoch":"new","reset":{"epoch":"old","since":40},"events":[{"v":1,"event":"issues","seq":1},{"v":1,"event":"issues","seq":2}]}"#;
        let result = handle_frame(frame, 40, Some("old"));
        assert_eq!(result.cursor, 2);
        assert_eq!(result.epoch.as_deref(), Some("new"));
    }

    #[test]
    fn epoch_mismatch_on_replay_without_events_resets_cursor_to_zero() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","epoch":"new","reset":{"epoch":"old","since":40},"events":[]}"#;
        let result = handle_frame(frame, 40, Some("old"));
        assert_eq!(result.cursor, 0);
        assert_eq!(result.epoch.as_deref(), Some("new"));
    }

    #[test]
    fn epoch_mismatch_on_hello_resets_cursor_to_hello_seq() {
        let frame = r#"{"v":1,"event":"relay","action":"connected","seq":3,"epoch":"new"}"#;
        let result = handle_frame(frame, 40, Some("old"));
        assert!(result.notifications.is_empty());
        assert_eq!(result.cursor, 3);
        assert_eq!(result.epoch.as_deref(), Some("new"));
    }

    #[test]
    fn missing_client_epoch_adopts_frame_epoch_and_keeps_max() {
        let frame = r#"{"v":1,"event":"relay","action":"connected","seq":50,"epoch":"e1"}"#;
        let result = handle_frame(frame, 40, None);
        assert_eq!(result.cursor, 50);
        assert_eq!(result.epoch.as_deref(), Some("e1"));
    }

    #[test]
    fn missing_client_epoch_with_hello_behind_cursor_resets_cursor() {
        let frame = r#"{"v":1,"event":"relay","action":"connected","seq":3,"epoch":"e1"}"#;
        let result = handle_frame(frame, 40, None);
        assert_eq!(result.cursor, 3);
        assert_eq!(result.epoch.as_deref(), Some("e1"));
    }

    #[test]
    fn reset_replay_without_client_epoch_resets_cursor() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","epoch":"e1","reset":{"since":40},"events":[{"v":1,"event":"issues","seq":2}]}"#;
        let result = handle_frame(frame, 40, None);
        assert_eq!(result.cursor, 2);
        assert_eq!(result.epoch.as_deref(), Some("e1"));
        assert_eq!(
            result.notifications[0]
                .meta
                .get("event")
                .map(String::as_str),
            Some("reset")
        );
    }

    #[test]
    fn same_epoch_keeps_max() {
        let frame = r#"{"v":1,"event":"relay","action":"connected","seq":3,"epoch":"e1"}"#;
        let result = handle_frame(frame, 40, Some("e1"));
        assert_eq!(result.cursor, 40);
        assert_eq!(result.epoch.as_deref(), Some("e1"));
    }

    #[test]
    fn frames_without_epoch_keep_client_epoch() {
        let event = handle_frame(r#"{"v":1,"event":"issues","seq":41}"#, 40, Some("e1"));
        assert_eq!(event.cursor, 41);
        assert_eq!(event.epoch.as_deref(), Some("e1"));
        let hello = handle_frame(
            r#"{"v":1,"event":"relay","action":"connected","seq":3}"#,
            40,
            Some("e1"),
        );
        assert_eq!(hello.cursor, 40);
        assert_eq!(hello.epoch.as_deref(), Some("e1"));
    }

    #[test]
    fn reset_notifies_before_gap_and_replay() {
        let frame = r#"{"v":1,"event":"relay","action":"replay","epoch":"new","reset":{"epoch":"old","since":40},"gap":{"from":1,"to":2},"events":[{"v":1,"event":"issues","seq":3}]}"#;
        let result = handle_frame(frame, 40, Some("old"));
        assert_eq!(result.notifications.len(), 3);
        assert_eq!(
            result.notifications[0].meta,
            meta(&[("event", "reset"), ("since", "40")])
        );
        assert!(result.notifications[0].content.contains("seq 40"));
        assert_eq!(
            result.notifications[1].meta,
            meta(&[("event", "gap"), ("from", "1"), ("to", "2")])
        );
        assert_eq!(
            result.notifications[2].meta,
            meta(&[("event", "replay"), ("count", "1")])
        );
        assert_eq!(result.cursor, 3);
    }

    #[test]
    fn build_ws_url_sets_replaces_and_drops_epoch() {
        let with = build_ws_url("wss://relay.test/ws/chan?token=t", Some(17), Some("e1")).unwrap();
        assert!(with.contains("since=17"));
        assert!(with.contains("epoch=e1"));
        assert!(with.contains("token=t"));

        let replaced = build_ws_url(
            "wss://relay.test/ws/chan?epoch=old&since=3&token=t",
            Some(17),
            Some("e1"),
        )
        .unwrap();
        assert!(replaced.contains("epoch=e1"));
        assert!(!replaced.contains("epoch=old"));
        assert_eq!(replaced.matches("epoch=").count(), 1);

        let no_epoch =
            build_ws_url("wss://relay.test/ws/chan?epoch=old&token=t", Some(17), None).unwrap();
        assert!(no_epoch.contains("since=17"));
        assert!(!no_epoch.contains("epoch="));

        let no_cursor = build_ws_url(
            "wss://relay.test/ws/chan?epoch=old&token=t",
            None,
            Some("e1"),
        )
        .unwrap();
        assert!(!no_cursor.contains("epoch="));
        assert!(no_cursor.contains("token=t"));
    }
}
