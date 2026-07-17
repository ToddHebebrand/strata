#![cfg(feature = "coordination-test-api")]

#[path = "support/coordination.rs"]
#[allow(dead_code)]
mod coordination_support;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use coordination_support::{
    FixedDeltaBuilder, GraphDerivedAnalyzer, MediumCoordinationFixture, NodePatchBuilder,
    begin_with_intents, rename,
};
use strata_kernel::{
    ClaimHandle, ClaimOutcome, GraphChange, GraphDelta, GraphGeneration, IntentAnalysis,
    IntentRecord, Kernel, PublishClaimOutcome, ReferenceRecord, ResourceVersion, SCHEMA_VERSION,
    SubmissionOutcome, TestSemanticProvider, affected_resource_keys,
};

const USER_ID: &str = "fc98295bca9efc3e";

#[test]
fn every_structural_and_index_bucket_advances_monotonically() {
    let fixture = MediumCoordinationFixture::load();
    let before = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let delta = rename_and_retarget_delta(&before);
    let user = before.node(USER_ID).unwrap();
    let container = user.parent_id.as_deref().unwrap_or("root");
    let semantic_index_keys = BTreeSet::from([
        format!("namespace:{container}:User"),
        format!("namespace:{container}:Account"),
        format!("absence:InterfaceDeclaration:{container}:User"),
        format!("absence:InterfaceDeclaration:{container}:Account"),
    ]);
    let keys = affected_resource_keys(&before, &delta, &semantic_index_keys).unwrap();

    assert!(keys.contains("node:fc98295bca9efc3e"));
    assert!(keys.iter().any(|key| key.starts_with("children:")));
    assert!(keys.iter().any(|key| key.starts_with("edge:")));
    assert!(keys.iter().any(|key| key.starts_with("references-to:")));
    assert!(keys.contains(&format!("namespace:{container}:User")));
    assert!(keys.contains(&format!("namespace:{container}:Account")));
    assert!(keys.contains(&format!("absence:InterfaceDeclaration:{container}:User")));
    assert!(keys.contains(&format!("absence:InterfaceDeclaration:{container}:Account")));

    let (kernel, path) = kernel_with_test_semantics(before);
    publish_fixture_delta(&kernel, "rename-user", delta);
    let first = kernel.test_resource_clocks(&keys).unwrap();
    assert_eq!(first.len(), keys.len());
    assert!(first.values().all(|clock| *clock == 1));
    drop(kernel);

    let (reopened, _) = Kernel::open_with_test_semantics(path, fixture_provider()).unwrap();
    assert_eq!(reopened.test_resource_clocks(&keys).unwrap(), first);
}

#[test]
fn changing_the_same_node_twice_advances_its_clock_to_two() {
    let fixture = MediumCoordinationFixture::load();
    let before = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let (kernel, _) = kernel_with_test_semantics(before);
    let node_key = format!("node:{USER_ID}");
    let keys = BTreeSet::from([node_key.clone()]);

    publish_node_patch(
        &kernel,
        "patch-user-once",
        "Account",
        "\n// clock mutation one",
    );
    assert_eq!(kernel.test_resource_clocks(&keys).unwrap()[&node_key], 1);

    publish_node_patch(
        &kernel,
        "patch-user-twice",
        "Account",
        "\n// clock mutation two",
    );
    let second = kernel.test_resource_clocks(&keys).unwrap();
    assert_eq!(second[&node_key], 2);
    assert_ne!(
        second[&node_key],
        kernel.snapshot().node(USER_ID).unwrap().payload.len() as u64
    );
}

fn kernel_with_test_semantics(before: GraphGeneration) -> (Kernel, PathBuf) {
    let directory = tempfile::tempdir().unwrap().keep();
    let path = directory.join("kernel.redb");
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, before.snapshot(), fixture_provider()).unwrap();
    (kernel, path)
}

fn fixture_provider() -> Arc<dyn TestSemanticProvider> {
    Arc::new(ResourceClockProvider)
}

