use clap::{Parser, Subcommand, ValueEnum};
use knorvia_cli::{
    open_control, ready_session, rpc, rpc_idempotent_once, turn_exit_code, turn_machine_status,
    turn_output, version_line, wait_turn,
};
use knorvia_daemon::run_stdio;
use serde_json::{Value, json};
use std::fs;
use std::io::{self, IsTerminal, Read};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

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
    /// Machine output format. NDJSON emits one object per observation.
    #[arg(long, global = true, value_enum, default_value_t = OutputFormat::Json)]
    output: OutputFormat,
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
    /// Submit, inspect, wait for, or interrupt an ordinary Kernel turn.
    Turn {
        #[command(subcommand)]
        action: TurnCmd,
    },
    /// Long-running goal operations over Knorvia Protocol.
    Goal {
        #[command(subcommand)]
        action: GoalCmd,
    },
    /// Create, revise, and preview durable automation schedules.
    Automation {
        #[command(subcommand)]
        action: AutomationCmd,
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

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
enum OutputFormat {
    Json,
    Ndjson,
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
enum TurnCmd {
    /// Submit a normal Turn. It returns admission immediately unless --wait is set.
    Run {
        #[arg(long)]
        thread_id: String,
        #[arg(long, conflicts_with_all = ["file", "stdin"])]
        input: Option<String>,
        #[arg(long, conflicts_with_all = ["input", "stdin"])]
        file: Option<PathBuf>,
        #[arg(long, conflicts_with_all = ["input", "file"])]
        stdin: bool,
        #[arg(long)]
        idempotency_key: Option<String>,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
        #[arg(long)]
        write: bool,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        reasoning_effort: Option<String>,
    },
    /// Read the latest durable projection of an accepted Turn.
    Read {
        #[arg(long)]
        id: String,
    },
    /// Wait for a Turn without cancelling it when the deadline or CLI lifetime ends.
    Wait {
        #[arg(long)]
        id: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    /// Explicitly request interruption of the accepted Turn.
    Interrupt {
        #[arg(long)]
        id: String,
    },
}

#[derive(Debug)]
struct RunOutcome {
    exit_code: u8,
}

impl RunOutcome {
    fn success() -> Self {
        Self { exit_code: 0 }
    }
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
enum AutomationCmd {
    Create {
        #[arg(long)]
        workspace_id: String,
        #[arg(long)]
        title: String,
        #[arg(long)]
        prompt: String,
        /// Schedule JSON, for example {"kind":"once","at":1780000000000}.
        #[arg(long)]
        schedule: String,
        #[arg(long)]
        valid_from: Option<i64>,
        #[arg(long)]
        valid_until: Option<i64>,
        #[arg(long)]
        paused: bool,
    },
    UpdateWindow {
        #[arg(long)]
        id: String,
        #[arg(long)]
        revision: u64,
        #[arg(
            long,
            conflicts_with = "clear_valid_from",
            required_unless_present_any = ["valid_until", "clear_valid_from", "clear_valid_until"]
        )]
        valid_from: Option<i64>,
        #[arg(long, conflicts_with = "valid_from")]
        clear_valid_from: bool,
        #[arg(long, conflicts_with = "clear_valid_until")]
        valid_until: Option<i64>,
        #[arg(long, conflicts_with = "valid_until")]
        clear_valid_until: bool,
    },
    Preview {
        #[arg(long, conflicts_with = "schedule")]
        id: Option<String>,
        #[arg(long, conflicts_with = "id")]
        schedule: Option<String>,
        #[arg(long)]
        from: Option<i64>,
        #[arg(long, default_value_t = 5)]
        count: u8,
        #[arg(long)]
        valid_from: Option<i64>,
        #[arg(long)]
        valid_until: Option<i64>,
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
    let output = cli.output;
    match run(cli) {
        Ok(outcome) => ExitCode::from(outcome.exit_code),
        Err(err) => {
            emit(
                output,
                &json!({
                    "schemaVersion": 1,
                    "status": "error",
                    "error": {
                        "category": err.category,
                        "message": err.message,
                        "retryable": err.retryable,
                        "retryAfter": err.retry_after,
                    }
                }),
            );
            ExitCode::from(1)
        }
    }
}

fn emit(format: OutputFormat, value: &Value) {
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(value).expect("json")),
        OutputFormat::Ndjson => println!("{}", serde_json::to_string(value).expect("json")),
    }
}

fn automation_window_params(
    id: String,
    revision: u64,
    valid_from: Option<i64>,
    clear_valid_from: bool,
    valid_until: Option<i64>,
    clear_valid_until: bool,
) -> Result<Value, knorvia_protocol::ProtocolError> {
    if valid_from.is_some() && clear_valid_from || valid_until.is_some() && clear_valid_until {
        return Err(knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::InvalidArgument,
            "an automation validity boundary cannot be set and cleared together",
        ));
    }
    if valid_from.is_none() && !clear_valid_from && valid_until.is_none() && !clear_valid_until {
        return Err(knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::InvalidArgument,
            "automation update-window requires a set or clear action",
        ));
    }
    let mut params = json!({
        "id": id,
        "expectedRevision": revision,
    });
    if clear_valid_from {
        params["validFrom"] = Value::Null;
    } else if let Some(value) = valid_from {
        params["validFrom"] = json!(value);
    }
    if clear_valid_until {
        params["validUntil"] = Value::Null;
    } else if let Some(value) = valid_until {
        params["validUntil"] = json!(value);
    }
    Ok(params)
}

