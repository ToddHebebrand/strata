#![cfg(feature = "redb-spike-api")]

use std::path::Path;

use redb::TableDefinition;
use strata_kernel::{
    ChangeSetRecord, ChangeSetState, CoordinationEvent, CoordinationEventKind,
    CoordinationFailpoint, CoordinationTicket, CreateDraftOutcome, DurableStore,
    DynamicExpansionPolicy, GraphGeneration, GraphSnapshot, IdempotencyClass, InferredScope,
    IntentParameters, IntentRecord, ResourceVersion, SCHEMA_VERSION, TicketState,
};
use tempfile::tempdir;

fn intent(intent_id: &str, change_set_id: &str, target: &str) -> IntentRecord {
    IntentRecord::new(
        SCHEMA_VERSION,
        intent_id,
        change_set_id,
        0,
        IntentParameters::RenameSymbol {
            declaration_id: target.into(),
            new_name: format!("{target}Renamed"),
        },
    )
    .unwrap()
}

fn draft(change_set_id: &str, key: &str) -> ChangeSetRecord {
    ChangeSetRecord::new(
        SCHEMA_VERSION,
        change_set_id,
        "agent:test",
        "coordinate two related renames",
        0,
        key,
        &[],
    )
    .unwrap()
}

fn seed_graph_schema(store: &DurableStore) {
    store
        .seed(&GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
        })
        .unwrap();
}

fn scope() -> InferredScope {
    InferredScope {
        read_set: vec![ResourceVersion::new("node:clock", "v0").unwrap()],
        write_set: vec![ResourceVersion::new("node:clock", "v0").unwrap()],
        validation_set: vec![ResourceVersion::new("module:time", "v0").unwrap()],
        reservation_keys: vec!["symbol:Clock".into()],
        scope_fingerprint: "scope:clock-and-user".into(),
        dynamic_expansion_policy: DynamicExpansionPolicy::NeedsDecision,
        idempotency_class: IdempotencyClass::RequiresDecision,
    }
}

fn queued_records(
    durable: &strata_kernel::CoordinationDurable<'_>,
) -> (ChangeSetRecord, CoordinationTicket, CoordinationEvent) {
    queued_records_for(
        durable,
        "change-set:one",
        "ticket:one",
        "event:queued:one",
        1,
    )
}

fn queued_records_for(
    durable: &strata_kernel::CoordinationDurable<'_>,
    change_set_id: &str,
    ticket_id: &str,
    event_id: &str,
    sequence: u64,
) -> (ChangeSetRecord, CoordinationTicket, CoordinationEvent) {
    let mut change_set = durable.change_set(change_set_id).unwrap().unwrap();
    change_set.state = ChangeSetState::Queued;
    change_set.inferred_scope = Some(scope());
    change_set.queue_sequence = Some(sequence);
    let ticket = CoordinationTicket::new(
        SCHEMA_VERSION,
        ticket_id,
        change_set_id,
        TicketState::Queued,
        "scope:clock-and-user",
        vec!["symbol:Clock".into()],
        sequence,
    )
    .unwrap();
    let event = CoordinationEvent::new(
        SCHEMA_VERSION,
        event_id,
        sequence,
        CoordinationEventKind::IntentQueued,
        change_set_id,
        0,
        "{}",
    )
    .unwrap();
    (change_set, ticket, event)
}

#[test]
fn coordination_lifecycle_round_trips_after_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&path).unwrap();
    seed_graph_schema(&store);
    let durable = store.coordination();

    let original_draft = draft("change-set:one", "submission:one");
    assert_eq!(
        durable.create_draft(&original_draft).unwrap(),
        CreateDraftOutcome::Created {
            change_set: original_draft
        }
    );
    let first = intent("intent:clock", "change-set:one", "Clock");
    let second = intent("intent:user", "change-set:one", "User");
    durable.append_intent(&first).unwrap();
    durable.append_intent(&second).unwrap();
    let (change_set, ticket, event) = queued_records(&durable);
    durable.submit(&change_set, &ticket, &event).unwrap();

    drop(store);
    let reopened = DurableStore::open(&path).unwrap();
    let durable = reopened.coordination();
    assert_eq!(
        durable.change_set("change-set:one").unwrap(),
        Some(change_set)
    );
    assert_eq!(
        durable.intents_for("change-set:one").unwrap(),
        vec![first, second]
    );
    assert_eq!(durable.active_tickets().unwrap(), vec![ticket]);
    assert!(durable.ready_offers().unwrap().is_empty());
    assert_eq!(durable.metadata_state().unwrap().next_queue_sequence, 2);
    assert_eq!(durable.metadata_state().unwrap().current_event_sequence, 1);
    assert_eq!(
        durable
            .submission_change_set_id("submission:one")
            .unwrap()
            .as_deref(),
        Some("change-set:one")
    );
    assert_eq!(durable.event(1).unwrap(), Some(event));
}

