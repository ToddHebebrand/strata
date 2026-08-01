//! Task 3: kernel-level discovery query methods — `list_modules`,
//! `list_module_declarations`, scoped `find_declarations`, and
//! `incoming_references`. Fixtures are built directly as `GraphSnapshot`s
//! (no ingest, no bridge) following the pattern in `graph_generation.rs` /
//! `coordination_resources.rs`.

use strata_kernel::{
    DeclarationMatch, GraphSnapshot, IncomingReference, Kernel, MAX_DECLARATION_MATCHES,
    MAX_MODULE_DECLARATION_PAGE_ITEMS, MAX_MODULE_PAGE_ITEMS, MAX_REFERENCE_PAGE_ITEMS,
    ModuleDeclarationEntry, ModuleEntry, NodeRecord, ReferenceRecord, SCHEMA_VERSION,
};
use tempfile::TempDir;

/// Three-module fixture shared by most tests here.
///
/// `module:a` children: `stmt:a1` (`FunctionDeclaration`, `export function
/// alpha() {}`, with identifier child `ident:a1name` carrying the exact
/// `{"text":"alpha","offset":16}` name-token convention `declaration_name_token`
/// expects — "export function " is 16 bytes/utf16 units), `stmt:a2`
/// (`FirstStatement`, `const x = 1;`, deliberately no identifier child so its
/// name resolves to `None`), `stmt:a3` (`ExpressionStatement`, must be
/// excluded from both counts and listings — it is not a discovery kind).
///
/// `module:b`/`module:c` each hold one or more `ExpressionStatement` nodes
/// that reference `ident:a1name` directly (matching real ingest, which always
/// targets a declaration's name-identifier child, never the statement node).
/// One additional reference runs `stmt:a1 -> ident:a1name`, i.e. from a node
/// INSIDE `stmt:a1`'s own subtree, to exercise subtree-exclusion.
fn three_module_snapshot() -> GraphSnapshot {
    let module = |id: &str, path: &str| NodeRecord {
        id: id.into(),
        kind: "Module".into(),
        parent_id: None,
        child_index: None,
        payload: path.into(),
    };
    let stmt = |id: &str, kind: &str, parent: &str, index: i64, payload: &str| NodeRecord {
        id: id.into(),
        kind: kind.into(),
        parent_id: Some(parent.into()),
        child_index: Some(index),
        payload: payload.into(),
    };
    let identifier = |id: &str, parent: &str, text: &str, offset: u64| NodeRecord {
        id: id.into(),
        kind: "Identifier".into(),
        parent_id: Some(parent.into()),
        child_index: Some(0),
        payload: serde_json::json!({ "text": text, "offset": offset }).to_string(),
    };
    let reference = |from: &str, to: &str| ReferenceRecord {
        from_node_id: from.into(),
        to_node_id: to.into(),
        kind: "symbol".into(),
    };

    GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![
            module("module:a", "src/a.ts"),
            module("module:b", "src/b.ts"),
            module("module:c", "src/c.ts"),
            stmt(
                "stmt:a1",
                "FunctionDeclaration",
                "module:a",
                0,
                "export function alpha() {}",
            ),
            identifier("ident:a1name", "stmt:a1", "alpha", 16),
            stmt("stmt:a2", "FirstStatement", "module:a", 1, "const x = 1;"),
            stmt(
                "stmt:a3",
                "ExpressionStatement",
                "module:a",
                2,
                "alpha();",
            ),
            stmt("stmt:b1", "ExpressionStatement", "module:b", 0, "alpha();"),
            stmt("stmt:c1", "ExpressionStatement", "module:c", 0, "alpha();"),
            stmt("stmt:c2", "ExpressionStatement", "module:c", 1, "alpha();"),
        ],
        references: vec![
            reference("stmt:b1", "ident:a1name"),
            reference("stmt:c1", "ident:a1name"),
            reference("stmt:c2", "ident:a1name"),
            // Inside stmt:a1's own subtree — must be EXCLUDED by
            // incoming_references("stmt:a1", ...).
            reference("stmt:a1", "ident:a1name"),
        ],
    }
}

fn kernel_with(snapshot: GraphSnapshot) -> (Kernel, TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, snapshot).unwrap();
    (kernel, directory)
}

