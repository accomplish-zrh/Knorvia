//! Bounded credential removal for diagnostics crossing persistence or RPC
//! boundaries. This module deliberately has no provider-specific dependency so
//! every native layer can apply the same rules.

use serde_json::{Map, Value};

pub const MAX_DIAGNOSTIC_INPUT_BYTES: usize = 256 * 1024;
pub const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
pub const MAX_DIAGNOSTIC_STRING_BYTES: usize = 8 * 1024;
const MAX_JSON_DEPTH: usize = 16;
const MAX_JSON_MEMBERS: usize = 128;
const REDACTED: &str = "[redacted]";
const TRUNCATED: &str = " [diagnostic truncated]";

fn bounded_prefix(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut end = bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn bound_final(mut text: String) -> String {
    if text.len() <= MAX_DIAGNOSTIC_BYTES {
        return text;
    }
    let keep = MAX_DIAGNOSTIC_BYTES.saturating_sub(TRUNCATED.len());
    let end = bounded_prefix(&text, keep).len();
    text.truncate(end);
    text.push_str(TRUNCATED);
    text
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn secret_key(key: &str) -> bool {
    matches!(
        normalized_key(key).as_str(),
        "authorization"
            | "proxyauthorization"
            | "apikey"
            | "xapikey"
            | "bearer"
            | "bearertoken"
            | "authtoken"
            | "sessiontoken"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "secret"
            | "secretkey"
            | "clientsecret"
            | "privatekey"
            | "password"
            | "passwd"
            | "oauthcode"
            | "oauthstate"
            | "pkceverifier"
            | "codeverifier"
            | "verifier"
            | "sessionstate"
            | "code"
            | "state"
            | "jwt"
    )
}

fn token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+' | b'/' | b'=')
}

fn percent_decode_once(input: &str) -> String {
    let bytes = bounded_prefix(input, MAX_DIAGNOSTIC_STRING_BYTES).as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            let hex = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            if let (Some(high), Some(low)) = (hex(bytes[at + 1]), hex(bytes[at + 2])) {
                output.push((high << 4) | low);
                at += 3;
                continue;
            }
        }
        output.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn contains_encoded_secret_context(input: &str) -> bool {
    let mut current = bounded_prefix(input, MAX_DIAGNOSTIC_STRING_BYTES).to_string();
    for _ in 0..3 {
        let lower = current.to_ascii_lowercase();
        for key in [
            "code",
            "state",
            "access_token",
            "refresh_token",
            "id_token",
            "api_key",
            "x-api-key",
            "client_secret",
            "session_state",
            "code_verifier",
        ] {
            if lower.starts_with(&format!("{key}="))
                || ["?", "&", "#"]
                    .iter()
                    .any(|prefix| lower.contains(&format!("{prefix}{key}=")))
            {
                return true;
            }
        }
        let decoded = percent_decode_once(&current);
        if decoded == current {
            break;
        }
        current = decoded;
    }
    false
}

fn looks_secret(value: &str) -> bool {
    let trimmed = value.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ')' | ']'));
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("sk-") || lower.contains("-sk-") || lower.contains("_sk-") {
        return true;
    }
    if contains_encoded_secret_context(trimmed) && trimmed.contains('%') {
        return true;
    }
    let segments: Vec<&str> = trimmed.split('.').collect();
    if segments.len() == 3
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        && segments[0].starts_with("eyJ")
    {
        return true;
    }
    let safe_identifier = [
        "gpt-",
        "claude-",
        "deepseek-",
        "qwen-",
        "gemini-",
        "llama-",
        "mistral-",
        "ollama-",
        "ollama/",
        "o1-",
        "o3-",
        "o4-",
        "grok-",
        "text-embedding-",
        "dall-e-",
        "whisper-",
        "tts-",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix));
    !safe_identifier
        && !trimmed.bytes().all(|byte| byte.is_ascii_alphabetic())
        && trimmed.len() >= 20
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn url_end(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len()
        && !bytes[at].is_ascii_whitespace()
        && !matches!(bytes[at], b'"' | b'\'' | b'<' | b'>' | b'(' | b')' | b'[' | b']' | b'{'
            | b'}')
    {
        at += 1;
    }
    at
}

