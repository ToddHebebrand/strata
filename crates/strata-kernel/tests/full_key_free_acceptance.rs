#![cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]

#[path = "support/full_key_free.rs"]
mod full_key_free_support;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;

use full_key_free_support::{
    CanonicalFinalState, ClientActor, assert_canonical_final_state,
    assert_projected_typescript_green, assert_typescript_green, classified_request_count,
    classified_worker_exchange, create_classified_projected_kernel, create_projected_kernel,
    inject_validated_add_parameter_g1, localized_add_parameter_fixture,
    localized_only_green_together_fixture, reopen_projected_kernel,
};
use strata_kernel::{
    ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEventKind, IntentParameters, Kernel,
    PublishClaimOutcome, PublishFailpoint, ReadyOffer, SubmissionOutcome, TicketState,
};
use tempfile::tempdir;

const USER_DECLARATION_ID: &str = "fc98295bca9efc3e";
const FORMAT_TIMESTAMP_DECLARATION_ID: &str = "9a25d67ed4b74807";
const GREET_DECLARATION_ID: &str = "603b2ae524ee3c70";
const ROW_8_CHANGE_SET_ID: &str = "row-8-user-rename";
const ROW_8_CHILD_DATABASE: &str = "STRATA_ROW_8_CHILD_DATABASE";
const ROW_8_CHILD_CLAIM: &str = "STRATA_ROW_8_CHILD_CLAIM";
const ROW_8_CHILD_FAILPOINT: &str = "STRATA_ROW_8_CHILD_FAILPOINT";

struct AcceptanceRow {
    number: u8,
    owner_name: &'static str,
    owner: fn(),
}

const ACCEPTANCE_ROWS: [AcceptanceRow; 12] = [
    AcceptanceRow {
        number: 1,
        owner_name: "disjoint real renames publish in both orders",
        owner: row_1_disjoint_real_renames_publish_in_both_orders,
    },
    AcceptanceRow {
        number: 2,
        owner_name: "same-symbol successor requires a fresh decision",
        owner: row_2_same_symbol_real_renames_require_a_fresh_decision,
    },
    AcceptanceRow {
        number: 3,
        owner_name: "real reference facts infer overlap before mutation",
        owner: row_3_real_reference_facts_infer_overlap_before_mutation,
    },
    AcceptanceRow {
        number: 4,
        owner_name: "waiting add-parameter requeues against the latest graph",
        owner: row_4_add_parameter_requeues_before_build_and_updates_the_new_callsite,
    },
    AcceptanceRow {
        number: 5,
        owner_name: "old wide ticket ages without starvation",
        owner: row_5_real_scopes_age_the_old_wide_ticket_while_only_disjoint_work_bypasses,
    },
    AcceptanceRow {
        number: 6,
        owner_name: "restart fences stale real claims",
        owner:
            rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish,
    },
    AcceptanceRow {
        number: 7,
        owner_name: "restart preserves queued tickets and unacknowledged events",
        owner:
            rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish,
    },
    AcceptanceRow {
        number: 8,
        owner_name: "real claimed publication crashes complete old or new",
        owner: row_8_real_claimed_node_publication_crashes_complete_old_or_new,
    },
    AcceptanceRow {
        number: 9,
        owner_name: "real publications replay exactly across a snapshot boundary",
        owner: row_9_real_publications_replay_exactly_across_a_generation_two_snapshot,
    },
    AcceptanceRow {
        number: 10,
        owner_name: "only-green-together change set publishes once",
        owner: row_10_only_green_together_change_set_publishes_once,
    },
    AcceptanceRow {
        number: 11,
        owner_name: "duplicate event delivery and publication are harmless",
        owner:
            rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish,
    },
    AcceptanceRow {
        number: 12,
        owner_name: "Node protocol receives no canonical-storage authority",
        owner: row_12_real_worker_requests_are_bounded_semantic_inputs_only,
    },
];

const FORBIDDEN_NODE_AUTHORITY_KEYS: [&str; 22] = [
    "redbPath",
    "databasePath",
    "storePath",
    "canonicalStore",
    "storeHandle",
    "resourceKeys",
    "resourceVersions",
    "dependencyClocks",
    "reservationKeys",
    "reservations",
    "fence",
    "fences",
    "fencingTokens",
    "dynamicExpansionPolicy",
    "idempotencyClass",
    "candidateDigest",
    "publication",
    "publicationInstructions",
    "publish",
    "provider",
    "candidateBuilder",
    "workerPath",
];

fn assert_exact_object_keys(value: &serde_json::Value, expected: &[&str], label: &str) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("{label} must be a JSON object"));
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(actual, expected, "{label} key allowlist changed");
}

fn assert_no_node_authority_keys(value: &serde_json::Value, path: &str) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                assert!(
                    !FORBIDDEN_NODE_AUTHORITY_KEYS.contains(&key.as_str()),
                    "forbidden Rust authority key {key:?} reached the Node worker at {path}"
                );
                assert_no_node_authority_keys(child, &format!("{path}.{key}"));
            }
        }
        serde_json::Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                assert_no_node_authority_keys(child, &format!("{path}[{index}]"));
            }
        }
        _ => {}
    }
}

fn module_paths(request: &serde_json::Value) -> BTreeSet<&str> {
    request["snapshot"]["nodes"]
        .as_array()
        .expect("worker request snapshot nodes")
        .iter()
        .filter(|node| node["kind"] == "Module")
        .map(|node| {
            node["payload"]
                .as_str()
                .expect("Module payload is its approved source path")
        })
        .collect()
}

fn assert_request_omits_database_path(request: &serde_json::Value, database_path: &Path) {
    let serialized = serde_json::to_string(request).unwrap();
    let raw_path = database_path.to_string_lossy();
    assert!(
        !serialized.contains(raw_path.as_ref()),
        "Node worker request exposed canonical database path {raw_path}"
    );
    let canonical_path = fs::canonicalize(database_path).unwrap();
    let canonical_path = canonical_path.to_string_lossy();
    assert!(
        !serialized.contains(canonical_path.as_ref()),
        "Node worker request exposed canonical database path {canonical_path}"
    );
}

fn submit_wide_rename(
    actor: &ClientActor,
    kernel: &Kernel,
    change_set_id: &str,
    parse_declaration_id: &str,
    now_tick: u64,
) -> SubmissionOutcome {
    actor
        .begin_change_set(
            kernel,
            change_set_id,
            "rename User and parseArgs as one old wide change",
            now_tick,
        )
        .unwrap();
    for parameters in [
        IntentParameters::RenameSymbol {
            declaration_id: USER_DECLARATION_ID.into(),
            new_name: "WideUser".into(),
        },
        IntentParameters::RenameSymbol {
            declaration_id: parse_declaration_id.into(),
            new_name: "parseWideArgs".into(),
        },
    ] {
        actor.add_intent(kernel, change_set_id, parameters).unwrap();
    }
    actor
        .submit_change_set(kernel, change_set_id, now_tick + 1)
        .unwrap()
}

fn submit_rename(
    actor: &ClientActor,
    kernel: &Kernel,
    change_set_id: &str,
    declaration_id: &str,
    new_name: &str,
    now_tick: u64,
) -> SubmissionOutcome {
    actor
        .begin_change_set(
            kernel,
            change_set_id,
            &format!("rename {declaration_id} to {new_name}"),
            now_tick,
        )
        .unwrap();
    actor
        .add_intent(
            kernel,
            change_set_id,
            IntentParameters::RenameSymbol {
                declaration_id: declaration_id.into(),
                new_name: new_name.into(),
            },
        )
        .unwrap();
    actor
        .submit_change_set(kernel, change_set_id, now_tick + 1)
        .unwrap()
}

