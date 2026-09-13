//! A13: the resource budgets every provider read path shares.
//!
//! Success and failure bytes from an upstream are equally untrusted: a
//! provider that never sends a newline, one enormous `data:` block, a
//! never-ending tool-argument stream or a multi-gigabyte error document must
//! cost this process a declared amount of memory and then stop. The budget is
//! one table for the direct execution path, the Kernel bridge and the error
//! bodies, so a limit cannot be tightened in one place and forgotten in
//! another.
//!
//! Exceeding a budget aborts *this* request only. It is a typed diagnostic
//! with the partial facts still attached: whatever text arrived stays on the
//! result as provisional, and the result is never reported as completed.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};

/// One physical SSE line. The Kernel bridge historically used exactly this
/// figure, so keeping it here preserves that defence while extending it.
pub const DEFAULT_MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// One accumulated SSE event (several `data:` lines make one payload).
pub const DEFAULT_MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;
/// An HTTP error document is never worth more than a page of diagnostics.
pub const DEFAULT_MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
/// One tool call's accumulated arguments.
pub const DEFAULT_MAX_TOOL_ARGS_BYTES: usize = 2 * 1024 * 1024;
/// Everything a single request may accumulate across the whole stream.
pub const DEFAULT_MAX_TOTAL_BYTES: usize = 48 * 1024 * 1024;
/// A sanity ceiling on event count, independent of their size.
pub const DEFAULT_MAX_EVENTS: u64 = 200_000;
/// Operator overrides below this are ignored rather than wedging the product.
const MIN_BUDGET_BYTES: usize = 1024;

/// Which budget fired. Also the stable machine-readable name on the wire.
pub type BudgetName = &'static str;
pub const LINE_BUDGET: BudgetName = "line";
pub const EVENT_BUDGET: BudgetName = "event";
pub const ERROR_BODY_BUDGET: BudgetName = "errorBody";
pub const TOOL_ARGS_BUDGET: BudgetName = "toolArguments";
pub const TOTAL_OUTPUT_BUDGET: BudgetName = "totalOutput";
pub const EVENT_COUNT_BUDGET: BudgetName = "events";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamBudget {
    pub max_line_bytes: usize,
    pub max_event_bytes: usize,
    pub max_error_body_bytes: usize,
    pub max_tool_args_bytes: usize,
    pub max_total_bytes: usize,
    pub max_events: u64,
}

fn env_number(key: &str, fallback: u64, floor: u64) -> u64 {
    std::env::var(key)
        .ok()
        .map(|raw| raw.replace('_', "").trim().to_string())
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value >= floor)
        .unwrap_or(fallback)
}

impl Default for StreamBudget {
    fn default() -> Self {
        Self {
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            max_event_bytes: DEFAULT_MAX_EVENT_BYTES,
            max_error_body_bytes: DEFAULT_MAX_ERROR_BODY_BYTES,
            max_tool_args_bytes: DEFAULT_MAX_TOOL_ARGS_BYTES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
            max_events: DEFAULT_MAX_EVENTS,
        }
    }
}

impl StreamBudget {
    /// Production budgets: the declared defaults, overridable per deployment.
    /// Values under 1 KiB are ignored so a typo cannot silently disable every
    /// provider call. Tests inject [`StreamBudget`] directly instead of
    /// touching the process environment.
    pub fn from_env() -> Self {
        Self {
            max_line_bytes: env_number(
                "KNORVIA_PROVIDER_MAX_LINE_BYTES",
                DEFAULT_MAX_LINE_BYTES as u64,
                MIN_BUDGET_BYTES as u64,
            ) as usize,
            max_event_bytes: env_number(
                "KNORVIA_PROVIDER_MAX_EVENT_BYTES",
                DEFAULT_MAX_EVENT_BYTES as u64,
                MIN_BUDGET_BYTES as u64,
            ) as usize,
            max_error_body_bytes: env_number(
                "KNORVIA_PROVIDER_MAX_ERROR_BODY_BYTES",
                DEFAULT_MAX_ERROR_BODY_BYTES as u64,
                MIN_BUDGET_BYTES as u64,
            ) as usize,
            max_tool_args_bytes: env_number(
                "KNORVIA_PROVIDER_MAX_TOOL_ARGS_BYTES",
                DEFAULT_MAX_TOOL_ARGS_BYTES as u64,
                MIN_BUDGET_BYTES as u64,
            ) as usize,
            max_total_bytes: env_number(
                "KNORVIA_PROVIDER_MAX_TOTAL_BYTES",
                DEFAULT_MAX_TOTAL_BYTES as u64,
                MIN_BUDGET_BYTES as u64,
            ) as usize,
            max_events: env_number("KNORVIA_PROVIDER_MAX_EVENTS", DEFAULT_MAX_EVENTS, 1),
        }
    }