#[test]
fn submission_key_always_returns_the_current_original_change_set() {
    for state in [
        ChangeSetState::Draft,
        ChangeSetState::Queued,
        ChangeSetState::Ready,
        ChangeSetState::Executing,
        ChangeSetState::Committed,
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let store = DurableStore::create(&path).unwrap();
        seed_graph_schema(&store);
        let durable = store.coordination();
        let original_draft = draft("change-set:original", "submission:stable");
        assert_eq!(
            durable.create_draft(&original_draft).unwrap(),
            CreateDraftOutcome::Created {
                change_set: original_draft.clone()
            }
        );
        drop(store);

        let mut original = original_draft;
        original.state = state;
        overwrite_change_set_fixture(&path, &original);

        let store = DurableStore::open(&path).unwrap();
        let durable = store.coordination();
        let counts = durable.table_counts().unwrap();
        let metadata = durable.metadata_state().unwrap();

        let outcome = durable
            .create_draft(&draft("change-set:different", "submission:stable"))
            .unwrap();
        assert_eq!(
            outcome,
            CreateDraftOutcome::Duplicate {
                change_set: original
            }
        );
        assert_eq!(durable.table_counts().unwrap(), counts);
        assert_eq!(durable.metadata_state().unwrap(), metadata);
        assert!(!store.was_published("submission:stable").unwrap());
    }
}

#[test]
fn create_draft_rejects_every_non_pristine_new_record() {
    let mut cases = Vec::new();
    let mut record = draft("change-set:state", "submission:state");
    record.state = ChangeSetState::Queued;
    cases.push(record);
    let mut record = draft("change-set:intents", "submission:intents");
    record.intent_ids = vec!["intent:fabricated".into()];
    cases.push(record);
    let mut record = draft("change-set:scope", "submission:scope");
    record.inferred_scope = Some(scope());
    cases.push(record);
    let mut record = draft("change-set:queue", "submission:queue");
    record.queue_sequence = Some(1);
    cases.push(record);
    let mut record = draft("change-set:expansion", "submission:expansion");
    record.expansion_count = 1;
    cases.push(record);
    let mut record = draft("change-set:blocker", "submission:blocker");
    record.blocking_change_set_id = Some("change-set:blocker-source".into());
    cases.push(record);
    let mut record = draft("change-set:committed", "submission:committed");
    record.committed_generation = Some(1);
    cases.push(record);

    for invalid in cases {
        let directory = tempdir().unwrap();
        let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
        let durable = store.coordination();
        let error = durable.create_draft(&invalid).unwrap_err();
        assert!(error.to_string().contains("pristine Draft"));
        assert_eq!(durable.change_set(&invalid.change_set_id).unwrap(), None);
        assert_eq!(
            durable
                .submission_change_set_id(&invalid.submission_idempotency_key)
                .unwrap(),
            None
        );
    }
}

