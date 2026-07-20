use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, ensure};

use super::observer;
use super::process::NodeBridgeClient;
use super::protocol::{
    BridgeBinding, BridgeKind, BridgeRequest, BuildValidateCandidateRequest, ChangeSet, Hash64,
    PROTOCOL_VERSION, ValidationProfile, WireGraphDelta, WireSnapshot, WireU64,
};
use super::provider::wire_intent;
use crate::GraphDelta;
use crate::coordination::{CandidateEnvelope, ChangeSetState, PreparedCandidate};

pub(crate) trait CandidateExecutor: Send + Sync {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope>;
}

pub(crate) struct NodeCandidateExecutor {
    client: Arc<NodeBridgeClient>,
    service_epoch: u64,
}

impl NodeCandidateExecutor {
    pub(crate) fn new(client: Arc<NodeBridgeClient>, service_epoch: u64) -> Self {
        Self {
            client,
            service_epoch,
        }
    }
}

fn candidate_request(
    service_epoch: u64,
    prepared: &PreparedCandidate,
    validation_profile: ValidationProfile,
) -> Result<BridgeRequest> {
    ensure!(
        prepared.change_set.state == ChangeSetState::Executing,
        "candidate execution requires an Executing change set"
    );
    ensure!(
        prepared
            .intents
            .iter()
            .all(|intent| intent.change_set_id == prepared.change_set.change_set_id),
        "candidate intents do not belong to the prepared change set"
    );
    let snapshot = WireSnapshot::from_graph_snapshot(&prepared.graph.snapshot())?;
    Ok(BridgeRequest::BuildValidateCandidate(
        BuildValidateCandidateRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: format!(
                "candidate:{}:{}:{}",
                service_epoch,
                prepared.graph.generation(),
                prepared.attempt_id
            ),
            kind: BridgeKind::BuildValidateCandidate,
            binding: BridgeBinding {
                service_epoch: WireU64::new(service_epoch),
                graph_generation: WireU64::new(prepared.graph.generation()),
                graph_digest: Hash64::parse(prepared.graph.digest())?,
            },
            snapshot,
            attempt_id: prepared.attempt_id.clone(),
            scope_fingerprint: Hash64::parse(&prepared.scope_fingerprint)?,
            change_set: ChangeSet {
                change_set_id: prepared.change_set.change_set_id.clone(),
                actor: prepared.change_set.actor.clone(),
                reasoning: prepared.change_set.reasoning.clone(),
                ordered_intents: prepared
                    .intents
                    .iter()
                    .map(|intent| wire_intent(intent, prepared.graph.generation()))
                    .collect(),
            },
            validation_profile,
        },
    ))
}

fn candidate_envelope(
    prepared: &PreparedCandidate,
    wire_delta: WireGraphDelta,
) -> Result<CandidateEnvelope> {
    let converted = wire_delta.to_graph_delta()?;
    let reparsed: GraphDelta = serde_json::from_slice(
        &serde_json::to_vec(&converted).context("serialize converted candidate delta")?,
    )
    .context("reparse converted candidate delta")?;
    ensure!(
        reparsed.base_generation == prepared.graph.generation(),
        "candidate delta base generation does not match prepared graph"
    );
    CandidateEnvelope::from_internal_delta(reparsed)
}

impl CandidateExecutor for NodeCandidateExecutor {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        let build_start = Instant::now();
        let request = candidate_request(
            self.service_epoch,
            prepared,
            self.client.validation_profile(),
        )?;
        if self.client.collects_metrics() {
            let snapshot_build_ns =
                u64::try_from(build_start.elapsed().as_nanos()).unwrap_or(u64::MAX);
            // Extra snapshot serialization happens only when collecting.
            let snapshot_bytes = match &request {
                BridgeRequest::BuildValidateCandidate(inner) => serde_json::to_vec(&inner.snapshot)
                    .context("serialize candidate snapshot for run metrics")?
                    .len() as u64,
                BridgeRequest::AnalyzeIntent(_) => 0,
            };
            observer::set_request_build(snapshot_bytes, snapshot_build_ns);
        }

        // The protocol parser rejects request/kind/epoch/generation/digest/attempt/scope
        // mismatches before exposing the worker delta.
        let wire_delta = self.client.run(&request)?.into_candidate_result()?;
        candidate_envelope(prepared, wire_delta)
    }
}

#[cfg(test)]
mod tests {
    use super::super::protocol::parse_bridge_response;
    use super::*;
    use crate::coordination::{ChangeSetRecord, IntentParameters, IntentRecord};
    use crate::{GraphGeneration, GraphSnapshot, SCHEMA_VERSION};