#[test]
fn list_modules_pages_deterministically_in_id_order() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());

    let (generation_first, first_page, has_more_first) =
        kernel.list_modules(None, 2).unwrap();
    assert_eq!(
        first_page.iter().map(|m| m.module_id.as_str()).collect::<Vec<_>>(),
        vec!["module:a", "module:b"]
    );
    assert!(has_more_first);

    let (generation_second, second_page, has_more_second) = kernel
        .list_modules(Some(first_page.last().unwrap().module_id.as_str()), 2)
        .unwrap();
    assert_eq!(
        second_page.iter().map(|m| m.module_id.as_str()).collect::<Vec<_>>(),
        vec!["module:c"]
    );
    assert!(!has_more_second);
    assert_eq!(generation_first, generation_second);

    let mut walked: Vec<ModuleEntry> = first_page;
    walked.extend(second_page);

    let (_, single_page, has_more_single) =
        kernel.list_modules(None, MAX_MODULE_PAGE_ITEMS).unwrap();
    assert!(!has_more_single);
    assert_eq!(walked, single_page);

    // Repeating both walks is deterministic.
    let (_, repeat_first, repeat_has_more_first) = kernel.list_modules(None, 2).unwrap();
    assert_eq!(repeat_first, walked[..2]);
    assert!(repeat_has_more_first);
    let (_, repeat_single, _) = kernel.list_modules(None, MAX_MODULE_PAGE_ITEMS).unwrap();
    assert_eq!(repeat_single, single_page);
}

#[test]
fn list_modules_counts_only_discovery_statement_kinds() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());
    let (_, modules, _) = kernel.list_modules(None, MAX_MODULE_PAGE_ITEMS).unwrap();
    let module_a = modules.iter().find(|m| m.module_id == "module:a").unwrap();
    assert_eq!(module_a.declaration_count, 2, "stmt:a3 must be excluded");
}

#[test]
fn list_modules_rejects_out_of_bound_limits() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());
    assert!(kernel.list_modules(None, 0).is_err());
    assert!(kernel.list_modules(None, MAX_MODULE_PAGE_ITEMS + 1).is_err());
}

#[test]
fn list_module_declarations_lists_names_export_flags_and_nulls() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());
    let (_, declarations, has_more) = kernel
        .list_module_declarations("module:a", None, MAX_MODULE_DECLARATION_PAGE_ITEMS)
        .unwrap();
    assert!(!has_more);
    assert_eq!(
        declarations,
        vec![
            ModuleDeclarationEntry {
                node_id: "stmt:a1".into(),
                name: Some("alpha".into()),
                kind: "FunctionDeclaration".into(),
                exported: true,
            },
            ModuleDeclarationEntry {
                node_id: "stmt:a2".into(),
                name: None,
                kind: "FirstStatement".into(),
                exported: false,
            },
        ]
    );
    assert!(
        declarations.iter().all(|d| d.node_id != "stmt:a3"),
        "ExpressionStatement must never be listed"
    );

    // Cursor walk (limit 1) must equal the full page.
    let (_, page_one, more_one) = kernel.list_module_declarations("module:a", None, 1).unwrap();
    assert!(more_one);
    assert_eq!(page_one.len(), 1);
    let (_, page_two, more_two) = kernel
        .list_module_declarations("module:a", Some(page_one[0].node_id.as_str()), 1)
        .unwrap();
    assert!(!more_two);
    let mut walked = page_one;
    walked.extend(page_two);
    assert_eq!(walked, declarations);
}

#[test]
fn list_module_declarations_rejects_non_module_target() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());
    assert!(
        kernel
            .list_module_declarations("stmt:a1", None, 10)
            .is_err()
    );
    assert!(
        kernel
            .list_module_declarations("does:not:exist", None, 10)
            .is_err()
    );
}