#[test]
fn submit_rejects_fabricated_transition_owned_fields() {
    for case in 0..7 {
        let directory = tempdir().unwrap();
        let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
        seed_graph_schema(&store);
        let durable = store.coordination();
        durable
            .create_draft(&draft("change-set:one", "submission:one"))
            .unwrap();
        durable
            .append_intent(&intent("intent:one", "change-set:one", "Clock"))
            .unwrap();
        let (mut change_set, mut ticket, mut event) = queued_records(&durable);
        match case {
            0 => change_set.expansion_count = 1,
            1 => change_set.blocking_change_set_id = Some("change-set:blocker".into()),
            2 => change_set.committed_generation = Some(1),
            3 => ticket.age_rounds = 1,
            4 => ticket.ready_offer_id = Some("offer:fabricated".into()),
            5 => ticket.active_claim_id = Some("claim:fabricated".into()),
            6 => event.graph_generation = 1,
            _ => unreachable!(),
        }
        let counts = durable.table_counts().unwrap();
        let metadata = durable.metadata_state().unwrap();

        let error = durable.submit(&change_set, &ticket, &event).unwrap_err();
        assert!(error.to_string().contains("canonical Draft-to-Queued"));
        assert_eq!(durable.table_counts().unwrap(), counts);
        assert_eq!(durable.metadata_state().unwrap(), metadata);
    }
}

#[test]
fn event_ids_are_unique_across_sequences() {
    let directory = tempdir().unwrap();
    let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
    seed_graph_schema(&store);
    let durable = store.coordination();
    durable
        .create_draft(&draft("change-set:one", "submission:one"))
        .unwrap();
    durable
        .append_intent(&intent("intent:one", "change-set:one", "Clock"))
        .unwrap();
    let (first_change_set, first_ticket, first_event) = queued_records(&durable);
    durable
        .submit(&first_change_set, &first_ticket, &first_event)
        .unwrap();

    durable
        .create_draft(&draft("change-set:two", "submission:two"))
        .unwrap();
    durable
        .append_intent(&intent("intent:two", "change-set:two", "User"))
        .unwrap();
    let (second_change_set, second_ticket, second_event) = queued_records_for(
        &durable,
        "change-set:two",
        "ticket:two",
        &first_event.event_id,
        2,
    );
    let counts = durable.table_counts().unwrap();
    let metadata = durable.metadata_state().unwrap();

    let error = durable
        .submit(&second_change_set, &second_ticket, &second_event)
        .unwrap_err();
    assert!(error.to_string().contains("event ID already exists"));
    assert_eq!(durable.table_counts().unwrap(), counts);
    assert_eq!(durable.metadata_state().unwrap(), metadata);
    assert_eq!(durable.event(2).unwrap(), None);
}

#[test]
fn failed_submit_rolls_back_every_coordination_write() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&path).unwrap();
    seed_graph_schema(&store);
    let durable = store.coordination();
    durable
        .create_draft(&draft("change-set:one", "submission:one"))
        .unwrap();
    durable
        .append_intent(&intent("intent:clock", "change-set:one", "Clock"))
        .unwrap();
    let (mut change_set, ticket, event) = queued_records(&durable);
    change_set.intent_ids = vec!["intent:clock".into()];
    let counts_before = durable.table_counts().unwrap();
    let metadata_before = durable.metadata_state().unwrap();

    let error = durable
        .submit_with_failpoint(
            &change_set,
            &ticket,
            &event,
            CoordinationFailpoint::BeforeCommit,
        )
        .unwrap_err();
    assert!(error.to_string().contains("coordination failpoint"));
    drop(store);

    let reopened = DurableStore::open(&path).unwrap();
    let durable = reopened.coordination();
    assert_eq!(durable.table_counts().unwrap(), counts_before);
    assert_eq!(durable.metadata_state().unwrap(), metadata_before);
    assert_eq!(
        durable.change_set("change-set:one").unwrap().unwrap().state,
        ChangeSetState::Draft
    );
    assert!(durable.active_tickets().unwrap().is_empty());
    assert_eq!(durable.event(1).unwrap(), None);
    assert_eq!(
        durable
            .submission_change_set_id("submission:one")
            .unwrap()
            .as_deref(),
        Some("change-set:one")
    );
    assert!(!reopened.was_published("submission:one").unwrap());
}

