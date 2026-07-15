use std::collections::BTreeSet;
#[cfg(feature = "coordination-test-api")]
use std::sync::Arc;

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::GraphDelta;
use crate::GraphGeneration;
#[cfg(feature = "coordination-test-api")]
use crate::PublicationReport;

use super::{IntentAnalysis, IntentRecord};

#[cfg(feature = "coordination-test-api")]
#[derive(Clone)]
pub struct PreparedCandidate {
    pub change_set: super::ChangeSetRecord,
    pub intents: Vec<IntentRecord>,
    pub graph: Arc<GraphGeneration>,
    pub attempt_id: String,
    pub scope_fingerprint: String,
}

#[cfg(feature = "coordination-test-api")]
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEnvelope {
    pub delta: GraphDelta,
    pub candidate_digest: String,
}

#[cfg(feature = "coordination-test-api")]
impl CandidateEnvelope {
    pub fn from_delta(delta: GraphDelta) -> Result<Self> {
        let candidate_digest = canonical_candidate_digest(&delta)?;
        Ok(Self {
            delta,
            candidate_digest,
        })
    }

    pub(crate) fn validate_digest(&self) -> Result<()> {
        if canonical_candidate_digest(&self.delta)? != self.candidate_digest {
            return Err(anyhow::Error::new(
                super::CoordinationError::CandidateDigestMismatch,
            ));
        }
        Ok(())
    }
}

#[cfg(feature = "coordination-test-api")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PublishClaimOutcome {
    Published(PublicationReport),
    Requeued {
        ticket: super::CoordinationTicket,
        event: super::CoordinationEvent,
    },
    NeedsDecision {
        change_set: super::ChangeSetRecord,
        event: super::CoordinationEvent,
    },
}

pub fn canonical_candidate_digest(delta: &GraphDelta) -> Result<String> {
    let bytes = serde_json::to_vec(delta)?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
}

/// Builds only candidate data from immutable, authority-free prepared input.
#[cfg(feature = "coordination-test-api")]
pub trait CandidateBuilder: Send + Sync {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorityPlan {
    pub scope: super::InferredScope,
    pub dependency_keys: BTreeSet<String>,
}

pub(crate) trait SemanticProvider: Send + Sync {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis>;
}

pub(crate) fn plan_change_set(
    graph: &GraphGeneration,
    intents: &[IntentRecord],
    provider: &dyn SemanticProvider,
) -> Result<AuthorityPlan> {
    let scope = super::analyzer::analyze_change_set(graph, intents, provider)?;
    let dependency_keys = scope
        .read_set
        .iter()
        .chain(&scope.write_set)
        .chain(&scope.validation_set)
        .map(|resource| resource.resource_key.clone())
        .collect();
    Ok(AuthorityPlan {
        scope,
        dependency_keys,
    })
}

#[cfg(feature = "coordination-test-api")]
pub trait TestSemanticProvider: Send + Sync {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis>;
}

#[cfg(feature = "coordination-test-api")]
pub(crate) struct TestSemanticAdapter(pub Arc<dyn TestSemanticProvider>);

#[cfg(feature = "coordination-test-api")]
impl SemanticProvider for TestSemanticAdapter {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        self.0.analyze(graph, intent)
    }
}

#[cfg(feature = "coordination-test-api")]
pub fn analyze_change_set(
    graph: &GraphGeneration,
    intents: &[IntentRecord],
    provider: &dyn TestSemanticProvider,
) -> Result<super::InferredScope> {
    struct TestSemanticRef<'a>(&'a dyn TestSemanticProvider);

    impl SemanticProvider for TestSemanticRef<'_> {
        fn analyze(
            &self,
            graph: &GraphGeneration,
            intent: &IntentRecord,
        ) -> Result<IntentAnalysis> {
            self.0.analyze(graph, intent)
        }
    }

    Ok(plan_change_set(graph, intents, &TestSemanticRef(provider))?.scope)
}
