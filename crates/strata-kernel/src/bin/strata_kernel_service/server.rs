use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::protocol::{LocalServiceResponse, MAX_REQUEST_FRAME_BYTES, serialize_response_frame};
use super::session::{ServiceConfig, ServiceSession};

const SOCKET_DIRECTORY: &str = "/tmp/strata-lc";
const MAX_SOCKET_PATH_BYTES: usize = 96;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Readiness {
    protocol_version: u8,
    socket_path: String,
    service_epoch: String,
    recovered: bool,
}

pub(super) fn serve(config: ServiceConfig, socket_token: &str) -> Result<()> {
    validate_token(socket_token)?;
    let socket_path = socket_path(socket_token);
    validate_socket_path(&socket_path)?;

    // Recovery is intentionally complete before the authority becomes reachable.
    let (session, service_epoch) = ServiceSession::open(config)?;
    let listener = bind_private_socket(&socket_path)?;
    let ready = Readiness {
        protocol_version: 1,
        socket_path: socket_path.to_string_lossy().into_owned(),
        service_epoch: service_epoch.to_string(),
        recovered: session.recovered(),
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &ready)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    drop(stdout);

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let session = Arc::clone(&session);
                thread::spawn(move || {
                    let _ = handle_connection(stream, &session);
                });
            }
            Err(error) => return Err(error).context("accept local service connection"),
        }
    }
    Ok(())
}

pub(super) fn validate_socket_path(path: &Path) -> Result<()> {
    let encoded = path
        .to_str()
        .context("local service socket path must be valid UTF-8")?;
    let parent = path
        .parent()
        .context("local service socket path has no parent")?;
    if parent != Path::new(SOCKET_DIRECTORY) {
        bail!("local service socket must be directly under /tmp/strata-lc/");
    }
    if encoded.len() > MAX_SOCKET_PATH_BYTES {
        bail!("local service socket path exceeds 96 UTF-8 bytes");
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("local service socket has no UTF-8 basename")?;
    let hash = name
        .strip_suffix(".sock")
        .context("local service socket must end in .sock")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("local service socket basename must be a SHA-256 token hash");
    }
    Ok(())
}

fn socket_path(token: &str) -> PathBuf {
    let digest = Sha256::digest(token.as_bytes());
    Path::new(SOCKET_DIRECTORY).join(format!("{digest:x}.sock"))
}

fn validate_token(token: &str) -> Result<()> {
    if token.is_empty() || token.len() > 512 {
        bail!("socket token must contain between 1 and 512 UTF-8 bytes");
    }
    Ok(())
}

fn bind_private_socket(path: &Path) -> Result<UnixListener> {
    fs::create_dir_all(SOCKET_DIRECTORY).context("create local service socket directory")?;
    fs::set_permissions(SOCKET_DIRECTORY, fs::Permissions::from_mode(0o700))
        .context("protect local service socket directory")?;
    if path.exists() {
        fs::remove_file(path).context("remove stale local service socket")?;
    }
    let listener = UnixListener::bind(path).context("bind local service Unix socket")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("protect local service Unix socket")?;
    Ok(listener)
}

fn handle_connection(mut stream: UnixStream, session: &ServiceSession) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut request = Vec::new();
    let mut chunk = [0_u8; 4096];
    while request.len() <= MAX_REQUEST_FRAME_BYTES && !request.contains(&b'\n') {
        let read = stream
            .read(&mut chunk)
            .context("read local service request")?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    let response = session.handle_frame(&request);
    let frame = bounded_response_frame(&response)?;
    // A peer may disconnect after the durable effect and before receiving the response.
    let _ = stream.write_all(&frame);
    let _ = stream.flush();
    Ok(())
}

fn bounded_response_frame(response: &LocalServiceResponse) -> Result<Vec<u8>> {
    let response_request_id = response.request_id().to_owned();
    serialize_response_frame(response).or_else(|_| {
        serialize_response_frame(&LocalServiceResponse::error(
            response_request_id,
            "response_too_large",
            "response exceeds the local protocol frame bound",
            false,
            Vec::new(),
        ))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::protocol::{
        ChangeSetState, MAX_RESPONSE_FRAME_BYTES, ResponseResult, ServiceEvent, WireU64,
    };

    #[test]
    fn event_aggregate_uses_the_shared_bounded_fallback() {
        let events = (0..9)
            .map(|event| ServiceEvent {
                sequence: WireU64::new(event + 1),
                change_set_id: format!("change:{event}"),
                state: ChangeSetState::Published,
                operation_id: None,
                affected_node_ids: (0..64)
                    .map(|node| {
                        let prefix = format!("affected-{event:03}-{node:03}-");
                        format!("{prefix}{}", "x".repeat(512 - prefix.len()))
                    })
                    .collect(),
                diagnostics: Vec::new(),
                publication_digest: None,
            })
            .collect();
        let response =
            LocalServiceResponse::success("events:oversized", ResponseResult::Events { events });
        assert!(serde_json::to_vec(&response).unwrap().len() > MAX_RESPONSE_FRAME_BYTES);

        let frame = bounded_response_frame(&response).unwrap();

        assert!(frame.len() <= MAX_RESPONSE_FRAME_BYTES);
        assert_eq!(frame.last(), Some(&b'\n'));
        let parsed: Value = serde_json::from_slice(&frame[..frame.len() - 1]).unwrap();
        assert_eq!(parsed["ok"], false, "{parsed}");
        assert_eq!(parsed["requestId"], "events:oversized");
        assert_eq!(parsed["error"]["code"], "response_too_large");
    }
}
