//! GitHub-token → relay-token exchange helpers. Ported from TS `exchange.ts`;
//! pure and unit-testable.

use url::Url;

/// True when the WS URL already carries a static `?token=` (legacy mode).
pub fn has_static_token(ws_url: &str) -> bool {
    Url::parse(ws_url)
        .map(|u| u.query_pairs().any(|(k, _)| k == "token"))
        .unwrap_or(false)
}

/// Resolve a usable GitHub token from an env value, or `None`. Ignores an
/// unexpanded `${GITHUB_TOKEN}` placeholder — Claude Code passes the literal
/// string through when a referenced env var is unset.
pub fn resolve_env_token(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() || (trimmed.starts_with("${") && trimmed.ends_with('}')) {
        return None;
    }
    Some(trimmed.to_owned())
}

/// Map `wss://host/ws/<channel>?…` → `https://host/auth/<channel>`.
pub fn auth_endpoint_for(ws_url: &str) -> Result<String, String> {
    let url = Url::parse(ws_url).map_err(|e| e.to_string())?;
    let path = url.path();
    let channel = path
        .strip_prefix("/ws/")
        .filter(|c| !c.is_empty() && !c.contains('/'))
        .ok_or_else(|| {
            format!("cannot derive auth endpoint from path {path} (expected /ws/<channel>)")
        })?;
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    let host = url.host_str().ok_or("missing host")?;
    let authority = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_owned(),
    };
    Ok(format!("{scheme}://{authority}/auth/{channel}"))
}

/// Return the WS URL with the exchanged token applied (replaces any existing).
pub fn with_token(ws_url: &str, token: &str) -> Result<String, url::ParseError> {
    let mut url = Url::parse(ws_url)?;
    let others: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "token")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(&others)
        .append_pair("token", token);
    Ok(url.to_string())
}

/// Refresh when the token is missing or within `margin` seconds of expiry.
pub fn should_refresh(expires_at: Option<i64>, now: i64, margin: i64) -> bool {
    match expires_at {
        None => true,
        Some(exp) => now >= exp - margin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_static_token_detects_presence() {
        assert!(has_static_token("wss://r.test/ws/chan?token=abc"));
        assert!(!has_static_token("wss://r.test/ws/chan?events=push"));
    }

    #[test]
    fn resolve_env_token_ignores_empty_and_placeholder() {
        assert_eq!(
            resolve_env_token(Some("gho_abc")).as_deref(),
            Some("gho_abc")
        );
        assert_eq!(
            resolve_env_token(Some("  gho_abc  ")).as_deref(),
            Some("gho_abc")
        );
        assert_eq!(resolve_env_token(None), None);
        assert_eq!(resolve_env_token(Some("")), None);
        assert_eq!(resolve_env_token(Some("${GITHUB_TOKEN}")), None);
    }

    #[test]
    fn auth_endpoint_maps_scheme_and_path() {
        assert_eq!(
            auth_endpoint_for("wss://r.test/ws/acme--widgets?events=push").unwrap(),
            "https://r.test/auth/acme--widgets"
        );
        assert_eq!(
            auth_endpoint_for("ws://127.0.0.1:8796/ws/chan").unwrap(),
            "http://127.0.0.1:8796/auth/chan"
        );
        assert!(auth_endpoint_for("wss://r.test/other/chan").is_err());
    }

    #[test]
    fn with_token_adds_or_replaces() {
        let url = with_token("wss://r.test/ws/chan?events=push&token=old", "new").unwrap();
        assert!(url.contains("token=new"));
        assert!(url.contains("events=push"));
        assert!(!url.contains("old"));
    }

    #[test]
    fn should_refresh_when_missing_or_near_expiry() {
        assert!(should_refresh(None, 1000, 300));
        assert!(!should_refresh(Some(1000 + 301), 1000, 300));
        assert!(should_refresh(Some(1000 + 299), 1000, 300));
        assert!(should_refresh(Some(500), 1000, 300));
    }
}
