//! Shared v2 session helpers for the `local_service*` integration suites.
//!
//! Under protocol v1 a test could connect, write one frame, half-close, and
//! `read_to_end`. None of that works on a session wire: the first frame must be
//! an `open_session` handshake, a half-close ends the session, and the daemon
//! never closes the connection, so `read_to_end` would block until a timeout.
//!
//! Deliberately built from raw JSON rather than the `protocol` module. These
//! suites include that module by `#[path]`, and a helper that shared its types
//! would silently agree with the implementation it is supposed to be checking.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

/// Connects and completes the handshake, returning the live session stream and
/// the daemon's `session_opened` reply. Panics on rejection: a test that means
/// to be refused should drive the handshake itself.
pub fn open_session(
    socket: &Path,
    actor: &str,
    role: &str,
    client_instance: &str,
    generation: u64,
) -> (UnixStream, Value) {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    stream
        .write_all(&frame(&json!({
            "protocolVersion": 2,
            "type": "open_session",
            "actor": actor,
            "role": role,
            "clientInstance": client_instance,
            "connectionGeneration": generation.to_string(),
        })))
        .unwrap();
    let reply = read_frame(&mut stream).expect("daemon closed before replying to the handshake");
    let reply: Value = serde_json::from_slice(&reply[..reply.len() - 1]).unwrap();
    assert_eq!(
        reply["type"], "session_opened",
        "handshake was rejected: {reply}"
    );
    (stream, reply)
}

/// Opens a work-lane session with defaulted instance identity, for the many
/// tests that only care that a session exists.
pub fn open_work_session(socket: &Path, actor: &str) -> UnixStream {
    open_session(socket, actor, "work", &format!("instance:{actor}"), 1).0
}

/// Opens an observation-lane session, for tests that drive reads by hand.
pub fn open_observation_session(socket: &Path, actor: &str) -> UnixStream {
    open_session(
        socket,
        actor,
        "observation",
        &format!("instance:{actor}"),
        1,
    )
    .0
}

/// The lane an action rides, mirroring `action-lane.json`.
///
/// Spelled out here rather than imported from the `protocol` module on
/// purpose: a helper that asked the implementation which lane to use could
/// never catch the implementation putting an action on the wrong one.
pub fn lane_for(action: &str) -> &'static str {
    match action {
        "begin_change_set" | "add_intent" | "submit_change_set" | "advance_change_set"
        | "cancel_change_set" => "work",
        _ => "observation",
    }
}

/// Opens the lane this request belongs on, sends it, and returns the response.
/// One session per call -- not how a real client behaves, but it keeps the
/// existing suites asserting request semantics rather than connection reuse.
pub fn send_one(socket: &Path, actor: &str, request: &Value) -> Value {
    let mut stream = open_lane_for(socket, actor, request);
    exchange(&mut stream, request)
}

/// Opens the correct lane for `request` without sending it, for tests that
/// need to drive the socket by hand afterwards.
pub fn open_lane_for(socket: &Path, actor: &str, request: &Value) -> UnixStream {
    let action = request["action"]["type"].as_str().unwrap_or("hello");
    open_session(
        socket,
        actor,
        lane_for(action),
        &format!("instance:{actor}"),
        1,
    )
    .0
}

/// Writes one request frame and reads exactly one response frame back.
pub fn exchange(stream: &mut UnixStream, request: &Value) -> Value {
    stream.write_all(&frame(request)).unwrap();
    let response = read_frame(stream).expect("daemon closed before responding");
    serde_json::from_slice(&response[..response.len() - 1]).unwrap()
}

/// Reads bytes until the first LF, returning the frame INCLUDING it, or `None`
/// on a clean end of stream. Stops at the delimiter rather than at EOF, because
/// a v2 daemon holds the connection open after answering.
pub fn read_frame(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return if buffer.is_empty() { None } else { Some(buffer) },
            Ok(_) => {
                buffer.push(byte[0]);
                if byte[0] == b'\n' {
                    return Some(buffer);
                }
            }
            Err(_) => return if buffer.is_empty() { None } else { Some(buffer) },
        }
    }
}

pub fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    bytes
}
