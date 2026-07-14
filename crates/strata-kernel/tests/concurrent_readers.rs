use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use strata_kernel::{
    EventRecord, FenceClaim, GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, Kernel,
    NodeRecord, OperationRecord, Publication, SCHEMA_VERSION, TicketRecord,
};
use tempfile::tempdir;

const READER_COUNT: usize = 8;
const OBSERVATION_DEADLINE: Duration = Duration::from_secs(15);

struct StopReaders(Arc<AtomicBool>);

impl Drop for StopReaders {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn wait_for_all_readers(
    observations: &mpsc::Receiver<(usize, u64)>,
    target_generation: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + OBSERVATION_DEADLINE;
    let mut readers = BTreeSet::new();
    while readers.len() < READER_COUNT {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "timed out waiting for every reader to observe generation {target_generation}; observed readers {readers:?}"
            ));
        }
        let (reader_id, generation) = observations.recv_timeout(remaining).map_err(|error| {
            format!(
                "failed waiting for every reader to observe generation {target_generation}: {error}; observed readers {readers:?}"
            )
        })?;
        if generation == target_generation {
            readers.insert(reader_id);
        }
    }
    Ok(())
}

fn fixture() -> GraphSnapshot {
    serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap()
}

fn publication(generation: u64, changed_node: NodeRecord) -> Publication {
    let next_generation = generation + 1;
    Publication {
        schema_version: SCHEMA_VERSION,
        idempotency_key: format!("reader-proof:{next_generation}"),
        delta: GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: generation,
            changes: vec![GraphChange::UpsertNode {
                node: changed_node.clone(),
            }],
        },
        operation: OperationRecord {
            operation_id: format!("operation:reader-proof:{next_generation}"),
            change_set_id: format!("change-set:reader-proof:{next_generation}"),
            actor: "reader-proof".into(),
            kind: "RenameSymbol".into(),
            reasoning: "prove immutable readers during publication".into(),
            affected_node_ids: vec![changed_node.id],
        },
        ticket: TicketRecord {
            ticket_id: format!("ticket:reader-proof:{next_generation}"),
            state: "committed".into(),
            scope_fingerprint: "symbol:reader-proof".into(),
        },
        event: EventRecord {
            event_id: format!("event:reader-proof:{next_generation}"),
            sequence: next_generation,
            kind: "IntentCommitted".into(),
            graph_generation: next_generation,
            payload_json: "{}".into(),
        },
        fence: FenceClaim {
            service_epoch: 0,
            resource_tokens: BTreeMap::new(),
        },
    }
}

#[test]
fn eight_readers_never_observe_a_torn_generation() {
    let initial = fixture();
    let original_node_ids: BTreeSet<String> =
        initial.nodes.iter().map(|node| node.id.clone()).collect();
    let mut changed_node = initial
        .nodes
        .iter()
        .find(|node| node.kind == "Identifier")
        .unwrap()
        .clone();

    let mut expected_graph = GraphGeneration::from_snapshot(initial.clone()).unwrap();
    let mut expected_pairs = BTreeSet::from([(
        expected_graph.generation(),
        expected_graph.digest().to_owned(),
    )]);
    let mut publications = Vec::new();
    for generation in 0..25_u64 {
        changed_node.payload = format!(r#"{{"text":"ReaderProof{generation}","offset":0}}"#);
        let publication = publication(generation, changed_node.clone());
        expected_graph = expected_graph.apply(&publication.delta).unwrap();
        expected_pairs.insert((
            expected_graph.generation(),
            expected_graph.digest().to_owned(),
        ));
        publications.push(publication);
    }
    assert_eq!(expected_pairs.len(), 26);

    let directory = tempdir().unwrap();
    let database = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(database, initial).unwrap();
    let kernel = Arc::new(kernel);
    let expected_pairs = Arc::new(expected_pairs);
    let original_node_ids = Arc::new(original_node_ids);
    let stop = Arc::new(AtomicBool::new(false));
    let _stop_readers = StopReaders(Arc::clone(&stop));
    let (observation_tx, observation_rx) = mpsc::channel();

    let readers: Vec<_> = (0..READER_COUNT)
        .map(|reader_id| {
            let kernel = Arc::clone(&kernel);
            let expected_pairs = Arc::clone(&expected_pairs);
            let original_node_ids = Arc::clone(&original_node_ids);
            let stop = Arc::clone(&stop);
            let observation_tx = observation_tx.clone();
            thread::spawn(move || {
                let mut observed = Vec::new();
                let mut reported_generations = BTreeSet::new();
                loop {
                    let live = kernel.snapshot();
                    let materialized = live.snapshot();
                    let pair = (live.generation(), live.digest().to_owned());
                    assert!(expected_pairs.contains(&pair), "torn pair: {pair:?}");

                    let node_ids: BTreeSet<String> = materialized
                        .nodes
                        .iter()
                        .map(|node| node.id.clone())
                        .collect();
                    assert_eq!(node_ids, *original_node_ids, "missing or extra graph node");
                    assert!(materialized.references.iter().all(|reference| {
                        node_ids.contains(&reference.from_node_id)
                            && node_ids.contains(&reference.to_node_id)
                    }));
                    observed.push(pair);
                    if reported_generations.insert(live.generation()) {
                        let _ = observation_tx.send((reader_id, live.generation()));
                    }

                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    thread::yield_now();
                }
                observed
            })
        })
        .collect();
    drop(observation_tx);

    wait_for_all_readers(&observation_rx, 0).unwrap();

    let mut publications = publications.into_iter();
    let mut first = publications.next().unwrap();
    first.fence = kernel.issue_fence(&["symbol:reader-proof".into()]).unwrap();
    kernel.publish(first).unwrap();
    wait_for_all_readers(&observation_rx, 1).unwrap();

    for mut publication in publications {
        publication.fence = kernel.issue_fence(&["symbol:reader-proof".into()]).unwrap();
        kernel.publish(publication).unwrap();
        thread::yield_now();
    }
    wait_for_all_readers(&observation_rx, 25).unwrap();
    stop.store(true, Ordering::Release);

    for reader in readers {
        let observed = reader.join().unwrap();
        assert!(!observed.is_empty());
        assert!(observed.iter().all(|pair| expected_pairs.contains(pair)));
        let observed_generations: BTreeSet<u64> =
            observed.iter().map(|(generation, _)| *generation).collect();
        assert!(observed_generations.contains(&0));
        assert!(observed_generations.contains(&1));
        assert!(observed_generations.contains(&25));
    }
    assert_eq!(kernel.snapshot().generation(), 25);
}
