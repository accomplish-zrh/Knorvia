//! `knorvia-pack-worker`: the supervised pack worker process.
//!
//! Spawned by the daemon with an explicit environment allowlist. Speaks
//! framed JSON-RPC over stdio: initialize / render / shutdown. It never
//! opens ports, never writes the product store, and never sees the parent
//! environment beyond the allowlist.

use std::io::BufReader;

fn main() -> std::process::ExitCode {
    #[cfg(debug_assertions)]
    if fixture_child() {
        return std::process::ExitCode::SUCCESS;
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let render = |pack_id: &str, input: &serde_json::Value| {
        #[cfg(debug_assertions)]
        fixture_render(input);
        let mut runner = knorvia_packs::InProcessRunner::new(knorvia_packs::gateway::env_choice());
        use knorvia_packs::PackRunner;
        let ctx = knorvia_packs::RenderContext {
            job_id: String::new(),
            invocation_id: String::new(),
        };
        match runner.render(&ctx, pack_id, input) {
            Ok(rendered) => Ok((rendered.mime.to_string(), rendered.title, rendered.bytes)),
            Err(e) => Err(e.to_string()),
        }
    };
    match knorvia_capability_host::worker::serve_worker(
        render,
        BufReader::new(stdin.lock()),
        stdout.lock(),
    ) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("knorvia-pack-worker: {err}");
            std::process::ExitCode::from(1)
        }
    }
}

#[cfg(debug_assertions)]
fn fixture_command() -> std::process::Command {
    let mut command =
        std::process::Command::new(std::env::current_exe().expect("fixture executable"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.stdin(std::process::Stdio::null());
    command
}

#[cfg(debug_assertions)]
fn fixture_write(tag: &str, role: &str, child: Option<u32>) {
    let Ok(directory) = std::env::var("KNORVIA_WORKER_FIXTURE_PID_DIR") else {
        return;
    };
    if !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return;
    }
    let path = std::path::Path::new(&directory).join(format!("{tag}-{role}.json"));
    let _ = std::fs::write(
        path,
        serde_json::json!({"pid":std::process::id(),"childPid":child}).to_string(),
    );
}

#[cfg(debug_assertions)]
fn fixture_child() -> bool {
    if std::env::var("KNORVIA_WORKER_FIXTURE_DELAY_MS").as_deref() != Ok("1") {
        return false;
    }
    let args = std::env::args().collect::<Vec<_>>();
    let Some(role) = args
        .get(1)
        .and_then(|arg| arg.strip_prefix("--knorvia-fixture-"))
    else {
        return false;
    };
    let tag = args.get(2).map(String::as_str).unwrap_or("fixture");
    let child = if role == "descendant" {
        Some(
            fixture_command()
                .arg("--knorvia-fixture-grandchild")
                .arg(tag)
                .spawn()
                .expect("fixture grandchild"),
        )
    } else {
        None
    };
    fixture_write(tag, role, child.as_ref().map(std::process::Child::id));
    std::thread::sleep(std::time::Duration::from_secs(120));
    true
}

#[cfg(debug_assertions)]
fn fixture_render(input: &serde_json::Value) {
    if std::env::var("KNORVIA_WORKER_FIXTURE_DELAY_MS").as_deref() != Ok("1") {
        return;
    }
    let tag = input.get("knorviaFixtureTag").and_then(|v| v.as_str());
    let child = tag.map(|tag| {
        fixture_command()
            .arg("--knorvia-fixture-descendant")
            .arg(tag)
            .spawn()
            .expect("fixture descendant")
    });
    if let Some(tag) = tag {
        fixture_write(tag, "worker", child.as_ref().map(std::process::Child::id));
    }
    if let Some(ms) = input.get("knorviaFixtureDelayMs").and_then(|v| v.as_u64()) {
        std::thread::sleep(std::time::Duration::from_millis(ms.min(120_000)));
    }
}