fn sanitize_pairs(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(MAX_DIAGNOSTIC_STRING_BYTES));
    for (index, pair) in text.split('&').enumerate() {
        if index > 0 {
            out.push('&');
        }
        let Some((key, value)) = pair.split_once('=') else {
            if looks_secret(pair) {
                out.push_str(REDACTED);
            } else {
                out.push_str(pair);
            }
            continue;
        };
        out.push_str(key);
        out.push('=');
        // Values of public parameters are still inspected. Only the name
        // controls unconditional redaction; generic secret shapes are never
        // allow-listed merely because the key is normally public.
        let mut decoded_key = bounded_prefix(key, MAX_DIAGNOSTIC_STRING_BYTES).to_string();
        let mut sensitive_key = false;
        for _ in 0..=3 {
            if secret_key(&decoded_key) {
                sensitive_key = true;
                break;
            }
            let decoded = percent_decode_once(&decoded_key);
            if decoded == decoded_key {
                break;
            }
            decoded_key = decoded;
        }
        if sensitive_key || looks_secret(value) {
            out.push_str(REDACTED);
        } else {
            out.push_str(value);
        }
    }
    out
}

fn sanitize_url(url: &str) -> String {
    let query = url.find('?');
    let fragment = url.find('#');
    let first = match (query, fragment) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    let first = first.unwrap_or(url.len());
    let base = &url[..first];
    let authority_start = base.find("://").map(|index| index + 3).unwrap_or(0);
    let authority_end = base[authority_start..]
        .find('/')
        .map(|offset| authority_start + offset)
        .unwrap_or(base.len());
    let authority = &base[authority_start..authority_end];
    let mut out = base[..authority_start].to_string();
    if let Some(at) = authority.rfind('@') {
        out.push_str(REDACTED);
        out.push('@');
        out.push_str(&authority[at + 1..]);
    } else {
        out.push_str(authority);
    }
    if authority_end < base.len() {
        for segment in base[authority_end..].split_inclusive('/') {
            let (slash, value) = if let Some(value) = segment.strip_prefix('/') {
                ("/", value)
            } else {
                ("", segment)
            };
            out.push_str(slash);
            if looks_secret(value) {
                out.push_str(REDACTED);
            } else {
                out.push_str(value);
            }
        }
    }
    let mut cursor = first;
    if cursor < url.len() && url.as_bytes()[cursor] == b'?' {
        out.push('?');
        cursor += 1;
        let end = url[cursor..]
            .find('#')
            .map(|offset| cursor + offset)
            .unwrap_or(url.len());
        out.push_str(&sanitize_pairs(&url[cursor..end]));
        cursor = end;
    }
    if cursor < url.len() && url.as_bytes()[cursor] == b'#' {
        out.push('#');
        out.push_str(&sanitize_pairs(&url[cursor + 1..]));
    }
    out
}

fn starts_ascii_case_insensitive(haystack: &[u8], at: usize, needle: &[u8]) -> bool {
    haystack
        .get(at..at.saturating_add(needle.len()))
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(needle))
}

fn word_boundary(bytes: &[u8], at: usize) -> bool {
    at == 0 || !token_char(bytes[at - 1])
}

