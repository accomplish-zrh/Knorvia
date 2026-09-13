//! Bounded, resumable, cancellable project-wide file and content search.
//!
//! The daemon serves every RPC on a single control thread, so a whole-project
//! search must never run to completion inside one request. Each
//! `workspace/files/search` call serves one page of matches produced by a
//! small wall-clock-bounded slice of a resumable depth-first walk held in an
//! in-memory session. Cancelling removes the session, which really stops the
//! traversal (there is no background work), and idle sessions expire.
//!
//! Scope is explicit and conservative: the walk starts at the workspace's
//! canonical root, never follows symlinks, skips VCS internals, hidden
//! directories and `node_modules`, honours a simple root `.gitignore` subset,
//! and never reads more than [`SEARCH_MAX_CONTENT_FILE_BYTES`] of any file for
//! content matches. Coverage counters let the UI state exactly what was
//! searched instead of implying a whole-corpus zero.

use crate::ControlPlane;
use crate::project_context::WorkspaceScope;
use knorvia_protocol::{ErrorCategory, ProtocolError};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

const SEARCH_SLICE: Duration = Duration::from_millis(250);
const SEARCH_SESSION_TTL: Duration = Duration::from_secs(60);
const SEARCH_DONE_TTL: Duration = Duration::from_secs(10);
const SEARCH_MAX_EMITTED: u64 = 2_000;
const SEARCH_MAX_CONTENT_FILE_BYTES: u64 = 1024 * 1024;
const SEARCH_BINARY_PROBE_BYTES: usize = 8 * 1024;
const SEARCH_SNIPPET_CHARS: usize = 240;
const SEARCH_MAX_MATCHES_PER_FILE: usize = 5;
const SEARCH_MAX_MATCH_COUNT_REPORT: u64 = 999;
const SEARCH_MAX_RULES_PER_GITIGNORE: usize = 512;
const SEARCH_MAX_TOTAL_RULES: usize = 4_096;
const SEARCH_MAX_ENTRIES_PER_RPC: usize = 256;
const SEARCH_MAX_SESSIONS: usize = 16;
const SEARCH_MAX_DEPTH: usize = 128;
const SEARCH_MAX_IGNORE_BYTES: u64 = 64 * 1024;
const SEARCH_MAX_QUERY_BYTES: usize = 256;
const SEARCH_MAX_PATH_BYTES: usize = 4 * 1024;
const SEARCH_DEFAULT_PAGE: usize = 50;
const SEARCH_MAX_PAGE: usize = 200;
/// VCS internals and dependency trees are skipped even without a .gitignore;
/// everything else follows the project's own ignore file.
const ALWAYS_IGNORED_DIRS: [&str; 5] = [".git", ".hg", ".svn", "node_modules", ".knorvia"];

// --- request parameters ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchMode {
    Paths,
    Content,
    Both,
}

impl SearchMode {
    fn parse(value: Option<&str>) -> Result<Self, ProtocolError> {
        match value {
            None | Some("both") => Ok(Self::Both),
            Some("paths") => Ok(Self::Paths),
            Some("content") => Ok(Self::Content),
            Some(other) => Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("mode must be paths, content, or both, not {other}"),
            )),
        }
    }

    fn searches_paths(self) -> bool {
        matches!(self, Self::Paths | Self::Both)
    }

    fn searches_content(self) -> bool {
        matches!(self, Self::Content | Self::Both)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Paths => "paths",
            Self::Content => "content",
            Self::Both => "both",
        }
    }
}

#[derive(Debug, Clone)]
struct SearchPlan {
    query: String,
    needle: String,
    mode: SearchMode,
    case_sensitive: bool,
    page_size: usize,
}

// --- ignore rules (simple .gitignore subset) ---------------------------------

#[derive(Debug, Clone)]
struct IgnoreRule {
    /// Directory-relative path the pattern is anchored to ("" = project root).
    base: String,
    pattern: String,
    dir_only: bool,
    /// Patterns containing a slash anywhere (including a leading one) match
    /// from their base directory, like gitignore; bare names match any path
    /// segment.
    anchored: bool,
}

#[derive(Debug)]
struct IgnoreSet {
    rules: Vec<IgnoreRule>,
    #[allow(dead_code)] // surfaced in tests; the walk keeps working when set
    overflow: bool,
}

