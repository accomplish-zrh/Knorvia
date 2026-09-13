//! P02 global artifact catalog: one directory scan serves a filtered,
//! sorted, cursor-paginated view across every workspace. Corrupt metadata is
//! skipped and *counted* — a single bad record never hides healthy outputs,
//! and the response never claims completeness it does not have.

use super::{Artifact, ProductStore, StoreError, invalid, read_json};
use serde::{Deserialize, Serialize};
use std::fs;

pub const MAX_CATALOG_PAGE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCatalogPage {
    pub artifacts: Vec<Artifact>,
    /// Opaque keyset cursor over (updated_at, id); `None` ends the result.
    pub next_cursor: Option<String>,
    /// Corrupt/unreadable metadata files skipped by this and prior pages of
    /// the current scan. Healthy outputs stay visible; the count must be
    /// surfaced so a partial view is never mistaken for a complete one.
    pub skipped_unreadable: u64,
    /// Total catalog entries matching the filter for this scan (all pages).
    pub total_matching: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ArtifactCatalogQuery<'a> {
    /// `None` lists every workspace.
    pub workspace_id: Option<&'a str>,
    /// Case-insensitive substring match on the artifact title.
    pub title_contains: Option<&'a str>,
    /// Exact artifact type match.
    pub artifact_type: Option<&'a str>,
}

/// Keyset cursor: `(updated_at, id)` of the last row of the previous page.
/// New rows inserted later sort *before* an existing cursor, so forward
/// pagination neither repeats nor skips rows that already existed.
fn encode_cursor(artifact: &Artifact) -> String {
    serde_json::json!([artifact.updated_at, artifact.id]).to_string()
}

fn decode_cursor(raw: &str) -> Result<(String, String), StoreError> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| invalid(format!("artifact catalog cursor is invalid: {e}")))?;
    let updated_at = parsed
        .get(0)
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("artifact catalog cursor is missing updated_at"))?
        .to_string();
    let id = parsed
        .get(1)
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("artifact catalog cursor is missing id"))?
        .to_string();
    Ok((updated_at, id))
}

/// `updated_at` is `<millis>ms`; compare numerically when it parses so an
/// era with more digits cannot sort out of order.
fn updated_at_key(value: &str) -> (u64, String) {
    let digits = value.strip_suffix("ms").unwrap_or(value);
    (digits.parse::<u64>().unwrap_or(u64::MAX), value.to_string())
}

impl ProductStore {
    pub fn list_artifacts_catalog(
        &self,
        query: ArtifactCatalogQuery<'_>,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ArtifactCatalogPage, StoreError> {
        if limit == 0 {
            return Err(invalid(
                "artifact catalog page limit must be greater than zero",
            ));
        }
        let limit = limit.min(MAX_CATALOG_PAGE);
        let after = cursor.map(decode_cursor).transpose()?;
        let dir = self.product_dir().join("artifacts");
        let mut matching: Vec<Artifact> = Vec::new();
        let mut skipped_unreadable: u64 = 0;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ArtifactCatalogPage {
                    artifacts: Vec::new(),
                    next_cursor: None,
                    skipped_unreadable: 0,
                    total_matching: 0,
                });
            }
            Err(e) => return Err(StoreError::Io(e)),
        };
        let needle = query
            .title_contains
            .map(str::to_lowercase)
            .filter(|n| !n.is_empty());
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    skipped_unreadable += 1;
                    continue;
                }
            };
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let artifact: Artifact = match read_json(&path) {
                Ok(artifact) => artifact,
                // One corrupt record is reported, never fatal.
                Err(_) => {
                    skipped_unreadable += 1;
                    continue;
                }
            };
            if let Some(workspace) = query.workspace_id {
                if artifact.workspace_id != workspace {
                    continue;
                }
            }
            if let Some(artifact_type) = query.artifact_type {
                if !artifact_type.is_empty() && artifact.r#type != artifact_type {
                    continue;
                }
            }
            if let Some(needle) = &needle {
                if !artifact.title.to_lowercase().contains(needle) {
                    continue;
                }
            }
            matching.push(artifact);
        }
        let total_matching = matching.len() as u64;
        matching.sort_by(|a, b| {
            let (a_at, b_at) = (updated_at_key(&a.updated_at), updated_at_key(&b.updated_at));
            b_at.cmp(&a_at).then_with(|| b.id.cmp(&a.id))
        });
        let rows: Vec<Artifact> = match &after {
            None => matching,
            Some((after_at, after_id)) => matching
                .into_iter()
                .skip_while(|artifact| {
                    let at = updated_at_key(&artifact.updated_at);
                    let cursor_at = updated_at_key(after_at);
                    (at > cursor_at) || (at == cursor_at && &artifact.id >= after_id)
                })
                .collect(),
        };
        let has_more = rows.len() > limit;
        let page: Vec<Artifact> = rows.into_iter().take(limit).collect();
        let next_cursor = has_more.then(|| encode_cursor(page.last().expect("nonempty page")));
        Ok(ArtifactCatalogPage {
            artifacts: page,
            next_cursor,
            skipped_unreadable,
            total_matching,
        })
    }
}

#[cfg(test)]
#[path = "artifact_catalog_tests.rs"]
mod artifact_catalog_tests;