    /// The declared limits, so a client or log can tell what was enforced.
    pub fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "lineBytes": self.max_line_bytes,
            "eventBytes": self.max_event_bytes,
            "errorBodyBytes": self.max_error_body_bytes,
            "toolArgumentsBytes": self.max_tool_args_bytes,
            "totalBytes": self.max_total_bytes,
            "events": self.max_events,
        })
    }
}

/// A budget that its upstream exceeded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBreach {
    /// Which declared budget fired (`line`, `event`, `errorBody`,
    /// `toolArguments`, `totalOutput`, `events`).
    pub budget: String,
    /// `bytes` or `events`.
    pub unit: String,
    pub limit: u64,
    pub received: u64,
    /// True when the bytes collected before the breach are still on the
    /// result. They are always provisional, never a completion.
    pub partial_kept: bool,
}

impl BudgetBreach {
    pub fn new(budget: BudgetName, limit: u64, received: u64, unit: &'static str) -> Self {
        Self {
            budget: budget.to_string(),
            unit: unit.to_string(),
            limit,
            received,
            partial_kept: true,
        }
    }

    /// Honest operator-facing diagnosis: what stopped, at what declared
    /// limit, and what a caller must do (raise the limit explicitly, or
    /// shrink the requested output) instead of blindly retrying.
    pub fn message(&self) -> String {
        format!(
            "provider response exceeded the {budget} budget of {limit}{unit} after {received}{unit}; \
             this request was aborted and its partial result is provisional, not a completion \
             (retry only with an explicitly larger budget or a smaller requested output)",
            budget = self.budget,
            limit = self.limit,
            unit = if self.unit == "bytes" {
                " bytes "
            } else {
                " events "
            },
            received = self.received,
        )
    }

