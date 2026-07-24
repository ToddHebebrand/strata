//! Canonical sync digest for daemon↔worker mirror attestation (bridge
//! persistence slice, Task 2).
//!
//! The digest must be byte-identical with the Node worker's
//! `packages/kernel-bridge/src/sync-digest.ts`, so the encoded byte string is
//! assembled by an EXPLICIT writer — never by serializing a whole struct —
//! keeping the encoding independent of any serializer's object-key behavior.
//! Only individual string values delegate to `serde_json::to_string`, whose
//! RFC 8259 minimal escaping matches `JSON.stringify` on the shared domain of
//! valid Unicode strings (proven by the pinned fixture vectors and the
//! randomized cross-language differential test below).
//!
//! This digest exists for sync attestation only; `GraphGeneration::digest`
//! is a different encoding and stays untouched.

use crate::model::{NodeRecord, ReferenceRecord};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// Lowercase-hex SHA-256 over the canonical encoding
/// `{"schema":1,"generation":"<decimal-u64>","nodes":[...],"references":[...]}`:
/// - nodes sorted by id (byte-wise over UTF-8 — Rust `str` `Ord`, made
///   explicit via `as_bytes`; the TS side compares UTF-8 encodings, never
///   UTF-16 code units), each as `[id,kind,parentId|null,childIndex|null,payload]`
/// - references sorted by (fromNodeId, toNodeId) byte-wise, each as
///   `[fromNodeId,toNodeId,kind]`
/// - generation and childIndex as plain decimal, null literal for absent
///   values, no whitespace anywhere.
///
/// Input slices may arrive in any order; sorting here is part of the contract.
pub fn canonical_sync_digest(
    generation: u64,
    nodes: &[NodeRecord],
    references: &[ReferenceRecord],
) -> String {
    let mut sorted_nodes: Vec<&NodeRecord> = nodes.iter().collect();
    sorted_nodes.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
    let mut sorted_references: Vec<&ReferenceRecord> = references.iter().collect();
    sorted_references.sort_by(|a, b| {
        a.from_node_id
            .as_bytes()
            .cmp(b.from_node_id.as_bytes())
            .then_with(|| a.to_node_id.as_bytes().cmp(b.to_node_id.as_bytes()))
    });

    let mut encoded = String::new();
    encoded.push_str("{\"schema\":1,\"generation\":\"");
    write!(&mut encoded, "{generation}").expect("writing to a String cannot fail");
    encoded.push_str("\",\"nodes\":[");
    for (index, node) in sorted_nodes.iter().enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push('[');
        push_json_string(&mut encoded, &node.id);
        encoded.push(',');
        push_json_string(&mut encoded, &node.kind);
        encoded.push(',');
        match node.parent_id.as_deref() {
            Some(parent_id) => push_json_string(&mut encoded, parent_id),
            None => encoded.push_str("null"),
        }
        encoded.push(',');
        match node.child_index {
            Some(child_index) => {
                write!(&mut encoded, "{child_index}").expect("writing to a String cannot fail")
            }
            None => encoded.push_str("null"),
        }
        encoded.push(',');
        push_json_string(&mut encoded, &node.payload);
        encoded.push(']');
    }
    encoded.push_str("],\"references\":[");
    for (index, reference) in sorted_references.iter().enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push('[');
        push_json_string(&mut encoded, &reference.from_node_id);
        encoded.push(',');
        push_json_string(&mut encoded, &reference.to_node_id);
        encoded.push(',');
        push_json_string(&mut encoded, &reference.kind);
        encoded.push(']');
    }
    encoded.push_str("]}");

    let hash = Sha256::digest(encoded.as_bytes());
    let mut digest = String::with_capacity(hash.len() * 2);
    for byte in hash {
        write!(&mut digest, "{byte:02x}").expect("writing to a String cannot fail");
    }
    digest
}