impl IgnoreSet {
    fn empty() -> Self {
        Self {
            rules: Vec::new(),
            overflow: false,
        }
    }

    fn parse(&mut self, base: &str, text: &str) {
        let mut taken = 0;
        for raw in text.lines() {
            if taken >= SEARCH_MAX_RULES_PER_GITIGNORE || self.rules.len() >= SEARCH_MAX_TOTAL_RULES
            {
                self.overflow = true;
                break;
            }
            let line = raw.trim_end();
            let line = line.strip_suffix('\r').unwrap_or(line);
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if line.starts_with('!') {
                // Negation is outside this subset; the entry stays ignored.
                continue;
            }
            let dir_only = line.ends_with('/');
            let body = line.trim_end_matches('/');
            if body.is_empty() {
                continue;
            }
            let anchored = body.contains('/') || body.starts_with('/');
            let pattern = body.trim_start_matches('/').to_string();
            if pattern.is_empty() {
                continue;
            }
            self.rules.push(IgnoreRule {
                base: base.to_string(),
                pattern,
                dir_only,
                anchored,
            });
            taken += 1;
        }
    }

    fn matches(&self, relative: &str, is_dir: bool) -> bool {
        self.rules.iter().any(|rule| {
            if rule.dir_only && !is_dir {
                return false;
            }
            // A rule from directory D applies only to entries inside D.
            let rest = if rule.base.is_empty() {
                relative
            } else if relative == rule.base.as_str() {
                return false;
            } else if let Some(rest) = relative.strip_prefix(&format!("{}/", rule.base)) {
                rest
            } else {
                return false;
            };
            if rule.anchored {
                glob_match(rule.pattern.as_str(), rest)
            } else {
                rest.split('/')
                    .any(|segment| glob_match(rule.pattern.as_str(), segment))
            }
        })
    }
}

/// Shell-style glob with `*` matching within one path segment and `?` matching
/// one character; everything else is literal. `**` is treated as two segment
/// stars and therefore does not span slashes (documented subset).
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    // Iterative two-pointer with backtracking on the last '*'.
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut star_t) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            star_t = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            star_t += 1;
            ti = star_t;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

// --- traversal state ---------------------------------------------------------

#[derive(Debug)]
struct DirFrame {
    relative: String,
    entries: fs::ReadDir,
}

#[derive(Debug, Default, Clone)]
struct SearchCoverage {
    scanned_files: u64,
    scanned_directories: u64,
    matched_files: u64,
    skipped_binary: u64,
    skipped_large: u64,
    skipped_symlink: u64,
    ignored_entries: u64,
    unreadable: u64,
    bytes_scanned: u64,
    other_entries: u64,
    enumerated_entries: u64,
    skipped_directories: u64,
}

impl SearchCoverage {
    fn to_value(&self) -> Value {
        json!({
            "scannedFiles": self.scanned_files,
            "scannedDirectories": self.scanned_directories,
            "matchedFiles": self.matched_files,
            "skippedBinary": self.skipped_binary,
            "skippedLarge": self.skipped_large,
            "skippedSymlink": self.skipped_symlink,
            "ignoredEntries": self.ignored_entries,
            "unreadable": self.unreadable,
            "bytesScanned": self.bytes_scanned,
            "otherEntries": self.other_entries,
            "enumeratedEntries": self.enumerated_entries,
            "skippedDirectories": self.skipped_directories,
        })
    }
}

#[derive(Debug)]
pub(crate) struct ProjectSearchSession {
    scope: WorkspaceScope,
    plan: SearchPlan,
    stack: Vec<DirFrame>,
    ignore: IgnoreSet,
    buffer: VecDeque<Value>,
    /// Pages already handed out; the next cursor must request exactly this.
    page: usize,
    emitted: u64,
    seen_matches: HashSet<String>,
    limit_reached: bool,
    done: bool,
    last_touched: Instant,
    coverage: SearchCoverage,
}

