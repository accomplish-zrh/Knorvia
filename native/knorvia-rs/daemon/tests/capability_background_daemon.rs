//! A05 daemon-level verification against the REAL `knorvia-daemon.exe`
//! binary: a long pack invocation runs in the background while the same
//! connection AND a second connection still answer `system/health`;
//! `capability/cancel` reclaims the live worker (`reclaimed: true`), the
//! job ends cancelled, and nothing is published.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use knorvia_protocol::{read_frame, write_frame};
use serde_json::{Value, json};

const DAEMON_EXE: &str = env!("CARGO_BIN_EXE_knorvia-daemon");

fn worker_exe() -> PathBuf {
    // The worker is a bin of another workspace package; it lives next to
    // the daemon binary in the shared target directory.
    let daemon = PathBuf::from(DAEMON_EXE);
    daemon
        .parent()
        .expect("daemon has a parent")
        .join("knorvia-pack-worker.exe")
}

struct Daemon {
    child: Child,
    addr: String,
    token: String,
    home: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn start_daemon(home: &std::path::Path) -> Daemon {
    let pid_dir = home.join("worker-pids");
    std::fs::create_dir_all(&pid_dir).unwrap();
    let mut command = Command::new(DAEMON_EXE);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .arg("serve")
        .env("KNORVIA_WORKER_FIXTURE_PID_DIR", &pid_dir)
        .env("KNORVIA_HOME", home)
        .env("KNORVIA_NATIVE_HOME", home)
        .env("KNORVIA_WORKSPACE_ROOT", home)
        // Allowlist the fixture delay for the worker.
        .env("KNORVIA_WORKER_FIXTURE_DELAY_MS", "1")
        // The worker resolves next to the daemon by current_exe; point the
        // env override at the same workspace bin for determinism.
        .env("KNORVIA_PACK_WORKER_BIN", worker_exe())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("daemon binary spawns");
    let endpoint_path = home.join("run").join("shared-owner.json");
    let deadline = Instant::now() + Duration::from_secs(20);
    let endpoint: Value = loop {
        if let Ok(data) = std::fs::read_to_string(&endpoint_path) {
            break serde_json::from_str(&data).expect("endpoint json");
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("daemon never published its endpoint");
        }
        if let Ok(Some(_)) = child.try_wait() {
            panic!("daemon exited before publishing its endpoint");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let addr = format!("127.0.0.1:{}", endpoint["port"].as_u64().expect("port"));
    Daemon {
        child,
        addr,
        token: endpoint["token"].as_str().expect("token").to_string(),
        home: home.to_path_buf(),
    }
}

struct Client {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: u64,
}

impl Client {
    /// The daemon requires a framed owner-identity token before JSON-RPC.
    fn connect(addr: &str, token: &str) -> Self {
        let stream = TcpStream::connect(addr).expect("connect to daemon");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        let mut writer = stream.try_clone().expect("clone stream");
        write_frame(&mut writer, &json!({"token": token}).to_string()).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let ack = read_frame(&mut reader).expect("owner ack");
        let ack: Value = serde_json::from_str(&ack).expect("ack json");
        assert_eq!(ack["attached"], true, "owner attach ack: {ack}");
        let mut client = Self {
            reader,
            writer,
            next_id: 100,
        };
        // Each daemon session has its own handshake: initialize first.
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocol":{"major":1,"minor":0},
            "client":{"name":"a05-daemon-e2e","version":"0"},
            "capabilities":["thread","artifact","job"]}});
        client.send_raw(init);
        loop {
            let reply = client.read_any();
            if reply.get("id").and_then(|v| v.as_u64()) == Some(1) {
                break;
            }
        }
        client.send_raw(json!({"jsonrpc":"2.0","method":"initialized"}));
        client
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        write_frame(&mut self.writer, &request.to_string()).unwrap();
        loop {
            let body = read_frame(&mut self.reader).expect("reply frame");
            let reply: Value = serde_json::from_str(&body).expect("reply json");
            if reply.get("id").and_then(|v| v.as_u64()) == Some(id) {
                assert!(reply.get("error").is_none(), "unexpected error: {reply}");
                return reply["result"].clone();
            }
            // Skip notifications interleaved on the stream.
        }
    }

