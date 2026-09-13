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
    let mut command = Command::new(DAEMON_EXE);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .arg("serve")
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
            let endpoint: Value = serde_json::from_str(&data).expect("endpoint json");
            if endpoint["pid"].as_u64() == Some(child.id() as u64) {
                break endpoint;
            }
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
fn replay_large_durable_stream_survives_rebuild_restart_and_frozen_catchup() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!("knorvia-a08-daemon-{stamp}"));
    let store =
        knorvia_store::ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    let ws = store.create_workspace("replay").unwrap();
    let thread = store.create_thread(&ws.id, "history", None, None).unwrap();
    for i in 0..400 {
        store
            .append_event(
                &thread.id,
                "fixture.event",
                json!({"i":i,"body":"x".repeat(24_000)}),
                None,
            )
            .unwrap();
    }
    let durable = serde_json::to_value(store.replay(&thread.id, 0).unwrap()).unwrap();
    assert!(serde_json::to_vec(&durable).unwrap().len() > 8 * 1024 * 1024);
    drop(store);
    let mut daemon = start_daemon(&home);
    let mut client = Client::connect(&daemon.addr, &daemon.token);
    let mut other = Client::connect(&daemon.addr, &daemon.token);
    let mut params = json!({"streamId":thread.id, "afterSeq":0, "limit":25,"maxBytes":128*1024});
    let mut seen = Vec::new();
    let mut rebuilding = 0;
    let mut max_health = Duration::ZERO;
    let mut frozen = None;
    let mut restarted = false;
    loop {
        client.send_raw(json!({"jsonrpc":"2.0","id":800,"method":"event/replay","params":params}));
        let began = Instant::now();
        assert_eq!(other.call("system/health", json!({}))["ok"], true);
        max_health = max_health.max(began.elapsed());
        let response = client.read_reply(800, Instant::now() + Duration::from_secs(10));
        if response["error"].is_object() {
            assert_eq!(response["error"]["code"], -32032, "{response}");
            assert!(
                response["error"]["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("replay_index_building:"),
                "{response}"
            );
            rebuilding += 1;
            assert!(rebuilding < 200);
            continue;
        }
        assert!(serde_json::to_vec(&response).unwrap().len() <= 128 * 1024);
        let page = &response["result"];
        let upper = page["upperSeq"].as_u64().unwrap();
        if frozen.is_none() {
            frozen = Some(upper);
            other.call(
                "thread/update",
                json!({"id":thread.id,"title":"new event during replay"}),
            );
        }
        assert_eq!(Some(upper), frozen);
        let events = page["events"].as_array().unwrap();
        assert!(!events.is_empty());
        seen.extend(events.iter().cloned());
        params["afterSeq"] = page["nextSeq"].clone();
        params["upperSeq"] = page["upperSeq"].clone();
        params["cursor"] = page["nextCursor"].clone();
        if !restarted && seen.len() > 40 {
            drop(client);
            drop(other);
            daemon.child.kill().unwrap();
            daemon.child.wait().unwrap();
            // Keep fixture Home while replacing the daemon process.
            daemon.home = home.join("unused-cleanup-path");
            drop(daemon);
            daemon = start_daemon(&home);
            client = Client::connect(&daemon.addr, &daemon.token);
            other = Client::connect(&daemon.addr, &daemon.token);
            restarted = true;
        }
        if page["hasMore"] == false {
            break;
        }
    }
    assert_eq!(Value::Array(seen), durable);
    assert!(rebuilding > 1);
    assert!(
        max_health < Duration::from_secs(1),
        "health blocked for {max_health:?}"
    );
    let caught_up = client.call(
        "event/replay",
        json!({"streamId":thread.id,"afterSeq":frozen.unwrap()}),
    );
    assert_eq!(caught_up["events"].as_array().unwrap().len(), 1);
    assert_eq!(caught_up["events"][0]["kind"], "thread.updated");
    // Large IDs are diagnosed without constructing an illegal outgoing frame.
    client.send_raw(json!({"jsonrpc":"2.0","id":"x".repeat(3*1024*1024),"method":"event/replay","params":{"streamId":thread.id}}));
    let rejected = client.read_any();
    assert_eq!(rejected["error"]["data"]["category"], "INVALID_ARGUMENT");
    assert!(serde_json::to_vec(&rejected).unwrap().len() < knorvia_protocol::MAX_FRAME_BYTES);
    eprintln!(
        "A08 durable replay: frozen={:?}, rebuild responses={rebuilding}, maximum second-client health={max_health:?}",
        frozen
    );
}
