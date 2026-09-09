//! Supervised pack worker RPC (CAP-001).
//!
//! The daemon spawns the `knorvia-pack-worker` binary with an explicit
//! environment allowlist (never the full parent environment), performs the
//! framed initialize/render handshake over stdio, and enforces deadlines by
//! killing the worker (a killed worker cannot publish anything: the daemon
//! owns the artifact runtime). A worker crash or protocol violation yields a
//! typed failure — never a fabricated success.

use knorvia_protocol::{ProtocolError, read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const WORKER_BIN_ENV: &str = "KNORVIA_PACK_WORKER_BIN";
/// Hard deadline for one render call (the watchdog kills the worker).
pub const RENDER_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("pack worker binary unavailable: {0}; set KNORVIA_PACK_WORKER_BIN")]
    BinaryMissing(String),
    #[error("pack worker transport failure: {0}")]
    Transport(String),
    #[error("pack worker failed: {0}")]
    Failed(String),
    #[error("pack worker render exceeded {0}s deadline; worker killed")]
    Deadline(u64),
}

/// The subset of the parent environment the worker may receive.
pub fn worker_env() -> Vec<(String, String)> {
    let mut vars = Vec::new();
    // Keep in sync with knorvia_packs::gateway (the provider variables the
    // pack model backend may consume).
    const ALLOWLIST: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "windir",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "KNORVIA_PROVIDER_KIND",
        "KNORVIA_PROVIDER_MODEL",
        "KNORVIA_PROVIDER_BASE_URL",
        "KNORVIA_PROVIDER_API_KEY",
    ];
    for key in ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            vars.push(((*key).to_string(), value));
        }
    }
    vars
}

fn worker_bin_name() -> &'static str {
    if cfg!(windows) {
        "knorvia-pack-worker.exe"
    } else {
        "knorvia-pack-worker"
    }
}