    fn read_any(&mut self) -> Value {
        serde_json::from_str(&read_frame(&mut self.reader).expect("reply frame"))
            .expect("reply json")
    }

    fn send_raw(&mut self, request: Value) {
        write_frame(&mut self.writer, &request.to_string()).unwrap();
    }

    fn read_reply(&mut self, id: u64, deadline: Instant) -> Value {
        loop {
            let body = read_frame(&mut self.reader).expect("reply frame");
            let reply: Value = serde_json::from_str(&body).expect("reply json");
            if reply.get("id").and_then(|v| v.as_u64()) == Some(id) {
                return reply;
            }
            assert!(Instant::now() < deadline, "reply never arrived: {reply}");
        }
    }
}

#[test]
fn daemon_long_pack_keeps_health_and_cancel_responsive() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!("knorvia-a05-daemon-e2e-{stamp}"));
    std::fs::create_dir_all(&home).unwrap();
    let daemon = start_daemon(&home);
    let mut client = Client::connect(&daemon.addr, &daemon.token);

    let workspace = client.call("workspace/create", json!({"title": "a05 e2e"}));
    let workspace_id = workspace["id"].as_str().unwrap().to_string();

    // Long pack: the worker sleeps 20s before rendering (fixture-gated).
    // The background dispatch answers with the durable identity fast.
    let started = Instant::now();
    client.send_raw(json!({"jsonrpc":"2.0","id":3,"method":"capability/invokeBackground",
        "params":{"packId":"research.knowledge","workspaceId":workspace_id,
            "input":{"query":"night","knorviaFixtureDelayMs":20000,"knorviaFixtureTag":"background"}}}));
    let accepted = client.read_reply(3, started + Duration::from_secs(10));
    assert!(
        accepted.get("error").is_none(),
        "background invoke error: {accepted}"
    );
    let invocation_id = accepted["result"]["invocationId"]
        .as_str()
        .expect("invocation id")
        .to_string();
    let job_id = accepted["result"]["jobId"]
        .as_str()
        .expect("job id")
        .to_string();
    assert_eq!(accepted["result"]["status"], "running");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "admission must not wait for the render"
    );

    // Health is answered on the SAME connection while the pack sleeps, and
    // a second connection stays fully usable too.
    client.send_raw(json!({"jsonrpc":"2.0","id":4,"method":"system/health"}));
    let health = client.read_reply(4, started + Duration::from_secs(8));
    assert_eq!(health["result"]["ok"], true);
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "health answered during a 20s pack"
    );
    let mut second = Client::connect(&daemon.addr, &daemon.token);
    let health2 = second.call("system/health", json!({}));
    assert_eq!(health2["ok"], true);

    let pids = wait_fixture_tree(&home, "background");
    let independent = second.call("capability/invokeBackground", json!({"packId":"research.knowledge","workspaceId":workspace_id,"input":{"query":"independent","knorviaFixtureDelayMs":1500}}));
    // Cancel lands while the pack still sleeps; the live worker is
    // reclaimed and the outcome is cancelled without publishing.
    client.send_raw(json!({"jsonrpc":"2.0","id":5,"method":"capability/cancel",
        "params":{"invocationId": invocation_id}}));
    let cancel = client.read_reply(5, Instant::now() + Duration::from_secs(30));
    assert!(cancel.get("error").is_none(), "cancel error: {cancel}");
    assert_eq!(cancel["result"]["status"], "cancelled");
    assert_eq!(
        cancel["result"]["reclaimed"], true,
        "the cancel must confirm the worker tree is gone: {cancel}"
    );

    assert_processes_gone(&pids);
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        let independent_status = second.call(
            "capability/status",
            json!({"invocationId":independent["invocationId"]}),
        );
        if independent_status["status"] == "succeeded" {
            break;
        }
        assert_ne!(independent_status["status"], "cancelled");
        assert!(
            Instant::now() < until,
            "another worker failed to continue: {independent_status}"
        );
        std::thread::sleep(Duration::from_millis(40));
    }
    let status = client.call("capability/status", json!({"invocationId": invocation_id}));
    assert_eq!(status["status"], "cancelled");
    assert_eq!(status["jobStatus"], "cancelled");
    assert!(
        status["artifactId"].is_null(),
        "a cancelled invocation must not publish: {status}"
    );
    assert_eq!(status["jobId"], json!(job_id));

    // The daemon is still healthy afterwards.
    let health = client.call("system/health", json!({}));
    assert_eq!(health["ok"], true);
}

