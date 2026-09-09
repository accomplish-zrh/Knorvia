//! Pack model backend backed by the live Provider Gateway.
//!
//! Used by the daemon AND by the pack worker process (which receives only the
//! explicitly allowlisted provider variables — never the full parent
//! environment).

use crate::{PackExecError, PackModel};
use knorvia_provider_gateway::{
    CanonicalMessage, CanonicalRequest, ExecuteConfig, PROVIDER_BASE_URL_ENV, PROVIDER_KEY_ENV,
    ProviderKind, execute, translate,
};

pub const PROVIDER_KIND_ENV: &str = "KNORVIA_PROVIDER_KIND";
pub const PROVIDER_MODEL_ENV: &str = "KNORVIA_PROVIDER_MODEL";

/// Environment variables the pack worker may inherit from the daemon. The
/// worker never receives the full parent environment.
pub const WORKER_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    PROVIDER_KIND_ENV,
    PROVIDER_MODEL_ENV,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_KEY_ENV,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayModel {
    kind: ProviderKind,
    model: String,
    base_url: String,
    api_key: Option<String>,
}

fn env_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl GatewayModel {
    /// `Some` only when the provider environment is fully configured
    /// (model + base URL). The API key is optional (local gateways).
    pub fn from_env() -> Option<Self> {
        let model = env_trimmed(PROVIDER_MODEL_ENV)?;
        let base_url = env_trimmed(PROVIDER_BASE_URL_ENV)?;
        let kind = env_trimmed(PROVIDER_KIND_ENV)
            .and_then(|k| ProviderKind::parse(&k).ok())
            .unwrap_or(ProviderKind::OpenAiResponses);
        Some(Self {
            kind,
            model,
            base_url,
            api_key: env_trimmed(PROVIDER_KEY_ENV),
        })
    }
}

impl PackModel for GatewayModel {
    fn complete(&mut self, prompt: &str) -> Result<String, PackExecError> {
        let req = CanonicalRequest {
            model: self.model.clone(),
            messages: vec![CanonicalMessage {
                role: "user".into(),
                text: prompt.to_string(),
                ..Default::default()
            }],
            max_tokens: 2048,
            ..Default::default()
        };
        let tx = translate(self.kind, req)
            .map_err(|e| PackExecError::Msg(format!("provider translation failed: {e}")))?;
        let cfg = ExecuteConfig {
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
        };
        let result = execute(&tx, &cfg)
            .map_err(|e| PackExecError::Msg(format!("provider call failed: {e}")))?;
        if let Some(err) = result.error {
            return Err(PackExecError::Msg(format!("provider error: {err}")));
        }
        Ok(result.text)
    }
}

/// The model choice for this process: `GatewayFromEnv` when the provider
/// environment is configured, otherwise template mode (labeled, never
/// pretending to be model output).
pub fn env_choice() -> crate::ModelChoice<'static> {
    if GatewayModel::from_env().is_some() {
        crate::ModelChoice::GatewayFromEnv
    } else {
        crate::ModelChoice::None
    }
}