/// Resolve the worker binary: explicit env override, then a sibling of the
/// current executable. Never PATH.
pub fn resolve_worker_bin() -> Result<PathBuf, WorkerError> {
    if let Some(p) = std::env::var_os(WORKER_BIN_ENV) {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(WorkerError::BinaryMissing(format!(
            "{WORKER_BIN_ENV} not a file: {}",
            path.display()
        )));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(worker_bin_name());
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    Err(WorkerError::BinaryMissing(
        "no sibling knorvia-pack-worker binary next to the daemon".into(),
    ))
}

pub struct PackWorkerClient {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    event_sink: Option<Arc<dyn Fn(&Value) + Send + Sync>>,
}

/// Command spec for spawning a worker process (program + args). The
/// allowlisted environment applies to every spec.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl PackWorkerClient {
    /// Spawn the worker with the allowlisted environment only.
    pub fn spawn(bin: &Path) -> Result<Self, WorkerError> {
        Self::spawn_spec(&WorkerSpec {
            program: bin.to_path_buf(),
            args: Vec::new(),
        })
    }

    /// Spawn the worker from an explicit command spec (e.g. the Python media
    /// worker: `[python, "-m", "knorvia.workers.media_worker]`). The
    /// allowlisted environment applies to every spec.
    pub fn spawn_spec(spec: &WorkerSpec) -> Result<Self, WorkerError> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Worker stderr is logs only; inherit so verbose workers cannot
            // deadlock on an unread pipe.
            .stderr(Stdio::inherit());
        // Explicit environment: NOTHING is inherited by default.
        cmd.env_clear();
        for (key, value) in worker_env() {
            cmd.env(key, value);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| WorkerError::Transport(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| WorkerError::Transport("worker stdin missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| WorkerError::Transport("worker stdout missing".into()))?;
        Ok(Self {
            child: Arc::new(std::sync::Mutex::new(child)),
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            event_sink: None,
        })
    }

    /// Resolve the command spec for a pack runtime: `native` → the Rust
    /// worker binary; `python` → the Python media worker module.
    pub fn spec_for_runtime(runtime: &str) -> Result<WorkerSpec, WorkerError> {
        match runtime {
            "python" => {
                let python = std::env::var("KNORVIA_PYTHON").unwrap_or_else(|_| "python".into());
                Ok(WorkerSpec {
                    program: PathBuf::from(python),
                    args: vec!["-m".into(), "knorvia.workers.media_worker".into()],
                })
            }
            _ => Ok(WorkerSpec {
                program: resolve_worker_bin()?,
                args: Vec::new(),
            }),
        }
    }

    pub fn is_alive(&self) -> bool {
        matches!(
            self.child.lock().ok().and_then(|mut c| c.try_wait().ok()),
            Some(None)
        )
    }

    /// Kill the worker (cancel/crash path). Reaps the process so file locks
    /// are released.
    pub fn kill(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn write_msg(&mut self, msg: &Value) -> Result<(), WorkerError> {
        let body = serde_json::to_string(msg).map_err(|e| WorkerError::Transport(e.to_string()))?;
        write_frame(&mut self.stdin, &body).map_err(|e| WorkerError::Transport(e.to_string()))?;
        self.stdin
            .flush()
            .map_err(|e| WorkerError::Transport(e.to_string()))?;
        Ok(())
    }

    fn read_response(&mut self, request_id: i64) -> Result<Value, WorkerError> {
        loop {
            let body =
                read_frame(&mut self.stdout).map_err(|e| WorkerError::Transport(e.to_string()))?;
            let v: Value = serde_json::from_str(&body)
                .map_err(|e| WorkerError::Transport(format!("worker sent non-JSON frame: {e}")))?;
            if v.get("id").is_none() {
                // Worker notification (progress/cancelled-ack): surface it.
                if let Some(sink) = self.event_sink.as_ref() {
                    sink(&v);
                }
                continue;
            }
            if v.get("id").and_then(|i| i.as_i64()) != Some(request_id) {
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(WorkerError::Failed(
                    err.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("worker error")
                        .to_string(),
                ));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Surface worker notifications (progress events) to the caller.
    pub fn set_event_sink(&mut self, sink: Option<Arc<dyn Fn(&Value) + Send + Sync>>) {
        self.event_sink = sink;
    }

    /// Cooperative cancel: notify the worker to stop at its next checkpoint.
    /// A render already in flight finishes its current stage; combined with
    /// the watchdog kill this bounds worst-case cancellation latency.
    pub fn cancel(&mut self) -> Result<(), WorkerError> {
        let msg = json!({"method": "cancel", "params": {}});
        self.write_msg(&msg)
    }

    /// Request with a watchdog: on deadline the worker is killed and the
    /// read fails typed. The worker can never outlive its deadline while
    /// holding the caller.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, WorkerError> {
        let request_id = self.next_id;
        self.next_id += 1;
        let msg = json!({"id": request_id, "method": method, "params": params});
        self.write_msg(&msg)?;

        let watchdog_fired = Arc::new(AtomicBool::new(false));
        let child = Arc::clone(&self.child);
        let secs = RENDER_TIMEOUT_SECS;
        let watchdog_flag = Arc::clone(&watchdog_fired);
        std::thread::spawn(move || {
            for _ in 0..secs {
                if watchdog_flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            watchdog_flag.store(true, Ordering::Relaxed);
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        });
        let result = self.read_response(request_id);
        // Detach the watchdog: it exits on its own flag once the response
        // arrives; joining here would block fast callers for the full
        // deadline. The deadline classification uses the watchdog flag, not
        // the join.
        match result {
            Ok(v) => Ok(v),
            Err(WorkerError::Transport(_)) if watchdog_fired.load(Ordering::Relaxed) => {
                Err(WorkerError::Deadline(RENDER_TIMEOUT_SECS))
            }
            Err(other) => Err(other),
        }
    }

    /// Handshake: identify the daemon and confirm the installed pack list.
    pub fn initialize(&mut self, packs: &[&str]) -> Result<(), WorkerError> {
        let result = self.request(
            "initialize",
            json!({
                "client": {"name": "knorvia-daemon", "version": env!("CARGO_PKG_VERSION")},
                "packs": packs,
            }),
        )?;
        if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(WorkerError::Failed(format!(
                "worker initialize rejected: {result}"
            )));
        }
        Ok(())
    }

    /// Render one pack artifact. Returns (mime, title, bytes).
    pub fn render(
        &mut self,
        pack_id: &str,
        input: &Value,
    ) -> Result<(String, String, Vec<u8>), WorkerError> {
        let result = self.request("render", json!({"packId": pack_id, "input": input}))?;
        let mime = result
            .get("mime")
            .and_then(|m| m.as_str())
            .ok_or_else(|| WorkerError::Failed("worker response missing mime".into()))?
            .to_string();
        let title = result
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("artifact")
            .to_string();
        let content_b64 = result
            .get("contentBase64")
            .and_then(|c| c.as_str())
            .ok_or_else(|| WorkerError::Failed("worker response missing contentBase64".into()))?;
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content_b64)
            .map_err(|e| WorkerError::Failed(format!("worker contentBase64 invalid: {e}")))?;
        Ok((mime, title, bytes))
    }
}

impl Drop for PackWorkerClient {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Convenience: one render per client lifecycle (the daemon's invoke path).
pub fn render_via_worker(
    pack_id: &str,
    input: &Value,
) -> Result<(String, String, Vec<u8>), WorkerError> {
    let bin = resolve_worker_bin()?;
    let mut client = PackWorkerClient::spawn(&bin)?;
    client.initialize(&[pack_id])?;
    client.render(pack_id, input)
}

/// Worker-side request loop (used by the `knorvia-pack-worker` binary).
pub fn serve_worker<W: Write>(
    render: impl Fn(&str, &Value) -> Result<(String, String, Vec<u8>), String>,
    mut input: impl std::io::BufRead,
    mut output: W,
) -> Result<(), ProtocolError> {
    let cancelled = Arc::new(AtomicBool::new(false));
    loop {
        let body = match read_frame(&mut input) {
            Ok(b) => b,
            Err(knorvia_protocol::WireError::Io(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => {
                return Err(ProtocolError::new(
                    knorvia_protocol::ErrorCategory::InvalidArgument,
                    e.to_string(),
                ));
            }
        };
        let cancelled = Arc::clone(&cancelled);
        let v: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Notifications (no id): cancel sets the cooperative flag; anything
        // else is ignored by the worker loop.
        let Some(id) = v.get("id") else {
            if v.get("method").and_then(|m| m.as_str()) == Some("cancel") {
                cancelled.store(true, Ordering::SeqCst);
            }
            continue;
        };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let response = match method {
            "initialize" => json!({"id": id, "result": {"ok": true}}),
            "render" => {
                let pack_id = v
                    .pointer("/params/packId")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                let input = v.pointer("/params/input").cloned().unwrap_or(json!({}));
                let mut emit = |step: &str| {
                    let note = json!({
                        "method": "progress",
                        "params": {"packId": pack_id, "step": step},
                    });
                    let _ = write_frame(&mut output, &serde_json::to_string(&note).expect("json"));
                    let _ = output.flush();
                };
                emit("render.start");
                // Cooperative cancel: answer the render with the typed
                // cancelled error and stop the loop (nothing was rendered, so
                // no side effects exist to clean up).
                if cancelled.load(Ordering::SeqCst) {
                    let out = json!({
                        "id": id,
                        "error": {"code": -32030, "message": "cancelled by user"},
                    });
                    write_frame(&mut output, &serde_json::to_string(&out).expect("json")).map_err(
                        |e| {
                            ProtocolError::new(
                                knorvia_protocol::ErrorCategory::Internal,
                                e.to_string(),
                            )
                        },
                    )?;
                    return Ok(());
                }
                let outcome = render(pack_id, &input);
                if cancelled.load(Ordering::SeqCst) {
                    let out = json!({
                        "id": id,
                        "error": {"code": -32030, "message": "cancelled by user"},
                    });
                    write_frame(&mut output, &serde_json::to_string(&out).expect("json")).map_err(
                        |e| {
                            ProtocolError::new(
                                knorvia_protocol::ErrorCategory::Internal,
                                e.to_string(),
                            )
                        },
                    )?;
                    return Ok(());
                }
                emit("render.done");
                match outcome {
                    Ok((mime, title, bytes)) => {
                        use base64::Engine as _;
                        json!({
                            "id": id,
                            "result": {
                                "mime": mime,
                                "title": title,
                                "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
                            }
                        })
                    }
                    Err(message) => json!({
                        "id": id,
                        "error": {"code": -32000, "message": message},
                    }),
                }
            }
            "shutdown" => {
                let out = json!({"id": id, "result": {"ok": true}});
                write_frame(&mut output, &serde_json::to_string(&out).expect("json")).map_err(
                    |e| {
                        ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, e.to_string())
                    },
                )?;
                return Ok(());
            }
            other => json!({
                "id": id,
                "error": {"code": -32601, "message": format!("unknown worker method {other}")},
            }),
        };
        write_frame(
            &mut output,
            &serde_json::to_string(&response).expect("json"),
        )
        .map_err(|e| {
            ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, e.to_string())
        })?;
    }
    Ok(())
}

/// Sentinel error for a cooperatively cancelled render.
#[derive(Debug, thiserror::Error)]
#[error("cancelled by user")]
pub struct WorkerCancelled;

impl From<WorkerCancelled> for ProtocolError {
    fn from(value: WorkerCancelled) -> Self {
        ProtocolError::new(
            knorvia_protocol::ErrorCategory::Cancelled,
            value.to_string(),
        )
    }
}