impl ProjectSearchSession {
    fn start(scope: WorkspaceScope, plan: SearchPlan) -> Result<Self, ProtocolError> {
        let mut session = Self {
            scope,
            plan,
            stack: Vec::new(),
            ignore: IgnoreSet::empty(),
            buffer: VecDeque::new(),
            page: 0,
            emitted: 0,
            seen_matches: HashSet::new(),
            limit_reached: false,
            done: false,
            last_touched: Instant::now(),
            coverage: SearchCoverage::default(),
        };
        session.push_directory("");
        Ok(session)
    }

    fn push_directory(&mut self, relative: &str) {
        if self.stack.len() >= SEARCH_MAX_DEPTH {
            self.coverage.skipped_directories += 1;
            return;
        }
        let base = self.scope.cwd.join(relative);
        // Load rules before enumerating any entries, independent of directory order.
        let ignore_path = base.join(".gitignore");
        if fs::symlink_metadata(&ignore_path)
            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
        {
            if let Ok(file) = fs::File::open(ignore_path) {
                let mut bytes = Vec::new();
                if file
                    .take(SEARCH_MAX_IGNORE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .is_ok()
                {
                    if bytes.len() as u64 > SEARCH_MAX_IGNORE_BYTES {
                        self.ignore.overflow = true;
                        bytes.truncate(SEARCH_MAX_IGNORE_BYTES as usize);
                    }
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        self.ignore.parse(relative, text);
                    }
                }
            }
        }
        match fs::read_dir(&base) {
            Ok(entries) => self.stack.push(DirFrame {
                relative: relative.to_owned(),
                entries,
            }),
            Err(_) => {
                self.coverage.unreadable += 1;
                return;
            }
        }
        self.coverage.scanned_directories += 1;
    }

    fn is_ignored(&self, relative: &str, is_dir: bool, name: &str) -> bool {
        if is_dir {
            let lower = name.to_lowercase();
            if name.starts_with('.') || ALWAYS_IGNORED_DIRS.contains(&lower.as_str()) {
                return true;
            }
        }
        self.ignore.matches(relative, is_dir)
    }

    /// A single RPC owns one deadline and one enumeration budget. Empty pages
    /// are valid progress: their monotonically increasing page cursor resumes
    /// the same open directory iterators without rescanning a prefix.
    fn next_page(&mut self, page_size: usize, deadline: Instant) -> Vec<Value> {
        let mut page = Vec::with_capacity(page_size);
        while page.len() < page_size {
            match self.buffer.pop_front() {
                Some(value) => page.push(value),
                None => break,
            }
        }
        if page.len() < page_size && !self.done && !self.limit_reached {
            self.run_slice(deadline);
            while page.len() < page_size {
                match self.buffer.pop_front() {
                    Some(value) => page.push(value),
                    None => break,
                }
            }
        }
        page
    }

