//! Durable product→Kernel thread bindings (A04).
//!
//! A binding is a product record: one projection document per product
//! thread, committed through the WAL so a restart recovers it together with
//! the rest of the durable state. The legacy `kernel-threads.json` sidecar
//! stays the import source and is never rewritten here; losing the
//! reconstructible projection is repaired by re-import or re-bind, while the
//! Kernel keeps owning the rollout history itself.

use super::*;
use serde_json::{Value, json};
use std::collections::HashMap;

impl ProductStore {
    pub(crate) fn kernel_binding_path(&self, thread_id: &str) -> std::path::PathBuf {
        self.product_dir()
            .join("kernel-bindings")
            .join(format!("{thread_id}.json"))
    }

    /// Read one binding. A malformed document is a typed error, never an
    /// empty answer: a binding that cannot be understood must fail closed
    /// instead of silently starting a replacement Kernel conversation.
    pub fn read_kernel_thread_binding(
        &self,
        thread_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let path = self.kernel_binding_path(thread_id);
        if !path.exists() {
            return Ok(None);
        }
        let document: Value = read_json(&path)?;
        let kernel_thread_id = document
            .get("kernelThreadId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(format!("kernel binding {thread_id} has no kernelThreadId")))?
            .to_string();
        Ok(Some(kernel_thread_id))
    }

    /// Every durable binding. Entries that cannot be understood abort the
    /// listing with a typed error so callers never treat corruption as
    /// "unbound".
    pub fn list_kernel_thread_bindings(
        &self,
    ) -> Result<HashMap<String, String>, StoreError> {
        let dir = self.product_dir().join("kernel-bindings");
        let mut map = HashMap::new();
        if !dir.exists() {
            return Ok(map);
        }
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let document: Value = read_json(&path)?;
            let thread_id = document
                .get("threadId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!(
                    "kernel binding {} has no threadId",
                    path.display()
                )))?
                .to_string();
            let kernel_thread_id = document
                .get("kernelThreadId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!(
                    "kernel binding {thread_id} has no kernelThreadId"
                )))?
                .to_string();
            map.insert(thread_id, kernel_thread_id);
        }
        Ok(map)
    }

    /// Bind one product thread to one Kernel thread atomically. Binding the
    /// same target again is idempotent; any other pre-existing binding is a
    /// Conflict — rebinding requires an explicit, intentional flow, never a
    /// racing write.
    pub fn bind_kernel_thread(
        &self,
        thread_id: &str,
        kernel_thread_id: &str,
    ) -> Result<(), StoreError> {
        if thread_id.is_empty() || kernel_thread_id.is_empty() {
            return Err(invalid(
                "kernel binding requires a product thread and a Kernel thread id",
            ));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        if let Some(existing) = self.read_kernel_thread_binding(thread_id)? {
            if existing == kernel_thread_id {
                return Ok(());
            }
            return Err(conflict(format!(
                "product thread {thread_id} is already bound to another Kernel thread"
            )));
        }
        let document = json!({"threadId": thread_id, "kernelThreadId": kernel_thread_id});
        let write = self.projection_write(ProjectionKind::KernelBinding, thread_id, &document)?;
        self.commit_transaction_locked(
            thread_id,
            "kernelThread.bound",
            document,
            None,
            vec![write],
        )?;
        Ok(())
    }

    /// Idempotent import of the legacy sidecar map. Entries whose product
    /// thread already has a binding (to any target) are skipped, so
    /// re-importing after a partial run can never rebind or overwrite.
    /// Returns how many entries were newly bound.
    pub fn import_kernel_thread_bindings(
        &self,
        legacy: &HashMap<String, String>,
    ) -> Result<usize, StoreError> {
        let mut imported = 0;
        for (thread_id, kernel_thread_id) in legacy {
            if self.read_kernel_thread_binding(thread_id)?.is_some() {
                continue;
            }
            self.bind_kernel_thread(thread_id, kernel_thread_id)?;
            imported += 1;
        }
        Ok(imported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (ProductStore, String) {
        let home = std::env::temp_dir().join(format!(
            "knorvia-kernel-binding-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
        (store, home.to_string_lossy().into_owned())
    }

    #[test]
    fn bindings_survive_reopen_and_resume_the_same_kernel_identity() {
        let (store, home) = fixture();
        store.bind_kernel_thread("thr_a", "kernel-1").unwrap();
        // Idempotent same-target bind.
        store.bind_kernel_thread("thr_a", "kernel-1").unwrap();
        assert_eq!(
            store.read_kernel_thread_binding("thr_a").unwrap(),
            Some("kernel-1".to_string())
        );
        drop(store);
        let reopened = ProductStore::open(knorvia_platform_paths::layout(std::path::PathBuf::from(
            &home,
        )))
        .unwrap();
        assert_eq!(
            reopened.read_kernel_thread_binding("thr_a").unwrap(),
            Some("kernel-1".to_string()),
            "the binding is a durable product record"
        );
        let all = reopened.list_kernel_thread_bindings().unwrap();
        assert_eq!(all.get("thr_a").map(String::as_str), Some("kernel-1"));
    }

    #[test]
    fn rebinding_to_another_kernel_is_rejected() {
        let (store, _home) = fixture();
        store.bind_kernel_thread("thr_a", "kernel-1").unwrap();
        let error = store.bind_kernel_thread("thr_a", "kernel-2").unwrap_err();
        assert!(format!("{error}").contains("already bound"));
        assert_eq!(
            store.read_kernel_thread_binding("thr_a").unwrap(),
            Some("kernel-1".to_string())
        );
    }

    #[test]
    fn legacy_import_is_idempotent_and_never_rebinds() {
        let (store, _home) = fixture();
        store.bind_kernel_thread("thr_kept", "kernel-live").unwrap();
        let legacy: HashMap<String, String> = HashMap::from([
            ("thr_old".to_string(), "kernel-old".to_string()),
            // A stale sidecar entry for an already-bound thread: skipped.
            ("thr_kept".to_string(), "kernel-stale".to_string()),
        ]);
        assert_eq!(store.import_kernel_thread_bindings(&legacy).unwrap(), 1);
        assert_eq!(store.import_kernel_thread_bindings(&legacy).unwrap(), 0);
        assert_eq!(
            store.read_kernel_thread_binding("thr_kept").unwrap(),
            Some("kernel-live".to_string()),
            "import must not overwrite a live binding"
        );
        assert_eq!(
            store.read_kernel_thread_binding("thr_old").unwrap(),
            Some("kernel-old".to_string())
        );
    }

    #[test]
    fn concurrent_bindings_never_lose_keys() {
        // The legacy sidecar updated one JSON map through unlocked
        // read-modify-write: a racing writer dropped every key it could not
        // see. Durable binds are serialized store transactions, so N
        // simultaneous bindings of DIFFERENT threads all survive.
        let (store, _home) = fixture();
        let store = std::sync::Arc::new(store);
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    store
                        .bind_kernel_thread(&format!("thr_c{i}"), &format!("kernel-c{i}"))
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let all = store.list_kernel_thread_bindings().unwrap();
        assert_eq!(all.len(), 8, "no racing writer may drop a binding");
        for i in 0..8 {
            assert_eq!(
                all.get(&format!("thr_c{i}")).map(String::as_str),
                Some(&*format!("kernel-c{i}"))
            );
        }
    }

    #[test]
    fn corrupt_binding_documents_fail_closed_with_typed_errors() {
        let (store, _home) = fixture();
        store.bind_kernel_thread("thr_a", "kernel-1").unwrap();
        let path = store.kernel_binding_path("thr_b");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(store.read_kernel_thread_binding("thr_b").is_err());
        assert!(store.list_kernel_thread_bindings().is_err());
        // A structurally valid document without the kernel id also fails.
        std::fs::write(&path, b"{}").unwrap();
        assert!(store.read_kernel_thread_binding("thr_b").is_err());
    }
}
