use clap::{Parser, Subcommand};
use knorvia_daemon::{run_shared_owner, run_stdio};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(
    name = "knorvia-daemon",
    version,
    about = "Knorvia control plane. Not an OpenAI Codex product."
)]
struct Cli {
    /// Override Knorvia Home (otherwise KNORVIA_HOME or the platform default).
    #[arg(long)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Serve Knorvia Protocol on stdio (default).
    Stdio,
    /// Own the shared local runtime (normally started by a client).
    Serve,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Some(Command::Serve) => run_shared_owner(cli.home.as_deref()),
        _ => run_stdio(cli.home.as_deref()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("knorvia-daemon error: {} ({:?})", err.message, err.category);
            ExitCode::from(1)
        }
    }
}
