//! Transport sessions have independent handshakes but one durable owner.
use super::*;

impl ControlPlane {
    pub fn handle_session_json(
        &mut self,
        session: &mut Handshake,
        body: &str,
    ) -> Result<Option<String>, ProtocolError> {
        std::mem::swap(&mut self.handshake, session);
        let result = self.handle_json(body);
        std::mem::swap(&mut self.handshake, session);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_clients_handshake_does_not_initialize_another() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        let mut first = Handshake::new();
        let mut second = Handshake::new();
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocol":{"major":1,"minor":0},"client":{"name":"knorvia_test","version":"1"},
            "capabilities":[]
        }})
        .to_string();
        plane.handle_session_json(&mut first, &init).unwrap();
        plane
            .handle_session_json(&mut first, r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .unwrap();
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"workspace/list","params":{}}"#;
        let rejected = plane
            .handle_session_json(&mut second, req)
            .unwrap()
            .unwrap();
        assert!(rejected.contains("NOT_INITIALIZED"));
        let accepted = plane.handle_session_json(&mut first, req).unwrap().unwrap();
        assert!(accepted.contains("result"));
        plane.handle_session_json(&mut second, &init).unwrap();
        assert_ne!(first.session_id(), second.session_id());
    }
}