fn sanitize_text(input: &str) -> String {
    // Escaped quotes are normalized before fallback parsing. This is safer
    // than echoing malformed JSON verbatim and remains readable as a
    // diagnostic.
    let normalized = input.replace("\\\"", "\"");
    let bytes = normalized.as_bytes();
    let mut out = String::with_capacity(normalized.len().min(MAX_DIAGNOSTIC_BYTES));
    let mut at = 0;
    'scan: while at < bytes.len() {
        if starts_ascii_case_insensitive(bytes, at, b"https://")
            || starts_ascii_case_insensitive(bytes, at, b"http://")
        {
            let end = url_end(bytes, at);
            out.push_str(&sanitize_url(&normalized[at..end]));
            at = end;
            continue;
        }

        if bytes[at].is_ascii_alphanumeric() && word_boundary(bytes, at) {
            let mut key_end = at;
            while key_end < bytes.len()
                && (bytes[key_end].is_ascii_alphanumeric()
                    || matches!(bytes[key_end], b'-' | b'_'))
            {
                key_end += 1;
            }
            let key = &normalized[at..key_end];
            if key.eq_ignore_ascii_case("api") {
                let mut second = key_end;
                while second < bytes.len() && bytes[second].is_ascii_whitespace() {
                    second += 1;
                }
                if starts_ascii_case_insensitive(bytes, second, b"key")
                    && bytes
                        .get(second + 3)
                        .is_none_or(|byte| !byte.is_ascii_alphanumeric())
                {
                    let mut value_start = second + 3;
                    while value_start < bytes.len()
                        && (bytes[value_start].is_ascii_whitespace()
                            || matches!(bytes[value_start], b':' | b'=' | b'"' | b'\'' | b'\\'))
                    {
                        value_start += 1;
                    }
                    let mut value_end = value_start;
                    while value_end < bytes.len() && token_char(bytes[value_end]) {
                        value_end += 1;
                    }
                    if value_end > value_start {
                        out.push_str(&normalized[at..value_start]);
                        out.push_str(REDACTED);
                        at = value_end;
                        continue 'scan;
                    }
                }
            }
            let mut separator_end = key_end;
            while separator_end < bytes.len()
                && (bytes[separator_end].is_ascii_whitespace()
                    || matches!(bytes[separator_end], b'"' | b'\'' | b'\\'))
            {
                separator_end += 1;
            }
            let has_assignment = separator_end < bytes.len()
                && matches!(bytes[separator_end], b':' | b'=');
            if has_assignment {
                separator_end += 1;
                while separator_end < bytes.len()
                    && (bytes[separator_end].is_ascii_whitespace()
                        || matches!(bytes[separator_end], b'"' | b'\'' | b'\\'))
                {
                    separator_end += 1;
                }
                let mut encoded_end = separator_end;
                while encoded_end < bytes.len()
                    && !bytes[encoded_end].is_ascii_whitespace()
                    && !matches!(bytes[encoded_end], b'"' | b'\'')
                {
                    encoded_end += 1;
                }
                if looks_secret(&normalized[separator_end..encoded_end]) {
                    out.push_str(&normalized[at..separator_end]);
                    out.push_str(REDACTED);
                    at = encoded_end;
                    continue 'scan;
                }
            }
            let standalone_scheme = key.eq_ignore_ascii_case("bearer")
                || key.eq_ignore_ascii_case("basic")
                || key.eq_ignore_ascii_case("jwt");
            if (secret_key(key) && has_assignment) || standalone_scheme {
                let mut value_end = separator_end;
                if matches!(normalized_key(&normalized[at..key_end]).as_str(), "authorization" | "proxyauthorization") {
                    let line_end = normalized[value_end..]
                        .find(['\r', '\n'])
                        .map(|offset| value_end + offset)
                        .unwrap_or(normalized.len());
                    let mut scheme_end = value_end;
                    while scheme_end < bytes.len() && token_char(bytes[scheme_end]) {
                        scheme_end += 1;
                    }
                    if scheme_end > value_end
                        && bytes.get(scheme_end).is_some_and(u8::is_ascii_whitespace)
                    {
                        let scheme = &normalized[value_end..scheme_end];
                        out.push_str(&normalized[at..value_end]);
                        out.push_str(scheme);
                        out.push(' ');
                        out.push_str(REDACTED);
                        at = line_end;
                        continue 'scan;
                    }
                    out.push_str(&normalized[at..value_end]);
                    out.push_str(REDACTED);
                    at = line_end;
                    continue 'scan;
                }
                while value_end < bytes.len() && token_char(bytes[value_end]) {
                    value_end += 1;
                }
                if value_end > separator_end {
                    out.push_str(&normalized[at..separator_end]);
                    out.push_str(REDACTED);
                    at = value_end;
                    continue;
                }
            }

            let mut token_end = key_end;
            while token_end < bytes.len() && token_char(bytes[token_end]) {
                token_end += 1;
            }
            let token = &normalized[at..token_end];
            if looks_secret(token) {
                out.push_str(REDACTED);
            } else {
                out.push_str(token);
            }
            at = token_end;
            continue;
        }

        let ch = normalized[at..].chars().next().expect("character boundary");
        out.push(ch);
        at += ch.len_utf8();
    }
    out
}

struct ValueBudget {
    // Six bytes per retained byte covers JSON's worst common escaping, while
    // the fixed reserve covers punctuation and truncation markers.
    bytes: usize,
    members: usize,
    truncated: bool,
}

