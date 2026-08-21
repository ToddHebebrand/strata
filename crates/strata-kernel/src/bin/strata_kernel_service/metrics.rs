//! Opt-in observability sink for the local service daemon. Enabled only when
//! `serve --metrics <path>` is present; otherwise nothing in this module runs
//! and the daemon is byte-for-byte unchanged. Records ride a JSONL file only —
//! never the agent-visible wire — so this is purely a side channel.
//!
//! Each record is buffered-written, newline-terminated, and flushed (no fsync).
//! A `seq` is stamped by the sink from its own counter so consumers can order
//! records without wall-clock timestamps. Serialization failures are swallowed:
//! an observability record must never fail a request.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use strata_kernel::{PublicationReport, RecoveryReport, WorkerRunMetrics};

/// One line of the metrics JSONL. Internally tagged by `kind`; the sink stamps
/// `seq` at emit time (it is not a field of any variant). u128 nanosecond
/// durations are cast to `u64` at construction — in practice far below 2^53, so
/// they serialize as plain JSON numbers.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(super) enum MetricsRecord {
    Recovery {
        recovered: bool,
        open_ns: u64,
        replay_ns: u64,
        seed_ns: u64,
        replayed_operations: u64,
        snapshot_generation: u64,
        generation: u64,
        snapshot_bytes: u64,
    },
    WorkerRun(WorkerRunMetrics),
    Request {
        action: &'static str,
        wall_ns: u64,
        daemon_peak_rss_bytes: u64,
        // Monotonic daemon-lifetime count of worker children the node bridge has
        // spawned. Spawn-anchored (not drain-derived), so a spawned child that
        // produced no terminal workerRun record is still counted here — the
        // cross-check that closes the "spawn without a terminal record" hole.
        worker_starts_total: u64,
        publication: Option<PublicationRecord>,
        // B-2 Task 10 cost disclosure. Every field is Option + skipped when
        // absent, and all five are populated ONLY on behavioral-mode advances,
        // so a tsc-only daemon's request records stay byte-identical to the
        // pre-B-2 records the gate-2 profile was built from. Disclosure, not
        // gating: nothing downstream reads these to make a decision.
        #[serde(skip_serializing_if = "Option::is_none")]
        validation_wall_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        one_shot_fallbacks_total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rehydrations_total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        validation_timeouts_total: Option<u64>,
    },
}

/// The behavioral-mode cost disclosure attached to one request record.
/// `None` at the call site means "not a behavioral advance", and every field
/// is then omitted from the wire entirely.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct BehavioralDisclosure {
    /// Wall time the worker spent in its `validate` stage — tsc plus vitest
    /// for a behavioral candidate. `None` when no worker run on this request
    /// self-reported one.
    pub validation_wall_ms: Option<u64>,
    /// Head-of-line wait for the persistent worker. `None` on the one-shot
    /// route, which has no queue.
    pub queue_wait_ms: Option<u64>,
    pub one_shot_fallbacks_total: u64,
    pub rehydrations_total: u64,
    pub validation_timeouts_total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicationRecord {
    generation: u64,
    pre_candidate_analysis_ns: u64,
    post_candidate_analysis_ns: u64,
    candidate_ns: u64,
    persistence_ns: u64,
    memory_publish_ns: u64,
    core_graph_record_value_bytes: u64,
    already_published: bool,
}

impl From<PublicationReport> for PublicationRecord {
    fn from(report: PublicationReport) -> Self {
        Self {
            generation: report.generation,
            pre_candidate_analysis_ns: report.pre_candidate_analysis_ns as u64,
            post_candidate_analysis_ns: report.post_candidate_analysis_ns as u64,
            candidate_ns: report.candidate_ns as u64,
            persistence_ns: report.persistence_ns as u64,
            memory_publish_ns: report.memory_publish_ns as u64,
            core_graph_record_value_bytes: report.core_graph_record_value_bytes,
            already_published: report.already_published,
        }
    }
}

impl MetricsRecord {
    pub(super) fn recovery(recovered: bool, report: &RecoveryReport) -> Self {
        Self::Recovery {
            recovered,
            open_ns: report.open_ns as u64,
            replay_ns: report.replay_ns as u64,
            seed_ns: report.seed_ns as u64,
            replayed_operations: report.replayed_operations,
            snapshot_generation: report.snapshot_generation,
            generation: report.generation,
            snapshot_bytes: report.snapshot_bytes,
        }
    }

    pub(super) fn worker_run(run: WorkerRunMetrics) -> Self {
        Self::WorkerRun(run)
    }

