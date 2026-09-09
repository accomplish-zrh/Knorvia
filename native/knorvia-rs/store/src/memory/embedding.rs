//! Optional caller-supplied embeddings. This layer never loads a model,
//! sends network requests, or reads credentials. Plugins can provide vectors
//! from an explicitly selected backend; keyword recall remains the default.

use super::{MemoryError, MemoryErrorKind, MemoryRecord, err};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedMemory {
    pub record_id: String,
    pub revision: u64,
    pub vector: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEmbeddingQuery {
    pub model: String,
    pub query_vector: Vec<f64>,
    pub records: Vec<EmbeddedMemory>,
}

impl MemoryEmbeddingQuery {
    pub(super) fn validate(&self) -> Result<(), MemoryError> {
        let valid_vector = |vector: &[f64]| {
            !vector.is_empty()
                && vector.len() <= 4096
                && vector.iter().all(|v| v.is_finite() && v.abs() <= 1e6)
                && vector.iter().any(|v| *v != 0.0)
        };
        if self.model.trim().is_empty()
            || self.model.len() > 128
            || self.records.len() > 1000
            || !valid_vector(&self.query_vector)
        {
            return err(
                MemoryErrorKind::InvalidArgument,
                "invalid embedding model, vector or candidate limit",
            );
        }
        let mut ids = std::collections::HashSet::new();
        for record in &self.records {
            if !valid_vector(&record.vector)
                || record.vector.len() != self.query_vector.len()
                || !ids.insert(&record.record_id)
            {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    "embedding dimensions, values or duplicate ids are invalid",
                );
            }
        }
        Ok(())
    }

    /// Only called after visibility, status and validity filtering. Vectors
    /// from stale revisions never rank edited, forgotten or replaced text.
    pub(super) fn score(&self, record: &MemoryRecord) -> u64 {
        let Some(candidate) = self.records.iter().find(|candidate| {
            candidate.record_id == record.id && candidate.revision == record.revision
        }) else {
            return 0;
        };
        let dot: f64 = candidate
            .vector
            .iter()
            .zip(&self.query_vector)
            .map(|(a, b)| a * b)
            .sum();
        let norm = candidate.vector.iter().map(|v| v * v).sum::<f64>().sqrt()
            * self.query_vector.iter().map(|v| v * v).sum::<f64>().sqrt();
        let similarity = (dot / norm).clamp(-1.0, 1.0);
        if similarity < 0.25 {
            0
        } else {
            (similarity * 20.0).round() as u64
        }
    }
}
