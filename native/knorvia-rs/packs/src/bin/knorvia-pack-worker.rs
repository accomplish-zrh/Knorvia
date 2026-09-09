//! `knorvia-pack-worker`: the supervised pack worker process.
//!
//! Spawned by the daemon with an explicit environment allowlist. Speaks
//! framed JSON-RPC over stdio: initialize / render / shutdown. It never
//! opens ports, never writes the product store, and never sees the parent
//! environment beyond the allowlist.

use std::io::BufReader;

fn main() -> std::process::ExitCode {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let render = |pack_id: &str, input: &serde_json::Value| {
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
