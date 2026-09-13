//! The single control owner freezes admission before an idle provider restart.
//! This closes the check-then-stop race with scheduled work.
//!
//! A19 extends the same primitives into a full quiescence gate for state
//! transitions (`migration/rollback`, provider restart): no running Turn,
//! no Goal runner between rounds, and no automation run that reached a
//! durable claim boundary. The gate freezes admission FIRST, then checks,
//! and restores the previous admission state on every refusal so a failed
//! gate never wedges the runtime.

use super::*;
use std::sync::atomic::Ordering;

impl ControlPlane {
/// Facts that must be idle before `state/` can be swapped or replaced.
/// Each entry names concrete work; the gate refuses with all of them so an
/// operator never plays whack-a-mole with one blocker at a time.
pub(crate) fn quiescence_blockers(&self) -> Result<Vec<String>, ProtocolError> {
    let mut blockers = Vec::new();
    let active = self
        .store
        .running_turn_count()
        .map_err(|error| error.into_protocol())?;
    if active > 0 {
        blockers.push(format!("{active} running task turn(s)"));
    }
    if self
        .store
        .has_running_goal_execution()
        .map_err(|error| error.into_protocol())?
    {
        blockers.push(
            "a Goal batch is still advancing (a runner may sit between rounds)".to_string(),
        );
    }
    if self
        .store
        .has_active_automation_run()
        .map_err(|error| error.into_protocol())?
    {
        blockers.push(
            "an automation run has reached a durable claim and has not finished".to_string(),
        );
    }
    blockers.extend(self.live_dispatch_blockers()?);
    Ok(blockers)
}

/// Registries owned by other dispatch paths (A05 pack workers; A11/A17 add
/// their queues as they land). Reports every live background invocation as
/// a named blocker for the quiescence gate.
pub(crate) fn live_dispatch_blockers(&self) -> Result<Vec<String>, ProtocolError> {
    let live = self
        .live_packs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut blockers: Vec<String> = live
        .iter()
        .map(|(invocation_id, handle)| {
            format!(
                "pack worker for invocation {invocation_id} (job {}) is still running",
                handle.job_id
            )
        })
        .collect();
    drop(live);
    let rooms = self
        .room_dispatches
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    blockers.extend(rooms.keys().map(|conversation_id| {
        format!("room dispatch for conversation {conversation_id} is still running")
    }));
    if self.has_active_pack_requests() {
        blockers.push(
            "a deferred legacy pack request is still pending or executing".to_string(),
        );
    }
    Ok(blockers)
}

/// Freeze admission and require full quiescence for a state transition.
/// On any refusal the previous admission state is restored.
pub(crate) fn prepare_state_transition(&mut self, what: &str) -> Result<(), ProtocolError> {
    let already_paused = self.admissions_paused.swap(true, Ordering::AcqRel);
    // Wait for any scheduler tick which observed the old admission value.
    // Future ticks take the same barrier and see `paused`, so after this
    // lock is acquired the scheduler is fully quiescent for the transition.
    let _writer_barrier = self
        .state_writer_barrier
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match self.quiescence_blockers() {
        Ok(blockers) if blockers.is_empty() => Ok(()),
        Ok(blockers) => {
            self.admissions_paused
                .store(already_paused, Ordering::Release);
            Err(ProtocolError::new(
                ErrorCategory::Conflict,
                format!(
                    "{what} refused while work is in flight; finish or cancel it first: {}",
                    blockers.join("; ")
                ),
            ))
        }
        Err(error) => {
            self.admissions_paused
                .store(already_paused, Ordering::Release);
            Err(error)
        }
    }
}

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
    self.prepare_state_transition("connection update")?;
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
        let error = plane.prepare_restart().unwrap_err();
        assert_eq!(error.category, ErrorCategory::Conflict);
        assert!(error.message.contains("running task turn(s)"));
        // The refusal restored admission: the plane still accepts work.
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

    #[test]
    fn rollback_refuses_while_a_turn_is_running_and_keeps_the_state() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        let workspace = plane.store.create_workspace("rollback test").unwrap();
        let thread = plane
            .store
            .create_thread(&workspace.id, "active", None, None)
            .unwrap();
        let turn = plane.store.start_turn(&thread.id).unwrap();
        let error = plane
            .rpc_migration_rollback(&json!({"id": "run_does_not_matter"}))
            .unwrap_err();
        assert_eq!(error.category, ErrorCategory::Conflict);
        assert!(error.message.contains("running task turn(s)"));
        // Admission was restored after the refusal and no state switch
        // happened: the live Turn is untouched.
        assert!(plane.ensure_accepting_work().is_ok());
        assert_eq!(plane.store.read_turn(&turn.id).unwrap().status, "running");
    }

    #[test]
    fn quiescence_passes_on_an_idle_plane() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        assert!(plane.quiescence_blockers().unwrap().is_empty());
        plane.prepare_state_transition("rollback").unwrap();
        plane.cancel_restart().unwrap();
        assert!(plane.ensure_accepting_work().is_ok());
    }

    #[test]
    fn state_transition_refuses_a_room_dispatch_between_kernel_turns() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        plane.room_dispatches.lock().unwrap().insert(
            "room-between-rounds".into(),
            Arc::new(AtomicBool::new(false)),
        );
        let error = plane.prepare_state_transition("rollback").unwrap_err();
        assert_eq!(error.category, ErrorCategory::Conflict);
        assert!(error.message.contains("room-between-rounds"));
        assert!(plane.ensure_accepting_work().is_ok());
    }

    #[test]
    fn failed_rollback_preflight_releases_the_admission_pause() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        let error = plane
            .rpc_migration_rollback(&json!({"id": "missing-run"}))
            .unwrap_err();
        assert_eq!(error.category, ErrorCategory::Internal);
        assert!(plane.ensure_accepting_work().is_ok());
    }

    #[test]
    fn state_transition_refuses_a_deferred_pack_request_before_worker_registration() {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let mut plane = ControlPlane::open(knorvia_platform_paths::layout(home)).unwrap();
        plane.pack_requests.store(1, Ordering::Release);
        let error = plane.prepare_state_transition("rollback").unwrap_err();
        assert_eq!(error.category, ErrorCategory::Conflict);
        assert!(error.message.contains("deferred legacy pack request"));
        assert!(plane.ensure_accepting_work().is_ok());
        plane.pack_requests.store(0, Ordering::Release);
    }
}
