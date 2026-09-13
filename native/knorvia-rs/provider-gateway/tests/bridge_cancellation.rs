//! Real sockets: prove cancellation reclaims upstream reads and does not complete a turn.
use knorvia_provider_gateway::{BridgeServer, UpstreamProtocol, spawn_responses_bridge};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

fn read_request(stream: &TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut length = 0;
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
            length = v.trim().parse().unwrap();
        }
    }
    reader.read_exact(&mut vec![0; length]).unwrap();
}
fn downstream(bridge: &BridgeServer) -> TcpStream {
    let mut socket = TcpStream::connect(bridge.address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let body = r#"{"model":"test","input":"hello","stream":true}"#;
    write!(socket,"POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{}",bridge.auth_token,body.len(),body).unwrap();
    socket
}
fn wait_empty(bridge: &BridgeServer) {
    let start = Instant::now();
    while bridge.active_requests() != 0 {
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "request thread was not reclaimed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn upstream(
    modes: Vec<&'static str>,
) -> (
    String,
    Receiver<usize>,
    Receiver<usize>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (ready_tx, ready) = channel();
    let (closed_tx, closed) = channel();
    let handle = std::thread::spawn(move || {
        let mut threads = vec![];
        for (i, mode) in modes.into_iter().enumerate() {
            let (mut socket, _) = listener.accept().unwrap();
            let ready = ready_tx.clone();
            let closed = closed_tx.clone();
            threads.push(std::thread::spawn(move || {
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                read_request(&socket);
                if mode!="headers" { socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap(); }
                ready.send(i).unwrap();
                if mode=="normal" {
                    std::thread::sleep(Duration::from_millis(150));
                    socket.write_all(b"data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"alive\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").unwrap();
                } else {
                    let mut byte=[0];
                    match socket.read(&mut byte) { Ok(0)=>{}, Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted)=>{}, other=>panic!("upstream connection not reclaimed: {other:?}") }
                    closed.send(i).unwrap();
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
    });
    (base, ready, closed, handle)
}
#[test]
fn independent_cancellation_interrupts_headers_and_silent_body_without_fabricated_success() {
    for mode in ["headers", "silent"] {
        let (base, ready, closed, up) = upstream(vec![mode, "normal"]);
        let mut bridge =
            spawn_responses_bridge(UpstreamProtocol::ChatCompletions, base, "key".into(), None)
                .unwrap();
        let mut cancelled = downstream(&bridge);
        assert_eq!(ready.recv_timeout(Duration::from_secs(3)).unwrap(), 0);
        let id = bridge.active_request_ids()[0];
        let mut survivor = downstream(&bridge);
        assert_eq!(ready.recv_timeout(Duration::from_secs(3)).unwrap(), 1);
        let start = Instant::now();
        assert!(bridge.cancel_request(id));
        assert_eq!(closed.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
        let mut text = String::new();
        let _ = cancelled.read_to_string(&mut text);
        assert!(!text.contains("response.completed"), "{text}");
        let mut text = String::new();
        survivor.read_to_string(&mut text).unwrap();
        assert!(
            text.contains("response.completed") && text.contains("alive"),
            "{text}"
        );
        wait_empty(&bridge);
        bridge.close();
        up.join().unwrap();
        eprintln!(
            "{mode}: cancel + survivor + joined threads {:?}",
            start.elapsed()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
#[test]
fn downstream_disconnect_and_bridge_close_reclaim_all_pending_requests() {
    let (base, ready, closed, up) = upstream(vec!["headers", "silent", "headers"]);
    let mut bridge =
        spawn_responses_bridge(UpstreamProtocol::ChatCompletions, base, "key".into(), None)
            .unwrap();
    let first = downstream(&bridge);
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    first.shutdown(Shutdown::Both).unwrap();
    assert_eq!(closed.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
    wait_empty(&bridge);
    eprintln!("disconnect reclaimed {:?}", start.elapsed());
    let _second = downstream(&bridge);
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    let _third = downstream(&bridge);
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    bridge.close();
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(bridge.active_requests(), 0);
    closed.recv_timeout(Duration::from_secs(2)).unwrap();
    closed.recv_timeout(Duration::from_secs(2)).unwrap();
    up.join().unwrap();
}
#[test]
fn cancellation_interrupts_a_stalled_verified_tls_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("https://{}", listener.local_addr().unwrap());
    let (ready_tx, ready) = channel();
    let up = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).unwrap() > 0);
        ready_tx.send(()).unwrap();
        loop {
            match socket.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ) =>
                {
                    break;
                }
                other => panic!("TLS connection not reclaimed {other:?}"),
            }
        }
    });
    let mut bridge =
        spawn_responses_bridge(UpstreamProtocol::ChatCompletions, base, "key".into(), None)
            .unwrap();
    let _socket = downstream(&bridge);
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    let start = Instant::now();
    bridge.close();
    up.join().unwrap();
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(bridge.active_requests(), 0);
}
#[test]
fn cancellation_capability_is_specific_to_the_execution_path() {
    use knorvia_provider_gateway::{CapabilityStatus, ProviderKind, negotiate, negotiate_bridge};
    for kind in ProviderKind::ALL {
        let direct = negotiate(kind, "test")
            .into_iter()
            .find(|c| c.name == "cancellation")
            .unwrap();
        assert_eq!(direct.status, CapabilityStatus::Unavailable);
        let bridge = negotiate_bridge(kind, "test")
            .into_iter()
            .find(|c| c.name == "cancellation")
            .unwrap();
        assert_eq!(
            bridge.status,
            if matches!(
                kind,
                ProviderKind::OpenAiCompatible | ProviderKind::Anthropic | ProviderKind::Local
            ) {
                CapabilityStatus::Supported
            } else {
                CapabilityStatus::Unavailable
            }
        );
    }
}