fn submit_add_parameter(
    actor: &ClientActor,
    kernel: &Kernel,
    change_set_id: &str,
    function_id: &str,
    now_tick: u64,
) -> SubmissionOutcome {
    actor
        .begin_change_set(
            kernel,
            change_set_id,
            "add the uniform excited parameter to greet",
            now_tick,
        )
        .unwrap();
    actor
        .add_intent(
            kernel,
            change_set_id,
            IntentParameters::AddParameter {
                function_id: function_id.into(),
                name: "excited".into(),
                type_text: "boolean".into(),
                position: 1,
                default_value: Some("false".into()),
            },
        )
        .unwrap();
    actor
        .submit_change_set(kernel, change_set_id, now_tick + 1)
        .unwrap()
}

fn ready(outcome: SubmissionOutcome) -> ReadyOffer {
    let SubmissionOutcome::Ready { offer, .. } = outcome else {
        panic!("change set must be ready")
    };
    offer
}

fn claim(actor: &ClientActor, kernel: &Kernel, offer: &ReadyOffer, now_tick: u64) -> ClaimHandle {
    let ClaimOutcome::Claimed(claim) = actor.claim_ready(kernel, offer, now_tick).unwrap() else {
        panic!("ready offer must be claimable")
    };
    claim
}

fn published(outcome: PublishClaimOutcome) -> strata_kernel::PublicationReport {
    let PublishClaimOutcome::Published(report) = outcome else {
        panic!("real Node-backed claim must publish")
    };
    report
}

#[derive(Debug, Eq, PartialEq)]
struct CrashAtomicState {
    normalized: serde_json::Value,
}

impl CrashAtomicState {
    /// Reads the shared, library-expressible atomic-state projection
    /// (`Kernel::test_atomic_state_projection`, the same accessors the
    /// `export-snapshot --state-out` CLI oracle uses — see
    /// `crates/strata-kernel/src/kernel.rs`) and layers the claim-scoped bits
    /// that only make sense inside this crash test on top: the specific claim
    /// under test, its own publication-attempt outcome, and a deterministic
    /// ID-normalization pass so states captured from separate crash-boundary
    /// child processes compare equal when they reflect the same logical
    /// outcome. Those bits have no offline-export equivalent (there is no
    /// "the claim under test" for a static `export-snapshot` run), so they
    /// stay here rather than moving into the shared projection.
    fn read(kernel: &Kernel, original_claim: &ClaimHandle) -> anyhow::Result<Self> {
        let projection = kernel.test_atomic_state_projection()?;

        let change_set = kernel
            .change_set(ROW_8_CHANGE_SET_ID)?
            .expect("row-8 change set after recovery");
        change_set
            .inferred_scope
            .as_ref()
            .expect("row-8 inferred scope after recovery");
        let ticket = kernel
            .ticket_for_change_set(ROW_8_CHANGE_SET_ID)?
            .expect("row-8 ticket after recovery");
        let offer = kernel.ready_offer_for_change_set(ROW_8_CHANGE_SET_ID)?;
        let claims = kernel.test_active_claims()?;
        let coordination_events = kernel.events_after("events:row-8-audit", 0, 1_000)?;
        let publication_attempt = kernel.publication_attempt(&original_claim.attempt_id)?;
        let operations = (1..=kernel.snapshot().generation())
            .filter_map(|generation| kernel.operation(generation).transpose())
            .collect::<anyhow::Result<Vec<_>>>()?;
        let graph_events = (1..=kernel.snapshot().generation())
            .filter_map(|generation| kernel.test_graph_event(generation).transpose())
            .collect::<anyhow::Result<Vec<_>>>()?;

        let mut replacements = BTreeMap::from([
            (ticket.ticket_id.clone(), "<ticket-id>".to_owned()),
            (original_claim.claim_id.clone(), "<claim-id>".to_owned()),
            (original_claim.offer_id.clone(), "<offer-id>".to_owned()),
            (original_claim.attempt_id.clone(), "<attempt-id>".to_owned()),
        ]);
        for (index, intent_id) in change_set.intent_ids.iter().enumerate() {
            replacements.insert(intent_id.clone(), format!("<intent-id:{index}>"));
        }
        if let Some(offer) = &offer {
            replacements.insert(offer.offer_id.clone(), "<offer-id:recovered>".to_owned());
            replacements.insert(
                offer.claim_token.clone(),
                "<claim-token:recovered>".to_owned(),
            );
        }
        for (index, claim) in claims.iter().enumerate() {
            replacements.insert(claim.claim_id.clone(), format!("<claim-id:{index}>"));
            replacements.insert(claim.offer_id.clone(), format!("<offer-id:{index}>"));
            replacements.insert(claim.attempt_id.clone(), format!("<attempt-id:{index}>"));
        }
        for (index, operation) in operations.iter().enumerate() {
            replacements.insert(
                operation.operation_id.clone(),
                format!("<operation-id:{index}>"),
            );
        }
        for (index, event) in graph_events.iter().enumerate() {
            replacements.insert(event.event_id.clone(), format!("<graph-event-id:{index}>"));
        }
        for event in &coordination_events {
            replacements.insert(
                event.event_id.clone(),
                format!("<coordination-event-id:{}>", event.sequence),
            );
        }

        let state = serde_json::json!({
            "projection": projection,
            "rowEightChangeSet": change_set,
            "rowEightTicket": ticket,
            "rowEightOffer": offer,
            "rowEightPublicationAttempt": publication_attempt,
            "rowEightCoordinationEvents": coordination_events,
        });
        Ok(Self {
            normalized: normalize_crash_state(state, &replacements),
        })
    }
}

fn normalize_crash_state(
    mut value: serde_json::Value,
    replacements: &BTreeMap<String, String>,
) -> serde_json::Value {
    fn visit(value: &mut serde_json::Value, replacements: &BTreeMap<String, String>) {
        match value {
            serde_json::Value::String(text) => {
                if let Some(replacement) = replacements.get(text) {
                    *text = replacement.clone();
                } else if let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(text) {
                    visit(&mut payload, replacements);
                    *value = payload;
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    visit(value, replacements);
                }
            }
            serde_json::Value::Object(fields) => {
                // Rekey, not just revalue: maps keyed by a random ID (e.g.
                // `graphTickets`'s ticket_id keys) need the same
                // ID-normalization the values already get, or two
                // independently-generated crash-boundary captures compare
                // unequal on key identity alone even when every value
                // matches.
                let original = std::mem::take(fields);
                for (key, mut nested) in original {
                    visit(&mut nested, replacements);
                    let key = replacements.get(&key).cloned().unwrap_or(key);
                    fields.insert(key, nested);
                }
            }
            _ => {}
        }
    }
    visit(&mut value, replacements);
    value
}