fn input_text(
    input: Option<String>,
    file: Option<PathBuf>,
    force_stdin: bool,
) -> Result<String, knorvia_protocol::ProtocolError> {
    if let Some(input) = input {
        return nonempty_input(input);
    }
    if let Some(path) = file {
        let text = fs::read_to_string(path).map_err(|error| {
            knorvia_protocol::ProtocolError::new(
                knorvia_protocol::ErrorCategory::InvalidArgument,
                format!("could not read input file: {error}"),
            )
        })?;
        return nonempty_input(text);
    }
    if !force_stdin && io::stdin().is_terminal() {
        return Err(knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::InvalidArgument,
            "provide --input, --file, or pipe Turn input on stdin",
        ));
    }
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).map_err(|error| {
        knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::InvalidArgument,
            format!("could not read stdin: {error}"),
        )
    })?;
    nonempty_input(text)
}

fn nonempty_input(input: String) -> Result<String, knorvia_protocol::ProtocolError> {
    if input.trim().is_empty() {
        Err(knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::InvalidArgument,
            "Turn input must not be empty",
        ))
    } else {
        Ok(input)
    }
}

fn json_argument(name: &str, raw: String) -> Result<Value, knorvia_protocol::ProtocolError> {
    serde_json::from_str(&raw).map_err(|error| {
        knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::InvalidArgument,
            format!("{name} must be valid JSON: {error}"),
        )
    })
}