struct ResourceClockProvider;

impl TestSemanticProvider for ResourceClockProvider {
    fn analyze(
        &self,
        graph: &GraphGeneration,
        intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        let mut analysis = GraphDerivedAnalyzer::new().analyze(graph, intent)?;
        let Some(identifier) = graph.snapshot().nodes.into_iter().find(|node| {
            node.parent_id.as_deref() == Some(USER_ID)
                && node.kind == "Identifier"
                && identifier_text(node).as_deref() == Some("User")
        }) else {
            return Ok(analysis);
        };
        if let Some(reference) = graph.references_to(&identifier.id).next() {
            analysis.write_set.push(
                ResourceVersion::new(
                    format!("edge:{}", reference.from_node_id),
                    "trusted-clock-test-edge",
                )
                .map_err(anyhow::Error::msg)?,
            );
        }
        Ok(analysis)
    }
}

fn publish_fixture_delta(kernel: &Kernel, change_set_id: &str, delta: GraphDelta) {
    let claim = claim_rename(kernel, change_set_id, "Account", 10);
    let outcome = kernel
        .publish_claimed(&claim, &FixedDeltaBuilder(delta), 12)
        .unwrap();
    let PublishClaimOutcome::Published(report) = outcome else {
        panic!("fixture delta did not publish")
    };
    assert!(!report.already_published);
}

fn publish_node_patch(kernel: &Kernel, change_set_id: &str, new_name: &str, marker: &str) {
    let tick = kernel.snapshot().generation() * 10 + 20;
    let claim = claim_rename(kernel, change_set_id, new_name, tick);
    let builder = NodePatchBuilder::new(vec![(USER_ID.into(), marker.into())]);
    let PublishClaimOutcome::Published(report) =
        kernel.publish_claimed(&claim, &builder, tick + 2).unwrap()
    else {
        panic!("node patch did not publish")
    };
    assert!(!report.already_published);
}

fn claim_rename(kernel: &Kernel, change_set_id: &str, new_name: &str, tick: u64) -> ClaimHandle {
    begin_with_intents(kernel, change_set_id, [rename(USER_ID, new_name)]).unwrap();
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set(change_set_id, tick).unwrap()
    else {
        panic!("expected ready change set")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, tick + 1)
        .unwrap()
    else {
        panic!("expected claimed change set")
    };
    claim
}

fn rename_and_retarget_delta(graph: &GraphGeneration) -> GraphDelta {
    let mut user = graph.node(USER_ID).unwrap().clone();
    user.payload = user.payload.replace("interface User", "interface Account");

    let mut name_identifier = graph
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.parent_id.as_deref() == Some(USER_ID)
                && node.kind == "Identifier"
                && identifier_text(node).as_deref() == Some("User")
        })
        .unwrap();
    let declaration_identifier_id = name_identifier.id.clone();
    name_identifier.payload = serde_json::json!({ "text": "Account", "offset": 74 }).to_string();
    // Membership is shape-only (spec 2026-07-17 Change 5): a payload edit no
    // longer advances the parent's children bucket, so this monotonicity row
    // moves the identifier to a fresh child index to keep every bucket class
    // represented in one published delta.
    // Identifier rows ship childIndex: null, so assign a concrete index
    // rather than mapping over None.
    name_identifier.child_index = Some(name_identifier.child_index.unwrap_or(0) + 100);

    let old_reference = graph
        .references_to(&declaration_identifier_id)
        .next()
        .unwrap();
    let reference = ReferenceRecord {
        from_node_id: old_reference.from_node_id.clone(),
        to_node_id: USER_ID.into(),
        kind: old_reference.kind.clone(),
    };

    GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: graph.generation(),
        changes: vec![
            GraphChange::UpsertNode { node: user },
            GraphChange::UpsertNode {
                node: name_identifier,
            },
            GraphChange::UpsertReference { reference },
        ],
    }
}

fn identifier_text(node: &strata_kernel::NodeRecord) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&node.payload)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_owned)
}
