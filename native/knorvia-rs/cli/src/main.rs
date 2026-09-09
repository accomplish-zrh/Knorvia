use clap::{Parser, Subcommand};
use knorvia_cli::{open_control, ready_session, rpc, version_line};
use knorvia_daemon::run_stdio;
use serde_json::json;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(
    name = "knorvia",
    version = concat!(env!("CARGO_PKG_VERSION"), " (Knorvia)"),
    about = "Knorvia CLI — local-first agent workbench. Not an OpenAI Codex product.",
    long_about = "Public command is `knorvia`. This binary never installs, wraps, or overwrites `codex`.\nHome is KNORVIA_HOME / %LOCALAPPDATA%\\Knorvia. It does not read or write ~/.codex."
)]
struct Cli {
    /// Override Knorvia Home.
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Print identity (same as --version, always Knorvia).
    Version,
    /// Run knorvia-daemon on stdio (protocol frames on stdout).
    Daemon,
    /// Workspace operations over Knorvia Protocol.
    Workspace {
        #[command(subcommand)]
        action: WorkspaceCmd,
    },
    /// Thread operations over Knorvia Protocol.
    Thread {
        #[command(subcommand)]
        action: ThreadCmd,
    },
    /// Long-running goal operations over Knorvia Protocol.
    Goal {
        #[command(subcommand)]
        action: GoalCmd,
    },
    /// Official domain packs (RAG, Memory, Office, Media, Learning, Partners, Automations).
    Pack {
        #[command(subcommand)]
        action: PackCmd,
    },
    /// Model-neutral Provider Gateway (negotiate / translate, no silent drop).
    Provider {
        #[command(subcommand)]
        action: ProviderCmd,
    },
    /// Legacy data migration (source is never overwritten).
    Migrate {
        #[command(subcommand)]
        action: MigrateCmd,
    },
}

#[derive(Subcommand, Debug)]
enum WorkspaceCmd {
    Create {
        #[arg(long)]
        title: String,
    },
    List,
    Read {
        #[arg(long)]
        id: String,
    },
}

#[derive(Subcommand, Debug)]
enum ThreadCmd {
    Start {
        #[arg(long)]
        workspace_id: String,
        #[arg(long, default_value = "Untitled")]
        title: String,
    },
    Read {
        #[arg(long)]
        id: String,
    },
}

#[derive(Subcommand, Debug)]
enum GoalCmd {
    /// Execute the recorded next action using the real Kernel; returns admission, not completion.
    Run {
        #[arg(long)]
        id: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        input: Option<String>,
        #[arg(long)]
        thread_id: Option<String>,
        #[arg(long)]
        task_id: Option<String>,
    },
    /// Record human acceptance against a completed output from this Goal.
    Evidence {
        #[arg(long)]
        id: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        turn_id: String,
        #[arg(long)]
        item_id: String,
        #[arg(long)]
        summary: String,
    },
    /// Create a goal; completion requires durable success criteria.
    Create {
        #[arg(long)]
        workspace_id: String,
        #[arg(long)]
        title: String,
        /// What "done" means. Required for the goal to ever be completed.
        #[arg(long)]
        success_criteria: Option<String>,
        #[arg(long)]
        constraints: Option<String>,
        #[arg(long)]
        next_action: Option<String>,
    },
    /// List a workspace's goals.
    List {
        #[arg(long)]
        workspace_id: String,
    },
    /// Read one goal including its task roll-up.
    Read {
        #[arg(long)]
        id: String,
    },
    /// Record a progress checkpoint (and optionally set the next action).
    Checkpoint {
        #[arg(long)]
        id: String,
        /// Durable revision for the concurrent-edit guard.
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        next_action: Option<String>,
    },
    /// Move the goal to another status (active/paused/blocked/completed/cancelled).
    Status {
        #[arg(long)]
        id: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        status: String,
    },
}

#[derive(Subcommand, Debug)]
enum PackCmd {
    List,
    Invoke {
        #[arg(long)]
        id: String,
        #[arg(long)]
        workspace_id: String,
        #[arg(long)]
        input: String,
    },
}

#[derive(Subcommand, Debug)]
enum MigrateCmd {
    Discover {
        #[arg(long)]
        source: PathBuf,
    },
    Run {
        #[arg(long)]
        source: PathBuf,
    },
    Rollback {
        #[arg(long)]
        id: String,
    },
}

#[derive(Subcommand, Debug)]
enum ProviderCmd {
    List,
    Negotiate {
        #[arg(long)]
        kind: String,
        #[arg(long)]
        model: String,
    },
    Translate {
        #[arg(long)]
        kind: String,
        #[arg(long)]
        request: String,
    },
    /// Execute the canonical request against the configured gateway.
    Execute {
        #[arg(long)]
        kind: String,
        #[arg(long)]
        request: String,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("knorvia: {} ({:?})", err.message, err.category);
            ExitCode::from(1)
        }
    }
}