    fn run_slice(&mut self, deadline: Instant) {
        let mut entries = 0;
        while !self.stack.is_empty()
            && !self.limit_reached
            && self.buffer.len() < self.plan.page_size
            && Instant::now() < deadline
            && entries < SEARCH_MAX_ENTRIES_PER_RPC
        {
            let entry = match self.stack.last_mut().expect("checked").entries.next() {
                Some(Ok(entry)) => entry,
                Some(Err(_)) => {
                    self.coverage.unreadable += 1;
                    entries += 1;
                    continue;
                }
                None => {
                    self.stack.pop();
                    continue;
                }
            };
            entries += 1;
            self.coverage.enumerated_entries += 1;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => {
                    self.coverage.unreadable += 1;
                    continue;
                }
            };
            let is_symlink = metadata.file_type().is_symlink();
            let is_dir = metadata.is_dir() && !is_symlink;
            let relative = if self
                .stack
                .last()
                .map(|frame| frame.relative.is_empty())
                .unwrap_or(true)
            {
                name.clone()
            } else {
                format!("{}/{}", self.stack.last().expect("checked").relative, name)
            };
            if relative.len() > SEARCH_MAX_PATH_BYTES {
                self.coverage.ignored_entries += 1;
                continue;
            }
            if is_symlink {
                self.coverage.skipped_symlink += 1;
                // Symlinks can be named by path search but are never followed.
                if self.plan.mode.searches_paths() && self.path_matches(&relative) {
                    self.emit_path_match(&relative, "symlink");
                }
                continue;
            }
            if is_dir {
                if self.is_ignored(&relative, true, &name) {
                    self.coverage.ignored_entries += 1;
                    continue;
                }
                // Directories are name-searchable too, but never traversed
                // as content.
                if self.plan.mode.searches_paths() && self.path_matches(&relative) {
                    self.emit_path_match(&relative, "directory");
                }
                self.push_directory(&relative);
                continue;
            }
            if self.is_ignored(&relative, false, &name) {
                self.coverage.ignored_entries += 1;
                continue;
            }
            self.coverage.scanned_files += 1;
            if self.plan.mode.searches_paths() && self.path_matches(&relative) {
                self.emit_path_match(&relative, "file");
                continue;
            }
            if self.plan.mode.searches_content() {
                self.scan_content(&relative, &path);
            }
        }
        if self.stack.is_empty() {
            self.done = true;
        }
    }

    fn path_matches(&self, relative: &str) -> bool {
        if self.plan.case_sensitive {
            relative.contains(&self.plan.query)
        } else {
            relative.to_lowercase().contains(&self.plan.needle)
        }
    }

    fn emit_path_match(&mut self, relative: &str, kind: &str) {
        let name = relative.rsplit('/').next().unwrap_or(relative).to_string();
        self.push_match(json!({
            "path": relative,
            "name": name,
            "kind": kind,
        }));
        self.coverage.matched_files += 1;
    }

    fn push_match(&mut self, value: Value) {
        if self.emitted >= SEARCH_MAX_EMITTED {
            return;
        }
        let identity = format!(
            "{}:{}:{}:{}",
            value["path"], value["line"], value["column"], value["kind"]
        );
        if !self.seen_matches.insert(identity) {
            return;
        }
        self.emitted += 1;
        if self.emitted >= SEARCH_MAX_EMITTED {
            self.limit_reached = true;
        }
        self.buffer.push_back(value);
    }

    fn scan_content(&mut self, relative: &str, path: &Path) {
        let Ok(metadata) = fs::metadata(path) else {
            self.coverage.unreadable += 1;
            return;
        };
        if !metadata.is_file() {
            self.coverage.other_entries += 1;
            return;
        }
        if metadata.len() > SEARCH_MAX_CONTENT_FILE_BYTES {
            self.coverage.skipped_large += 1;
            return;
        }
        let mut file = match fs::File::open(path) {
            Ok(file) => file,
            Err(_) => {
                self.coverage.unreadable += 1;
                return;
            }
        };
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        if file.read_to_end(&mut bytes).is_err() {
            self.coverage.unreadable += 1;
            return;
        }
        let probe_len = bytes.len().min(SEARCH_BINARY_PROBE_BYTES);
        if looks_binary(&bytes[..probe_len]) {
            self.coverage.skipped_binary += 1;
            return;
        }
        self.coverage.bytes_scanned += bytes.len() as u64;
        let text = String::from_utf8_lossy(&bytes);
        let needle = if self.plan.case_sensitive {
            self.plan.query.clone()
        } else {
            self.plan.needle.clone()
        };
        // Count every hit, but keep at most the first few as page entries so
        // one chatty file cannot flood the results.
        let mut total_in_file = 0u64;
        let mut recorded: Vec<(usize, usize, String)> = Vec::new();
        for (index, line) in text.split('\n').enumerate() {
            let hay = if self.plan.case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            let Some(byte_index) = hay.find(&needle) else {
                continue;
            };
            total_in_file += 1;
            if recorded.len() >= SEARCH_MAX_MATCHES_PER_FILE {
                continue;
            }
            let chars_before = hay[..byte_index].chars().count();
            // The lowercased line's char index maps back to the original line
            // (lowercasing can expand a char, so re-walk the original).
            let original_chars = map_lower_char_index(line, chars_before);
            recorded.push((
                index + 1,
                original_chars + 1,
                snippet_around(line, original_chars),
            ));
        }
        if total_in_file == 0 {
            return;
        }
        self.coverage.matched_files += 1;
        let name = relative.rsplit('/').next().unwrap_or(relative);
        let count = json!(total_in_file.min(SEARCH_MAX_MATCH_COUNT_REPORT));
        for (line, column, snippet) in recorded {
            self.push_match(json!({
                "path": relative,
                "name": name,
                "kind": "file",
                "line": line,
                "column": column,
                "snippet": snippet,
                "matchCount": count.clone(),
            }));
        }
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
        || matches!(
            std::str::from_utf8(bytes),
            Err(error) if error.error_len().is_some()
        )
}

