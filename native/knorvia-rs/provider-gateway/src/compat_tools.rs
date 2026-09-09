//! Lossless identities across protocols without native tool namespaces.
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) struct CompatTools {
    aliases: HashMap<String, (String, String, Option<String>)>,
}
impl CompatTools {
    pub(crate) fn prepare(body: &Value) -> (Value, Self) {
        let mut result = body.clone();
        let mut this = Self {
            aliases: HashMap::new(),
        };
        let mut tools = Vec::new();
        for tool in body["tools"].as_array().into_iter().flatten() {
            if tool["type"] == "namespace" {
                let namespace = tool["name"].as_str().unwrap_or("");
                for nested in tool["tools"].as_array().into_iter().flatten() {
                    let name = nested["name"].as_str().unwrap_or("");
                    let mut nested = nested.clone();
                    nested["name"] = json!(this.alias("function_call", name, Some(namespace)));
                    tools.push(nested);
                }
            } else if tool["type"] == "tool_search" {
                tools.push(json!({"type": "function", "name": this.alias("tool_search_call", "tool_search", None), "description": tool["description"], "parameters": tool["parameters"]}));
            } else if tool["type"] == "custom" {
                tools.push(json!({"type": "function", "name": this.alias("custom_tool_call", tool["name"].as_str().unwrap_or(""), None), "description": tool["description"], "parameters": {"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false}}));
            } else if tool["type"] == "function" {
                tools.push(tool.clone());
            }
        }
        result["tools"] = json!(tools);
        if let Some(items) = result["input"].as_array_mut() {
            for item in items {
                match item["type"].as_str().unwrap_or("") {
                    "function_call" if item["namespace"].is_string() => {
                        let alias = this.alias(
                            "function_call",
                            item["name"].as_str().unwrap_or(""),
                            item["namespace"].as_str(),
                        );
                        item["name"] = json!(alias);
                    }
                    "tool_search_call" => {
                        let arguments = item["arguments"].to_string();
                        item["type"] = json!("function_call");
                        item["name"] = json!(this.alias("tool_search_call", "tool_search", None));
                        item["arguments"] = json!(arguments);
                    }
                    "tool_search_output" => {
                        let output = item["tools"].to_string();
                        item["type"] = json!("function_call_output");
                        item["output"] = json!(output);
                    }
                    "custom_tool_call" => {
                        let name = this.alias(
                            "custom_tool_call",
                            item["name"].as_str().unwrap_or(""),
                            None,
                        );
                        let arguments = json!({"input":item["input"]}).to_string();
                        item["type"] = json!("function_call");
                        item["name"] = json!(name);
                        item["arguments"] = json!(arguments);
                    }
                    "custom_tool_call_output" => {
                        item["type"] = json!("function_call_output");
                    }
                    _ => {}
                }
            }
        }
        (result, this)
    }
    fn alias(&mut self, kind: &str, name: &str, namespace: Option<&str>) -> String {
        let identity = format!("{kind}\0{}\0{name}", namespace.unwrap_or(""));
        let hash = identity.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
        let alias = format!("knorvia_{hash:016x}");
        self.aliases.insert(
            alias.clone(),
            (kind.into(), name.into(), namespace.map(str::to_string)),
        );
        alias
    }
    pub(crate) fn restore(&self, event: &mut Value) {
        if event["item"]["type"] != "function_call" {
            return;
        }
        let Some((kind, name, namespace)) = event["item"]["name"]
            .as_str()
            .and_then(|name| self.aliases.get(name))
        else {
            return;
        };
        let item = &mut event["item"];
        item["type"] = json!(kind);
        item["name"] = json!(name);
        if let Some(namespace) = namespace {
            item["namespace"] = json!(namespace);
        }
        if kind == "tool_search_call" {
            item["execution"] = json!("client");
            item["arguments"] = serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(json!({}));
            item.as_object_mut().unwrap().remove("name");
        } else if kind == "custom_tool_call" {
            let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(json!({}));
            item["input"] = args["input"].clone();
            item.as_object_mut().unwrap().remove("arguments");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespace_and_search_roundtrip_preserves_identity() {
        let input = json!({"tools":[{"type":"namespace","name":"multi_agent_v1","tools":[{"type":"function","name":"spawn_agent","parameters":{"type":"object"}}]},{"type":"tool_search","parameters":{"type":"object"}}]});
        let (out, map) = CompatTools::prepare(&input);
        assert_eq!(out["tools"].as_array().unwrap().len(), 2);
        let mut call = json!({"item":{"type":"function_call","name":out["tools"][0]["name"],"call_id":"c","arguments":"{}"}});
        map.restore(&mut call);
        assert_eq!(call["item"]["name"], "spawn_agent");
        assert_eq!(call["item"]["namespace"], "multi_agent_v1");
        let mut search = json!({"item":{"type":"function_call","name":out["tools"][1]["name"],"arguments":"{\"query\":\"spawn\"}"}});
        map.restore(&mut search);
        assert_eq!(search["item"]["type"], "tool_search_call");
        assert_eq!(search["item"]["arguments"]["query"], "spawn");
    }
}
