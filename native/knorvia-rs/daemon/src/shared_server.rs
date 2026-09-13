//! Bounded multi-client transport; the calling thread is the only control owner.
use crate::endpoint::PublishedEndpoint;
use knorvia_control::{ControlPlane, EventSink};
use knorvia_platform_paths::KnorviaPaths;
use knorvia_protocol::{
    ErrorCategory, Handshake, ProtocolError, RpcFailure, read_frame, write_frame,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufReader};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_CONNECTIONS: usize = 32;
const QUEUE_LIMIT: usize = 64;

#[derive(Clone)]
struct Peer {
    output: SyncSender<String>,
    socket: Arc<TcpStream>,
    ready: Arc<AtomicBool>,
}

impl Peer {
    fn send(&self, body: String) {
        if self.output.try_send(body).is_err() {
            // A stalled client reconnects and replays durable events; it cannot
            // block a Kernel notification or allocate an unbounded spill queue.
            self.ready.store(false, Ordering::Release);
            let _ = self.socket.shutdown(Shutdown::Both);
        }
    }
}

enum Incoming {
    Open(usize, Peer),
    Frame(usize, String),
    Close(usize),
}

fn io_error(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(ErrorCategory::Internal, error.to_string())
}

struct ListenerGuard {
    stopping: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn listen(
    listener: TcpListener,
    token: String,
    incoming: SyncSender<Incoming>,
) -> io::Result<ListenerGuard> {
    listener.set_nonblocking(true)?;
    let stopping = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&stopping);
    let connections = Arc::new(AtomicUsize::new(0));
    let worker = thread::Builder::new()
        .name("knorvia-local-listener".into())
        .spawn(move || {
            let mut sequence = 0;
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket, address)) => {
                        if !address.ip().is_loopback()
                            || connections.load(Ordering::Acquire) >= MAX_CONNECTIONS
                        {
                            continue;
                        }
                        connections.fetch_add(1, Ordering::AcqRel);
                        sequence += 1;
                        let id = sequence;
                        let count = Arc::clone(&connections);
                        let token = token.clone();
                        let incoming = incoming.clone();
                        let spawned = thread::Builder::new()
                            .name("knorvia-local-client".into())
                            .spawn(move || {
                                let _ = read_client(id, socket, &token, &incoming);
                                let _ = incoming.send(Incoming::Close(id));
                                count.fetch_sub(1, Ordering::AcqRel);
                            });
                        if spawned.is_err() {
                            connections.fetch_sub(1, Ordering::AcqRel);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        })?;
    Ok(ListenerGuard {
        stopping,
        worker: Some(worker),
    })
}

fn read_client(
    id: usize,
    mut socket: TcpStream,
    token: &str,
    incoming: &SyncSender<Incoming>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Accepted sockets inherit the listener's nonblocking mode on Windows.
    socket.set_nonblocking(false)?;
    socket.set_nodelay(true)?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(socket.try_clone()?);
    let frame = read_frame(&mut reader)?;
    let auth: Value = serde_json::from_str(&frame)?;
    if auth.get("token").and_then(Value::as_str) != Some(token) {
        // Do not echo credentials or any product data to unauthenticated peers.
        return Err("local owner authentication failed".into());
    }
    write_frame(
        &mut socket,
        &json!({"attached":true,"version":1,"ownerPid":std::process::id()}).to_string(),
    )?;
    socket.set_read_timeout(None)?;
    reader.get_ref().set_read_timeout(None)?;
    reader.get_ref().set_nonblocking(false)?;
    let (output, messages) = mpsc::sync_channel::<String>(QUEUE_LIMIT);
    let peer = Peer {
        output,
        socket: Arc::new(socket.try_clone()?),
        ready: Arc::new(AtomicBool::new(false)),
    };
    thread::Builder::new()
        .name("knorvia-local-writer".into())
        .spawn(move || {
            for body in messages {
                if write_frame(&mut socket, &body).is_err() {
                    break;
                }
            }
            let _ = socket.shutdown(Shutdown::Both);
        })?;
    incoming.send(Incoming::Open(id, peer))?;
    loop {
        match read_frame(&mut reader) {
            Ok(body) => incoming.send(Incoming::Frame(id, body))?,
            Err(knorvia_protocol::WireError::Io(error))
                if error.kind() == io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(_) => break,
        }
    }
    Ok(())
}