/// Mirrors `isExportedPayload` in `packages/store/src/discovery.ts`
/// byte-for-byte, tested indirectly through `list_module_declarations`'s
/// `exported` field since `is_exported_payload` is `pub(crate)`.
#[test]
fn exported_payload_parity_with_product_discovery() {
    let module = NodeRecord {
        id: "module:parity".into(),
        kind: "Module".into(),
        parent_id: None,
        child_index: None,
        payload: "src/parity.ts".into(),
    };
    let cases: [(&str, &str, bool); 6] = [
        (
            "parity:01",
            "// comment\nexport const p1 = 1;",
            true,
        ),
        ("parity:02", "/* block */ export const p2 = 2;", true),
        (
            "parity:03",
            "/* unterminated comment export const p3 = 3;",
            false,
        ),
        (
            "parity:04",
            "// no trailing newline export",
            false,
        ),
        ("parity:05", "exports.foo = 1;", true),
        (
            "parity:06",
            "   \n\t export const p6 = 6;",
            true,
        ),
    ];
    let mut nodes = vec![module];
    for (index, (id, payload, _)) in cases.iter().enumerate() {
        nodes.push(NodeRecord {
            id: (*id).into(),
            kind: "FirstStatement".into(),
            parent_id: Some("module:parity".into()),
            child_index: Some(i64::try_from(index).unwrap()),
            payload: (*payload).into(),
        });
    }
    let snapshot = GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes,
        references: vec![],
    };
    let (kernel, _dir) = kernel_with(snapshot);
    let (_, declarations, has_more) = kernel
        .list_module_declarations("module:parity", None, MAX_MODULE_DECLARATION_PAGE_ITEMS)
        .unwrap();
    assert!(!has_more);
    assert_eq!(declarations.len(), cases.len());
    for ((id, _, expected_exported), entry) in cases.iter().zip(declarations.iter()) {
        assert_eq!(entry.node_id, *id, "unexpected ordering");
        assert_eq!(
            entry.exported, *expected_exported,
            "payload {:?} exported mismatch",
            id
        );
    }
}

/// 70 same-named `FunctionDeclaration`s across 70 modules, zero-padded so
/// lexicographic node-id order matches numeric order. Exercises the old
/// `ensure!`-bail-past-64 path, now a page.
fn seventy_declarations_snapshot() -> GraphSnapshot {
    let mut nodes = Vec::new();
    for index in 0..70 {
        let module_id = format!("gen:module:{index:03}");
        let decl_id = format!("gen:decl:{index:03}");
        let ident_id = format!("gen:ident:{index:03}");
        nodes.push(NodeRecord {
            id: module_id.clone(),
            kind: "Module".into(),
            parent_id: None,
            child_index: None,
            payload: format!("src/gen{index:03}.ts"),
        });
        nodes.push(NodeRecord {
            id: decl_id.clone(),
            kind: "FunctionDeclaration".into(),
            parent_id: Some(module_id),
            child_index: Some(0),
            payload: "export function shared() {}".into(),
        });
        nodes.push(NodeRecord {
            id: ident_id,
            kind: "Identifier".into(),
            parent_id: Some(decl_id),
            child_index: Some(0),
            payload: serde_json::json!({ "text": "shared", "offset": 16 }).to_string(),
        });
    }
    GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes,
        references: vec![],
    }
}

#[test]
fn find_declarations_pages_instead_of_failing_past_64() {
    let (kernel, _dir) = kernel_with(seventy_declarations_snapshot());

    let (generation_first, first_page, has_more_first) = kernel
        .find_declarations("shared", Some("function"), None, None)
        .unwrap();
    assert_eq!(first_page.len(), MAX_DECLARATION_MATCHES);
    assert!(has_more_first);
    assert!(first_page.windows(2).all(|pair| pair[0].node_id < pair[1].node_id));

    let cursor = first_page.last().unwrap().node_id.clone();
    let (generation_second, second_page, has_more_second) = kernel
        .find_declarations("shared", Some("function"), None, Some(cursor.as_str()))
        .unwrap();
    assert_eq!(second_page.len(), 70 - MAX_DECLARATION_MATCHES);
    assert!(!has_more_second);
    assert_eq!(generation_first, generation_second);

    let mut all: Vec<DeclarationMatch> = first_page;
    all.extend(second_page);
    assert_eq!(all.len(), 70);
    let mut ids: Vec<&str> = all.iter().map(|m| m.node_id.as_str()).collect();
    let mut sorted_ids = ids.clone();
    sorted_ids.sort_unstable();
    assert_eq!(ids, sorted_ids, "must be id-ascending");
    ids.dedup();
    assert_eq!(ids.len(), 70, "all 70 must be unique");
}

