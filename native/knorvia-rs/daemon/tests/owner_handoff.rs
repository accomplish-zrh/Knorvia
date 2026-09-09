use knorvia_control::ControlPlane;
use knorvia_platform_paths::resolve;
use knorvia_protocol::{read_frame, write_frame};
use serde_json::{Value, json};
use std::fs;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct TestHome(PathBuf);
impl Drop for TestHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Client(Child);
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn client_retries_ownership_after_a_draining_owner_releases_its_lock() {
    let home = TestHome(std::env::temp_dir().join(format!(
        "knorvia-owner-handoff-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )));
    let paths = resolve(Some(&home.0)).unwrap();
    // Reproduce the real shutdown interval: discovery is gone, but the old
    // owner still holds the OS lock while its Kernel is being reaped.
    let ownership = ControlPlane::acquire_home(paths.clone()).unwrap();
    let daemon = std::env::var_os("KNORVIA_TEST_DAEMON_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_knorvia-daemon")));
    let mut command = Command::new(&daemon);
    command
        .arg("--home")
        .arg(&home.0)
        .env("KNORVIA_HOME", &home.0)
        .env("KNORVIA_DAEMON_BIN", &daemon)
        .env_remove("CODEX_HOME")
        .env_remove("KNORVIA_PROVIDER_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut client = Client(command.spawn().unwrap());
    write_frame(
        client.0.stdin.as_mut().unwrap(),
        &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocol":{"major":1,"minor":0},
            "client":{"name":"knorvia_handoff_test","version":"1"},
            "capabilities":[]
        }})
        .to_string(),
    )
    .unwrap();
    let diagnostics = paths.logs.join("shared-owner.log");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fs::read_to_string(&diagnostics)
        .unwrap_or_default()
        .contains("active daemon")
    {
        assert!(
            Instant::now() < deadline,
            "client never attempted ownership while the old owner held the lock"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !paths.run.join("shared-owner.json").exists(),
        "second writer acquired the locked Home"
    );
    drop(ownership);

    let output = client.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let result = read_frame(&mut BufReader::new(output)).map_err(|error| error.to_string());
        let _ = send.send(result);
    });
    let response = receive
        .recv_timeout(Duration::from_secs(5))
        .expect("client did not retry ownership after the old owner released its lock")
        .unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(
        response["result"]["server"]["name"], "knorvia-daemon",
        "{response}"
    );
    drop(client.0.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    while client.0.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "new owner did not close after its only client detached"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!paths.run.join("shared-owner.json").exists());
}
