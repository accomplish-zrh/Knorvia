//! The single control owner freezes admission before an idle provider restart.
//! This closes the check-then-stop race with scheduled work.

use super::*;
use std::sync::atomic::Ordering;

impl ControlPlane {
    pub(crate) fn ensure_accepting_work(&self) -> Result<(), ProtocolError> {
        if self.admissions_paused.load(Ordering::Acquire) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "the runtime is updating its connection; retry after it reconnects",
            ));
        }
        Ok(())
    }

    pub(crate) fn prepare_restart(&mut self) -> Result<Value, ProtocolError> {
        let already_paused = self.admissions_paused.swap(true, Ordering::AcqRel);
        let active = match self.store.running_turn_count() {
            Ok(count) => count,
            Err(error) => {
                self.admissions_paused
                    .store(already_paused, Ordering::Release);
                return Err(error.into_protocol());
            }
        };
        if active > 0 {
            self.admissions_paused
                .store(already_paused, Ordering::Release);
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                format!(
                    "{active} task(s) are still running; update the connection after they finish"
                ),
            ));
        }
        Ok(json!({"ready": true, "activeTurnCount": 0}))
    }

    pub(crate) fn cancel_restart(&mut self) -> Result<Value, ProtocolError> {
        self.admissions_paused.store(false, Ordering::Release);
        Ok(json!({"ready": true, "admissionsPaused": false}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_rejects_live_turns_and_does_not_leave_admission_frozen() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        let workspace = plane.store.create_workspace("restart test").unwrap();
        let thread = plane
            .store
            .create_thread(&workspace.id, "active", None, None)
            .unwrap();
        let turn = plane.store.start_turn(&thread.id).unwrap();
        assert!(matches!(
            plane.prepare_restart(),
            Err(ProtocolError {
                category: ErrorCategory::Conflict,
                ..
            })
        ));
        assert!(plane.ensure_accepting_work().is_ok());
        assert_eq!(plane.store.read_turn(&turn.id).unwrap().status, "running");
    }

    #[test]
    fn prepared_restart_blocks_new_turns_until_cancelled() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        let workspace = plane.store.create_workspace("restart test").unwrap();
        let thread = plane
            .store
            .create_thread(&workspace.id, "ready", None, None)
            .unwrap();
        assert_eq!(plane.prepare_restart().unwrap()["ready"], true);
        assert_eq!(plane.prepare_restart().unwrap()["ready"], true);
        assert!(matches!(
            plane.rpc_turn_start(&json!({"threadId":thread.id,"input":"must not start"})),
            Err(ProtocolError {
                category: ErrorCategory::Conflict,
                ..
            })
        ));
        assert!(plane.store.list_turns(&thread.id).unwrap().is_empty());
        plane.cancel_restart().unwrap();
        assert!(plane.ensure_accepting_work().is_ok());
    }
}
