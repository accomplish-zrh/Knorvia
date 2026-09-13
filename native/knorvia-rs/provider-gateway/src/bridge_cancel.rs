//! Per-request socket ownership for synchronous ureq, including TLS handshakes.
use std::io;
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
pub(super) struct RequestCancel(Arc<RequestState>);
#[derive(Default)]
struct RequestState {
    stopped: AtomicBool,
    sockets: Mutex<Vec<TcpStream>>,
}

impl RequestCancel {
    pub fn stopped(&self) -> bool {
        self.0.stopped.load(Ordering::Acquire)
    }
    pub fn register(&self, socket: &TcpStream) -> io::Result<()> {
        let mut sockets = self.0.sockets.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopped() {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "bridge request cancelled",
            ));
        }
        sockets.push(socket.try_clone()?);
        Ok(())
    }
    pub fn cancel(&self) {
        self.0.stopped.store(true, Ordering::Release);
        for socket in self
            .0
            .sockets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

pub(super) struct DisconnectWatch {
    cancel: RequestCancel,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl DisconnectWatch {
    pub fn start(socket: &TcpStream, cancel: RequestCancel) -> io::Result<Self> {
        let socket = socket.try_clone()?;
        socket.set_read_timeout(Some(Duration::from_millis(50)))?;
        let watch = cancel.clone();
        let thread = std::thread::Builder::new()
            .name("bridge-disconnect".into())
            .spawn(move || {
                let mut byte = [0];
                while !watch.stopped() {
                    match socket.peek(&mut byte) {
                        Ok(0) => break,
                        Err(error)
                            if !matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                            ) =>
                        {
                            break;
                        }
                        _ => {}
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                watch.cancel();
            })?;
        Ok(Self {
            cancel,
            thread: Some(thread),
        })
    }
}
impl Drop for DisconnectWatch {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// DNS is resolved during bridge construction, before any in-flight request
/// exists. A live request uses at most two cached addresses, bounded connect
/// attempts, and a registered socket before HTTP headers or TLS can block.
#[derive(Clone)]
pub(super) struct UpstreamTransport {
    addresses: Vec<SocketAddr>,
    plaintext: bool,
    port: u16,
    tls: Arc<ureq::rustls::ClientConfig>,
}
impl UpstreamTransport {
    pub fn prepare(base: &str) -> io::Result<Self> {
        let url = url::Url::parse(base).map_err(io::Error::other)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(io::Error::other("bridge upstream requires http or https"));
        }
        let host = url
            .host_str()
            .ok_or_else(|| io::Error::other("upstream host missing"))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| io::Error::other("upstream port missing"))?;
        let addresses: Vec<_> = (host, port).to_socket_addrs()?.take(2).collect();
        if addresses.is_empty() {
            return Err(io::Error::other("upstream DNS returned no addresses"));
        }
        let roots = ureq::rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = ureq::rustls::ClientConfig::builder_with_provider(
            ureq::rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_root_certificates(roots)
        .with_no_client_auth();
        Ok(Self {
            addresses,
            plaintext: url.scheme() == "http",
            port,
            tls: Arc::new(tls),
        })
    }
    pub fn request(&self, address: &str, cancel: RequestCancel) -> io::Result<ureq::Request> {
        let mut url = url::Url::parse(address).map_err(io::Error::other)?;
        // ureq exposes socket ownership at its TLS connector seam. Explicit
        // HTTP endpoints pass through that seam unchanged on their original
        // port; HTTPS uses the same verified rustls trust roots as ureq.
        url.set_scheme("https")
            .map_err(|_| io::Error::other("invalid upstream scheme"))?;
        url.set_port(Some(self.port))
            .map_err(|_| io::Error::other("invalid upstream port"))?;
        let addresses = self.addresses.clone();
        let resolve_cancel = cancel.clone();
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(Duration::from_millis(500))
            .timeout_write(Duration::from_secs(5))
            .resolver(move |_: &str| {
                if resolve_cancel.stopped() {
                    Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "request cancelled",
                    ))
                } else {
                    Ok(addresses.clone())
                }
            })
            .tls_connector(Arc::new(TrackedConnector {
                cancel,
                plaintext: self.plaintext,
                tls: Arc::clone(&self.tls),
            }))
            .build();
        Ok(agent.post(url.as_str()))
    }
}

struct TrackedConnector {
    cancel: RequestCancel,
    plaintext: bool,
    tls: Arc<ureq::rustls::ClientConfig>,
}
impl ureq::TlsConnector for TrackedConnector {
    fn connect(
        &self,
        name: &str,
        io: Box<dyn ureq::ReadWrite>,
    ) -> Result<Box<dyn ureq::ReadWrite>, ureq::Error> {
        let socket = io.socket().ok_or_else(|| {
            ureq::Error::from(io::Error::other(
                "upstream socket unavailable for cancellation",
            ))
        })?;
        self.cancel.register(socket).map_err(ureq::Error::from)?;
        if self.plaintext {
            Ok(io)
        } else {
            ureq::TlsConnector::connect(&self.tls, name, io)
        }
    }
}