/// The index (in chars) of the original character whose lowercase form produced
/// `lower_char_index`. Falls back to the requested index when mapping is
/// impossible.
fn map_lower_char_index(original: &str, lower_char_index: usize) -> usize {
    let mut produced = 0usize;
    let mut source_chars = 0usize;
    for ch in original.chars() {
        if produced >= lower_char_index {
            return source_chars;
        }
        produced += ch.to_lowercase().count();
        source_chars += 1;
    }
    source_chars
}

/// A bounded snippet of the original (non-lowercased) line around the match,
/// with ellipses when content was cut.
fn snippet_around(line: &str, match_char_index: usize) -> String {
    let all: Vec<char> = line.chars().collect();
    let half = SEARCH_SNIPPET_CHARS / 2;
    let start = match_char_index.saturating_sub(half);
    let end = (match_char_index + half).min(all.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(&all[start..end]);
    if end < all.len() {
        snippet.push('…');
    }
    snippet
}

// --- registry ----------------------------------------------------------------

#[derive(Default)]
pub(crate) struct ProjectSearchRegistry {
    sessions: HashMap<String, ProjectSearchSession>,
    next_id: u64,
    request_budget: Option<Duration>,
}

struct SearchRequest {
    scope: WorkspaceScope,
    plan: SearchPlan,
    search_id: Option<String>,
    cursor: Option<usize>,
}

fn parse_search_request(
    control: &ControlPlane,
    params: &Value,
) -> Result<SearchRequest, ProtocolError> {
    let scope = control.resolve_workspace_scope(params)?;
    let query = match params.get("query").and_then(Value::as_str) {
        Some(query) if !query.is_empty() => query.to_string(),
        Some(_) => {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "query must be a non-empty string",
            ));
        }
        None => {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "missing string field query",
            ));
        }
    };
    if query.len() > SEARCH_MAX_QUERY_BYTES {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("query must be at most {SEARCH_MAX_QUERY_BYTES} bytes"),
        ));
    }
    let mode = SearchMode::parse(params.get("mode").and_then(Value::as_str))?;
    let case_sensitive = match params.get("caseSensitive") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "caseSensitive must be a boolean",
            ));
        }
    };
    let page_size = match params.get("maxResults") {
        None | Some(Value::Null) => SEARCH_DEFAULT_PAGE,
        Some(value) => {
            let requested = value.as_u64().ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "maxResults must be a positive integer",
                )
            })? as usize;
            if requested == 0 || requested > SEARCH_MAX_PAGE {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    format!("maxResults must be between 1 and {SEARCH_MAX_PAGE}"),
                ));
            }
            requested
        }
    };
    let plan = SearchPlan {
        needle: query.to_lowercase(),
        query,
        mode,
        case_sensitive,
        page_size,
    };
    let search_id = match params.get("searchId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(_) => {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "searchId must be a string",
            ));
        }
    };
    let cursor = match params.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.parse::<usize>().map_err(|_| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "cursor must be a non-negative decimal page number",
            )
        })?),
        Some(_) => {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "cursor must be a string",
            ));
        }
    };
    Ok(SearchRequest {
        scope,
        plan,
        search_id,
        cursor,
    })
}

fn sweep_expired_sessions(registry: &mut ProjectSearchRegistry) {
    let now = Instant::now();
    registry.sessions.retain(|_, session| {
        let lifetime = if session.done || session.limit_reached {
            SEARCH_DONE_TTL
        } else {
            SEARCH_SESSION_TTL
        };
        now.duration_since(session.last_touched) < lifetime
    });
}

