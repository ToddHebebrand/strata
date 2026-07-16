#[path = "../src/bin/strata_kernel_service/protocol.rs"]
mod protocol;

use protocol::{
    LocalServiceProtocolContext, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
    parse_request_frame, parse_response_frame, serialize_request_frame, serialize_response_frame,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct FixtureFile {
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    name: String,
    direction: String,
    value: Value,
}

fn fixture(name: &str) -> FixtureFile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/live-compare/tests/fixtures/protocol-v1")
        .join(format!("{name}.json"));
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    bytes
}

fn accepted_value(name: &str) -> Value {
    fixture("accepted")
        .cases
        .into_iter()
        .find(|entry| entry.name == name)
        .unwrap()
        .value
}

#[test]
fn protocol_shared_golden_messages_round_trip_as_one_lf_frame() {
    for case in fixture("accepted").cases {
        let encoded = if case.direction == "request" {
            let parsed = parse_request_frame(&frame(&case.value), None).unwrap();
            serialize_request_frame(&parsed).unwrap()
        } else {
            let parsed = parse_response_frame(&frame(&case.value)).unwrap();
            serialize_response_frame(&parsed).unwrap()
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded[..encoded.len() - 1]).unwrap(),
            case.value,
            "{}",
            case.name
        );
        assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);
    }
}

#[test]
fn protocol_shared_invalid_messages_are_rejected() {
    for case in fixture("rejected").cases {
        let result = if case.direction == "request" {
            parse_request_frame(&frame(&case.value), None).map(|_| ())
        } else {
            parse_response_frame(&frame(&case.value)).map(|_| ())
        };
        assert!(
            result.is_err(),
            "fixture unexpectedly accepted: {}",
            case.name
        );
    }
}

#[test]
fn protocol_rejects_missing_empty_extra_and_multiple_frames() {
    assert!(parse_request_frame(b"{}", None).is_err());
    assert!(parse_request_frame(b"\n", None).is_err());
    assert!(parse_request_frame(b"{}\n ", None).is_err());
    assert!(parse_request_frame(b"{}\n{}\n", None).is_err());
}

#[test]
fn protocol_rejects_invalid_utf8_and_json() {
    assert!(parse_request_frame(&[0xff, b'\n'], None).is_err());
    assert!(parse_request_frame(b"{]\n", None).is_err());
}

#[test]
fn protocol_rejects_frames_over_both_bounds_before_schema_parsing() {
    let request_error = parse_request_frame(&vec![0; MAX_REQUEST_FRAME_BYTES + 1], None)
        .unwrap_err()
        .to_string();
    assert!(request_error.contains("frame exceeds"));
    let response_error = parse_response_frame(&vec![0; MAX_RESPONSE_FRAME_BYTES + 1])
        .unwrap_err()
        .to_string();
    assert!(response_error.contains("frame exceeds"));
}

#[test]
fn protocol_rejects_duplicate_request_ids_with_different_bodies() {
    let original = accepted_value("inspect-nodes-request");
    let mut changed = original.clone();
    changed["action"]["nodeIds"] = json!(["node:other"]);
    let mut context = LocalServiceProtocolContext::default();
    parse_request_frame(&frame(&original), Some(&mut context)).unwrap();
    let error = parse_request_frame(&frame(&changed), Some(&mut context))
        .unwrap_err()
        .to_string();
    assert!(error.contains("request ID was already used with a different body"));
    parse_request_frame(&frame(&original), Some(&mut context)).unwrap();
}

#[test]
fn protocol_rejects_cross_client_change_set_access() {
    let mut submit = accepted_value("submit-change-set-request");
    submit["clientId"] = json!("client:beta");
    let mut context = LocalServiceProtocolContext::default();
    context
        .record_change_set_owner("change:1", "client:alpha")
        .unwrap();
    let error = parse_request_frame(&frame(&submit), Some(&mut context))
        .unwrap_err()
        .to_string();
    assert!(error.contains("change set belongs to a different client"));
}

#[test]
fn protocol_bounds_duplicate_and_ownership_context() {
    let mut context = LocalServiceProtocolContext::with_capacities(1, 1).unwrap();
    context
        .record_change_set_owner("change:1", "client:alpha")
        .unwrap();
    assert!(
        context
            .record_change_set_owner("change:2", "client:alpha")
            .unwrap_err()
            .to_string()
            .contains("context capacity")
    );

    parse_request_frame(&frame(&accepted_value("hello-request")), Some(&mut context)).unwrap();
    assert!(
        parse_request_frame(
            &frame(&accepted_value("inspect-nodes-request")),
            Some(&mut context),
        )
        .unwrap_err()
        .to_string()
        .contains("context capacity")
    );
}
