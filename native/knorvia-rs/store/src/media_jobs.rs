//! Durable job lookup for optional media workers. Job state stays in the store.
use super::*;

impl ProductStore {
    pub fn list_jobs(&self, workspace_id: &str, prefix: &str) -> Result<Vec<Job>, StoreError> {
        self.read_workspace(workspace_id)?;
        // A fresh store has no jobs directory yet; an empty list is the
        // honest answer, not an internal error.
        let entries = match fs::read_dir(self.product_dir().join("jobs")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut jobs = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                let job: Job = read_json(&path)?;
                if job.workspace_id == workspace_id && job.r#type.starts_with(prefix) {
                    jobs.push(job);
                }
            }
        }
        jobs.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(jobs)
    }
}

#[cfg(test)]
#[path = "media_jobs_tests.rs"]
mod tests;
