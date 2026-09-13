use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCategory {
    InvalidArgument,
    NotInitialized,
    UnsupportedProtocol,
    AlreadyInitialized,
    NotFound,
    Conflict,
    PreconditionFailed,
    Unauthenticated,
    PermissionDenied,
    PolicyDenied,
    CapabilityUnavailable,
    ProviderAuth,
    ProviderRateLimit,
    ProviderUnsupported,
    Cancelled,
    DeadlineExceeded,
    ResourceExhausted,
    Transient,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: i64,
    pub category: ErrorCategory,
    pub message: String,
    pub user_message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.category, self.message)
    }
}

impl std::error::Error for ProtocolError {}

impl ProtocolError {
    pub fn new(category: ErrorCategory, message: impl Into<String>) -> Self {
        // Protocol errors are an RPC, logging and often persistence boundary.
        // Apply the shared bounded sanitizer at construction so a missed
        // caller-specific wrapper cannot expose an upstream credential.
        let message = crate::sanitize_diagnostic(&message.into());
        let (code, retryable): (i64, bool) = match category {
            ErrorCategory::InvalidArgument => (-32602, false),
            ErrorCategory::NotInitialized => (-32000, false),
            ErrorCategory::UnsupportedProtocol => (-32001, false),
            ErrorCategory::AlreadyInitialized => (-32002, false),
            ErrorCategory::NotFound => (-32004, false),
            ErrorCategory::Conflict => (-32005, false),
            ErrorCategory::PreconditionFailed => (-32006, false),
            ErrorCategory::Unauthenticated => (-32010, false),
            ErrorCategory::PermissionDenied | ErrorCategory::PolicyDenied => (-32011, false),
            ErrorCategory::CapabilityUnavailable | ErrorCategory::ProviderUnsupported => {
                (-32020, false)
            }
            ErrorCategory::ProviderAuth => (-32021, false),
            ErrorCategory::Cancelled => (-32030, false),
            ErrorCategory::ProviderRateLimit => (-32022, true),
            ErrorCategory::DeadlineExceeded => (-32031, true),
            ErrorCategory::ResourceExhausted => (-32032, true),
            ErrorCategory::Transient => (-32040, true),
            ErrorCategory::Internal => (-32603, false),
        };
        Self {
            code,
            category,
            user_message: message.clone(),
            message,
            retryable,
            retry_after: None,
            request_id: None,
            trace_id: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum WireError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame too large: {0} bytes")]
    FrameTooLarge(usize),
    #[error("invalid header: {0}")]
    InvalidHeader(String),
    #[error("invalid json: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("utf-8")]
    Utf8,
}
