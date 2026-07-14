#[cfg(feature = "coordination-test-api")]
use std::sync::Arc;

use anyhow::Result;

use crate::GraphGeneration;

use super::{IntentAnalysis, IntentRecord};

pub(crate) trait SemanticProvider: Send + Sync {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis>;
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

    super::analyzer::analyze_change_set(graph, intents, &TestSemanticRef(provider))
}