/// The ONLY place the standard serializer participates: escaping one string
/// value. `serde_json` and `JSON.stringify` both emit RFC 8259 minimal
/// escaping on valid Unicode strings, which the shared vectors prove hostile
/// case by hostile case.
fn push_json_string(encoded: &mut String, value: &str) {
    encoded.push_str(
        &serde_json::to_string(value).expect("JSON-encoding a string value cannot fail"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    /// Pinned cross-language vectors, shared verbatim with
    /// `packages/kernel-bridge/tests/syncDigest.test.ts` (which resolves the
    /// same file by relative path).
    const VECTORS_JSON: &str = include_str!("../tests/fixtures/sync-digest-vectors.json");
    const VECTORS_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/sync-digest-vectors.json"
    );
    /// Written by `randomized_differential_vectors_for_typescript` and
    /// consumed by the TS suite, so the Rust side must run first:
    /// `cargo test -p strata-kernel sync_digest` and then
    /// `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test`.
    const DIFFERENTIAL_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/sync-digest-differential.json"
    );

    /// One shared fixture case. `expected_digest` is `None` only before the
    /// vectors are pinned by the regeneration helper.
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DigestVector {
        name: String,
        generation: String,
        nodes: Vec<NodeRecord>,
        references: Vec<ReferenceRecord>,
        #[serde(default)]
        expected_digest: Option<String>,
    }

    fn parse_vectors(json: &str) -> Vec<DigestVector> {
        serde_json::from_str(json).expect("sync-digest vectors must be valid JSON")
    }

    fn digest_of(vector: &DigestVector) -> String {
        let generation: u64 = vector
            .generation
            .parse()
            .expect("vector generation must be a canonical decimal u64 string");
        canonical_sync_digest(generation, &vector.nodes, &vector.references)
    }

    #[test]
    fn pinned_vectors_reproduce_expected_digests() {
        let vectors = parse_vectors(VECTORS_JSON);
        assert!(
            vectors.len() >= 9,
            "contract requires at least 9 shared vectors, found {}",
            vectors.len()
        );
        for vector in &vectors {
            let expected = vector.expected_digest.as_deref().unwrap_or_else(|| {
                panic!(
                    "vector {:?} has no pinned expectedDigest — regenerate once with \
                     REGEN_SYNC_DIGEST_VECTORS=1 cargo test -p strata-kernel sync_digest",
                    vector.name
                )
            });
            assert_eq!(digest_of(vector), expected, "vector {:?}", vector.name);
        }
    }

    #[test]
    fn digest_is_input_order_independent() {
        let vectors = parse_vectors(VECTORS_JSON);
        for mut vector in vectors {
            let forward = digest_of(&vector);
            vector.nodes.reverse();
            vector.references.reverse();
            assert_eq!(
                digest_of(&vector),
                forward,
                "vector {:?} must sort canonically regardless of input order",
                vector.name
            );
        }
    }

    /// Self-contained proof of the writer's exact bytes: the empty graph's
    /// digest is SHA-256 of the documented literal encoding, nothing else.
    #[test]
    fn empty_graph_digest_hashes_the_documented_literal_encoding() {
        let literal = br#"{"schema":1,"generation":"0","nodes":[],"references":[]}"#;
        let hash = Sha256::digest(literal);
        let mut expected = String::with_capacity(hash.len() * 2);
        for byte in hash {
            write!(&mut expected, "{byte:02x}").expect("writing to a String cannot fail");
        }
        assert_eq!(canonical_sync_digest(0, &[], &[]), expected);
    }

    /// Regeneration helper: recomputes every `expectedDigest` from the Rust
    /// implementation and rewrites the fixture file IN PLACE. Guarded so a
    /// normal test run never writes anything — vectors are generated once,
    /// reviewed, and pinned.
    #[test]
    fn regenerate_pinned_vectors_when_requested() {
        if std::env::var("REGEN_SYNC_DIGEST_VECTORS").as_deref() != Ok("1") {
            return;
        }
        // Read from disk (not include_str!) so repeated regens in one session
        // always start from the current file content.
        let raw = std::fs::read_to_string(VECTORS_PATH)
            .expect("sync-digest vectors fixture must be readable");
        let mut vectors = parse_vectors(&raw);
        for vector in &mut vectors {
            vector.expected_digest = Some(digest_of(vector));
        }
        let mut serialized = serde_json::to_string_pretty(&vectors)
            .expect("sync-digest vectors must serialize");
        serialized.push('\n');
        std::fs::write(VECTORS_PATH, serialized)
            .expect("sync-digest vectors fixture must be writable");
    }

    /// Deterministic PRNG (splitmix64) so the differential corpus is stable
    /// across runs and machines — no time- or OS-derived seed anywhere.
    struct SplitMix64(u64);

    impl SplitMix64 {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
    }

    /// Character pool deliberately includes astral characters (UTF-8 vs UTF-16
    /// sort divergence), U+2028/U+2029 (JS line separators), quotes and
    /// backslashes (escaping), and control characters.
    const TEXT_POOL: &[&str] = &[
        "a", "B", "z", "0", "_", "-", "~", "é", "Ω", "\u{FF61}", "\u{10000}", "\u{1F600}",
        "\u{2028}", "\u{2029}", "\"", "\\", "\n", "\t",
    ];
    const KIND_POOL: &[&str] = &["Module", "Identifier", "Call", "\u{1F600}kind", "K\"ind\\"];
    const REFERENCE_KIND_POOL: &[&str] = &["value", "type", "namespace", "va\"lue\\"];
    const SHARED_FROM_POOL: &[&str] = &["dup-from", "\u{10000}-from", "\u{FF61}-from"];

    fn pick<'pool>(rng: &mut SplitMix64, pool: &'pool [&'pool str]) -> &'pool str {
        pool[(rng.next() % pool.len() as u64) as usize]
    }

    fn random_text(rng: &mut SplitMix64, max_pieces: u64) -> String {
        let pieces = rng.next() % (max_pieces + 1);
        (0..pieces).map(|_| pick(rng, TEXT_POOL)).collect()
    }

    fn random_child_index(rng: &mut SplitMix64) -> Option<i64> {
        match rng.next() % 8 {
            0 => None,
            1 => Some(9_007_199_254_740_991),  // Number.MAX_SAFE_INTEGER
            2 => Some(-9_007_199_254_740_991), // -Number.MAX_SAFE_INTEGER
            3 => Some(-1),
            4 => Some(0),
            _ => Some((rng.next() % 100_000) as i64 - 50_000),
        }
    }

    fn random_graph(rng: &mut SplitMix64, index: usize) -> DigestVector {
        let node_count = (rng.next() % 12) as usize;
        let mut nodes: Vec<NodeRecord> = Vec::with_capacity(node_count);
        for node_index in 0..node_count {
            // Suffix keeps ids unique so byte-wise ordering is total and the
            // two languages cannot disagree on equal-key tie order.
            let id = format!("{}#{node_index}", random_text(rng, 4));
            let parent_id = match rng.next() % 4 {
                0 if node_index > 0 => {
                    Some(nodes[(rng.next() % node_index as u64) as usize].id.clone())
                }
                1 => Some(random_text(rng, 3)),
                _ => None,
            };
            nodes.push(NodeRecord {
                id,
                kind: pick(rng, KIND_POOL).to_owned(),
                parent_id,
                child_index: random_child_index(rng),
                payload: random_text(rng, 8),
            });
        }

        let reference_count = (rng.next() % 10) as usize;
        let mut references: Vec<ReferenceRecord> = Vec::with_capacity(reference_count);
        for reference_index in 0..reference_count {
            // Shared from-ids force the (fromNodeId, toNodeId) tiebreak; the
            // suffixed to-id keeps the sort key pair unique.
            let from_node_id = if rng.next() % 2 == 0 {
                pick(rng, SHARED_FROM_POOL).to_owned()
            } else {
                format!("{}#f{reference_index}", random_text(rng, 3))
            };
            references.push(ReferenceRecord {
                from_node_id,
                to_node_id: format!("{}#t{reference_index}", random_text(rng, 3)),
                kind: pick(rng, REFERENCE_KIND_POOL).to_owned(),
            });
        }

        let generation = match rng.next() % 4 {
            0 => 0,
            1 => u64::MAX,
            2 => rng.next() % 1_000,
            _ => rng.next(),
        };

        let expected_digest = Some(canonical_sync_digest(generation, &nodes, &references));
        DigestVector {
            name: format!("random-{index}"),
            generation: generation.to_string(),
            nodes,
            references,
            expected_digest,
        }
    }

    /// Generates the randomized cross-language corpus and writes it to
    /// `target/sync-digest-differential.json` for the TS suite to reproduce.
    /// This is a NORMAL test (never `#[ignore]`d) so every Rust run refreshes
    /// the corpus; the TS side skips cleanly when the file is absent.
    #[test]
    fn randomized_differential_vectors_for_typescript() {
        let mut rng = SplitMix64(0x5354_5241_5441_5347); // fixed seed, "STRATASG"
        let vectors: Vec<DigestVector> = (0..50).map(|index| random_graph(&mut rng, index)).collect();

        for vector in &vectors {
            let expected = vector
                .expected_digest
                .as_deref()
                .expect("generated vectors always carry a digest");
            // The digest must be a pure, order-independent function of its inputs.
            assert_eq!(digest_of(vector), expected, "vector {:?}", vector.name);
            let mut reversed = DigestVector {
                name: vector.name.clone(),
                generation: vector.generation.clone(),
                nodes: vector.nodes.iter().rev().cloned().collect(),
                references: vector.references.iter().rev().cloned().collect(),
                expected_digest: None,
            };
            reversed.expected_digest = Some(digest_of(&reversed));
            assert_eq!(
                reversed.expected_digest.as_deref(),
                Some(expected),
                "vector {:?} must be input-order independent",
                vector.name
            );
        }

        let path = std::path::Path::new(DIFFERENTIAL_PATH);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("target directory must be creatable");
        }
        let mut serialized =
            serde_json::to_string_pretty(&vectors).expect("differential vectors must serialize");
        serialized.push('\n');
        std::fs::write(path, serialized).expect("differential vectors must be writable");
    }
}
