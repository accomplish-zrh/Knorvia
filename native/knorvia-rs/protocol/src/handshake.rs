use crate::{
    ClientInfo, ErrorCategory, InitializeParams, InitializeResult, MAX_FRAME_BYTES, PRODUCT_NAME,
    PROTOCOL_MAJOR, PROTOCOL_MINOR, ProtocolError, ProtocolVersion, SERVER_NAME,
    STABLE_CAPABILITIES, ServerIdentity, TELEMETRY_NAMESPACE, USER_AGENT, session_id,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeState {
    New,
    InitializeReceived,
    Ready,
}

#[derive(Debug, Clone)]
pub struct Handshake {
    state: HandshakeState,
    session_id: Option<String>,
    client: Option<ClientInfo>,
    negotiated: Option<ProtocolVersion>,
}

impl Default for Handshake {
    fn default() -> Self {
        Self::new()
    }
}

impl Handshake {
    pub fn new() -> Self {
        Self {
            state: HandshakeState::New,
            session_id: None,
            client: None,
            negotiated: None,
        }
    }

    pub fn state(&self) -> HandshakeState {
        self.state
    }

    pub fn is_ready(&self) -> bool {
        self.state == HandshakeState::Ready
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn client(&self) -> Option<&ClientInfo> {
        self.client.as_ref()
    }

    pub fn initialize(
        &mut self,
        params: InitializeParams,
    ) -> Result<InitializeResult, ProtocolError> {
        if self.state != HandshakeState::New {
            return Err(ProtocolError::new(
                ErrorCategory::AlreadyInitialized,
                "initialize may be sent only once per connection",
            ));
        }
        if params.protocol.major != PROTOCOL_MAJOR {
            return Err(ProtocolError::new(
                ErrorCategory::UnsupportedProtocol,
                format!(
                    "unsupported protocol major {} (server {})",
                    params.protocol.major, PROTOCOL_MAJOR
                ),
            ));
        }
        if params.client.name.trim().is_empty() {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "client.name is required and must identify Knorvia, not a Codex product",
            ));
        }
        let minor = params.protocol.minor.min(PROTOCOL_MINOR);
        let negotiated = ProtocolVersion {
            major: PROTOCOL_MAJOR,
            minor,
        };
        let session = session_id();
        let mut caps: Vec<String> = STABLE_CAPABILITIES
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        caps.retain(|c| {
            params.capabilities.is_empty() || params.capabilities.iter().any(|p| p == c)
        });
        if caps.is_empty() {
            caps = STABLE_CAPABILITIES
                .iter()
                .map(|s| (*s).to_string())
                .collect();
        }
        self.state = HandshakeState::InitializeReceived;
        self.session_id = Some(session.clone());
        self.client = Some(params.client);
        self.negotiated = Some(negotiated);
        Ok(InitializeResult {
            protocol: negotiated,
            server: ServerIdentity {
                name: SERVER_NAME.to_string(),
                product: PRODUCT_NAME.to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                user_agent: USER_AGENT.to_string(),
                telemetry_namespace: TELEMETRY_NAMESPACE.to_string(),
            },
            session_id: session,
            capabilities: caps,
            preview_capabilities: Vec::new(),
            resume_supported: true,
            max_frame_bytes: MAX_FRAME_BYTES,
        })
    }

    pub fn initialized(&mut self) -> Result<(), ProtocolError> {
        match self.state {
            HandshakeState::InitializeReceived => {
                self.state = HandshakeState::Ready;
                Ok(())
            }
            HandshakeState::New => Err(ProtocolError::new(
                ErrorCategory::NotInitialized,
                "initialized sent before initialize",
            )),
            HandshakeState::Ready => Err(ProtocolError::new(
                ErrorCategory::AlreadyInitialized,
                "duplicate initialized",
            )),
        }
    }

    pub fn require_ready(&self) -> Result<(), ProtocolError> {
        if self.state == HandshakeState::Ready {
            Ok(())
        } else {
            Err(ProtocolError::new(
                ErrorCategory::NotInitialized,
                "connection is not initialized",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(major: u32, name: &str) -> InitializeParams {
        InitializeParams {
            protocol: ProtocolVersion { major, minor: 0 },
            client: ClientInfo {
                name: name.into(),
                version: "0.1.0".into(),
                platform: Some("windows".into()),
                title: None,
            },
            capabilities: vec!["thread".into(), "workspace".into()],
            locale: Some("zh-CN".into()),
        }
    }

    #[test]
    fn handshake_happy_path() {
        let mut hs = Handshake::new();
        let result = hs.initialize(params(1, "knorvia_desktop")).unwrap();
        assert_eq!(result.server.name, "knorvia-daemon");
        assert_eq!(result.server.product, "Knorvia");
        assert!(!result.server.user_agent.to_lowercase().contains("codex"));
        assert_eq!(result.protocol.major, 1);
        assert!(result.resume_supported);
        hs.initialized().unwrap();
        assert!(hs.is_ready());
    }

    #[test]
    fn rejects_wrong_major() {
        let mut hs = Handshake::new();
        let err = hs.initialize(params(2, "knorvia_desktop")).unwrap_err();
        assert_eq!(err.category, ErrorCategory::UnsupportedProtocol);
    }

    #[test]
    fn rejects_duplicate_initialize() {
        let mut hs = Handshake::new();
        hs.initialize(params(1, "knorvia_cli")).unwrap();
        let err = hs.initialize(params(1, "knorvia_cli")).unwrap_err();
        assert_eq!(err.category, ErrorCategory::AlreadyInitialized);
    }

    #[test]
    fn methods_before_ready_fail() {
        let hs = Handshake::new();
        let err = hs.require_ready().unwrap_err();
        assert_eq!(err.category, ErrorCategory::NotInitialized);
    }
}