#[test]
fn find_declarations_module_scope_filters_to_one_module() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());

    let (_, scoped_to_a, has_more_a) = kernel
        .find_declarations("alpha", Some("function"), Some("module:a"), None)
        .unwrap();
    assert_eq!(scoped_to_a.len(), 1);
    assert_eq!(scoped_to_a[0].node_id, "stmt:a1");
    assert!(!has_more_a);

    let (_, scoped_to_b, _) = kernel
        .find_declarations("alpha", Some("function"), Some("module:b"), None)
        .unwrap();
    assert!(scoped_to_b.is_empty());

    let (_, global, _) = kernel
        .find_declarations("alpha", Some("function"), None, None)
        .unwrap();
    assert_eq!(global, scoped_to_a, "global behavior unchanged");
}

#[test]
fn incoming_references_aggregate_subtree_and_page_by_from_node_id() {
    let (kernel, _dir) = kernel_with(three_module_snapshot());

    // `incoming_references` aggregates over the subtree rooted at
    // "stmt:a1" — the references actually target "ident:a1name" (its
    // child), never the statement node itself, matching real ingest.
    let (generation, full_page, has_more_full) = kernel
        .incoming_references("stmt:a1", None, MAX_REFERENCE_PAGE_ITEMS)
        .unwrap();
    assert!(!has_more_full);
    let from_ids: Vec<&str> = full_page.iter().map(|r| r.from_node_id.as_str()).collect();
    assert_eq!(from_ids, vec!["stmt:b1", "stmt:c1", "stmt:c2"]);
    assert!(
        full_page.iter().all(|r| r.from_node_id != "stmt:a1"),
        "in-subtree reference must be excluded"
    );
    for entry in &full_page {
        let expected_module = if entry.from_node_id == "stmt:b1" {
            "module:b"
        } else {
            "module:c"
        };
        assert_eq!(entry.module_id, expected_module);
        assert_eq!(entry.kind, "symbol");
    }

    // limit 2 + cursor walk equals the full page.
    let (_, page_one, has_more_one) = kernel.incoming_references("stmt:a1", None, 2).unwrap();
    assert!(has_more_one);
    assert_eq!(page_one.len(), 2);
    let (_, page_two, has_more_two) = kernel
        .incoming_references(
            "stmt:a1",
            Some(page_one.last().unwrap().from_node_id.as_str()),
            2,
        )
        .unwrap();
    assert!(!has_more_two);
    let mut walked: Vec<IncomingReference> = page_one;
    walked.extend(page_two);
    assert_eq!(walked, full_page);
    let _ = generation;

    assert!(kernel.incoming_references("does:not:exist", None, 10).is_err());
    assert!(kernel.incoming_references("stmt:a1", None, 0).is_err());
    assert!(
        kernel
            .incoming_references("stmt:a1", None, MAX_REFERENCE_PAGE_ITEMS + 1)
            .is_err()
    );
}

#[test]
fn incoming_references_fails_closed_on_broken_parent_chain() {
    let snapshot = GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![
            NodeRecord {
                id: "module:root".into(),
                kind: "Module".into(),
                parent_id: None,
                child_index: None,
                payload: "src/root.ts".into(),
            },
            NodeRecord {
                id: "target:main".into(),
                kind: "FunctionDeclaration".into(),
                parent_id: Some("module:root".into()),
                child_index: Some(0),
                payload: "export function main() {}".into(),
            },
            // Parent chain points at a node ID that does not exist in the
            // graph — the referrer's root module cannot be resolved.
            NodeRecord {
                id: "orphan:from".into(),
                kind: "ExpressionStatement".into(),
                parent_id: Some("missing:parent".into()),
                child_index: Some(0),
                payload: "main();".into(),
            },
        ],
        references: vec![ReferenceRecord {
            from_node_id: "orphan:from".into(),
            to_node_id: "target:main".into(),
            kind: "symbol".into(),
        }],
    };
    let (kernel, _dir) = kernel_with(snapshot);
    let error = kernel
        .incoming_references("target:main", None, MAX_REFERENCE_PAGE_ITEMS)
        .unwrap_err();
    assert!(
        error.to_string().contains("missing:parent"),
        "{error}"
    );
}
