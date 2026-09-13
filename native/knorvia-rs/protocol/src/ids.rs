use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn new_id(prefix: &str) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mix = ms ^ (n.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    format!("{prefix}_{ms:x}{mix:08x}")
}

pub fn workspace_id() -> String {
    new_id("ws")
}
pub fn goal_id() -> String {
    new_id("goal")
}
pub fn task_id() -> String {
    new_id("task")
}
pub fn thread_id() -> String {
    new_id("thr")
}
pub fn turn_id() -> String {
    new_id("turn")
}
pub fn item_id() -> String {
    new_id("item")
}
pub fn artifact_id() -> String {
    new_id("art")
}
pub fn revision_id() -> String {
    new_id("rev")
}
pub fn job_id() -> String {
    new_id("job")
}
pub fn event_id() -> String {
    new_id("evt")
}
pub fn session_id() -> String {
    new_id("sess")
}
pub fn agent_id() -> String {
    new_id("agt")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_prefixed_and_unique() {
        let mut seen = HashSet::new();
        for _ in 0..200 {
            let id = workspace_id();
            assert!(id.starts_with("ws_"));
            assert!(seen.insert(id));
        }
    }
}
pub fn goal_execution_id() -> String {
    new_id("gexec")
}
