use std::collections::BTreeSet;
use std::sync::Arc;

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::GraphDelta;
use crate::{GraphGeneration, PublicationReport};

use super::{IntentAnalysis, IntentRecord};

#[derive(Clone)]
pub struct PreparedCandidate {
    pub(crate) change_set: super::ChangeSetRecord,
    pub(crate) intents: Vec<IntentRecord>,
    pub(crate) graph: Arc<GraphGeneration>,
    pub(crate) attempt_id: String,
    pub(crate) scope_fingerprint: String,
}

#[cfg(feature = "coordination-test-api")]
impl PreparedCandidate {
    pub fn change_set(&self) -> &super::ChangeSetRecord {
        &self.change_set
    }

    pub fn intents(&self) -> &[IntentRecord] {
        &self.intents
    }

    pub fn graph(&self) -> &Arc<GraphGeneration> {
        &self.graph
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn scope_fingerprint(&self) -> &str {
        &self.scope_fingerprint
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEnvelope {
    pub(crate) delta: GraphDelta,
    pub(crate) candidate_digest: String,
}

impl CandidateEnvelope {
    #[cfg(feature = "coordination-test-api")]
    pub fn from_delta(delta: GraphDelta) -> Result<Self> {
        Self::from_internal_delta(delta)
    }

    pub(crate) fn from_internal_delta(delta: GraphDelta) -> Result<Self> {
        let candidate_digest = canonical_candidate_digest(&delta)?;
        Ok(Self {
            delta,
            candidate_digest,
        })
    }

    #[cfg(feature = "coordination-test-api")]
    #[doc(hidden)]
    pub fn test_with_digest(delta: GraphDelta, candidate_digest: impl Into<String>) -> Self {
        Self {
            delta,
            candidate_digest: candidate_digest.into(),
        }
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn candidate_digest(&self) -> &str {
        &self.candidate_digest
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

pub(crate) fn canonical_candidate_digest(delta: &GraphDelta) -> Result<String> {
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