fn budgeted_string(text: &str, budget: &mut ValueBudget, max: usize) -> String {
    let clean = sanitize_text(bounded_prefix(text, max));
    let allowed = budget.bytes / 6;
    if clean.len() <= allowed {
        budget.bytes = budget.bytes.saturating_sub(clean.len() * 6 + 2);
        return clean;
    }
    budget.truncated = true;
    let marker = "[truncated]";
    let keep = allowed.saturating_sub(marker.len());
    let mut shortened = bounded_prefix(&clean, keep).to_string();
    shortened.push_str(marker);
    budget.bytes = budget.bytes.saturating_sub(shortened.len() * 6 + 2);
    shortened
}

fn known_error_code(value: &Value) -> bool {
    match value {
        Value::Number(_) => true,
        Value::String(code) => {
            let lower = code.to_ascii_lowercase();
            lower.starts_with("invalid_")
                || lower.starts_with("error_")
                || lower.starts_with("provider_")
                || lower.starts_with("rate_limit")
                || matches!(
                    lower.as_str(),
                    "unauthorized" | "forbidden" | "not_found" | "timeout" | "overloaded"
                )
        }
        _ => false,
    }
}

const PRIORITY_KEYS: [&str; 9] = [
    "host",
    "hostname",
    "model",
    "status",
    "statusCode",
    "code",
    "message",
    "detail",
    "error",
];

fn insert_clean_member(
    clean: &mut Map<String, Value>,
    key: &str,
    value: &Value,
    object_is_error: bool,
    depth: usize,
    budget: &mut ValueBudget,
) {
    if budget.members == 0 || budget.bytes < 64 {
        budget.truncated = true;
        return;
    }
    budget.members -= 1;
    let safe_key = budgeted_string(key, budget, 256);
    let normalized = normalized_key(key);
    let code_is_error = normalized == "code" && (object_is_error || known_error_code(value));
    let clean_value = if secret_key(key) && !code_is_error {
        budget.bytes = budget.bytes.saturating_sub(REDACTED.len() * 6 + 2);
        Value::String(REDACTED.into())
    } else {
        // Error context applies only to the direct `code` member. A nested
        // `error.oauth.code` is an OAuth credential again.
        sanitize_value_at(value, depth + 1, normalized == "error", budget)
    };
    clean.insert(safe_key, clean_value);
}

fn sanitize_value_at(
    value: &Value,
    depth: usize,
    direct_parent_error: bool,
    budget: &mut ValueBudget,
) -> Value {
    if depth >= MAX_JSON_DEPTH || budget.bytes < 64 || budget.members == 0 {
        budget.truncated = true;
        return Value::String("[truncated]".into());
    }
    match value {
        Value::String(text) => {
            if contains_encoded_secret_context(text) && text.contains('%') {
                budget.bytes = budget.bytes.saturating_sub(REDACTED.len() * 6 + 2);
                Value::String(REDACTED.into())
            } else {
                Value::String(budgeted_string(
                    text,
                    budget,
                    MAX_DIAGNOSTIC_STRING_BYTES,
                ))
            }
        }
        Value::Array(values) => {
            let mut clean = Vec::new();
            for value in values.iter().take(MAX_JSON_MEMBERS) {
                if budget.members == 0 || budget.bytes < 64 {
                    budget.truncated = true;
                    break;
                }
                budget.members -= 1;
                clean.push(sanitize_value_at(value, depth + 1, false, budget));
            }
            if clean.len() < values.len() {
                budget.truncated = true;
                clean.push(Value::String("[truncated]".into()));
            }
            Value::Array(clean)
        }
        Value::Object(values) => {
            let object_is_error = direct_parent_error
                || values
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("error"))
                || (values.contains_key("code")
                    && (values.contains_key("message") || values.contains_key("error")));
            let mut clean = Map::new();
            // Direct lookups preserve the few diagnostic anchors even when a
            // hostile object is very wide. The remaining scan is capped.
            for key in PRIORITY_KEYS {
                if let Some(value) = values.get(key) {
                    insert_clean_member(
                        &mut clean,
                        key,
                        value,
                        object_is_error,
                        depth,
                        budget,
                    );
                }
            }
            for (key, value) in values.iter().take(MAX_JSON_MEMBERS) {
                if PRIORITY_KEYS.contains(&key.as_str()) {
                    continue;
                }
                insert_clean_member(
                    &mut clean,
                    key,
                    value,
                    object_is_error,
                    depth,
                    budget,
                );
                if budget.members == 0 || budget.bytes < 64 {
                    break;
                }
            }
            if clean.len() < values.len() {
                budget.truncated = true;
                clean.insert("_knorviaTruncated".into(), Value::Bool(true));
            }
            Value::Object(clean)
        }
        other => {
            budget.bytes = budget.bytes.saturating_sub(32);
            other.clone()
        }
    }
}

