//! CLI and stdio proxies attach to the same local owner. They never open stores.
use crate::endpoint::Endpoint;
use knorvia_platform_paths::{KnorviaPaths, resolve};
use knorvia_protocol::{ErrorCategory, ProtocolError, read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{self, BufReader};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub struct SharedClient {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

fn protocol_error(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(ErrorCategory::Transient, error.to_string())
}

impl SharedClient {
    pub fn connect(home: Option<&Path>) -> Result<Self, ProtocolError> {
        let paths = resolve(home).map_err(protocol_error)?;
        if knorvia_platform_paths::is_codex_path(&paths.home) {
            return Err(ProtocolError::new(
                ErrorCategory::PermissionDenied,
                "refusing a Codex Home",
            ));
        }
        if let Ok(client) = Self::attach(&paths) {
            return Ok(client);
        }
        let daemon = daemon_binary()?;
        std::fs::create_dir_all(&paths.logs).map_err(protocol_error)?;
        let diagnostics = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths.logs.join("shared-owner.log"))
            .map_err(protocol_error)?;
        let mut command = Command::new(daemon);
        command
            .arg("--home")
            .arg(&paths.home)
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(diagnostics));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            prevent_stdio_inheritance().map_err(protocol_error)?;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(protocol_error)?;
        // Concurrent starts are safe: only one server acquires the OS Home lock.
        // Losers attach to the winner; no stale discovery file grants ownership.
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut retry_delay = Duration::from_millis(150);
        let mut retry_at = Instant::now() + retry_delay;
        let client = loop {
            if let Ok(client) = Self::attach(&paths) {
                break Ok(client);
            }
            if Instant::now() >= deadline {
                break Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "could not attach to the Knorvia Home owner within 15 seconds; no second writer was opened",
                ));
            }
            // A draining owner removes discovery before releasing its Home
            // lock. Our first contender can lose that lock and exit after the
            // old listener has closed. Retry ownership once the contender has
            // exited; attaching alone could otherwise wait forever for a
            // winner that no longer exists. The OS lock still admits only one
            // writer, and bounded backoff avoids a spawn storm under failures.
            if matches!(child.try_wait(), Ok(Some(_))) && Instant::now() >= retry_at {
                child = command.spawn().map_err(protocol_error)?;
                retry_delay = (retry_delay * 2).min(Duration::from_secs(1));
                retry_at = Instant::now() + retry_delay;
            }
            thread::sleep(Duration::from_millis(30));
        };
        // Reap a server we launched without tying its lifetime to this client.
        thread::spawn(move || {
            let _ = child.wait();
        });
        client
    }

    fn attach(paths: &KnorviaPaths) -> Result<Self, ProtocolError> {
        let endpoint = Endpoint::read(paths).map_err(protocol_error)?;
        let mut writer =
            TcpStream::connect_timeout(&endpoint.address(), Duration::from_millis(300))
                .map_err(protocol_error)?;
        writer.set_nodelay(true).map_err(protocol_error)?;
        writer
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(protocol_error)?;
        writer
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(protocol_error)?;
        let mut reader = BufReader::new(writer.try_clone().map_err(protocol_error)?);
        write_frame(&mut writer, &json!({"token":endpoint.token}).to_string())
            .map_err(protocol_error)?;
        let ack: Value = serde_json::from_str(&read_frame(&mut reader).map_err(protocol_error)?)
            .map_err(protocol_error)?;
        if ack["attached"] != true || ack["ownerPid"] != endpoint.pid || ack["version"] != 1 {
            return Err(ProtocolError::new(
                ErrorCategory::Unauthenticated,
                "unexpected local owner identity",
            ));
        }
        writer
            .set_read_timeout(Some(Duration::from_secs(120)))
            .map_err(protocol_error)?;
        reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(120)))
            .map_err(protocol_error)?;
        Ok(Self { reader, writer })
    }

    pub fn handle_json(&mut self, body: &str) -> Result<Option<String>, ProtocolError> {
        let request: Value = serde_json::from_str(body).map_err(protocol_error)?;
        write_frame(&mut self.writer, body).map_err(protocol_error)?;
        let Some(id) = request.get("id") else {
            return Ok(None);
        };
        loop {
            let response = read_frame(&mut self.reader).map_err(protocol_error)?;
            let value: Value = serde_json::from_str(&response).map_err(protocol_error)?;
            if value.get("id") == Some(id) && value.get("method").is_none() {
                return Ok(Some(response));
            }
        }
    }

    pub fn proxy_stdio(self) -> Result<(), ProtocolError> {
        let Self {
            mut reader,
            mut writer,
        } = self;
        writer.set_read_timeout(None).map_err(protocol_error)?;
        reader
            .get_ref()
            .set_read_timeout(None)
            .map_err(protocol_error)?;
        thread::Builder::new()
            .name("knorvia-stdio-proxy".into())
            .spawn(move || {
                let mut input = io::stdin().lock();
                while let Ok(body) = read_frame(&mut input) {
                    if write_frame(&mut writer, &body).is_err() {
                        break;
                    }
                }
                let _ = writer.shutdown(Shutdown::Write);
            })
            .map_err(protocol_error)?;
        let mut output = io::stdout().lock();
        loop {
            match read_frame(&mut reader) {
                Ok(body) => write_frame(&mut output, &body).map_err(protocol_error)?,
                Err(knorvia_protocol::WireError::Io(error))
                    if error.kind() == io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(());
                }
                Err(error) => return Err(protocol_error(error)),
            }
        }
    }
}

#[cfg(windows)]
fn prevent_stdio_inheritance() -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{
        HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
    };
    // A spawned owner's redirected stdio must not retain the proxy's inherited
    // pipes. Otherwise Node's child `close` waits for the whole shared owner.
    for handle in [
        io::stdin().as_raw_handle(),
        io::stdout().as_raw_handle(),
        io::stderr().as_raw_handle(),
    ] {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            continue;
        }
        // SAFETY: handles are borrowed from the live standard streams; no close.
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn daemon_binary() -> Result<PathBuf, ProtocolError> {
    if let Some(path) = std::env::var_os("KNORVIA_DAEMON_BIN") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "KNORVIA_DAEMON_BIN must name an absolute daemon binary",
        ));
    }
    let current = std::env::current_exe().map_err(protocol_error)?;
    let filename = if cfg!(windows) {
        "knorvia-daemon.exe"
    } else {
        "knorvia-daemon"
    };
    let path = current.with_file_name(filename);
    if path.is_file() {
        Ok(path)
    } else {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "knorvia-daemon is missing beside the CLI",
        ))
    }
}