    #[test]
    fn candidate_request_is_bound_only_to_kernel_prepared_authority() {
        let snapshot: GraphSnapshot = serde_json::from_str(include_str!(
            "../../tests/fixtures/examples-medium.snapshot.json"
        ))
        .unwrap();
        let graph = Arc::new(GraphGeneration::from_snapshot(snapshot).unwrap());
        let intent = IntentRecord::new(
            SCHEMA_VERSION,
            "intent:executor",
            "change:executor",
            graph.generation(),
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
        let mut change_set = ChangeSetRecord::new(
            SCHEMA_VERSION,
            "change:executor",
            "agent:a",
            "build through the sealed executor",
            graph.generation(),
            "submit:executor",
            std::slice::from_ref(&intent),
        )
        .unwrap();
        change_set.state = ChangeSetState::Executing;
        let prepared = PreparedCandidate {
            change_set,
            intents: vec![intent],
            graph: graph.clone(),
            attempt_id: "attempt:executor".into(),
            scope_fingerprint: "a".repeat(64),
        };

        let request = candidate_request(
            17,
            &prepared,
            super::super::protocol::ValidationProfile::tsc_only("/corpus/src", "/corpus", true),
        )
        .unwrap();
        let value = serde_json::to_value(&request).unwrap();

        assert_eq!(value["kind"], "buildValidateCandidate");
        assert_eq!(value["binding"]["serviceEpoch"], "17");
        assert_eq!(value["binding"]["graphGeneration"], "0");
        assert_eq!(value["binding"]["graphDigest"], graph.digest());
        assert_eq!(value["attemptId"], "attempt:executor");
        assert_eq!(value["scopeFingerprint"], "a".repeat(64));
        assert_eq!(value["changeSet"]["changeSetId"], "change:executor");
        assert_eq!(value["changeSet"]["actor"], "agent:a");
        assert_eq!(
            value["changeSet"]["orderedIntents"][0]["baseGeneration"],
            "0"
        );
        assert!(value.get("provider").is_none());
        assert!(value.get("workerPath").is_none());
        assert!(value.get("fence").is_none());
        assert!(value.get("store").is_none());
    }

    #[test]
    fn candidate_response_rejects_malformed_or_misbound_data_before_rust_digesting() {
        let snapshot: GraphSnapshot = serde_json::from_str(include_str!(
            "../../tests/fixtures/examples-medium.snapshot.json"
        ))
        .unwrap();
        let graph = Arc::new(GraphGeneration::from_snapshot(snapshot).unwrap());
        let intent = IntentRecord::new(
            SCHEMA_VERSION,
            "intent:response",
            "change:response",
            0,
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
        let mut change_set = ChangeSetRecord::new(
            SCHEMA_VERSION,
            "change:response",
            "agent:a",
            "validate the bound worker response",
            0,
            "submit:response",
            std::slice::from_ref(&intent),
        )
        .unwrap();
        change_set.state = ChangeSetState::Executing;
        let prepared = PreparedCandidate {
            change_set,
            intents: vec![intent],
            graph: graph.clone(),
            attempt_id: "attempt:response".into(),
            scope_fingerprint: "b".repeat(64),
        };
        let request = candidate_request(
            23,
            &prepared,
            ValidationProfile::tsc_only("/corpus/src", "/corpus", true),
        )
        .unwrap();
        let request_value = serde_json::to_value(&request).unwrap();
        let response = serde_json::json!({
            "protocolVersion": 1,
            "requestId": request_value["requestId"],
            "kind": "buildValidateCandidate",
            "binding": {
                "serviceEpoch": "23",
                "graphGeneration": "0",
                "graphDigest": graph.digest(),
                "attemptId": "attempt:response",
                "scopeFingerprint": "b".repeat(64),
            },
            "ok": true,
            "result": {
                "delta": { "schemaVersion": 1, "baseGeneration": "0", "changes": [] },
                "diagnostics": [],
            },
        });

        let parsed =
            parse_bridge_response(&serde_json::to_vec(&response).unwrap(), &request, 64 * 1024)
                .unwrap()
                .into_candidate_result()
                .unwrap();
        let envelope = candidate_envelope(&prepared, parsed).unwrap();
        assert_eq!(
            envelope.candidate_digest,
            crate::coordination::canonical_candidate_digest(&envelope.delta).unwrap()
        );

        let mut misbound = response.clone();
        misbound["binding"]["attemptId"] = "attempt:other".into();
        assert!(
            parse_bridge_response(&serde_json::to_vec(&misbound).unwrap(), &request, 64 * 1024,)
                .is_err()
        );
        let mut wrong_base = response.clone();
        wrong_base["result"]["delta"]["baseGeneration"] = "1".into();
        assert!(
            parse_bridge_response(
                &serde_json::to_vec(&wrong_base).unwrap(),
                &request,
                64 * 1024,
            )
            .is_err()
        );
        let mut unknown = response;
        unknown["workerPath"] = "forbidden".into();
        assert!(
            parse_bridge_response(&serde_json::to_vec(&unknown).unwrap(), &request, 64 * 1024,)
                .is_err()
        );
        assert!(parse_bridge_response(b"{", &request, 64 * 1024).is_err());
    }
}