fn prepare_row_8_claim(kernel: &Kernel) -> ClaimHandle {
    let actor = ClientActor::new("agent:row-8-crash", "events:row-8-crash");
    let offer = ready(submit_rename(
        &actor,
        kernel,
        ROW_8_CHANGE_SET_ID,
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    claim(&actor, kernel, &offer, 2)
}

fn row_8_control(path: &std::path::Path, publish: bool) -> CrashAtomicState {
    let (kernel, _) = create_projected_kernel(path).unwrap();
    let claim = prepare_row_8_claim(&kernel);
    if publish {
        published(kernel.execute_claimed(&claim, 3).unwrap());
    }
    drop(kernel);
    let (reopened, _) = Kernel::open(path).unwrap();
    CrashAtomicState::read(&reopened, &claim).unwrap()
}

fn run_row_8_crash_child() {
    let database_path = std::env::var_os(ROW_8_CHILD_DATABASE).unwrap();
    let claim_path = std::env::var_os(ROW_8_CHILD_CLAIM).unwrap();
    let boundary_name = std::env::var(ROW_8_CHILD_FAILPOINT).unwrap();
    let failpoint = PublishFailpoint::from_boundary_name(&boundary_name)
        .unwrap_or_else(|| panic!("unknown row-8 crash boundary {boundary_name}"));
    let directory = std::path::Path::new(&database_path)
        .parent()
        .expect("row-8 child database directory");
    let (kernel, _, _) = create_classified_projected_kernel(&database_path, directory).unwrap();
    let claim = prepare_row_8_claim(&kernel);
    let claim_bytes = serde_json::to_vec(&claim).unwrap();
    let claim_file = fs::File::create(claim_path).unwrap();
    std::io::Write::write_all(&mut &claim_file, &claim_bytes).unwrap();
    claim_file.sync_all().unwrap();
    let _ = kernel
        .execute_claimed_with_failpoint(&claim, 3, failpoint)
        .unwrap();
    panic!("row-8 crash failpoint {boundary_name} returned without terminating the child");
}

fn canonical_reverse_reference_index_bytes(graph: &strata_kernel::GraphGeneration) -> Vec<u8> {
    let mut index = std::collections::BTreeMap::new();
    for node in graph.snapshot().nodes {
        let references = graph.references_to(&node.id).cloned().collect::<Vec<_>>();
        if !references.is_empty() {
            index.insert(node.id, references);
        }
    }
    serde_json::to_vec(&index).unwrap()
}

fn run_disjoint_rename_order(format_first: bool) {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let user = ClientActor::new("agent:row-1-user", "events:row-1-user");
    let format = ClientActor::new("agent:row-1-format", "events:row-1-format");
    assert_ne!(user.actor_id(), format.actor_id());

    let user_offer = ready(submit_rename(
        &user,
        &kernel,
        "row-1-user",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let user_claim = claim(&user, &kernel, &user_offer, 2);
    let format_offer = ready(submit_rename(
        &format,
        &kernel,
        "row-1-format",
        FORMAT_TIMESTAMP_DECLARATION_ID,
        "renderTimestamp",
        0,
    ));
    let format_claim = claim(&format, &kernel, &format_offer, 2);
    assert_eq!(user_claim.graph_generation, 0);
    assert_eq!(format_claim.graph_generation, 0);

    let (first, second) = if format_first {
        (
            published(format.execute_claimed(&kernel, &format_claim, 3).unwrap()),
            published(user.execute_claimed(&kernel, &user_claim, 4).unwrap()),
        )
    } else {
        (
            published(user.execute_claimed(&kernel, &user_claim, 3).unwrap()),
            published(format.execute_claimed(&kernel, &format_claim, 4).unwrap()),
        )
    };
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 2);

    let final_state =
        CanonicalFinalState::capture(&kernel, &["row-1-user", "row-1-format"], &[&user, &format])
            .unwrap();
    assert_eq!(final_state.graph_generation, 2);
    assert_eq!(final_state.operations.len(), 2);
    let expected_change_set_order = if format_first {
        ["row-1-format", "row-1-user"]
    } else {
        ["row-1-user", "row-1-format"]
    };
    assert_eq!(
        final_state
            .operations
            .iter()
            .map(|operation| operation.change_set_id.as_str())
            .collect::<Vec<_>>(),
        expected_change_set_order
    );
    assert_eq!(
        final_state
            .operations
            .iter()
            .map(|operation| operation.actor.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([user.actor_id(), format.actor_id()])
    );
    let snapshot = final_state.graph_snapshot();
    assert!(
        snapshot
            .nodes
            .iter()
            .find(|node| node.id == USER_DECLARATION_ID)
            .unwrap()
            .payload
            .contains("interface Account")
    );
    assert!(
        snapshot
            .nodes
            .iter()
            .find(|node| node.id == FORMAT_TIMESTAMP_DECLARATION_ID)
            .unwrap()
            .payload
            .contains("function renderTimestamp")
    );
    assert_projected_typescript_green(&snapshot);
}

#[test]
fn acceptance_manifest_covers_each_governing_row_exactly_once() {
    assert_eq!(ACCEPTANCE_ROWS.len(), 12);
    assert_eq!(
        ACCEPTANCE_ROWS
            .iter()
            .map(|row| row.number)
            .collect::<Vec<_>>(),
        (1..=12).collect::<Vec<_>>()
    );
    assert_eq!(
        ACCEPTANCE_ROWS
            .iter()
            .map(|row| row.owner_name)
            .collect::<BTreeSet<_>>()
            .len(),
        12,
        "each governing row needs a distinct auditable owner label"
    );

    let mut owner_pointers = Vec::<fn()>::new();
    for row in &ACCEPTANCE_ROWS {
        if !owner_pointers
            .iter()
            .any(|owner| std::ptr::fn_addr_eq(*owner, row.owner))
        {
            owner_pointers.push(row.owner);
        }
    }
    assert_eq!(
        owner_pointers.len(),
        10,
        "only rows 6, 7, and 11 may share one integrated scenario owner"
    );
    let shared_restart_owner: fn() =
        rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish;
    assert_eq!(
        ACCEPTANCE_ROWS
            .iter()
            .filter(|row| std::ptr::fn_addr_eq(row.owner, shared_restart_owner))
            .map(|row| row.number)
            .collect::<Vec<_>>(),
        [6, 7, 11]
    );
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_1_disjoint_real_renames_publish_in_both_orders() {
    run_disjoint_rename_order(true);
    run_disjoint_rename_order(false);
}

/// Validation-circle narrowing acceptance (spec 2026-07-17, kernel-side
/// counterpart of the live-compare mMechanism probe): two byte-disjoint
/// declarations of ONE module (`logEvent` and `eventLine` in
/// src/server/events.ts — they share only a cross-module callee, never a
/// statement) submit ready/ready, hold both claims before either
/// publication, publish in both orders with no fresh decision or
/// needs_decision event, and leave a green projected tree.
#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn same_module_disjoint_renames_publish_concurrently_in_both_orders() {
    run_same_module_disjoint_order(true);
    run_same_module_disjoint_order(false);
}

fn run_same_module_disjoint_order(event_line_first: bool) {
    const LOG_EVENT_DECLARATION_ID: &str = "377324e0d5d31549";
    const EVENT_LINE_DECLARATION_ID: &str = "55fffd2a919faf4c";
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let log_agent = ClientActor::new("agent:same-module-log", "events:same-module-log");
    let line_agent = ClientActor::new("agent:same-module-line", "events:same-module-line");
    let log_offer = ready(submit_rename(
        &log_agent,
        &kernel,
        "same-module-log",
        LOG_EVENT_DECLARATION_ID,
        "recordEvent",
        0,
    ));
    let log_claim = claim(&log_agent, &kernel, &log_offer, 2);
    let line_offer = ready(submit_rename(
        &line_agent,
        &kernel,
        "same-module-line",
        EVENT_LINE_DECLARATION_ID,
        "formatEventLine",
        0,
    ));
    let line_claim = claim(&line_agent, &kernel, &line_offer, 2);
    assert_eq!(log_claim.graph_generation, 0);
    assert_eq!(line_claim.graph_generation, 0);

    let (first, second) = if event_line_first {
        (
            published(
                line_agent
                    .execute_claimed(&kernel, &line_claim, 3)
                    .unwrap(),
            ),
            published(log_agent.execute_claimed(&kernel, &log_claim, 4).unwrap()),
        )
    } else {
        (
            published(log_agent.execute_claimed(&kernel, &log_claim, 3).unwrap()),
            published(
                line_agent
                    .execute_claimed(&kernel, &line_claim, 4)
                    .unwrap(),
            ),
        )
    };
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 2);

    let final_state = CanonicalFinalState::capture(
        &kernel,
        &["same-module-log", "same-module-line"],
        &[&log_agent, &line_agent],
    )
    .unwrap();
    assert_eq!(final_state.graph_generation, 2);
    assert_eq!(final_state.operations.len(), 2);
    let snapshot = final_state.graph_snapshot();
    assert!(
        snapshot
            .nodes
            .iter()
            .find(|node| node.id == LOG_EVENT_DECLARATION_ID)
            .unwrap()
            .payload
            .contains("function recordEvent")
    );
    assert!(
        snapshot
            .nodes
            .iter()
            .find(|node| node.id == EVENT_LINE_DECLARATION_ID)
            .unwrap()
            .payload
            .contains("function formatEventLine")
    );
    assert_projected_typescript_green(&snapshot);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_2_same_symbol_real_renames_require_a_fresh_decision() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let first = ClientActor::new("agent:row-2-first", "events:row-2-first");
    let second = ClientActor::new("agent:row-2-second", "events:row-2-second");
    let first_offer = ready(submit_rename(
        &first,
        &kernel,
        "row-2-account",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let first_claim = claim(&first, &kernel, &first_offer, 2);
    let SubmissionOutcome::Queued { ticket } = submit_rename(
        &second,
        &kernel,
        "row-2-customer",
        USER_DECLARATION_ID,
        "Customer",
        1,
    ) else {
        panic!("same-symbol successor must queue behind the held first claim")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    let stale_fingerprint = kernel
        .change_set("row-2-customer")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap()
        .scope_fingerprint;

    let first_report = published(first.execute_claimed(&kernel, &first_claim, 3).unwrap());
    assert_eq!(first_report.generation, 1);
    assert!(
        kernel
            .ready_offer_for_change_set("row-2-customer")
            .unwrap()
            .is_none(),
        "the second client must not receive authority from its stale G0 analysis"
    );
    let second_change_set = kernel.change_set("row-2-customer").unwrap().unwrap();
    assert_eq!(second_change_set.state, ChangeSetState::NeedsDecision);
    let fresh_fingerprint = second_change_set
        .inferred_scope
        .as_ref()
        .unwrap()
        .scope_fingerprint
        .clone();
    assert_ne!(fresh_fingerprint, stale_fingerprint);

    let decision_event = second
        .read_events(&kernel, 100)
        .unwrap()
        .into_iter()
        .rev()
        .find(|event| {
            event.change_set_id == "row-2-customer"
                && event.kind == CoordinationEventKind::IntentNeedsDecision
        })
        .expect("fresh-state decision event");
    let decision: serde_json::Value = serde_json::from_str(&decision_event.payload_json).unwrap();
    assert_eq!(decision["beforeGeneration"], 0);
    assert_eq!(decision["afterGeneration"], 1);
    assert_eq!(decision["scopeFingerprint"], fresh_fingerprint);
    assert!(decision["blockingOperationId"].as_str().is_some());

    let final_state = CanonicalFinalState::capture(
        &kernel,
        &["row-2-account", "row-2-customer"],
        &[&first, &second],
    )
    .unwrap();
    assert_eq!(final_state.graph_generation, 1);
    assert_eq!(final_state.operations.len(), 1);
    assert_eq!(final_state.operations[0].change_set_id, "row-2-account");
    assert_eq!(final_state.operations[0].actor, first.actor_id());
    assert_eq!(
        final_state
            .tickets
            .iter()
            .find(|ticket| ticket.change_set_id == "row-2-customer")
            .unwrap()
            .state,
        TicketState::NeedsDecision
    );
    let user = final_state
        .nodes
        .iter()
        .find(|node| node.id == USER_DECLARATION_ID)
        .unwrap();
    assert!(user.payload.contains("interface Account"));
    assert!(!user.payload.contains("Customer"));
    assert_projected_typescript_green(&final_state.graph_snapshot());
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_3_real_reference_facts_infer_overlap_before_mutation() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);
    let before = kernel.snapshot();
    let user_name_id = before
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.kind == "Identifier"
                && node.parent_id.as_deref() == Some(USER_DECLARATION_ID)
                && serde_json::from_str::<serde_json::Value>(&node.payload)
                    .ok()
                    .and_then(|payload| payload["text"].as_str().map(str::to_owned))
                    .as_deref()
                    == Some("User")
        })
        .expect("stable User declaration-name identifier")
        .id;
    let greet_user_reference = before
        .snapshot()
        .references
        .into_iter()
        .find(|reference| {
            reference.to_node_id == user_name_id
                && before
                    .node(&reference.from_node_id)
                    .is_some_and(|source| source.parent_id.as_deref() == Some(GREET_DECLARATION_ID))
        })
        .expect("greet signature must contain a real graph reference to User");

    let rename = ClientActor::new("agent:row-3-rename", "events:row-3-rename");
    let parameter = ClientActor::new("agent:row-3-parameter", "events:row-3-parameter");
    let rename_offer = ready(submit_rename(
        &rename,
        &kernel,
        "row-3-rename-user",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let rename_claim = claim(&rename, &kernel, &rename_offer, 2);
    let SubmissionOutcome::Queued { ticket } = submit_add_parameter(
        &parameter,
        &kernel,
        "row-3-parameter-greet",
        GREET_DECLARATION_ID,
        1,
    ) else {
        panic!("the reference-mediated add-parameter must queue before mutation")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    assert!(
        kernel
            .ready_offer_for_change_set("row-3-parameter-greet")
            .unwrap()
            .is_none(),
        "the overlapping client must not receive concurrent claim authority"
    );
    assert_eq!(kernel.snapshot().generation(), 0);
    assert!(kernel.operation(1).unwrap().is_none());

    let parameter_scope = kernel
        .change_set("row-3-parameter-greet")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    let overlap = rename_claim
        .reservation_keys
        .iter()
        .filter(|key| parameter_scope.reservation_keys.contains(key))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        overlap.contains(&format!("node:{GREET_DECLARATION_ID}")),
        "User reference source {} makes greet a Rust-derived shared reservation: {overlap:?}",
        greet_user_reference.from_node_id
    );
    assert_eq!(
        kernel
            .snapshot()
            .node(GREET_DECLARATION_ID)
            .unwrap()
            .payload,
        before.node(GREET_DECLARATION_ID).unwrap().payload
    );
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_4_add_parameter_requeues_before_build_and_updates_the_new_callsite() {
    let directory = tempdir().unwrap();
    let fixture = localized_add_parameter_fixture(directory.path());
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) =
        Kernel::create_with_node_bridge(&database_path, fixture.g0.clone(), fixture.worker_config)
            .unwrap();
    assert_eq!(created.generation, 0);

    let publisher = ClientActor::new("agent:row-4-publisher", "events:row-4-publisher");
    let parameter = ClientActor::new("agent:row-4-parameter", "events:row-4-parameter");
    let offer = ready(submit_add_parameter(
        &parameter,
        &kernel,
        "row-4-add-parameter",
        &fixture.greet_id,
        0,
    ));
    let submitted_scope = kernel
        .change_set("row-4-add-parameter")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert!(
        !submitted_scope.write_set.iter().any(|resource| {
            resource.resource_key == format!("node:{}", fixture.new_callsite_id)
        })
    );
    let analyses_before_claim = classified_request_count(&fixture.request_counts, "analyzeIntent");
    assert!(analyses_before_claim >= 1);
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        0
    );

    // This is a combined-feature fixture publisher, never a client or production storage path.
    inject_validated_add_parameter_g1(&kernel, &fixture.g0, &fixture.g1);
    let ClaimOutcome::Requeued { ticket, event } =
        parameter.claim_ready(&kernel, &offer, 2).unwrap()
    else {
        panic!("the G+1 callsite must expand scope and requeue")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    assert_eq!(event.kind, CoordinationEventKind::ScopeExpanded);
    assert_eq!(event.change_set_id, "row-4-add-parameter");
    assert!(
        classified_request_count(&fixture.request_counts, "analyzeIntent") > analyses_before_claim
    );
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        0,
        "fresh expansion must requeue before any candidate construction"
    );
    let expanded_scope = kernel
        .change_set("row-4-add-parameter")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert_ne!(
        expanded_scope.scope_fingerprint,
        submitted_scope.scope_fingerprint
    );
    assert!(
        expanded_scope.write_set.iter().any(|resource| {
            resource.resource_key == format!("node:{}", fixture.new_callsite_id)
        })
    );

    kernel.reconsider_tickets(3).unwrap();
    let fresh_offer = kernel
        .ready_offer_for_change_set("row-4-add-parameter")
        .unwrap()
        .expect("expanded replay-safe intent must receive fresh authority");
    let fresh_claim = claim(&parameter, &kernel, &fresh_offer, 4);
    let report = published(parameter.execute_claimed(&kernel, &fresh_claim, 5).unwrap());
    assert_eq!(report.generation, 2);
    assert!(!report.already_published);
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        1
    );

    let final_state =
        CanonicalFinalState::capture(&kernel, &["row-4-add-parameter"], &[&publisher, &parameter])
            .unwrap();
    assert_eq!(final_state.graph_generation, 2);
    assert_eq!(final_state.operations.len(), 2);
    assert_eq!(final_state.operations[0].actor, "fixture:ingest-exporter");
    assert_eq!(final_state.operations[1].actor, parameter.actor_id());
    assert_eq!(
        final_state.operations[1].change_set_id,
        "row-4-add-parameter"
    );
    assert!(
        final_state.operations[1]
            .affected_node_ids
            .contains(&fixture.greet_id)
    );
    assert!(
        final_state.operations[1]
            .affected_node_ids
            .contains(&fixture.new_callsite_id)
    );
    assert!(kernel.operation(3).unwrap().is_none());
    let callsite = final_state
        .nodes
        .iter()
        .find(|node| node.id == fixture.new_callsite_id)
        .unwrap();
    assert_eq!(callsite.payload.matches("false").count(), 1);
    assert!(
        parameter
            .read_events(&kernel, 100)
            .unwrap()
            .iter()
            .any(|event| {
                event.change_set_id == "row-4-add-parameter"
                    && event.kind == CoordinationEventKind::IntentCommitted
            })
    );
    assert_typescript_green(&final_state.graph_snapshot(), &fixture.corpus_root);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_5_real_scopes_age_the_old_wide_ticket_while_only_disjoint_work_bypasses() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);
    let parse_declaration_id = kernel
        .snapshot()
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.kind == "FunctionDeclaration" && node.payload.contains("function parseArgs(")
        })
        .expect("real parseArgs declaration")
        .id;

    let active = ClientActor::new("agent:row-5-active", "events:row-5-active");
    let wide = ClientActor::new("agent:row-5-wide", "events:row-5-wide");
    let disjoint = ClientActor::new("agent:row-5-disjoint", "events:row-5-disjoint");
    let active_offer = ready(submit_rename(
        &active,
        &kernel,
        "row-5-active-user",
        USER_DECLARATION_ID,
        "HeldUser",
        0,
    ));
    let _active_claim = claim(&active, &kernel, &active_offer, 2);
    let SubmissionOutcome::Queued { ticket } =
        submit_wide_rename(&wide, &kernel, "row-5-old-wide", &parse_declaration_id, 1)
    else {
        panic!("the old wide change must queue behind the held User claim")
    };
    assert_eq!(ticket.state, TicketState::Queued);

    let overlap_clients = (0..1)
        .map(|index| {
            ClientActor::new(
                format!("agent:row-5-overlap-{index}"),
                format!("events:row-5-overlap-{index}"),
            )
        })
        .collect::<Vec<_>>();
    for (index, actor) in overlap_clients.iter().enumerate() {
        let change_set_id = format!("row-5-newer-overlap-{index}");
        let SubmissionOutcome::Queued { .. } = submit_rename(
            actor,
            &kernel,
            &change_set_id,
            USER_DECLARATION_ID,
            &format!("NewerUser{index}"),
            3 + index as u64,
        ) else {
            panic!("newer overlapping work must remain bounded behind the old wide ticket")
        };
    }

    for index in 0..2 {
        let change_set_id = format!("row-5-disjoint-{index}");
        let offer = ready(submit_rename(
            &disjoint,
            &kernel,
            &change_set_id,
            FORMAT_TIMESTAMP_DECLARATION_ID,
            &format!("renderTimestamp{index}"),
            10 + index * 4,
        ));
        let disjoint_claim = claim(&disjoint, &kernel, &offer, 12 + index * 4);
        let report = published(
            disjoint
                .execute_claimed(&kernel, &disjoint_claim, 13 + index * 4)
                .unwrap(),
        );
        assert_eq!(report.generation, index + 1);
        for overlap_index in 0..overlap_clients.len() {
            assert!(
                kernel
                    .ready_offer_for_change_set(&format!("row-5-newer-overlap-{overlap_index}"))
                    .unwrap()
                    .is_none(),
                "newer overlap bypassed FIFO after disjoint round {index}"
            );
        }
    }
    let aged = kernel
        .ticket_for_change_set("row-5-old-wide")
        .unwrap()
        .unwrap();
    assert_eq!(aged.state, TicketState::Queued);
    assert!(
        aged.age_rounds >= 2,
        "each deterministic bypass round must age the old ticket"
    );

    let cancellation = active
        .cancel_change_set(&kernel, "row-5-active-user", 50)
        .unwrap();
    let wide_offer = cancellation
        .ready_offers
        .into_iter()
        .find(|offer| offer.change_set_id == "row-5-old-wide")
        .expect("releasing the blocker must offer the oldest wide ticket immediately");
    let wide_claim = claim(&wide, &kernel, &wide_offer, 51);
    assert_eq!(wide_claim.change_set_id, "row-5-old-wide");
    for overlap_index in 0..overlap_clients.len() {
        assert!(
            kernel
                .ready_offer_for_change_set(&format!("row-5-newer-overlap-{overlap_index}"))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let first = ClientActor::new("agent:rows-6-7-11-first", "events:rows-6-7-11-first");
    let queued = ClientActor::new("agent:rows-6-7-11-queued", "events:rows-6-7-11-queued");
    let mut observer =
        ClientActor::new("agent:rows-6-7-11-observer", "events:rows-6-7-11-observer");
    let first_offer = ready(submit_rename(
        &first,
        &kernel,
        "rows-6-7-11-first",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let old_claim = claim(&first, &kernel, &first_offer, 2);
    let SubmissionOutcome::Queued { .. } = submit_rename(
        &queued,
        &kernel,
        "rows-6-7-11-queued",
        USER_DECLARATION_ID,
        "Customer",
        1,
    ) else {
        panic!("the second real client must be durably queued")
    };
    let first_ticket_id = kernel
        .ticket_for_change_set("rows-6-7-11-first")
        .unwrap()
        .unwrap()
        .ticket_id;
    let queued_ticket_id = kernel
        .ticket_for_change_set("rows-6-7-11-queued")
        .unwrap()
        .unwrap()
        .ticket_id;
    let events_before_restart = observer.read_events(&kernel, 100).unwrap();
    assert!(!events_before_restart.is_empty());
    assert_eq!(observer.acknowledged_event_sequence(), 0);
    let old_epoch = old_claim.service_epoch;
    drop(kernel);

    let (reopened, recovered) = reopen_projected_kernel(&database_path).unwrap();
    assert!(recovered.service_epoch > old_epoch);
    assert_eq!(
        reopened
            .ticket_for_change_set("rows-6-7-11-first")
            .unwrap()
            .unwrap()
            .ticket_id,
        first_ticket_id
    );
    let recovered_queued = reopened
        .ticket_for_change_set("rows-6-7-11-queued")
        .unwrap()
        .unwrap();
    assert_eq!(recovered_queued.ticket_id, queued_ticket_id);
    assert_eq!(recovered_queued.state, TicketState::Queued);

    let before_stale_attempt = reopened.snapshot().digest().to_owned();
    let stale_error = first
        .execute_claimed(&reopened, &old_claim, 3)
        .unwrap_err()
        .to_string();
    assert!(
        stale_error.contains("claim")
            || stale_error.contains("epoch")
            || stale_error.contains("lease has expired"),
        "old real claim must be rejected by recovered authority: {stale_error}"
    );
    assert_eq!(reopened.snapshot().generation(), 0);
    assert_eq!(reopened.snapshot().digest(), before_stale_attempt);
    assert!(reopened.operation(1).unwrap().is_none());

    let delivery_one = observer.read_events(&reopened, 100).unwrap();
    let delivery_two = observer.read_events(&reopened, 100).unwrap();
    assert_eq!(
        delivery_one, delivery_two,
        "redelivery before acknowledgement is stable"
    );
    assert_eq!(
        &delivery_one[..events_before_restart.len()],
        events_before_restart.as_slice(),
        "unacknowledged event IDs and payloads must survive restart"
    );
    let delivered_ids = delivery_one
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(delivered_ids.len(), delivery_one.len());
    let acknowledged = delivery_one.last().unwrap().sequence;
    let first_ack = observer
        .acknowledge_events(&reopened, acknowledged)
        .unwrap();
    let duplicate_ack = observer
        .acknowledge_events(&reopened, acknowledged)
        .unwrap();
    let older_ack = observer
        .acknowledge_events(&reopened, acknowledged.saturating_sub(1))
        .unwrap();
    assert_eq!(first_ack, duplicate_ack);
    assert_eq!(older_ack.acknowledged_sequence, acknowledged);
    assert!(observer.read_events(&reopened, 100).unwrap().is_empty());

    let fresh_offer = reopened
        .ready_offer_for_change_set("rows-6-7-11-first")
        .unwrap()
        .expect("restart must issue fresh authority for the oldest recovered ticket");
    assert_ne!(fresh_offer.service_epoch, old_claim.service_epoch);
    let fresh_claim = claim(&first, &reopened, &fresh_offer, 4);
    let first_publish = published(first.execute_claimed(&reopened, &fresh_claim, 5).unwrap());
    assert_eq!(first_publish.generation, 1);
    assert!(!first_publish.already_published);
    let duplicate_publish = published(first.execute_claimed(&reopened, &fresh_claim, 6).unwrap());
    assert_eq!(duplicate_publish.generation, 1);
    assert!(duplicate_publish.already_published);
    assert_eq!(reopened.snapshot().generation(), 1);
    assert!(reopened.operation(2).unwrap().is_none());
    assert_eq!(
        (1..=reopened.snapshot().generation())
            .filter_map(|generation| reopened.operation(generation).unwrap())
            .filter(|operation| operation.change_set_id == "rows-6-7-11-first")
            .count(),
        1
    );
    let committed_events = reopened
        .events_after("events:rows-6-7-11-audit", 0, 100)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.change_set_id == "rows-6-7-11-first"
                && event.kind == CoordinationEventKind::IntentCommitted
        })
        .count();
    assert_eq!(committed_events, 1);
    assert_projected_typescript_green(&reopened.snapshot().snapshot());
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_8_real_claimed_node_publication_crashes_complete_old_or_new() {
    if std::env::var_os(ROW_8_CHILD_DATABASE).is_some() {
        run_row_8_crash_child();
        return;
    }

    let controls = tempdir().unwrap();
    let complete_old = row_8_control(&controls.path().join("complete-old.redb"), false);
    let complete_new = row_8_control(&controls.path().join("complete-new.redb"), true);
    assert_ne!(complete_old, complete_new);

    let boundaries = PublishFailpoint::crash_boundaries().collect::<Vec<_>>();
    assert_eq!(boundaries.len(), 4, "every authorized crash boundary once");
    assert_eq!(
        boundaries
            .iter()
            .map(|failpoint| failpoint.boundary_name())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        boundaries.len(),
        "authorized crash boundary names must be unique"
    );

    for failpoint in boundaries {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("kernel.redb");
        let claim_path = directory.path().join("claim.json");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "row_8_real_claimed_node_publication_crashes_complete_old_or_new",
                "--ignored",
                "--nocapture",
            ])
            .env(ROW_8_CHILD_DATABASE, &database_path)
            .env(ROW_8_CHILD_CLAIM, &claim_path)
            .env(ROW_8_CHILD_FAILPOINT, failpoint.boundary_name())
            .output()
            .unwrap();
        assert!(
            !child.status.success(),
            "crash boundary {} returned successfully\nstdout:\n{}\nstderr:\n{}",
            failpoint.boundary_name(),
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr),
        );
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                child.status.signal(),
                Some(6),
                "{} must terminate through the authorized abort boundary",
                failpoint.boundary_name()
            );
        }
        assert_eq!(
            classified_request_count(
                &directory.path().join("node-request-count"),
                "buildValidateCandidate"
            ),
            1,
            "{} must build and validate one real Node candidate before crashing",
            failpoint.boundary_name()
        );
        let claim: ClaimHandle = serde_json::from_slice(&fs::read(&claim_path).unwrap()).unwrap();
        let (reopened, report) = Kernel::open(&database_path).unwrap();
        let actual = CrashAtomicState::read(&reopened, &claim).unwrap();
        let expected = if failpoint.expects_committed_state() {
            &complete_new
        } else {
            &complete_old
        };
        assert_eq!(
            actual,
            *expected,
            "{} must recover as complete-{}",
            failpoint.boundary_name(),
            if failpoint.expects_committed_state() {
                "new"
            } else {
                "old"
            }
        );
        assert_eq!(
            report.generation,
            u64::from(failpoint.expects_committed_state()),
            "{} durable generation",
            failpoint.boundary_name()
        );
    }
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_9_real_publications_replay_exactly_across_a_generation_two_snapshot() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let user = ClientActor::new("agent:row-9-user", "events:row-9-user");
    let timestamp = ClientActor::new("agent:row-9-timestamp", "events:row-9-timestamp");
    let greet = ClientActor::new("agent:row-9-greet", "events:row-9-greet");
    assert_eq!(
        std::collections::BTreeSet::from(
            [user.actor_id(), timestamp.actor_id(), greet.actor_id(),]
        )
        .len(),
        3,
        "each real publication must come from an independent client"
    );

    for (actor, change_set_id, declaration_id, new_name, now_tick) in [
        (&user, "row-9-user", USER_DECLARATION_ID, "ReplayAccount", 0),
        (
            &timestamp,
            "row-9-timestamp",
            FORMAT_TIMESTAMP_DECLARATION_ID,
            "replayTimestamp",
            4,
        ),
    ] {
        let offer = ready(submit_rename(
            actor,
            &kernel,
            change_set_id,
            declaration_id,
            new_name,
            now_tick,
        ));
        let claimed = claim(actor, &kernel, &offer, now_tick + 2);
        let report = published(
            actor
                .execute_claimed(&kernel, &claimed, now_tick + 3)
                .unwrap(),
        );
        assert_eq!(report.generation, now_tick / 4 + 1);
    }

    let generation_two = kernel.snapshot().snapshot();
    assert_eq!(generation_two.generation, 2);
    kernel.write_snapshot(&generation_two).unwrap();

    let greet_offer = ready(submit_rename(
        &greet,
        &kernel,
        "row-9-greet",
        GREET_DECLARATION_ID,
        "welcomeUser",
        8,
    ));
    let greet_claim = claim(&greet, &kernel, &greet_offer, 10);
    let third_report = published(greet.execute_claimed(&kernel, &greet_claim, 11).unwrap());
    assert_eq!(third_report.generation, 3);

    let expected_graph = kernel.snapshot();
    let expected_snapshot = expected_graph.snapshot();
    let expected_node_bytes = serde_json::to_vec(&expected_snapshot.nodes).unwrap();
    let expected_reference_bytes = serde_json::to_vec(&expected_snapshot.references).unwrap();
    let expected_index_bytes = canonical_reverse_reference_index_bytes(&expected_graph);
    let expected_operations = (1..=expected_graph.generation())
        .map(|generation| {
            kernel
                .operation(generation)
                .unwrap()
                .expect("every published generation has one operation")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        expected_operations
            .iter()
            .map(|operation| operation.change_set_id.as_str())
            .collect::<Vec<_>>(),
        ["row-9-user", "row-9-timestamp", "row-9-greet"]
    );
    assert_eq!(
        expected_operations
            .iter()
            .map(|operation| operation.actor.as_str())
            .collect::<Vec<_>>(),
        [user.actor_id(), timestamp.actor_id(), greet.actor_id()]
    );
    let expected_generation = expected_graph.generation();
    let expected_digest = expected_graph.digest().to_owned();
    assert_projected_typescript_green(&expected_snapshot);
    drop(expected_graph);
    drop(kernel);

    let (reopened, recovered) = Kernel::open(&database_path).unwrap();
    assert_eq!(recovered.snapshot_generation, 2);
    assert_eq!(recovered.replayed_operations, 1);
    assert_eq!(recovered.generation, expected_generation);
    assert_eq!(recovered.digest, expected_digest);

    let actual_graph = reopened.snapshot();
    let actual_snapshot = actual_graph.snapshot();
    assert_eq!(
        serde_json::to_vec(&actual_snapshot.nodes).unwrap(),
        expected_node_bytes,
        "canonical node bytes must survive snapshot-plus-operation replay"
    );
    assert_eq!(
        serde_json::to_vec(&actual_snapshot.references).unwrap(),
        expected_reference_bytes,
        "canonical reference bytes must survive snapshot-plus-operation replay"
    );
    assert_eq!(
        canonical_reverse_reference_index_bytes(&actual_graph),
        expected_index_bytes,
        "the public reverse-reference index view must survive replay byte-for-byte"
    );
    let actual_operations = (1..=actual_graph.generation())
        .map(|generation| {
            reopened
                .operation(generation)
                .unwrap()
                .expect("replayed generation retains its operation")
        })
        .collect::<Vec<_>>();
    assert_eq!(actual_operations, expected_operations);
    assert_eq!(actual_graph.generation(), expected_generation);
    assert_eq!(actual_graph.digest(), expected_digest);
    assert_eq!(actual_snapshot, expected_snapshot);
    assert_projected_typescript_green(&actual_snapshot);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_10_add_parameter_alone_fails_validation_without_publication() {
    let directory = tempdir().unwrap();
    let fixture = localized_only_green_together_fixture(directory.path());
    assert_eq!(fixture.g0.generation, 0);
    assert_eq!(fixture.g0.nodes.len(), 1_212);
    assert_eq!(fixture.g0.references.len(), 594);

    let database_path = directory.path().join("negative-control.redb");
    let (kernel, created) = Kernel::create_with_node_bridge(
        &database_path,
        fixture.g0.clone(),
        fixture.worker_config.clone(),
    )
    .unwrap();
    assert_eq!(created.generation, 0);

    let actor = ClientActor::new("agent:row-10-negative", "events:row-10-negative");
    actor
        .begin_change_set(
            &kernel,
            "row-10-add-parameter-alone",
            "prove Account is unresolved without the grouped rename",
            0,
        )
        .unwrap();
    let added = actor
        .add_intent(
            &kernel,
            "row-10-add-parameter-alone",
            IntentParameters::AddParameter {
                function_id: fixture.greet_id.clone(),
                name: "account".into(),
                type_text: "Account".into(),
                position: 1,
                default_value: Some("undefined as never".into()),
            },
        )
        .unwrap();
    let offer = ready(
        actor
            .submit_change_set(&kernel, "row-10-add-parameter-alone", 1)
            .unwrap(),
    );
    let claimed = claim(&actor, &kernel, &offer, 2);
    let durable = kernel
        .change_set("row-10-add-parameter-alone")
        .unwrap()
        .unwrap();
    assert_eq!(durable.intent_ids, [added.intent_id]);

    let before =
        CanonicalFinalState::capture(&kernel, &["row-10-add-parameter-alone"], &[&actor]).unwrap();
    let before_graph_tables = kernel.test_graph_table_counts().unwrap();
    let before_clocks = kernel.test_all_resource_clocks().unwrap();
    let before_claims = kernel.test_active_claims().unwrap();
    assert_eq!(before_claims.as_slice(), std::slice::from_ref(&claimed));

    let error = actor.execute_claimed(&kernel, &claimed, 3).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("Validate/typescriptFailed"), "{error:#}");
    assert!(
        message.contains("candidate TypeScript validation failed"),
        "{error:#}"
    );
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        1
    );

    let exchange = classified_worker_exchange(&fixture.request_counts, "buildValidateCandidate");
    assert_eq!(exchange.response["ok"], false);
    assert_eq!(exchange.response["error"]["code"], "typescriptFailed");
    let diagnostics = exchange.response["error"]["diagnostics"]
        .as_array()
        .expect("candidate diagnostics array");
    assert_eq!(diagnostics.len(), 1, "bounded negative-control diagnostics");
    assert_eq!(diagnostics[0]["code"], 2304);
    assert_eq!(diagnostics[0]["nodeId"], fixture.greet_id);
    assert_eq!(diagnostics[0]["message"], "Cannot find name 'Account'.");
    assert!(
        diagnostics[0]["modulePath"]
            .as_str()
            .is_some_and(|path| path.ends_with("/src/users/greet.ts"))
    );
    assert!(
        serde_json::to_vec(diagnostics).unwrap().len() <= 64 * 1024,
        "diagnostics must remain within the production bridge bound"
    );

    let after =
        CanonicalFinalState::capture(&kernel, &["row-10-add-parameter-alone"], &[&actor]).unwrap();
    assert_canonical_final_state(&before, &after);
    assert_eq!(
        kernel.test_graph_table_counts().unwrap(),
        before_graph_tables
    );
    assert_eq!(kernel.test_all_resource_clocks().unwrap(), before_clocks);
    assert_eq!(kernel.test_active_claims().unwrap(), before_claims);
    assert!(
        kernel
            .publication_attempt(&claimed.attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(kernel.operation(1).unwrap().is_none());
    assert_eq!(
        kernel
            .change_set("row-10-add-parameter-alone")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Executing
    );
    for stable_id in [
        &fixture.user_id,
        &fixture.greet_id,
        &fixture.new_callsite_id,
    ] {
        assert_eq!(
            kernel.snapshot().node(stable_id),
            fixture.g0.nodes.iter().find(|node| &node.id == stable_id),
            "failed candidate must preserve stable logical ID {stable_id}"
        );
    }
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_10_only_green_together_change_set_publishes_once() {
    let directory = tempdir().unwrap();
    let fixture = localized_only_green_together_fixture(directory.path());
    assert_eq!(fixture.g0.generation, 0);
    assert_eq!(fixture.g0.nodes.len(), 1_212);
    assert_eq!(fixture.g0.references.len(), 594);

    let database_path = directory.path().join("grouped.redb");
    let (kernel, created) = Kernel::create_with_node_bridge(
        &database_path,
        fixture.g0.clone(),
        fixture.worker_config.clone(),
    )
    .unwrap();
    assert_eq!(created.generation, 0);
    assert!(kernel.operation(1).unwrap().is_none());

    let actor = ClientActor::new("agent:row-10-grouped", "events:row-10-grouped");
    actor
        .begin_change_set(
            &kernel,
            "row-10-only-green-together",
            "rename User and add the Account parameter atomically",
            0,
        )
        .unwrap();
    let renamed = actor
        .add_intent(
            &kernel,
            "row-10-only-green-together",
            IntentParameters::RenameSymbol {
                declaration_id: fixture.user_id.clone(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
    let added = actor
        .add_intent(
            &kernel,
            "row-10-only-green-together",
            IntentParameters::AddParameter {
                function_id: fixture.greet_id.clone(),
                name: "account".into(),
                type_text: "Account".into(),
                position: 1,
                default_value: Some("undefined as never".into()),
            },
        )
        .unwrap();
    let ordered_intent_ids = [renamed.intent_id.clone(), added.intent_id.clone()];
    let draft_change_set = kernel
        .change_set("row-10-only-green-together")
        .unwrap()
        .unwrap();
    assert_eq!(draft_change_set.state, ChangeSetState::Draft);
    assert_eq!(draft_change_set.intent_ids, ordered_intent_ids);
    let offer = ready(
        actor
            .submit_change_set(&kernel, "row-10-only-green-together", 1)
            .unwrap(),
    );
    let claimed = claim(&actor, &kernel, &offer, 2);
    let before = kernel.snapshot().snapshot();
    assert_eq!(before, fixture.g0);

    let report = published(actor.execute_claimed(&kernel, &claimed, 3).unwrap());
    assert_eq!(report.generation, 1);
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        1,
        "the ordered pair must execute in one Node scratch transaction"
    );

    let exchange = classified_worker_exchange(&fixture.request_counts, "buildValidateCandidate");
    let ordered_intents = exchange.request["changeSet"]["orderedIntents"]
        .as_array()
        .expect("ordered candidate intents");
    assert_eq!(ordered_intents.len(), 2);
    assert_eq!(ordered_intents[0]["intentId"], ordered_intent_ids[0]);
    assert_eq!(ordered_intents[0]["parameters"]["type"], "renameSymbol");
    assert_eq!(ordered_intents[1]["intentId"], ordered_intent_ids[1]);
    assert_eq!(ordered_intents[1]["parameters"]["type"], "addParameter");
    assert_eq!(exchange.response["ok"], true);
    assert_eq!(
        exchange.response["result"]["diagnostics"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let changes = exchange.response["result"]["delta"]["changes"]
        .as_array()
        .expect("validated grouped delta");
    assert_eq!(changes.len(), 64);
    let change_kinds = changes.iter().fold(BTreeMap::new(), |mut counts, change| {
        *counts
            .entry(change["type"].as_str().unwrap().to_owned())
            .or_insert(0_usize) += 1;
        counts
    });
    assert_eq!(
        change_kinds,
        BTreeMap::from([
            ("deleteReference".to_owned(), 1),
            ("upsertNode".to_owned(), 60),
            ("upsertReference".to_owned(), 3),
        ])
    );

    let operation = kernel.operation(1).unwrap().unwrap();
    assert_eq!(operation.change_set_id, "row-10-only-green-together");
    assert_eq!(operation.actor, actor.actor_id());
    assert_eq!(
        operation.reasoning,
        "rename User and add the Account parameter atomically"
    );
    assert_eq!(operation.kind, "CompositeChangeSet(2)");
    for stable_id in [
        &fixture.user_id,
        &fixture.greet_id,
        &fixture.new_callsite_id,
    ] {
        assert!(operation.affected_node_ids.contains(stable_id));
    }
    assert!(kernel.operation(2).unwrap().is_none());
    let committed_change_set = kernel
        .change_set("row-10-only-green-together")
        .unwrap()
        .unwrap();
    assert_eq!(committed_change_set.state, ChangeSetState::Committed);
    assert_eq!(committed_change_set.intent_ids, ordered_intent_ids);
    assert_eq!(
        kernel
            .ticket_for_change_set("row-10-only-green-together")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Completed
    );

    let after = kernel.snapshot().snapshot();
    assert_eq!(after.generation, 1);
    let user = after
        .nodes
        .iter()
        .find(|node| node.id == fixture.user_id)
        .expect("stable localized User declaration ID");
    assert!(user.payload.contains("interface Account"));
    let greet = after
        .nodes
        .iter()
        .find(|node| node.id == fixture.greet_id)
        .expect("stable localized greet declaration ID");
    assert!(
        greet
            .payload
            .contains("greet(user: Account, account: Account = undefined as never)")
    );
    let callsite = after
        .nodes
        .iter()
        .find(|node| node.id == fixture.new_callsite_id)
        .expect("stable localized deterministic callsite ID");
    assert!(callsite.payload.contains("}, undefined as never)"));
    assert_typescript_green(&after, &fixture.corpus_root);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_12_real_worker_requests_are_bounded_semantic_inputs_only() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("canonical-kernel.redb");
    let (kernel, created, request_counts) =
        create_classified_projected_kernel(&database_path, directory.path()).unwrap();
    assert_eq!(created.generation, 0);

    let actor = ClientActor::new("agent:row-12", "events:row-12");
    let offer = ready(submit_rename(
        &actor,
        &kernel,
        "row-12-user-rename",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    assert_eq!(
        classified_request_count(&request_counts, "analyzeIntent"),
        2,
        "add-intent and submit each bind semantic analysis to the current graph"
    );
    let analyze = classified_worker_exchange(&request_counts, "analyzeIntent");

    let claimed = claim(&actor, &kernel, &offer, 2);
    let report = published(actor.execute_claimed(&kernel, &claimed, 3).unwrap());
    assert_eq!(report.generation, 1);
    assert_eq!(
        classified_request_count(&request_counts, "buildValidateCandidate"),
        1
    );
    let candidate = classified_worker_exchange(&request_counts, "buildValidateCandidate");

    assert_exact_object_keys(
        &analyze.request,
        &[
            "protocolVersion",
            "requestId",
            "kind",
            "binding",
            "snapshot",
            "intent",
        ],
        "analyzeIntent request",
    );
    assert_exact_object_keys(
        &candidate.request,
        &[
            "protocolVersion",
            "requestId",
            "kind",
            "binding",
            "snapshot",
            "attemptId",
            "scopeFingerprint",
            "changeSet",
            "validationProfile",
        ],
        "buildValidateCandidate request",
    );
    for (label, request) in [
        ("analyzeIntent", &analyze.request),
        ("buildValidateCandidate", &candidate.request),
    ] {
        assert_exact_object_keys(
            &request["binding"],
            &["serviceEpoch", "graphGeneration", "graphDigest"],
            &format!("{label} binding"),
        );
        assert_eq!(request["binding"]["graphGeneration"], "0");
        assert_eq!(
            request["binding"]["graphDigest"]
                .as_str()
                .expect("opaque graph digest")
                .len(),
            64
        );
        assert!(
            request["binding"]["serviceEpoch"].as_str().is_some_and(
                |epoch| !epoch.is_empty() && epoch.bytes().all(|byte| byte.is_ascii_digit())
            ),
            "{label} must preserve the opaque service epoch"
        );
        assert_no_node_authority_keys(request, label);
        assert_request_omits_database_path(request, &database_path);
    }
    assert_eq!(analyze.request["binding"], candidate.request["binding"]);
    assert_eq!(candidate.request["attemptId"], claimed.attempt_id);
    assert_eq!(
        candidate.request["scopeFingerprint"],
        claimed.scope_fingerprint
    );
    assert_eq!(
        candidate.request["scopeFingerprint"]
            .as_str()
            .expect("opaque scope fingerprint")
            .len(),
        64
    );

    assert_exact_object_keys(
        &candidate.request["validationProfile"],
        &[
            "mode",
            "sourceRoot",
            "corpusRoot",
            "behavioralFixtures",
            "strictSrcOnlyTscScope",
        ],
        "candidate validation profile",
    );
    let source_root = candidate.request["validationProfile"]["sourceRoot"]
        .as_str()
        .expect("approved source root");
    let corpus_root = candidate.request["validationProfile"]["corpusRoot"]
        .as_str()
        .expect("approved corpus root");
    assert!(Path::new(source_root).ends_with("examples/medium/src"));
    assert!(Path::new(corpus_root).ends_with("examples/medium"));
    assert!(Path::new(source_root).starts_with(corpus_root));

    let analyze_modules = module_paths(&analyze.request);
    let candidate_modules = module_paths(&candidate.request);
    assert_eq!(analyze_modules, candidate_modules);
    assert_eq!(analyze_modules.len(), 22);
    assert!(
        analyze_modules
            .iter()
            .all(|module| Path::new(module).starts_with(source_root)),
        "the bounded source projection may carry only approved module paths"
    );
    assert_eq!(analyze.response["ok"], true);
    assert_eq!(candidate.response["ok"], true);
    assert_projected_typescript_green(&kernel.snapshot().snapshot());
}