/// Sanitize a structured value while bounding recursion, members and strings.
pub fn sanitize_diagnostic_value(value: &Value) -> Value {
    let mut budget = ValueBudget {
        bytes: MAX_DIAGNOSTIC_BYTES.saturating_sub(1024),
        members: MAX_JSON_MEMBERS,
        truncated: false,
    };
    sanitize_value_at(value, 0, false, &mut budget)
}

/// Sanitize an untrusted diagnostic. Valid JSON is processed structurally;
/// malformed or plain text uses the context-aware fallback. Both paths have
/// input, string, collection, nesting and final-output limits.
pub fn sanitize_diagnostic(input: &str) -> String {
    let input_truncated = input.len() > MAX_DIAGNOSTIC_INPUT_BYTES;
    let bounded = bounded_prefix(input, MAX_DIAGNOSTIC_INPUT_BYTES);
    let mut clean = match serde_json::from_str::<Value>(bounded) {
        Ok(value) => serde_json::to_string(&sanitize_diagnostic_value(&value))
            .unwrap_or_else(|_| "diagnostic could not be rendered".into()),
        Err(_) => sanitize_text(bounded),
    };
    if input_truncated && !clean.ends_with(TRUNCATED) {
        clean.push_str(TRUNCATED);
    }
    bound_final(clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_and_text_secrets_are_removed_idempotently() {
        let secret = "eyJheader123.payload456789.signature987";
        let input = format!(
            r#"{{"error":{{"Authorization":"Bearer abc","nested":{{"api_key":"tiny","jwt":"{secret}"}}}},"model":"sk-secret","status":401}}"#
        );
        let clean = sanitize_diagnostic(&input);
        assert!(!clean.contains("abc"));
        assert!(!clean.contains("tiny"));
        assert!(!clean.contains(secret));
        assert!(!clean.contains("sk-secret"));
        assert!(clean.contains("401"));
        assert_eq!(sanitize_diagnostic(&clean), clean);
    }

    #[test]
    fn urls_are_processed_in_source_order_and_public_keys_do_not_whitelist_secrets() {
        let input = "先看 https://api.example.com/sk-secret?client_id=sk-secret&ok=yes#state=early 再看 http://sk-user-secret@later.example/cb?code=later 裸路径 https://bare.example/sk-bare-secret 编码键 https://encoded.example/cb?co%64e=short-secret&ok=1";
        let clean = sanitize_diagnostic(input);
        assert!(clean.contains("https://api.example.com/[redacted]?client_id=[redacted]&ok=yes#state=[redacted]"));
        assert!(clean.contains("http://[redacted]@later.example/cb?code=[redacted]"));
        assert!(!clean.contains("sk-secret"));
        assert!(!clean.contains("sk-user-secret"));
        assert!(!clean.contains("sk-bare-secret"));
        assert!(!clean.contains("short-secret"));
        assert!(clean.contains("co%64e=[redacted]&ok=1"));
        assert!(!clean.contains("early"));
        assert!(!clean.contains("later\""));
        assert!(clean.contains("先看") && clean.contains("再看"));
    }

    #[test]
    fn malformed_json_and_short_header_credentials_fail_closed() {
        let input = "broken {\\\"x-api-key\\\":\\\"z9\\\",\\\"state\\\":\\\"w8\\\"}\nBearer tiny\nAPI key: p6\nBasic u5\nAuthorization: Token j4\nProxy-Authorization: ApiKey m3\nAuthorization: Custom o2\nAuthorization: Digest username=alice, response=deadbeef, nonce=digest-secret";
        let clean = sanitize_diagnostic(input);
        for secret in [
            "z9",
            "w8",
            "tiny",
            "p6",
            "u5",
            "j4",
            "m3",
            "o2",
            "alice",
            "deadbeef",
            "digest-secret",
        ] {
            assert!(!clean.contains(secret), "{secret} leaked in {clean}");
        }
        assert!(clean.contains("Authorization: Digest [redacted]"));
        assert!(clean.contains("[redacted]"));
        let plain = "Authorization: Bearer [redacted]\nAPI key: [redacted]";
        assert_eq!(sanitize_diagnostic(plain), plain);
        assert_eq!(sanitize_diagnostic(&sanitize_diagnostic(plain)), plain);
    }

    #[test]
    fn expanded_structured_keys_hide_secrets_but_error_codes_survive() {
        let input = serde_json::json!({
            "error": {"code": "invalid_api_key", "status": 401, "oauth": {"code": "nested-oauth-short"}},
            "providerWrapper": {"type": "error", "code": "rate_limit_exceeded"},
            "oauth": {"code": "oauth-short", "state": "state-short"},
            "bearerToken": "bearer-short",
            "authToken": "auth-short",
            "sessionToken": "session-short",
            "secretKey": "secret-short",
            "privateKey": "private-short",
            "pkceVerifier": "pkce-short",
            "codeVerifier": "verifier-short",
            "session_state": "session-state-short",
            "redirect_uri": "https%3A%2F%2Fclient.example%2Fcb%3Fco%2564e%3Dencoded-short%26client_%2573ecret%3Dencoded-state"
        });
        let clean = sanitize_diagnostic(&input.to_string());
        assert!(clean.contains("invalid_api_key"), "{clean}");
        assert!(clean.contains("rate_limit_exceeded"), "{clean}");
        assert!(clean.contains("401"), "{clean}");
        for secret in [
            "oauth-short",
            "nested-oauth-short",
            "state-short",
            "bearer-short",
            "auth-short",
            "session-short",
            "secret-short",
            "private-short",
            "pkce-short",
            "verifier-short",
            "session-state-short",
            "encoded-short",
            "encoded-state",
        ] {
            assert!(!clean.contains(secret), "{secret} leaked in {clean}");
        }
        assert_eq!(sanitize_diagnostic(&clean), clean);
    }

    #[test]
    fn normal_diagnostics_remain_readable_and_all_bounds_apply() {
        let input = format!(
            "host api.example.com model gpt-5.4 claude-3-5-sonnet-20240620 deepseek-reasoner-preview o3-mini-high-20250131 text-embedding-3-large whisper-large-v3-turbo extraordinarilylongordinaryword status 429 文件 abcdefgh.ijklmnop.qrstuvwx report.final.txt 中文诊断 {}",
            "x".repeat(MAX_DIAGNOSTIC_INPUT_BYTES + 100)
        );
        let clean = sanitize_diagnostic(&input);
        assert!(clean.contains("api.example.com"));
        assert!(clean.contains("gpt-5.4"));
        assert!(clean.contains("claude-3-5-sonnet-20240620"));
        assert!(clean.contains("deepseek-reasoner-preview"));
        assert!(clean.contains("o3-mini-high-20250131"));
        assert!(clean.contains("text-embedding-3-large"));
        assert!(clean.contains("whisper-large-v3-turbo"));
        assert!(clean.contains("extraordinarilylongordinaryword"));
        assert!(clean.contains("429"));
        assert!(clean.contains("report.final.txt"));
        assert!(clean.contains("abcdefgh.ijklmnop.qrstuvwx"));
        assert!(clean.contains("中文诊断"));
        assert!(clean.len() <= MAX_DIAGNOSTIC_BYTES);
        assert!(clean.ends_with(TRUNCATED));

        let mut nested = Value::Null;
        for _ in 0..40 {
            nested = serde_json::json!({"safe": nested});
        }
        let rendered = serde_json::to_string(&sanitize_diagnostic_value(&nested)).unwrap();
        assert!(rendered.contains("[truncated]"));

        let wide = serde_json::json!({
            "values": vec!["x".repeat(8_000); 128],
            "host": "api.example.com",
            "model": "gpt-5.4",
            "status": 503
        });
        let bounded = sanitize_diagnostic_value(&wide);
        let rendered = serde_json::to_vec(&bounded).unwrap();
        assert!(rendered.len() <= MAX_DIAGNOSTIC_BYTES);
        let text = String::from_utf8(rendered).unwrap();
        assert!(text.contains("api.example.com"), "{text}");
        assert!(text.contains("gpt-5.4"), "{text}");
        assert!(text.contains("503"), "{text}");
    }
}
