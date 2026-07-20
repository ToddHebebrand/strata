use super::protocol::WorkerSelfMetrics;
use serde::Serialize;
use std::cell::Cell;

/// Phase attributed to a bridge run when no coordination phase guard is active.
pub(crate) const UNATTRIBUTED_PHASE: &str = "unattributed";

/// One terminal, spawn-anchored observability record for a single Node bridge
/// child process. Purely observational: produced only when a client is
/// configured to collect metrics, and never consulted by coordination,
/// protocol validation, or binding checks. `outcome` classifies the post-spawn
/// exit path; `phase` is the coordination phase that was active on the calling
/// thread when the record was produced; `worker` carries the child's
/// self-reported per-stage metrics when the run parsed a successful response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRunMetrics {
    pub request_kind: String,
    pub change_set_id: String,
    pub phase: &'static str,
    pub outcome: &'static str,
    pub bridge_wall_ns: u64,
    pub snapshot_bytes: u64,
    pub total_request_bytes: u64,
    pub snapshot_build_ns: u64,
    pub request_serialize_ns: u64,
    pub response_bytes: u64,
    pub worker: Option<WorkerSelfMetrics>,
}

/// Snapshot serialize-cost context handed from a request builder
/// (provider/executor) to the `run()` that immediately follows on the same
/// thread. Copyable so the thread-local cell can hand it back by value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RequestBuild {
    pub(crate) snapshot_bytes: u64,
    pub(crate) snapshot_build_ns: u64,
}

thread_local! {
    /// The coordination phase attributed to bridge runs on this thread.
    static CURRENT_PHASE: Cell<&'static str> = const { Cell::new(UNATTRIBUTED_PHASE) };
    /// Request-build context set for the next `run()` on this thread. Consumed
    /// (cleared) by that run so a value never survives into a later run.
    static REQUEST_BUILD: Cell<Option<RequestBuild>> = const { Cell::new(None) };
}

/// RAII scope that attributes bridge runs to `phase` until dropped, restoring
/// whatever phase was previously active. Observer-only: holding a guard has
/// zero effect on control flow or coordination semantics.
pub(crate) struct RunContextGuard {
    previous: &'static str,
}

impl Drop for RunContextGuard {
    fn drop(&mut self) {
        CURRENT_PHASE.with(|phase| phase.set(self.previous));
    }
}

/// Enters a phase attribution scope for the current thread. The returned guard
/// restores the previous phase on drop.
pub(crate) fn enter_phase(phase: &'static str) -> RunContextGuard {
    let previous = CURRENT_PHASE.with(|current| current.replace(phase));
    RunContextGuard { previous }
}

/// The phase currently attributed to bridge runs on this thread, defaulting to
/// [`UNATTRIBUTED_PHASE`] when no guard is active.
pub(crate) fn current_phase() -> &'static str {
    CURRENT_PHASE.with(Cell::get)
}

/// Records snapshot serialize-cost context for the next `run()` on this thread.
/// A no-op without an active collector: the value only survives to the run that
/// immediately follows, which consumes it; if that run does not collect metrics
/// the context is simply discarded.
pub(crate) fn set_request_build(snapshot_bytes: u64, snapshot_build_ns: u64) {
    REQUEST_BUILD.with(|build| {
        build.set(Some(RequestBuild {
            snapshot_bytes,
            snapshot_build_ns,
        }))
    });
}

/// Consumes any request-build context set for the current thread, clearing it
/// so it cannot leak into a later run.
pub(crate) fn take_request_build() -> Option<RequestBuild> {
    REQUEST_BUILD.with(Cell::take)
}
