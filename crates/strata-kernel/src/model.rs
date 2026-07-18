use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub id: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub child_index: Option<i64>,
    pub payload: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRecord {
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub schema_version: u32,
    pub generation: u64,
    pub nodes: Vec<NodeRecord>,
    pub references: Vec<ReferenceRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GraphChange {
    UpsertNode { node: NodeRecord },
    DeleteNode { node_id: String },
    UpsertReference { reference: ReferenceRecord },
    DeleteReference { from_node_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDelta {
    pub schema_version: u32,
    pub base_generation: u64,
    pub changes: Vec<GraphChange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub operation_id: String,
    pub change_set_id: String,
    pub actor: String,
    pub kind: String,
    pub reasoning: String,
    pub affected_node_ids: Vec<String>,
    /// Rename operations record the declaration's name transition so later
    /// fresh-decision reporting can name renamed symbols without re-deriving
    /// historic graph state. Absent on records written before this field.
    #[serde(default)]
    pub renames: Vec<OperationRename>,
    /// Typed per-intent parameters embedded at publication. Absent on records
    /// written before this field.
    #[serde(default)]
    pub intents: Vec<OperationIntentRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRename {
    pub node_id: String,
    pub from_name: String,
    pub to_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationIntentRecord {
    /// Intent kind, e.g. "RenameSymbol".
    pub kind: String,
    /// Canonical JSON of the typed intent parameters, embedded at publication
    /// so canonical history stays auditable without joining coordination tables.
    pub parameters_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRecord {
    pub ticket_id: String,
    pub state: String,
    pub scope_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub event_id: String,
    pub sequence: u64,
    pub kind: String,
    pub graph_generation: u64,
    pub payload_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceClaim {
    pub service_epoch: u64,
    pub resource_tokens: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub schema_version: u32,
    pub idempotency_key: String,
    pub delta: GraphDelta,
    pub operation: OperationRecord,
    pub ticket: TicketRecord,
    pub event: EventRecord,
    pub fence: FenceClaim,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_record_without_intents_field_deserializes_with_empty_intents() {
        let legacy = r#"{"operationId":"op-1","changeSetId":"cs-1","actor":"a",
            "kind":"RenameSymbol","reasoning":"r","affectedNodeIds":[],"renames":[]}"#;
        let record: OperationRecord = serde_json::from_str(legacy).unwrap();
        assert!(record.intents.is_empty());
    }

    #[test]
    fn operation_intent_record_round_trips_parameters_json() {
        let record = OperationIntentRecord {
            kind: "RenameSymbol".into(),
            parameters_json: r#"{"type":"renameSymbol","declarationId":"d","newName":"n"}"#.into(),
        };
        let json = serde_json::to_string(&record).unwrap();
        assert_eq!(
            serde_json::from_str::<OperationIntentRecord>(&json).unwrap(),
            record
        );
    }
}
