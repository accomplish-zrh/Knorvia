//! Provider failure classification shared by the direct execution path and
//! the Kernel bridge path.
//!
//! The protocol already defines the categories and the retry metadata
//! (`ErrorCategory::ProviderRateLimit`/`ProviderAuth`/`DeadlineExceeded`,
//! `ProtocolError::retryable/retry_after`). This module is the single place
//! that maps a concrete provider failure — HTTP status, `Retry-After`
//! header, transport message, or in-band stream error — onto that contract,
//! so both paths classify identically. Response bodies never flow through
//! here verbatim: callers extract a structured provider message and this
//! module additionally redacts token-like secrets before the text is stored
//! or surfaced.

use knorvia_protocol::ErrorCategory;
use std::time::{SystemTime, UNIX_EPOCH};

/// One classified provider failure, ready to be surfaced as protocol
/// metadata (B/UI consumes `category`/`retryable`/`retryAfter` directly).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailure {
    pub category: ErrorCategory,
    pub retryable: bool,
    /// Normalized seconds until retry (from `Retry-After` seconds or
    /// HTTP-date), when the provider supplied one.
    pub retry_after_secs: Option<u64>,
    pub message: String,
}

/// Parse an integer-seconds or IMF-fixdate `Retry-After` value into seconds
/// from now. Unparsable values are ignored (no invented backoff); a parsed
/// date already in the past clamps to 0. A hostile header can never panic
/// the control plane.
pub fn normalize_retry_after(header: Option<&str>, now: SystemTime) -> Option<u64> {
    let value = header?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(secs) = value.parse::<u64>() {
        return Some(secs);
    }
    let at = http_date_to_unix(value)?;
    let now_secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let delta = at.saturating_sub(now_secs);
    Some(if delta <= 0 { 0 } else { delta as u64 })
}

fn days_in_month(year: i64, month: i64) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Minimal IMF-fixdate parser (`Sun, 06 Nov 1994 08:49:37 GMT`) — the only
/// date shape mainstream provider gateways emit for `Retry-After`.
///
/// Signed and checked throughout: a pre-epoch (or absurdly small) year
/// yields `i64::MIN` — "long expired", which `normalize_retry_after` clamps
/// to 0 — while malformed or out-of-range input (wrong year width, nonsense
/// calendar dates, overflow) is `None`. A remote `Retry-After` can never
/// underflow or overflow this parser into a panic.
fn http_date_to_unix(value: &str) -> Option<i64> {
    let rest = value.trim().strip_suffix(" GMT")?;
    let (_weekday, rest) = rest.split_once(", ")?;
    let mut parts = rest.split(' ');
    let day: u32 = parts.next()?.parse().ok()?;
    let month = month_index(parts.next()?)?;
    let year_text = parts.next()?;
    // IMF-fixdate carries exactly four year digits; wider or non-numeric
    // years are malformed, not "huge".
    if year_text.len() != 4 || !year_text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let year: i64 = year_text.parse().ok()?;
    let time = parts.next()?;
    let (hh, mm, ss) = match time.splitn(3, ':').collect::<Vec<_>>()[..] {
        [h, m, s] => (
            h.parse::<i64>().ok()?,
            m.parse::<i64>().ok()?,
            s.parse::<i64>().ok()?,
        ),
        _ => return None,
    };
    if hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    if day == 0 || day > days_in_month(year, month as i64) {
        return None;
    }
    // Years far below the epoch are expired by definition; clamp instead of
    // taking the civil algorithm outside its validated positive range.
    if year < 1601 {
        return Some(i64::MIN);
    }
    // Days-from-civil (Howard Hinnant's algorithm) on signed values.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era
        .checked_mul(146_097)?
        .checked_add(doe)?
        .checked_sub(719_468)?;
    days.checked_mul(86_400)?
        .checked_add(hh.checked_mul(3_600)?)?
        .checked_add(mm.checked_mul(60)?)?
        .checked_add(ss)
}

fn month_index(name: &str) -> Option<u64> {
    Some(match name {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    })
}

/// Redact token-like secret runs (`sk-…`, bearer tokens, long alphanumeric
/// ids) inside a provider message before it is stored or displayed.
pub fn redact_secrets(text: &str) -> String {
    knorvia_protocol::sanitize_diagnostic(text)
}

