use std::collections::BTreeMap;
use std::path::Path;

use redb::{ReadableDatabase, ReadableTable, TableDefinition};
use strata_kernel::{GraphSnapshot, Kernel};
use tempfile::tempdir;

const GRAPH_META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
const COORDINATION_META: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_metadata");

fn fixture() -> GraphSnapshot {
    serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap()
}

fn metadata(path: &Path, table: TableDefinition<&str, &[u8]>) -> BTreeMap<String, Vec<u8>> {
    let database = redb::Database::open(path).unwrap();
    let read = database.begin_read().unwrap();
    let table = read.open_table(table).unwrap();
    table
        .iter()
        .unwrap()
        .map(|entry| {
            let (key, value) = entry.unwrap();
            (key.value().to_owned(), value.value().to_vec())
        })
        .collect()
}

#[test]
fn default_kernel_rejects_retained_version_corruption_without_writing() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture()).unwrap();
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut coordination = write.open_table(COORDINATION_META).unwrap();
        assert!(
            coordination
                .get("recovery_validation_version")
                .unwrap()
                .is_some()
        );
        coordination.remove("latest_lifecycle_revision").unwrap();
    }
    write.commit().unwrap();
    drop(database);
    let graph_before = metadata(&path, GRAPH_META);
    let coordination_before = metadata(&path, COORDINATION_META);

    let error = Kernel::open(&path)
        .err()
        .expect("default Kernel::open must run recovery integrity validation");
    assert!(error.to_string().contains("lifecycle marker"), "{error:#}");
    assert_eq!(metadata(&path, GRAPH_META), graph_before);
    assert_eq!(metadata(&path, COORDINATION_META), coordination_before);
}
