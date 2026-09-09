//! Only product-owned local marketplaces can reach the Kernel plugin API.
use super::*;

fn invalid(message: &str) -> ProtocolError {
    ProtocolError::new(ErrorCategory::InvalidArgument, message)
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn plugin_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

impl ControlPlane {
    pub(super) fn rpc_extension_kernel(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let root = self
            .store
            .paths()
            .home
            .join("extensions")
            .join("marketplaces");
        let root = root
            .canonicalize()
            .map_err(|_| invalid("No local marketplace exists"))?;
        let (manifest, requested, attempt) = if method == "plugin/uninstall" {
            let id = required_str(params, "pluginId")?;
            let (name, suffix) = id
                .split_once("@knorvia-")
                .ok_or_else(|| invalid("Only Knorvia-managed plugins can be removed"))?;
            if !plugin_name(name) || !uuid(suffix) {
                return Err(invalid("Invalid managed plugin identity"));
            }
            (
                root.join(suffix).join(".agents/plugins/marketplace.json"),
                name.to_string(),
                None,
            )
        } else {
            let name = required_str(params, "pluginName")?;
            if !plugin_name(name) {
                return Err(invalid("Invalid plugin name"));
            }
            let path = std::path::PathBuf::from(required_str(params, "marketplacePath")?);
            if !path.is_absolute() {
                return Err(invalid("marketplacePath must be absolute"));
            }
            let attempt = params.get("installAttemptId").and_then(Value::as_str);
            if method == "plugin/install" && !attempt.is_some_and(uuid) {
                return Err(invalid("installAttemptId must be a UUID"));
            }
            (path, name.to_string(), attempt.map(str::to_string))
        };
        let allowed = if method == "plugin/uninstall" {
            &["pluginId"][..]
        } else {
            &["marketplacePath", "pluginName", "installAttemptId"][..]
        };
        if params
            .as_object()
            .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
        {
            return Err(invalid("Unsupported plugin management field"));
        }
        let manifest = manifest
            .canonicalize()
            .map_err(|_| invalid("Local marketplace manifest is missing"))?;
        let relative = manifest
            .strip_prefix(&root)
            .map_err(|_| invalid("Marketplace is outside this Knorvia Home"))?;
        let parts: Vec<_> = relative.iter().filter_map(|part| part.to_str()).collect();
        if parts.len() != 4
            || !uuid(parts[0])
            || parts[1..] != [".agents", "plugins", "marketplace.json"]
        {
            return Err(invalid("Invalid local marketplace layout"));
        }
        let entry = root
            .join(parts[0])
            .canonicalize()
            .map_err(|_| invalid("Missing marketplace owner"))?;
        if std::fs::metadata(&manifest)
            .map_err(|_| invalid("Cannot read marketplace"))?
            .len()
            > 1024 * 1024
        {
            return Err(invalid("Marketplace manifest is too large"));
        }
        let value: Value = serde_json::from_slice(
            &std::fs::read(&manifest).map_err(|_| invalid("Cannot read marketplace"))?,
        )
        .map_err(|_| invalid("Invalid marketplace JSON"))?;
        if value["name"] != format!("knorvia-{}", parts[0]) {
            return Err(invalid("Marketplace owner mismatch"));
        }
        let plugins = value["plugins"]
            .as_array()
            .ok_or_else(|| invalid("Missing marketplace plugins"))?;
        let mut found = false;
        for plugin in plugins {
            if plugin["source"]["source"] != "local" {
                return Err(invalid("Only local plugin sources are allowed"));
            }
            let path = plugin["source"]["path"]
                .as_str()
                .ok_or_else(|| invalid("Missing local plugin source"))?;
            let source = entry
                .join(path)
                .canonicalize()
                .map_err(|_| invalid("Local plugin source is missing"))?;
            if !source.starts_with(&entry) || !source.is_dir() {
                return Err(invalid("Plugin source escapes its marketplace"));
            }
            found |= plugin["name"] == requested;
        }
        if !found {
            return Err(invalid("Plugin is absent from its managed marketplace"));
        }
        let upstream = if method == "plugin/uninstall" {
            json!({"pluginId":format!("{}@knorvia-{}", requested, parts[0])})
        } else {
            let mut value = json!({"marketplacePath":manifest, "pluginName":requested});
            if let Some(attempt) = attempt {
                value["installAttemptId"] = json!(attempt);
            }
            value
        };
        let result = self.executor_lock().extension_kernel(method, &upstream)?;
        let count = result
            .get("appsNeedingAuth")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        if method == "plugin/read" {
            Ok(
                json!({"ok":true, "installed":result.pointer("/plugin/summary/installed").or_else(|| result.pointer("/plugin/installed")).and_then(Value::as_bool), "enabled":result.pointer("/plugin/summary/enabled").or_else(|| result.pointer("/plugin/enabled")).and_then(Value::as_bool), "needsAuth":count}),
            )
        } else {
            Ok(json!({"ok":true,"needsAuth":count}))
        }
    }
}