    pub(super) fn request(
        action: &'static str,
        wall_ns: u128,
        daemon_peak_rss_bytes: u64,
        worker_starts_total: u64,
        publication: Option<PublicationReport>,
        disclosure: Option<BehavioralDisclosure>,
    ) -> Self {
        Self::Request {
            action,
            wall_ns: wall_ns as u64,
            daemon_peak_rss_bytes,
            worker_starts_total,
            publication: publication.map(PublicationRecord::from),
            validation_wall_ms: disclosure.and_then(|d| d.validation_wall_ms),
            queue_wait_ms: disclosure.and_then(|d| d.queue_wait_ms),
            one_shot_fallbacks_total: disclosure.map(|d| d.one_shot_fallbacks_total),
            rehydrations_total: disclosure.map(|d| d.rehydrations_total),
            validation_timeouts_total: disclosure.map(|d| d.validation_timeouts_total),
        }
    }
}

/// A create/truncate JSONL writer. Open failure fails daemon startup loudly;
/// per-record emission failures are swallowed.
pub(super) struct MetricsSink {
    writer: BufWriter<File>,
    seq: AtomicU64,
}

impl MetricsSink {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let file = File::create(path)
            .with_context(|| format!("open metrics sink {}", path.display()))?;
        Ok(Self {
            writer: BufWriter::new(file),
            seq: AtomicU64::new(0),
        })
    }

    pub(super) fn emit(&mut self, record: &MetricsRecord) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        // Serialize the record, then splice in the sink-stamped `seq`. A record
        // always serializes to a JSON object (internally tagged); anything else
        // is a bug we swallow rather than propagate into the request path.
        let Ok(Value::Object(mut map)) = serde_json::to_value(record) else {
            return;
        };
        map.insert("seq".to_owned(), Value::from(seq));
        let Ok(line) = serde_json::to_string(&Value::Object(map)) else {
            return;
        };
        let _ = self.writer.write_all(line.as_bytes());
        let _ = self.writer.write_all(b"\n");
        let _ = self.writer.flush();
    }
}

/// Process peak resident set size in bytes via `getrusage(RUSAGE_SELF)`.
/// macOS reports `ru_maxrss` in bytes; other Unixes report KiB.
pub(super) fn peak_rss_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    let max_rss = unsafe { usage.assume_init() }.ru_maxrss.max(0) as u64;
    #[cfg(target_os = "macos")]
    {
        max_rss
    }
    #[cfg(not(target_os = "macos"))]
    {
        max_rss.saturating_mul(1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The emitted keys, in the sink's own order. `MetricsSink::emit`
    /// serializes through `serde_json::to_value`, whose map is sorted, so the
    /// line's key order is alphabetical regardless of struct order — what a new
    /// field can change is the key SET, which is what these tests pin.
    fn request_keys(disclosure: Option<BehavioralDisclosure>) -> Vec<String> {
        let record = MetricsRecord::request("advance_change_set", 1_000, 2, 1, None, disclosure);
        let Value::Object(map) = serde_json::to_value(&record).unwrap() else {
            panic!("a request record must serialize to an object");
        };
        map.keys().cloned().collect()
    }

    /// The byte-identity guard for the no-manifest default: a tsc-only daemon's
    /// request record carries EXACTLY the pre-B-2 keys. Disclosure is opt-in by
    /// mode, so an absent disclosure must not leave five nulls behind.
    #[test]
    fn tsc_only_request_records_carry_no_disclosure_keys() {
        assert_eq!(
            request_keys(None),
            vec![
                "action",
                "daemonPeakRssBytes",
                "kind",
                "publication",
                "wallNs",
                "workerStartsTotal",
            ]
        );
    }

    /// A behavioral advance discloses its cost. Counters are always present
    /// (zero is a claim); the two durations are omitted individually when the
    /// route did not produce them — a one-shot run has no queue to wait in.
    #[test]
    fn behavioral_request_records_disclose_present_measurements_only() {
        assert_eq!(
            request_keys(Some(BehavioralDisclosure {
                validation_wall_ms: Some(1_200),
                queue_wait_ms: Some(3),
                one_shot_fallbacks_total: 0,
                rehydrations_total: 0,
                validation_timeouts_total: 2,
            })),
            vec![
                "action",
                "daemonPeakRssBytes",
                "kind",
                "oneShotFallbacksTotal",
                "publication",
                "queueWaitMs",
                "rehydrationsTotal",
                "validationTimeoutsTotal",
                "validationWallMs",
                "wallNs",
                "workerStartsTotal",
            ]
        );

        let unmeasured = request_keys(Some(BehavioralDisclosure::default()));
        assert!(!unmeasured.contains(&"validationWallMs".to_owned()));
        assert!(!unmeasured.contains(&"queueWaitMs".to_owned()));
        assert!(unmeasured.contains(&"validationTimeoutsTotal".to_owned()));
    }
}
