use strata_kernel::{
    ChangeSetRecord, ChangeSetState, CoordinationEvent, CoordinationEventKind,
    CoordinationFailpoint, CoordinationTicket, CreateDraftOutcome, DurableStore,
    DynamicExpansionPolicy, GraphSnapshot, IdempotencyClass, InferredScope, IntentParameters,
    IntentRecord, ResourceVersion, SCHEMA_VERSION, TicketState,
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
    let mut change_set = durable.change_set("change-set:one").unwrap().unwrap();
    change_set.state = ChangeSetState::Queued;
    change_set.inferred_scope = Some(scope());
    change_set.queue_sequence = Some(1);
    let ticket = CoordinationTicket::new(
        SCHEMA_VERSION,
        "ticket:one",
        "change-set:one",
        TicketState::Queued,
        "scope:clock-and-user",
        vec!["symbol:Clock".into()],
        1,
    )
    .unwrap();
    let event = CoordinationEvent::new(
        SCHEMA_VERSION,
        "event:queued:one",
        1,
        CoordinationEventKind::IntentQueued,
        "change-set:one",
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
        let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
        seed_graph_schema(&store);
        let durable = store.coordination();
        let mut original = draft("change-set:original", "submission:stable");
        original.state = state;
        assert_eq!(
            durable.create_draft(&original).unwrap(),
            CreateDraftOutcome::Created {
                change_set: original.clone()
            }
        );
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
    drop(redb::Database::create(&path).unwrap());

    let store = DurableStore::open(&path).unwrap();
    let counts = store.coordination().table_counts().unwrap();
    let metadata = store.coordination().metadata_state().unwrap();
    drop(store);

    let reopened = DurableStore::open(&path).unwrap();
    assert_eq!(reopened.coordination().table_counts().unwrap(), counts);
    assert_eq!(reopened.coordination().metadata_state().unwrap(), metadata);
    assert_eq!(metadata.next_queue_sequence, 1);
    assert_eq!(metadata.current_event_sequence, 0);
}
