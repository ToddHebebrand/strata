//! Task-5 scaffold routing: full-snapshot bridge requests over the persistent
//! transport (`--persistent-bridge`, default OFF).
//!
//! This is the charter's mandated B-as-scaffold intermediate: the daemon owns
//! ONE [`PersistentWorkerHost`] for the session and routes `analyzeIntent` /
//! `buildValidateCandidate` requests through it, while every request still
//! embeds the FULL SNAPSHOT exactly as the one-shot path does — the frame
//! body is the byte-identical output of `serialize_bridge_request`, and the
//! response bytes go through the same `parse_bridge_response` binding
//! validation. Only the transport changes (no spawn per request); semantics
//! are bit-identical. Task 6 replaces the in-band snapshot with attested
//! delta sync and retires the host's `request_unattested` scaffold entry.
//!
//! Fallback contract (plan v2, Task 5 requirement 3): ANY persistent-path
//! error — poison, deadline, refusal, spawn failure, response-binding
//! failure — falls back transparently to the untouched one-shot spawn for
//! that request. The coordination request never fails because the persistent
//! transport did; the failure is logged on the daemon's stderr (the existing
//! operational-error convention) and, under metrics, recorded as a non-`ok`
//! run record.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;

use super::observer::{self, RequestBuild, WorkerRunMetrics};
use super::persistent::{PersistentWorkerConfig, PersistentWorkerHost};
use super::process::{NodeBridgeClient, NodeBridgeConfig, elapsed_ns};
use super::protocol::{BridgeRequest, BridgeResponse, parse_bridge_response, serialize_bridge_request};

/// Routes bridge requests through one session-lifetime persistent worker,
/// preserving the one-shot path's request construction, response validation,
/// and per-run observability record shape.
pub(crate) struct PersistentScaffoldRouter {
    host: PersistentWorkerHost,
    /// Per-request deadline — the same value the one-shot transport uses, so
    /// a hung worker is bounded identically on both transports.
    deadline: Duration,
    max_diagnostics_bytes: usize,
    collect_metrics: bool,
}

impl PersistentScaffoldRouter {
    /// Spawns the session's ONE persistent worker EAGERLY (documented choice:
    /// the host's `spawn` is eager and Task 6's eager hydration lands at
    /// startup anyway; a spawn failure fails daemon startup loudly instead of
    /// surfacing per-request). After a poison the host lazily respawns on the
    /// next request — that respawn is counted in `spawns_total`.
    ///
    /// The worker argv is the one-shot worker path plus `--persistent`, and
    /// `--emit-metrics` is appended exactly when the one-shot transport would
    /// append it (metrics sink active), so per-trip worker self-metrics stay
    /// comparable across transports.
    pub(crate) fn spawn(config: &NodeBridgeConfig, service_epoch: u64) -> Result<Self> {
        let mut arguments = config.arguments.clone();
        arguments.push("--persistent".into());
        if config.collect_metrics {
            arguments.push("--emit-metrics".into());
        }
        let host = PersistentWorkerHost::spawn(PersistentWorkerConfig::new(
            config.executable.clone(),
            arguments,
            config.deadline,
            service_epoch,
        ))?;
        Ok(Self {
            host,
            deadline: config.deadline,
            max_diagnostics_bytes: config.max_diagnostics_bytes,
            collect_metrics: config.collect_metrics,
        })
    }

    /// Total worker children the underlying host has spawned this session.
    pub(crate) fn spawns_total(&self) -> u64 {
        self.host.spawns_total()
    }

    /// One request over the persistent transport. Mirrors `NodeBridgeClient::
    /// run` exactly in what it measures and records, with the documented
    /// difference that `bridge_wall_ns` is the `request_unattested` round
    /// trip — spawn-free by construction (the child already exists), so the
    /// one-shot record's spawn+module-load cost is absent from it.
    ///
    /// `request_build` is the provider/executor's snapshot-build context for
    /// THIS request (the caller owns the thread-local hand-off so a failed
    /// persistent attempt can re-arm it for the one-shot fallback).
    fn run(
        &self,
        client: &NodeBridgeClient,
        request: &BridgeRequest,
        request_build: Option<RequestBuild>,
    ) -> Result<BridgeResponse> {
        let serialize_start = Instant::now();
        let request_bytes = serialize_bridge_request(request)?;
        let request_serialize_ns = elapsed_ns(serialize_start);
        let total_request_bytes = request_bytes.len() as u64;

        let wall_start = Instant::now();
        let exchanged =
            self.host
                .request_unattested(request.request_id(), &request_bytes, self.deadline);
        let bridge_wall_ns = elapsed_ns(wall_start);

        let (outcome, response_bytes, result) = match exchanged {
            Ok(bytes) => {
                let response_bytes = bytes.len() as u64;
                // The identical binding/payload validation the one-shot path
                // runs, over the identical response body bytes.
                match parse_bridge_response(&bytes, request, self.max_diagnostics_bytes) {
                    Ok(response) => ("ok", response_bytes, Ok(response)),
                    Err(error) => ("parseFailed", response_bytes, Err(error)),
                }
            }
            Err(error) => ("persistentError", 0, Err(error)),
        };

        if self.collect_metrics {
            client.record_run_metrics(WorkerRunMetrics {
                request_kind: request.observed_kind().to_owned(),
                change_set_id: request.change_set_id().to_owned(),
                phase: observer::current_phase(),
                outcome,
                bridge_wall_ns,
                snapshot_bytes: request_build.map_or(0, |build| build.snapshot_bytes),
                total_request_bytes,
                snapshot_build_ns: request_build.map_or(0, |build| build.snapshot_build_ns),
                request_serialize_ns,
                response_bytes,
                worker: result
                    .as_ref()
                    .ok()
                    .and_then(|response| response.metrics_ref().cloned()),
            });
        }

        result
    }
}

/// The single dispatch seam the provider and executor share. With no router
/// configured this IS the one-shot path, untouched (the thread-local
/// request-build hand-off is not even read here). With a router, the request
/// goes persistent first; any error falls back to a fresh one-shot spawn for
/// this request, with the request-build context re-armed so the fallback's
/// run record keeps its snapshot fields.
pub(crate) fn run_with_persistent_fallback(
    router: Option<&Arc<PersistentScaffoldRouter>>,
    client: &NodeBridgeClient,
    request: &BridgeRequest,
) -> Result<BridgeResponse> {
    let Some(router) = router else {
        return client.run(request);
    };
    let request_build = observer::take_request_build();
    match router.run(client, request, request_build) {
        Ok(response) => Ok(response),
        Err(error) => {
            // Existing operational convention: bounded, single-line stderr on
            // the daemon. The coordination request itself is not failed.
            eprintln!(
                "persistent bridge trip failed; serving this request one-shot: {error:#}"
            );
            if let Some(build) = request_build {
                observer::set_request_build(build.snapshot_bytes, build.snapshot_build_ns);
            }
            client.run(request)
        }
    }
}
