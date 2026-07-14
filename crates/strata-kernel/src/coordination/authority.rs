use std::collections::BTreeSet;
#[cfg(feature = "coordination-test-api")]
use std::sync::Arc;

use anyhow::Result;

use crate::GraphGeneration;

use super::{IntentAnalysis, IntentRecord};

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
