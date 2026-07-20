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
        publication: Option<PublicationRecord>,
    },
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
        publication: Option<PublicationReport>,
    ) -> Self {
        Self::Request {
            action,
            wall_ns: wall_ns as u64,
            daemon_peak_rss_bytes,
            publication: publication.map(PublicationRecord::from),
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