fn run(cli: Cli) -> Result<RunOutcome, knorvia_protocol::ProtocolError> {
    let output = cli.output;
    match cli.command {
        None | Some(Command::Version) => {
            println!("{}", version_line());
            Ok(RunOutcome::success())
        }
        Some(Command::Daemon) => {
            run_stdio(cli.home.as_deref())?;
            Ok(RunOutcome::success())
        }
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
            Ok(RunOutcome::success())
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
            Ok(RunOutcome::success())
        }
        Some(Command::Turn { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli_turn")?;
            match action {
                TurnCmd::Run {
                    thread_id,
                    input,
                    file,
                    stdin,
                    idempotency_key,
                    wait,
                    timeout_seconds,
                    write,
                    cwd,
                    model,
                    reasoning_effort,
                } => {
                    let input = input_text(input, file, stdin)?;
                    let retry_transport = idempotency_key.is_some();
                    let params = json!({
                        "threadId": thread_id,
                        "input": input,
                        "idempotencyKey": idempotency_key,
                        "tools": {"write": write},
                        "cwd": cwd,
                        "model": model,
                        "reasoningEffort": reasoning_effort,
                    });
                    let result = if retry_transport {
                        rpc_idempotent_once(
                            &mut plane,
                            cli.home.as_deref(),
                            "turn-run",
                            "turn/start",
                            params,
                        )?
                    } else {
                        rpc(&mut plane, "turn-run", "turn/start", params)?
                    };
                    let turn_id = result
                        .pointer("/turn/id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            knorvia_protocol::ProtocolError::new(
                                knorvia_protocol::ErrorCategory::Internal,
                                "turn/start accepted work without a durable Turn id",
                            )
                        })?
                        .to_string();
                    let initial = rpc(
                        &mut plane,
                        "turn-run-read",
                        "turn/read",
                        json!({"id": turn_id}),
                    )?;
                    if !wait {
                        let envelope = turn_output("turn/run", initial, false);
                        let status = envelope["status"].as_str().unwrap_or("unknown");
                        emit(output, &envelope);
                        return Ok(RunOutcome {
                            exit_code: turn_exit_code(status),
                        });
                    }
                    let mut last_emitted: Option<String> = None;
                    let (snapshot, timed_out) = wait_turn(
                        &mut plane,
                        &turn_id,
                        Duration::from_secs(timeout_seconds),
                        |snapshot| {
                            if output == OutputFormat::Ndjson {
                                let state = turn_machine_status(snapshot).to_string();
                                if last_emitted.as_ref() != Some(&state) {
                                    emit(output, &turn_output("turn/run", snapshot.clone(), false));
                                    last_emitted = Some(state);
                                }
                            }
                        },
                    )?;
                    let envelope = turn_output("turn/run", snapshot, timed_out);
                    if output == OutputFormat::Json || timed_out {
                        emit(output, &envelope);
                    }
                    let status = envelope["status"].as_str().unwrap_or("unknown");
                    Ok(RunOutcome {
                        exit_code: turn_exit_code(status),
                    })
                }
                TurnCmd::Read { id } => {
                    let snapshot = rpc(&mut plane, "turn-read", "turn/read", json!({"id": id}))?;
                    let envelope = turn_output("turn/read", snapshot, false);
                    let status = envelope["status"].as_str().unwrap_or("unknown");
                    emit(output, &envelope);
                    Ok(RunOutcome {
                        exit_code: turn_exit_code(status),
                    })
                }
                TurnCmd::Wait {
                    id,
                    timeout_seconds,
                } => {
                    let mut last_emitted: Option<String> = None;
                    let (snapshot, timed_out) = wait_turn(
                        &mut plane,
                        &id,
                        Duration::from_secs(timeout_seconds),
                        |snapshot| {
                            if output == OutputFormat::Ndjson {
                                let state = turn_machine_status(snapshot).to_string();
                                if last_emitted.as_ref() != Some(&state) {
                                    emit(
                                        output,
                                        &turn_output("turn/wait", snapshot.clone(), false),
                                    );
                                    last_emitted = Some(state);
                                }
                            }
                        },
                    )?;
                    let envelope = turn_output("turn/wait", snapshot, timed_out);
                    if output == OutputFormat::Json || timed_out {
                        emit(output, &envelope);
                    }
                    let status = envelope["status"].as_str().unwrap_or("unknown");
                    Ok(RunOutcome {
                        exit_code: turn_exit_code(status),
                    })
                }
                TurnCmd::Interrupt { id } => {
                    let snapshot = rpc(
                        &mut plane,
                        "turn-interrupt",
                        "turn/interrupt",
                        json!({"turnId": id}),
                    )?;
                    let envelope = turn_output("turn/interrupt", snapshot, false);
                    emit(output, &envelope);
                    Ok(RunOutcome::success())
                }
            }
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
            Ok(RunOutcome::success())
        }
        Some(Command::Automation { action }) => {
            let mut plane = open_control(cli.home.as_deref())?;
            ready_session(&mut plane, "knorvia_cli_automation")?;
            let result = match action {
                AutomationCmd::Create {
                    workspace_id,
                    title,
                    prompt,
                    schedule,
                    valid_from,
                    valid_until,
                    paused,
                } => rpc(
                    &mut plane,
                    "automation-create",
                    "automation/create",
                    json!({
                        "workspaceId": workspace_id,
                        "title": title,
                        "prompt": prompt,
                        "schedule": json_argument("schedule", schedule)?,
                        "status": if paused { "paused" } else { "active" },
                        "validFrom": valid_from,
                        "validUntil": valid_until,
                    }),
                )?,
                AutomationCmd::UpdateWindow {
                    id,
                    revision,
                    valid_from,
                    clear_valid_from,
                    valid_until,
                    clear_valid_until,
                } => rpc(
                    &mut plane,
                    "automation-window",
                    "automation/update",
                    automation_window_params(
                        id,
                        revision,
                        valid_from,
                        clear_valid_from,
                        valid_until,
                        clear_valid_until,
                    )?,
                )?,
                AutomationCmd::Preview {
                    id,
                    schedule,
                    from,
                    count,
                    valid_from,
                    valid_until,
                } => {
                    if id.is_none() && schedule.is_none() {
                        return Err(knorvia_protocol::ProtocolError::new(
                            knorvia_protocol::ErrorCategory::InvalidArgument,
                            "automation preview requires --id or --schedule",
                        ));
                    }
                    let schedule = schedule
                        .map(|raw| json_argument("schedule", raw))
                        .transpose()?;
                    let mut params = json!({
                        "count": count,
                    });
                    if let Some(value) = id {
                        params["id"] = json!(value);
                    }
                    if let Some(value) = schedule {
                        params["schedule"] = value;
                    }
                    if let Some(value) = from {
                        params["from"] = json!(value);
                    }
                    if let Some(value) = valid_from {
                        params["validFrom"] = json!(value);
                    }
                    if let Some(value) = valid_until {
                        params["validUntil"] = json!(value);
                    }
                    rpc(
                        &mut plane,
                        "automation-preview",
                        "automation/preview",
                        params,
                    )?
                }
            };
            emit(output, &result);
            Ok(RunOutcome::success())
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
            Ok(RunOutcome::success())
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
            Ok(RunOutcome::success())
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
            Ok(RunOutcome::success())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_automation(args: &[&str]) -> AutomationCmd {
        let cli = Cli::try_parse_from(args).expect("valid CLI");
        let Some(Command::Automation { action }) = cli.command else {
            panic!("expected automation command");
        };
        action
    }

    #[test]
    fn update_window_clear_flags_parse_and_emit_explicit_nulls() {
        let action = parse_automation(&[
            "knorvia",
            "automation",
            "update-window",
            "--id",
            "auto_1",
            "--revision",
            "7",
            "--clear-valid-from",
            "--valid-until",
            "1900000000000",
        ]);
        let AutomationCmd::UpdateWindow {
            id,
            revision,
            valid_from,
            clear_valid_from,
            valid_until,
            clear_valid_until,
        } = action
        else {
            panic!("expected update-window");
        };
        let params = automation_window_params(
            id,
            revision,
            valid_from,
            clear_valid_from,
            valid_until,
            clear_valid_until,
        )
        .unwrap();
        assert_eq!(
            params,
            json!({
                "id": "auto_1",
                "expectedRevision": 7,
                "validFrom": null,
                "validUntil": 1900000000000_i64,
            })
        );
    }

    #[test]
    fn update_window_requires_an_action_and_rejects_set_plus_clear() {
        let missing = Cli::try_parse_from([
            "knorvia",
            "automation",
            "update-window",
            "--id",
            "auto_1",
            "--revision",
            "7",
        ]);
        assert!(missing.is_err(), "one set/clear action is required");

        let conflict = Cli::try_parse_from([
            "knorvia",
            "automation",
            "update-window",
            "--id",
            "auto_1",
            "--revision",
            "7",
            "--valid-from",
            "1800000000000",
            "--clear-valid-from",
        ]);
        assert!(conflict.is_err(), "a boundary cannot be set and cleared");
    }

    #[test]
    fn update_window_clear_until_keeps_the_other_boundary_unchanged() {
        let params = automation_window_params("auto_2".into(), 9, None, false, None, true).unwrap();
        assert_eq!(params["validUntil"], Value::Null);
        assert!(params.get("validFrom").is_none());
        assert_eq!(params["expectedRevision"], 9);
    }
}