    /// Short form for when another fact already stands (an HTTP status, say)
    /// and only the body was cut off. Every exit words it the same way.
    pub fn truncation_note(&self) -> String {
        format!(
            "{} budget of {} bytes exceeded ({} received); the remainder was not read",
            self.budget, self.limit, self.received
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineRead {
    /// One physical line, newline included, within the cap.
    Line(Vec<u8>),
    /// The stream ended cleanly.
    End,
    /// This line passed its cap; nothing further of it is buffered.
    Breach(BudgetBreach),
}

/// Reads one `\n`-terminated line, holding at most `max` bytes. Chunk
/// boundaries are irrelevant (a UTF-8 sequence split across reads is still
/// one line), and an over-long line is detected at the cap instead of being
/// buffered whole.
pub fn read_capped_line<R: Read>(
    reader: &mut BufReader<R>,
    max: usize,
    budget: BudgetName,
) -> std::io::Result<LineRead> {
    let mut line: Vec<u8> = Vec::new();
    loop {
        let filled = reader.fill_buf()?;
        if filled.is_empty() {
            return Ok(if line.is_empty() {
                LineRead::End
            } else {
                LineRead::Line(line)
            });
        }
        let take = match filled.iter().position(|byte| *byte == b'\n') {
            Some(newline) => newline + 1,
            None => filled.len(),
        };
        let ended = filled[..take].last() == Some(&b'\n');
        let seen = line.len().saturating_add(take);
        if seen > max {
            // Consume the inspected buffer but never append beyond the
            // declared cap. The caller aborts this response on the breach.
            reader.consume(take);
            return Ok(LineRead::Breach(BudgetBreach::new(
                budget,
                max as u64,
                seen as u64,
                "bytes",
            )));
        }
        line.extend_from_slice(&filled[..take]);
        reader.consume(take);
        if ended {
            break;
        }
    }
    if line.len() > max {
        let seen = line.len() as u64;
        line.clear();
        return Ok(LineRead::Breach(BudgetBreach::new(
            budget, max as u64, seen, "bytes",
        )));
    }
    Ok(LineRead::Line(line))
}

/// Reads a whole body up to `max`, reporting the breach instead of silently
/// handing back a truncated document. A failed read is reported as an
/// `io::Error` so the caller can keep the transport fact distinct from a
/// budget breach.
pub fn read_capped_body<R: Read>(
    reader: &mut R,
    max: usize,
    budget: BudgetName,
) -> std::io::Result<(Vec<u8>, Option<BudgetBreach>)> {
    let mut body = Vec::new();
    let mut scratch = [0u8; 16 * 1024];
    let mut breach = None;
    loop {
        match reader.read(&mut scratch) {
            Ok(0) => break,
            Ok(n) => {
                let before = body.len();
                if before.saturating_add(n) > max {
                    let room = max.saturating_sub(before);
                    body.extend_from_slice(&scratch[..room]);
                    breach = Some(BudgetBreach::new(
                        budget,
                        max as u64,
                        before.saturating_add(n) as u64,
                        "bytes",
                    ));
                    break;
                }
                body.extend_from_slice(&scratch[..n]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok((body, breach))
}

/// Counts accumulated output against one declared total.
#[derive(Debug, Clone)]
pub struct OutputMeter {
    limit: u64,
    used: u64,
}

impl OutputMeter {
    pub fn new(limit: u64) -> Self {
        Self { limit, used: 0 }
    }

    /// Charges `amount`; on the first charge that crosses the limit the
    /// excess is not counted and the breach is returned.
    pub fn charge(&mut self, amount: usize, budget: BudgetName) -> Option<BudgetBreach> {
        let next = self.used.saturating_add(amount as u64);
        if next > self.limit {
            return Some(BudgetBreach::new(budget, self.limit, next, "bytes"));
        }
        self.used = next;
        None
    }
}

/// Counts parsed events against `max_events`.
#[derive(Debug, Clone)]
pub struct EventCounter {
    limit: u64,
    seen: u64,
}

impl EventCounter {
    pub fn new(limit: u64) -> Self {
        Self { limit, seen: 0 }
    }

    pub fn one(&mut self) -> Option<BudgetBreach> {
        self.seen += 1;
        if self.seen > self.limit {
            return Some(BudgetBreach::new(
                EVENT_COUNT_BUDGET,
                self.limit,
                self.seen,
                "events",
            ));
        }
        None
    }
}

/// One framed SSE event, or the reason reading stopped.
pub enum SseFrame {
    /// The joined `data:` payload of one event (multi-line events included).
    Event(String),
    /// A declared budget was crossed; nothing further of this response is read.
    Breach(BudgetBreach),
    /// The upstream ended the body.
    End,
}

/// The one SSE framer every provider read path uses: physical line, joined
/// event, whole-stream accumulated bytes and event count all carry declared
/// ceilings, so no wire format can be flooded without a typed breach. Frames
/// are delivered per the SSE spec (consecutive `data:` lines join one event),
/// and a breach is reported as such rather than as an arbitrarily cut event.
pub struct SseFramer<R: Read> {
    reader: BufReader<R>,
    budget: StreamBudget,
    meter: OutputMeter,
    events: EventCounter,
}

impl<R: Read> SseFramer<R> {
    pub fn new(reader: R, budget: StreamBudget) -> Self {
        Self {
            reader: BufReader::new(reader),
            meter: OutputMeter::new(budget.max_total_bytes as u64),
            events: EventCounter::new(budget.max_events),
            budget,
        }
    }

    pub fn next_frame(&mut self) -> std::io::Result<SseFrame> {
        let mut data = String::new();
        let mut event_bytes = 0usize;
        loop {
            let line = match read_capped_line(
                &mut self.reader,
                self.budget.max_line_bytes,
                LINE_BUDGET,
            )? {
                LineRead::Line(line) => line,
                LineRead::End => {
                    return Ok(if data.is_empty() {
                        SseFrame::End
                    } else {
                        self.deliver(data)
                    });
                }
                LineRead::Breach(breach) => return Ok(SseFrame::Breach(breach)),
            };
            // Charge the exact wire bytes before interpreting the field.
            // Comments, event/id/retry metadata, blank lines and data
            // prefixes all consume the request's total-output allowance.
            if let Some(breach) = self.meter.charge(line.len(), TOTAL_OUTPUT_BUDGET) {
                return Ok(SseFrame::Breach(breach));
            }
            let text = String::from_utf8_lossy(&line);
            let field = text.trim_end_matches(['\n', '\r']);
            if field.is_empty() {
                if data.is_empty() {
                    continue;
                }
                return Ok(self.deliver(std::mem::take(&mut data)));
            }
            // `event:`, `id:`, `retry:` and comment lines are ignored: every
            // provider wire carries its kind inside the JSON payload.
            let Some(payload) = field.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim_start();
            let joined = if data.is_empty() {
                payload.len()
            } else {
                payload.len() + 1
            };
            if event_bytes + joined > self.budget.max_event_bytes {
                return Ok(SseFrame::Breach(BudgetBreach::new(
                    EVENT_BUDGET,
                    self.budget.max_event_bytes as u64,
                    (event_bytes + joined) as u64,
                    "bytes",
                )));
            }
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(payload);
            event_bytes += joined;
        }
    }

    fn deliver(&mut self, data: String) -> SseFrame {
        match self.events.one() {
            Some(breach) => SseFrame::Breach(breach),
            None => SseFrame::Event(data),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn lines(reader: &mut BufReader<Cursor<Vec<u8>>>, max: usize) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            match read_capped_line(reader, max, LINE_BUDGET).unwrap() {
                LineRead::Line(line) => out.push(String::from_utf8_lossy(&line).to_string()),
                LineRead::End => break,
                LineRead::Breach(breach) => {
                    out.push(format!("breach:{}", breach.budget));
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn a_line_is_reassembled_across_read_boundaries() {
        // A UTF-8 sequence split across tiny reads is still one line.
        let payload = "data: 你好世界\n".as_bytes().to_vec();
        let mut reader = BufReader::with_capacity(3, Cursor::new(payload));
        let collected = lines(&mut reader, 64);
        assert_eq!(collected, vec!["data: 你好世界\n".to_string()]);
    }

    #[test]
    fn an_overlong_line_breaches_at_the_cap_without_buffering_it() {
        let payload = vec![b'a'; 100_000];
        let mut reader = BufReader::with_capacity(4096, Cursor::new(payload));
        let collected = lines(&mut reader, 1024);
        assert_eq!(collected, vec!["breach:line".to_string()]);
    }

    #[test]
    fn a_newline_free_tail_is_still_delivered_then_end() {
        let mut reader = BufReader::new(Cursor::new(b"partial".to_vec()));
        assert_eq!(
            read_capped_line(&mut reader, 64, LINE_BUDGET).unwrap(),
            LineRead::Line(b"partial".to_vec())
        );
        assert!(matches!(
            read_capped_line(&mut reader, 64, LINE_BUDGET).unwrap(),
            LineRead::End
        ));
    }

    #[test]
    fn capped_body_reads_report_the_overflow() {
        let (body, breach) =
            read_capped_body(&mut Cursor::new(vec![b'x'; 500]), 1024, ERROR_BODY_BUDGET).unwrap();
        assert_eq!(body.len(), 500);
        assert!(breach.is_none());

        let (body, breach) =
            read_capped_body(&mut Cursor::new(vec![b'x'; 5000]), 1024, ERROR_BODY_BUDGET).unwrap();
        assert_eq!(body.len(), 1024, "never keeps more than the budget");
        let breach = breach.expect("overflow must be a typed breach");
        assert_eq!(breach.budget, ERROR_BODY_BUDGET);
        assert_eq!(breach.limit, 1024);
        assert!(breach.received > 1024);
    }

    fn frames(body: &str, budget: StreamBudget) -> Vec<String> {
        let mut framer = SseFramer::new(body.as_bytes(), budget);
        let mut out = Vec::new();
        loop {
            match framer.next_frame().unwrap() {
                SseFrame::Event(event) => out.push(event),
                SseFrame::Breach(breach) => {
                    out.push(format!("breach:{}", breach.budget));
                    break;
                }
                SseFrame::End => break,
            }
        }
        out
    }

    #[test]
    fn one_event_joins_its_data_lines_and_ignores_other_fields() {
        let body = "event: response.created\ndata: {\"a\":\ndata: 1}\n\n: keepalive\nid: 7\ndata: {\"b\":2}\n\n";
        assert_eq!(
            frames(body, StreamBudget::default()),
            vec!["{\"a\":\n1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn an_event_bigger_than_its_budget_breaches_instead_of_arriving_cut() {
        let mut budget = StreamBudget::default();
        budget.max_event_bytes = 4096;
        let body = format!("data: {}\n\ndata: {{}}\n\n", "x".repeat(20_000));
        assert_eq!(frames(&body, budget), vec!["breach:event".to_string()]);
    }

    #[test]
    fn many_small_events_stop_at_the_count_ceiling() {
        let mut budget = StreamBudget::default();
        budget.max_events = 3;
        let body = "data: 1\n\n".repeat(10);
        assert_eq!(
            frames(&body, budget),
            vec![
                "1".to_string(),
                "1".to_string(),
                "1".to_string(),
                "breach:events".to_string()
            ]
        );
    }

    #[test]
    fn the_stream_total_caps_a_flood_of_separate_events() {
        let mut budget = StreamBudget::default();
        budget.max_total_bytes = 4096;
        let body = "data: 1234567890\n\n".repeat(500);
        let framed = frames(&body, budget);
        assert_eq!(
            framed.last().map(String::as_str),
            Some("breach:totalOutput")
        );
        assert!(
            framed.len() < 501,
            "the flood stops at the cap instead of being metered out whole"
        );
    }

    #[test]
    fn the_stream_total_counts_comments_and_metadata() {
        let mut budget = StreamBudget::default();
        budget.max_total_bytes = 4096;
        let body = format!(
            ": {}\nevent: tick\nid: 1\nretry: 1000\n\n",
            "x".repeat(5000)
        );
        assert_eq!(
            frames(&body, budget),
            vec!["breach:totalOutput".to_string()],
            "ignored SSE fields still consume wire bytes"
        );
    }

    #[test]
    fn meters_charge_once_and_counter_reports_the_offending_event() {
        let mut meter = OutputMeter::new(10);
        assert!(meter.charge(6, TOTAL_OUTPUT_BUDGET).is_none());
        let breach = meter.charge(6, TOTAL_OUTPUT_BUDGET).expect("over limit");
        assert_eq!(breach.limit, 10);
        assert_eq!(breach.received, 12);
        assert!(
            meter.charge(4, TOTAL_OUTPUT_BUDGET).is_none(),
            "a rejected charge is not accumulated"
        );
        assert!(meter.charge(1, TOTAL_OUTPUT_BUDGET).is_some());

        let mut counter = EventCounter::new(2);
        assert!(counter.one().is_none());
        assert!(counter.one().is_none());
        assert!(counter.one().is_some());
    }

    #[test]
    fn declared_budgets_are_generous_and_describable() {
        let budget = StreamBudget::default();
        assert!(budget.max_line_bytes >= 8 * 1024 * 1024);
        assert!(budget.max_total_bytes >= 16 * 1024 * 1024);
        let described = budget.describe();
        assert_eq!(described["lineBytes"], budget.max_line_bytes as u64);
        assert_eq!(described["totalBytes"], budget.max_total_bytes as u64);
    }
}