/// Extract the structured provider error message from a JSON body (redacted).
/// Raw bodies are never surfaced: returns `None` when the body has no usable
/// structured message field, and callers substitute a status-only line.
pub fn extract_provider_message(body: &str) -> Option<String> {
    let v = serde_json::from_str::<serde_json::Value>(body).ok()?;
    for pointer in [
        "/error/message",
        "/errors/0/message",
        "/message",
        "/detail",
        "/msg",
        "/error",
    ] {
        if let Some(s) = v.pointer(pointer).and_then(|candidate| candidate.as_str())
            && !s.trim().is_empty()
        {
            return Some(redact_secrets(s));
        }
    }
    None
}

/// Classify an HTTP-level provider failure. `body_message` is the structured
/// provider error text already extracted by the caller (never a raw body).
pub fn classify_status(
    status: u16,
    retry_after: Option<&str>,
    body_message: &str,
) -> ProviderFailure {
    let message = redact_secrets(body_message);
    let retry_after_secs = normalize_retry_after(retry_after, SystemTime::now());
    let (category, retryable) = match status {
        401 | 403 => (ErrorCategory::ProviderAuth, false),
        408 => (ErrorCategory::DeadlineExceeded, true),
        429 => (ErrorCategory::ProviderRateLimit, true),
        500..=599 => (ErrorCategory::Transient, true),
        _ => (ErrorCategory::ProviderUnsupported, false),
    };
    ProviderFailure {
        category,
        retryable,
        retry_after_secs,
        message,
    }
}

/// Classify a transport failure from its rendered message (ureq surfaces
/// timeouts as IO errors; the rendered text carries "timed out").
pub fn classify_transport(message: &str) -> ProviderFailure {
    let lower = message.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("operation timed out") {
        ProviderFailure {
            category: ErrorCategory::DeadlineExceeded,
            retryable: true,
            retry_after_secs: None,
            message: "provider request timed out before a response arrived".into(),
        }
    } else {
        ProviderFailure {
            category: ErrorCategory::Transient,
            retryable: true,
            retry_after_secs: None,
            message: format!("provider transport failure: {}", redact_secrets(message)),
        }
    }
}

