#![cfg(not(feature = "redb-spike-api"))]

#[test]
fn raw_publication_authority_is_not_exported_by_default() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/raw_publication_is_sealed.rs");
}

#[test]
#[cfg(not(feature = "coordination-test-api"))]
fn semantic_authority_is_not_exported_by_default() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/semantic_authority_is_sealed.rs");
    cases.compile_fail("tests/ui/production_execution_authority_is_sealed.rs");
    cases.compile_fail("tests/ui/coordinated_crash_execution_is_sealed.rs");
    cases.compile_fail("tests/ui/coordination_durable_test_authority_is_sealed.rs");
    cases.compile_fail("tests/ui/local_service_test_authority_is_sealed.rs");
}