fn run(cli: Cli) -> Result<(), knorvia_protocol::ProtocolError> {
    match cli.command {
        None | Some(Command::Version) => {
            println!("{}", version_line());
            Ok(())
        }
        Some(Command::Daemon) => run_stdio(cli.home.as_deref()),
        Some(Command::Workspace { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli")?;
            let result = match action {
                WorkspaceCmd::Create { title } => rpc(
                    &mut plane,
                    "ws-create",
                    "workspace/create",
                    json!({"title": title}),
                )?,
                WorkspaceCmd::List => rpc(&mut plane, "ws-list", "workspace/list", json!({}))?,
                WorkspaceCmd::Read { id } => {
                    rpc(&mut plane, "ws-read", "workspace/read", json!({"id": id}))?
                }
            };
            println!("{}", serde_json::to_string_pretty(&result).expect("json"));
            Ok(())
        }
        Some(Command::Thread { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli")?;
            let result = match action {
                ThreadCmd::Start {
                    workspace_id,
                    title,
                } => rpc(
                    &mut plane,
                    "th-start",
                    "thread/start",
                    json!({"workspaceId": workspace_id, "title": title}),
                )?,
                ThreadCmd::Read { id } => {
                    rpc(&mut plane, "th-read", "thread/read", json!({"id": id}))?
                }
            };
            println!("{}", serde_json::to_string_pretty(&result).expect("json"));
            Ok(())
        }
        Some(Command::Goal { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli")?;
            let result = match action {
                GoalCmd::Run {
                    id,
                    revision,
                    input,
                    thread_id,
                    task_id,
                } => rpc(
                    &mut plane,
                    "goal-run",
                    "goal/run",
                    json!({"id":id,"revision":revision,"input":input,"threadId":thread_id,"taskId":task_id}),
                )?,
                GoalCmd::Evidence {
                    id,
                    revision,
                    turn_id,
                    item_id,
                    summary,
                } => rpc(
                    &mut plane,
                    "goal-evidence",
                    "goal/evidence/add",
                    json!({"id":id,"revision":revision,"turnId":turn_id,"itemId":item_id,"summary":summary}),
                )?,
                GoalCmd::Create {
                    workspace_id,
                    title,
                    success_criteria,
                    constraints,
                    next_action,
                } => rpc(
                    &mut plane,
                    "goal-create",
                    "goal/create",
                    json!({
                        "workspaceId": workspace_id,
                        "title": title,
                        "successCriteria": success_criteria,
                        "constraints": constraints,
                        "nextAction": next_action,
                    }),
                )?,
                GoalCmd::List { workspace_id } => rpc(
                    &mut plane,
                    "goal-list",
                    "goal/list",
                    json!({"workspaceId": workspace_id}),
                )?,
                GoalCmd::Read { id } => {
                    rpc(&mut plane, "goal-read", "goal/read", json!({"id": id}))?
                }
                GoalCmd::Checkpoint {
                    id,
                    revision,
                    next_action,
                } => rpc(
                    &mut plane,
                    "goal-checkpoint",
                    "goal/update",
                    json!({"id": id, "revision": revision, "checkpoint": true, "nextAction": next_action}),
                )?,
                GoalCmd::Status {
                    id,
                    revision,
                    status,
                } => rpc(
                    &mut plane,
                    "goal-status",
                    "goal/update",
                    json!({"id": id, "revision": revision, "status": status}),
                )?,
            };
            println!("{}", serde_json::to_string_pretty(&result).expect("json"));
            Ok(())
        }
        Some(Command::Pack { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli")?;
            let result = match action {
                PackCmd::List => rpc(&mut plane, "pk-list", "capability/list", json!({}))?,
                PackCmd::Invoke {
                    id,
                    workspace_id,
                    input,
                } => {
                    let input_v: serde_json::Value = serde_json::from_str(&input).map_err(|e| {
                        knorvia_protocol::ProtocolError::new(
                            knorvia_protocol::ErrorCategory::InvalidArgument,
                            e.to_string(),
                        )
                    })?;
                    rpc(
                        &mut plane,
                        "pk-inv",
                        "capability/invoke",
                        json!({"packId": id, "workspaceId": workspace_id, "input": input_v}),
                    )?
                }
            };
            println!("{}", serde_json::to_string_pretty(&result).expect("json"));
            Ok(())
        }
        Some(Command::Provider { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli")?;
            let result = match action {
                ProviderCmd::List => rpc(&mut plane, "pv-list", "provider/list", json!({}))?,
                ProviderCmd::Negotiate { kind, model } => rpc(
                    &mut plane,
                    "pv-neg",
                    "provider/negotiate",
                    json!({"kind": kind, "model": model}),
                )?,
                ProviderCmd::Translate { kind, request } => {
                    let request_v: serde_json::Value =
                        serde_json::from_str(&request).map_err(|e| {
                            knorvia_protocol::ProtocolError::new(
                                knorvia_protocol::ErrorCategory::InvalidArgument,
                                e.to_string(),
                            )
                        })?;
                    rpc(
                        &mut plane,
                        "pv-tx",
                        "provider/translate",
                        json!({"kind": kind, "request": request_v}),
                    )?
                }
                ProviderCmd::Execute { kind, request } => {
                    let request_v: serde_json::Value =
                        serde_json::from_str(&request).map_err(|e| {
                            knorvia_protocol::ProtocolError::new(
                                knorvia_protocol::ErrorCategory::InvalidArgument,
                                e.to_string(),
                            )
                        })?;
                    rpc(
                        &mut plane,
                        "pv-exec",
                        "provider/execute",
                        json!({"kind": kind, "request": request_v}),
                    )?
                }
            };
            println!("{}", serde_json::to_string_pretty(&result).expect("json"));
            Ok(())
        }
        Some(Command::Migrate { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli")?;
            let result = match action {
                MigrateCmd::Discover { source } => rpc(
                    &mut plane,
                    "mg-disc",
                    "migration/discover",
                    json!({"source": source}),
                )?,
                MigrateCmd::Run { source } => rpc(
                    &mut plane,
                    "mg-run",
                    "migration/run",
                    json!({"source": source}),
                )?,
                MigrateCmd::Rollback { id } => {
                    rpc(&mut plane, "mg-rb", "migration/rollback", json!({"id": id}))?
                }
            };
            println!("{}", serde_json::to_string_pretty(&result).expect("json"));
            Ok(())
        }
    }
}