/// Classify an in-band stream error (200 OK, provider reports failure inside
/// the event stream) or a stream that ended without its terminal event.
pub fn classify_stream_error(message: &str) -> ProviderFailure {
    let lower = message.to_ascii_lowercase();
    let (category, retryable) = if lower.contains("rate limit") || lower.contains("overloaded") {
        (ErrorCategory::ProviderRateLimit, true)
    } else if lower.contains("invalid_api_key") || lower.contains("unauthorized") {
        (ErrorCategory::ProviderAuth, false)
    } else {
        (ErrorCategory::Transient, true)
    };
    ProviderFailure {
        category,
        retryable,
        retry_after_secs: None,
        message: redact_secrets(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn retry_after_seconds_and_httpdate_normalize_to_seconds() {
        assert_eq!(
            normalize_retry_after(Some(" 30 "), SystemTime::now()),
            Some(30)
        );
        assert_eq!(normalize_retry_after(Some(""), SystemTime::now()), None);
        assert_eq!(normalize_retry_after(None, SystemTime::now()), None);
        assert_eq!(normalize_retry_after(Some("soon"), SystemTime::now()), None);
        // Classic IMF-fixdate: 1994-11-06 08:49:37 GMT = 784111777.
        let at = http_date_to_unix("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
        assert_eq!(at, 784_111_777);
        let past = SystemTime::UNIX_EPOCH + Duration::from_secs(at as u64 + 5);
        assert_eq!(
            normalize_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), past),
            Some(0)
        );
        let before = SystemTime::UNIX_EPOCH + Duration::from_secs(at as u64 - 60);
        assert_eq!(
            normalize_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), before),
            Some(60)
        );
    }

    #[test]
    fn status_table_matches_protocol_contract() {
        let f = classify_status(429, Some("12"), "rate limited");
        assert_eq!(f.category, ErrorCategory::ProviderRateLimit);
        assert!(f.retryable);
        assert_eq!(f.retry_after_secs, Some(12));

        let f = classify_status(401, None, "bad key");
        assert_eq!(f.category, ErrorCategory::ProviderAuth);
        assert!(!f.retryable);

        let f = classify_status(403, None, "forbidden");
        assert_eq!(f.category, ErrorCategory::ProviderAuth);

        let f = classify_status(408, None, "req timeout");
        assert_eq!(f.category, ErrorCategory::DeadlineExceeded);
        assert!(f.retryable);

        for s in [500u16, 502, 503, 529] {
            let f = classify_status(s, None, "upstream");
            assert_eq!(f.category, ErrorCategory::Transient, "{s}");
            assert!(f.retryable, "{s}");
        }

        let f = classify_status(404, None, "no such model");
        assert_eq!(f.category, ErrorCategory::ProviderUnsupported);
        assert!(!f.retryable);
    }

    #[test]
    fn secrets_are_redacted_and_transport_is_classified() {
        assert_eq!(
            redact_secrets("auth failed for sk-abcdef1234567890abcdef12, retry"),
            "auth failed for [redacted], retry"
        );
        let f = classify_transport("network failure: connection timed out after 30s");
        assert_eq!(f.category, ErrorCategory::DeadlineExceeded);
        assert!(f.retryable);
        let f = classify_transport("Network failure: DNS lookup failed");
        assert_eq!(f.category, ErrorCategory::Transient);
        assert!(f.retryable);
    }

    #[test]
    fn stream_errors_classify_by_provider_vocabulary() {
        let f = classify_stream_error("provider overloaded, try again");
        assert_eq!(f.category, ErrorCategory::ProviderRateLimit);
        assert!(f.retryable);
        let f = classify_stream_error("invalid_api_key supplied");
        assert_eq!(f.category, ErrorCategory::ProviderAuth);
        let f = classify_stream_error("stream ended unexpectedly");
        assert_eq!(f.category, ErrorCategory::Transient);
    }

    /// CODEX-0030-A counterexample set: a hostile `Retry-After` date must
    /// never panic (the old u64 parser underflowed on pre-1970 dates and
    /// overflowed on huge years). Valid-but-expired dates clamp to 0;
    /// malformed or out-of-range ones are None.
    #[test]
    fn retry_after_dates_never_panic_and_clamp_or_reject() {
        let epoch = SystemTime::UNIX_EPOCH;
        // Pre-1970: a valid IMF-fixdate that underflowed the old parser.
        assert_eq!(
            normalize_retry_after(Some("Fri, 01 Jan 1960 00:00:00 GMT"), epoch),
            Some(0),
            "expired valid date clamps to 0, no underflow panic"
        );
        // Year 0000 and 0001: previously underflowed `year - 1` / era math.
        assert_eq!(
            normalize_retry_after(Some("Mon, 01 Jan 0001 00:00:00 GMT"), epoch),
            Some(0)
        );
        assert_eq!(
            normalize_retry_after(Some("Sat, 01 Jan 0000 00:00:00 GMT"), epoch),
            Some(0)
        );
        // Absurd year widths are malformed, not "huge" — no overflow panic.
        assert_eq!(
            normalize_retry_after(Some("Fri, 01 Jan 99999999 00:00:00 GMT"), epoch),
            None
        );
        assert_eq!(http_date_to_unix("Fri, 01 Jan 12030 00:00:00 GMT"), None);
        // Impossible calendar dates (day beyond the month, non-leap Feb 29).
        assert_eq!(http_date_to_unix("Sat, 31 Feb 2030 00:00:00 GMT"), None);
        assert_eq!(http_date_to_unix("Tue, 31 Apr 2030 00:00:00 GMT"), None);
        assert_eq!(http_date_to_unix("Tue, 29 Feb 2100 00:00:00 GMT"), None);
        assert_eq!(
            http_date_to_unix("Wed, 29 Feb 2028 00:00:00 GMT").is_some(),
            true
        );
        // A sane future date still normalizes to a positive delta.
        let future = http_date_to_unix("Fri, 01 Jan 2100 00:00:00 GMT").unwrap();
        let now = epoch + Duration::from_secs(4_000_000_000);
        assert_eq!(
            normalize_retry_after(Some("Fri, 01 Jan 2100 00:00:00 GMT"), now),
            Some(future as u64 - 4_000_000_000)
        );
    }
}