fn wait_fixture_tree(home: &std::path::Path, tag: &str) -> Vec<u32> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut pids = Vec::new();
        for role in ["worker", "descendant", "grandchild"] {
            if let Ok(raw) =
                std::fs::read(home.join("worker-pids").join(format!("{tag}-{role}.json")))
            {
                if let Ok(value) = serde_json::from_slice::<Value>(&raw) {
                    if let Some(pid) = value["pid"].as_u64() {
                        pids.push(pid as u32);
                    }
                }
            }
        }
        if pids.len() == 3 {
            return pids;
        }
        assert!(
            Instant::now() < deadline,
            "real worker/descendant fixture never started"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_processes_gone(pids: &[u32]) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        for pid in pids {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, *pid);
            if !process.is_null() {
                assert_eq!(
                    WaitForSingleObject(process, 0),
                    WAIT_OBJECT_0,
                    "PID {pid} survived confirmed cancellation"
                );
                CloseHandle(process);
            }
        }
    }
}

#[test]
fn legacy_invoke_defers_outcome_while_same_connection_handles_health_and_cancel() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!("knorvia-a05-legacy-{stamp}"));
    std::fs::create_dir_all(&home).unwrap();
    let daemon = start_daemon(&home);
    let mut client = Client::connect(&daemon.addr, &daemon.token);
    let ws = client.call("workspace/create", json!({"title":"legacy"}));
    client.send_raw(json!({"jsonrpc":"2.0","id":900,"method":"capability/invoke","params":{"packId":"research.knowledge","workspaceId":ws["id"],"idempotencyKey":"legacy-pack-once","input":{"query":"legacy","knorviaFixtureDelayMs":20000,"knorviaFixtureTag":"legacy"}}}));
    let pids = wait_fixture_tree(&home, "legacy");
    let started = Instant::now();
    assert_eq!(client.call("system/health", json!({}))["ok"], true);
    assert!(started.elapsed() < Duration::from_secs(1));
    client.send_raw(json!({"jsonrpc":"2.0","id":902,"method":"approval/respond","params":{"id":"missing-approval","decision":"decline"}}));
    let approval = client.read_reply(902, Instant::now() + Duration::from_secs(1));
    assert!(
        approval["error"].is_object(),
        "approval validation must still respond during pack execution"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    let mut invocation = None;
    for entry in std::fs::read_dir(
        knorvia_platform_paths::layout(home.clone())
            .packs
            .join("invocations"),
    )
    .unwrap()
    {
        let value: Value =
            serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
        if value["input"]["knorviaFixtureTag"] == "legacy" {
            invocation = Some(value["id"].clone());
        }
    }
    let invocation = invocation.expect("stable durable legacy invocation");
    client.send_raw(json!({"jsonrpc":"2.0","id":901,"method":"capability/cancel","params":{"invocationId":invocation}}));
    let mut cancelled = None;
    let mut outcome = None;
    while cancelled.is_none() || outcome.is_none() {
        let reply = client.read_any();
        if reply["id"] == 900 {
            outcome = Some(reply);
        } else if reply["id"] == 901 {
            cancelled = Some(reply);
        }
    }
    let cancelled = cancelled.unwrap();
    let outcome = outcome.unwrap();
    assert_eq!(cancelled["result"]["reclaimed"], true, "{cancelled}");
    assert_eq!(outcome["result"]["status"], "cancelled", "{outcome}");
    assert_eq!(outcome["result"]["invocationId"], invocation);
    assert!(outcome["result"]["artifactId"].is_null());
    assert_processes_gone(&pids);
    let retry = client.call("capability/invoke", json!({"packId":"research.knowledge","workspaceId":ws["id"],"idempotencyKey":"legacy-pack-once","input":{"query":"legacy","knorviaFixtureDelayMs":20000,"knorviaFixtureTag":"legacy"}}));
    assert_eq!(retry, outcome["result"]);
    eprintln!("A05 legacy/background cancellation reclaimed worker and 2 descendants: {pids:?}");
}