impl ControlPlane {
    pub(crate) fn rpc_workspace_files_search(
        &mut self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let deadline = Instant::now() + self.project_search.request_budget.unwrap_or(SEARCH_SLICE);
        let request = parse_search_request(self, params)?;
        sweep_expired_sessions(&mut self.project_search);

        let search_id = match &request.search_id {
            Some(search_id) => search_id.clone(),
            None => {
                if self.project_search.sessions.len() >= SEARCH_MAX_SESSIONS {
                    return Err(ProtocolError::new(
                        ErrorCategory::ResourceExhausted,
                        "too many search sessions; cancel a search or wait for expiry",
                    ));
                }
                if request.cursor.is_some_and(|cursor| cursor != 0) {
                    return Err(ProtocolError::new(
                        ErrorCategory::InvalidArgument,
                        "new searches must start at page zero",
                    ));
                }
                let search_id = format!("ps-{:06}", self.project_search.next_id);
                self.project_search.next_id += 1;
                let session =
                    ProjectSearchSession::start(request.scope.clone(), request.plan.clone())?;
                self.project_search
                    .sessions
                    .insert(search_id.clone(), session);
                search_id
            }
        };
        let Some(session) = self.project_search.sessions.get_mut(&search_id) else {
            return Err(ProtocolError::new(
                ErrorCategory::NotFound,
                "this search has expired or was cancelled; start a new search",
            ));
        };
        // Guard against a stale caller mixing pages of an older query into a
        // newer one: plan values must match the session.
        if session.plan.query != request.plan.query
            || session.plan.mode != request.plan.mode
            || session.plan.case_sensitive != request.plan.case_sensitive
            || session.scope.cwd != request.scope.cwd
            || session.scope.workspace_value() != request.scope.workspace_value()
        {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "search parameters changed; start a new search",
            ));
        }
        let expected = session.page;
        // An absent cursor always means page 0 (the first call of a search).
        if request.cursor.unwrap_or(0) != expected {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("cursor must request page {expected} of this search"),
            ));
        }
        session.last_touched = Instant::now();
        let page = session.next_page(session.plan.page_size, deadline);
        let (index, next_page) = (session.page, session.page + 1);
        session.page += 1;
        let (done, limit_reached, emitted, coverage, scope, mode, query, case_sensitive) = (
            session.done,
            session.limit_reached,
            session.emitted,
            session.coverage.clone(),
            session.scope.workspace_value(),
            session.plan.mode.as_str(),
            session.plan.query.clone(),
            session.plan.case_sensitive,
        );
        let has_more = (!done && !limit_reached) || !session.buffer.is_empty();
        let mut coverage = coverage.to_value();
        coverage["complete"] = json!(
            done && coverage["unreadable"] == 0
                && coverage["skippedDirectories"] == 0
                && !session.ignore.overflow
        );
        let remaining_known =
            done && session.coverage.skipped_directories == 0 && session.coverage.unreadable == 0;
        coverage["unscannedEntries"] = if remaining_known {
            json!(0)
        } else {
            Value::Null
        };
        coverage["unscannedEntriesKnown"] = json!(remaining_known);
        coverage["pendingDirectories"] = json!(session.stack.len());
        coverage["ignoreRulesTruncated"] = json!(session.ignore.overflow);
        Ok(json!({
            "workspace": scope,
            "searchId": search_id,
            "query": {"text": query, "mode": mode, "caseSensitive": case_sensitive},
            "matches": page,
            "page": {
                "index": index,
                "nextCursor": has_more.then(|| next_page.to_string()),
                "done": done,
            },
            "coverage": coverage,
            "matchedTotal": emitted,
            "matchedLimitReached": limit_reached,
            "scope": {
                "root": scope.get("cwd").cloned().unwrap_or(Value::Null),
                "followsSymlinks": false,
                "skipsHiddenDirectories": true,
                "alwaysSkippedDirectories": ALWAYS_IGNORED_DIRS,
                "honoursRootGitignore": true,
                "maxContentFileBytes": SEARCH_MAX_CONTENT_FILE_BYTES,
            },
        }))
    }

    pub(crate) fn rpc_workspace_files_search_cancel(
        &mut self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let search_id = params
            .get("searchId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "missing string field searchId",
                )
            })?;
        sweep_expired_sessions(&mut self.project_search);
        match self.project_search.sessions.remove(search_id) {
            Some(session) => Ok(json!({"cancelled": true, "searchId": search_id,
                "coverage": session.coverage.to_value(), "complete": false,
                "unscannedEntries": null, "pendingDirectories": session.stack.len()})),
            None => Err(ProtocolError::new(
                ErrorCategory::NotFound,
                "this search has already expired or was cancelled",
            )),
        }
    }
}

#[cfg(test)]
mod tests;