#[test]
fn failed_draft_creation_rolls_back_its_idempotency_mapping() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&path).unwrap();
    let durable = store.coordination();
    let counts_before = durable.table_counts().unwrap();
    let metadata_before = durable.metadata_state().unwrap();

    let error = durable
        .create_draft_with_failpoint(
            &draft("change-set:failed", "submission:failed"),
            CoordinationFailpoint::BeforeCommit,
        )
        .unwrap_err();
    assert!(error.to_string().contains("coordination failpoint"));
    drop(store);

    let reopened = DurableStore::open(&path).unwrap();
    let durable = reopened.coordination();
    assert_eq!(durable.table_counts().unwrap(), counts_before);
    assert_eq!(durable.metadata_state().unwrap(), metadata_before);
    assert_eq!(durable.change_set("change-set:failed").unwrap(), None);
    assert_eq!(
        durable
            .submission_change_set_id("submission:failed")
            .unwrap(),
        None
    );
}

#[test]
fn opening_a_pre_coordination_database_upgrades_schema_idempotently() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("legacy.redb");
    let snapshot = seed_prior_spike_database(&path);

    let store = DurableStore::open(&path).unwrap();
    assert_eq!(store.current_generation().unwrap(), 0);
    assert_eq!(store.latest_snapshot().unwrap(), snapshot);
    assert_eq!(
        store.generation_digest(0).unwrap(),
        GraphGeneration::from_snapshot(snapshot.clone())
            .unwrap()
            .digest()
    );
    let counts = store.coordination().table_counts().unwrap();
    let metadata = store.coordination().metadata_state().unwrap();
    drop(store);

    let reopened = DurableStore::open(&path).unwrap();
    assert_eq!(reopened.coordination().table_counts().unwrap(), counts);
    assert_eq!(reopened.coordination().metadata_state().unwrap(), metadata);
    assert_eq!(metadata.next_queue_sequence, 1);
    assert_eq!(metadata.current_event_sequence, 0);
}

const RAW_CHANGE_SETS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_change_sets");
const GRAPH_META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");
const OPERATIONS: TableDefinition<u64, &[u8]> = TableDefinition::new("operations");
const DELTAS: TableDefinition<u64, &[u8]> = TableDefinition::new("deltas");
const GRAPH_EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("events");
const GRAPH_TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("tickets");
const GRAPH_IDEMPOTENCY: TableDefinition<&str, u64> = TableDefinition::new("idempotency_keys");
const FENCES: TableDefinition<&str, u64> = TableDefinition::new("fence_tokens");
const CONSUMED_FENCES: TableDefinition<&str, u64> = TableDefinition::new("consumed_fence_tokens");
const GENERATION_DIGESTS: TableDefinition<u64, &str> = TableDefinition::new("generation_digests");

fn overwrite_change_set_fixture(path: &Path, record: &ChangeSetRecord) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    let bytes = serde_json::to_vec(record).unwrap();
    write
        .open_table(RAW_CHANGE_SETS)
        .unwrap()
        .insert(record.change_set_id.as_str(), bytes.as_slice())
        .unwrap();
    write.commit().unwrap();
}

fn seed_prior_spike_database(path: &Path) -> GraphSnapshot {
    let snapshot = GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![],
        references: vec![],
    };
    let digest = GraphGeneration::from_snapshot(snapshot.clone())
        .unwrap()
        .digest()
        .to_owned();
    let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
    let database = redb::Database::create(path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut metadata = write.open_table(GRAPH_META).unwrap();
        let zero = 0_u64.to_le_bytes();
        metadata
            .insert("current_generation", zero.as_slice())
            .unwrap();
        metadata
            .insert("current_event_sequence", zero.as_slice())
            .unwrap();
        metadata.insert("service_epoch", zero.as_slice()).unwrap();
    }
    write
        .open_table(SNAPSHOTS)
        .unwrap()
        .insert(0, snapshot_bytes.as_slice())
        .unwrap();
    write
        .open_table(GENERATION_DIGESTS)
        .unwrap()
        .insert(0, digest.as_str())
        .unwrap();
    drop(write.open_table(OPERATIONS).unwrap());
    drop(write.open_table(DELTAS).unwrap());
    drop(write.open_table(GRAPH_EVENTS).unwrap());
    drop(write.open_table(GRAPH_TICKETS).unwrap());
    drop(write.open_table(GRAPH_IDEMPOTENCY).unwrap());
    drop(write.open_table(FENCES).unwrap());
    drop(write.open_table(CONSUMED_FENCES).unwrap());
    write.commit().unwrap();
    snapshot
}