pub(crate) fn serve(paths: KnorviaPaths) -> Result<(), ProtocolError> {
    let ownership = ControlPlane::acquire_home(paths.clone())?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(io_error)?;
    let published =
        PublishedEndpoint::publish(&paths, listener.local_addr().map_err(io_error)?.port())
            .map_err(io_error)?;
    let (incoming, frames) = mpsc::sync_channel(QUEUE_LIMIT);
    let listener =
        listen(listener, published.endpoint.token.clone(), incoming).map_err(io_error)?;
    // Attachment is transport identity only, not readiness. Queue bounded client
    // initialization frames during a large cold replay, without timing out the
    // proxy's short owner-discovery deadline or ever admitting a second writer.
    // Recovery failure drops both the listener and the queued peers.
    let mut plane = ControlPlane::open_with_ownership(ownership)?;
    let peers: Arc<Mutex<HashMap<usize, Peer>>> = Arc::new(Mutex::new(HashMap::new()));
    let notify_peers = Arc::clone(&peers);
    let sink: EventSink = Arc::new(move |method, params| {
        let body = json!({"jsonrpc":"2.0","method":method,"params":params}).to_string();
        if let Ok(peers) = notify_peers.lock() {
            for peer in peers
                .values()
                .filter(|peer| peer.ready.load(Ordering::Acquire))
            {
                peer.send(body.clone());
            }
        }
    });
    plane.set_sink(Some(sink));
    let scheduler = plane.start_automation_scheduler()?;
    let mut sessions = HashMap::<usize, Handshake>::new();
    let mut restart_owner = None;
    let mut seen_client = false;
    let started = Instant::now();
    let mut final_peer = None;
    loop {
        plane.dispatch_queued_automations(&scheduler);
        if let Err(error) = plane.dispatch_queued_messages() { eprintln!("chat queue: {}", error.message); }
        match frames.recv_timeout(Duration::from_millis(25)) {
            Ok(Incoming::Open(id, peer)) => {
                if std::env::var_os("KNORVIA_TRANSPORT_TRACE").is_some() {
                    eprintln!("transport open {id}; peers={}", sessions.len());
                }
                if restart_owner.is_some() {
                    let _ = peer.socket.shutdown(Shutdown::Both);
                    continue;
                }
                seen_client = true;
                sessions.insert(id, Handshake::new());
                peers.lock().map_err(io_error)?.insert(id, peer);
            }
            Ok(Incoming::Frame(id, body)) => {
                let count = sessions.len();
                let Some(session) = sessions.get_mut(&id) else {
                    continue;
                };
                let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                let request_id =
                    serde_json::from_value::<knorvia_protocol::RequestId>(request["id"].clone())
                        .ok();
                let response = if method == "system/prepareRestart"
                    && count > 1
                    && session.is_ready()
                    && request_id.is_some()
                {
                    Some(serde_json::to_string(&RpcFailure::from_category(request_id.expect("validated request id"),
                        ErrorCategory::Conflict, "other clients are connected; close them before updating the shared runtime")).map_err(io_error)?)
                } else {
                    let peer = peers.lock().map_err(io_error)?.get(&id).cloned();
                    if let Some(peer) = peer {
                        if plane.defer_pack_request(session, &body, Arc::new(move |response| peer.send(response)))? { continue; }
                    }
                    match plane.handle_session_json(session, &body) {
                        Ok(response) => response,
                        Err(_) => {
                            if let Some(peer) = peers.lock().map_err(io_error)?.get(&id) {
                                let _ = peer.socket.shutdown(Shutdown::Both);
                            }
                            continue;
                        }
                    }
                };
                if let Some(response) = &response {
                    let ok = serde_json::from_str::<Value>(response)
                        .ok()
                        .is_some_and(|value| value.get("result").is_some());
                    if ok && method == "system/prepareRestart" {
                        restart_owner = Some(id);
                    }
                    if ok && method == "system/cancelRestart" {
                        restart_owner = None;
                    }
                }
                if let Some(peer) = peers.lock().map_err(io_error)?.get(&id) {
                    peer.ready.store(session.is_ready(), Ordering::Release);
                    if let Some(body) = response {
                        peer.send(body);
                    }
                }
            }
            Ok(Incoming::Close(id)) => {
                if std::env::var_os("KNORVIA_TRANSPORT_TRACE").is_some() {
                    eprintln!("transport close {id}; peers={}", sessions.len());
                }
                sessions.remove(&id);
                let peer = peers.lock().map_err(io_error)?.remove(&id);
                if sessions.is_empty() {
                    final_peer = peer;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if sessions.is_empty() && (seen_client || started.elapsed() > Duration::from_secs(10)) {
            let running = plane
                .store()
                .running_turn_count()
                .map_err(|error| error.into_protocol())?;
            let scheduled = plane
                .store()
                .list_automations(None)
                .map_err(|error| error.into_protocol())?
                .iter()
                .any(|plan| plan.status == knorvia_store::AutomationStatus::Active);
            let queued = plane.has_queued_message_work()?;
            if running == 0 && !queued && !plane.has_active_pack_requests() && (!scheduled || restart_owner.is_some()) {
                break;
            }
            // Closing a window detaches; active work and schedules retain ownership.
            final_peer = None;
        }
    }
    // The final client sees EOF only after the Kernel exits and the Home lock is
    // released, making provider replacement and a following CLI invocation safe.
    drop(listener);
    drop(published);
    drop(scheduler);
    plane.set_sink(None);
    drop(plane);
    drop(final_peer);
    for peer in peers.lock().map_err(io_error)?.values() {
        let _ = peer.socket.shutdown(Shutdown::Both);
    }
    Ok(())
}
