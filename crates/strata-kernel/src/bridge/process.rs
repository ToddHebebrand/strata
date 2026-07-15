use super::protocol::{
    BridgeRequest, BridgeResponse, ValidationProfile, parse_bridge_response,
    serialize_bridge_request,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wait_timeout::ChildExt;

#[derive(Clone, Debug)]
pub(crate) struct NodeBridgeConfig {
    pub(crate) executable: PathBuf,
    pub(crate) arguments: Vec<OsString>,
    pub(crate) deadline: Duration,
    pub(crate) max_request_bytes: usize,
    pub(crate) max_response_bytes: usize,
    pub(crate) max_stderr_bytes: usize,
    pub(crate) max_diagnostics_bytes: usize,
    pub(crate) validation_profile: ValidationProfile,
}

#[derive(Clone, Debug)]
pub(crate) struct NodeBridgeClient {
    config: NodeBridgeConfig,
}

impl NodeBridgeClient {
    pub(crate) fn new(config: NodeBridgeConfig) -> Self {
        Self { config }
    }

    pub(crate) fn run(&self, request: &BridgeRequest) -> Result<BridgeResponse> {
        let request_bytes = serialize_bridge_request(request)?;
        ensure!(
            request_bytes.len() <= self.config.max_request_bytes,
            "bridge request exceeds configured byte limit"
        );
        // Validation policy is service-startup-owned configuration. Candidate request
        // construction consumes it in the executor task; intent input never does.
        let _startup_validation_profile = &self.config.validation_profile;

        let mut command = Command::new(&self.config.executable);
        command
            .args(&self.config.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().with_context(|| {
            format!(
                "spawn Node bridge executable {}",
                self.config.executable.display()
            )
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Node bridge stdout pipe was not created"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Node bridge stderr pipe was not created"))?;

        // Both readers start before any potentially blocking stdin write or wait.
        let stdout_reader = spawn_bounded_reader(stdout, self.config.max_response_bytes);
        let stderr_reader = spawn_bounded_reader(stderr, self.config.max_stderr_bytes);

        let write_result = (|| -> Result<()> {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow!("Node bridge stdin pipe was not created"))?;
            stdin
                .write_all(&request_bytes)
                .context("write Node bridge request")?;
            stdin.flush().context("flush Node bridge request")?;
            drop(stdin);
            Ok(())
        })();

        let wait_result = child.wait_timeout(self.config.deadline);
        let mut timed_out = false;
        let status = match wait_result {
            Ok(Some(status)) => Some(status),
            Ok(None) => {
                timed_out = true;
                let kill_result = child.kill();
                let reap_result = child.wait();
                if let Err(error) = kill_result {
                    let _ = reap_result;
                    return finish_after_reader_join(
                        stdout_reader,
                        stderr_reader,
                        Err(anyhow!(error).context("kill timed-out Node bridge child")),
                    );
                }
                match reap_result {
                    Ok(status) => Some(status),
                    Err(error) => {
                        return finish_after_reader_join(
                            stdout_reader,
                            stderr_reader,
                            Err(anyhow!(error).context("reap timed-out Node bridge child")),
                        );
                    }
                }
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return finish_after_reader_join(
                    stdout_reader,
                    stderr_reader,
                    Err(anyhow!(error).context("wait for Node bridge child")),
                );
            }
        };

        let stdout_capture = join_reader(stdout_reader, "stdout")?;
        let stderr_capture = join_reader(stderr_reader, "stderr")?;

        if timed_out {
            bail!("Node bridge deadline exceeded; child was killed and reaped");
        }
        write_result?;
        if stderr_capture.over_limit {
            bail!("Node bridge stderr exceeded configured byte limit");
        }
        if stdout_capture.over_limit {
            bail!("Node bridge stdout response exceeded configured byte limit");
        }

        let status = status.expect("wait always returns or kills and reaps the child");
        if !status.success() {
            let stderr = String::from_utf8_lossy(&stderr_capture.bytes);
            bail!(
                "Node bridge exited with nonzero status {status}: {}",
                stderr.trim()
            );
        }

        parse_bridge_response(
            &stdout_capture.bytes,
            request,
            self.config.max_diagnostics_bytes,
        )
    }
}

struct BoundedCapture {
    bytes: Vec<u8>,
    over_limit: bool,
}

fn spawn_bounded_reader<R>(reader: R, limit: usize) -> JoinHandle<std::io::Result<BoundedCapture>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || read_bounded_and_drain(reader, limit))
}

fn read_bounded_and_drain<R: Read>(mut reader: R, limit: usize) -> std::io::Result<BoundedCapture> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut over_limit = false;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        if retained < read {
            over_limit = true;
        }
        // Continue draining even after the cap so a child cannot block forever
        // or receive SIGPIPE merely because its output is being rejected.
    }
    Ok(BoundedCapture { bytes, over_limit })
}

fn join_reader(
    handle: JoinHandle<std::io::Result<BoundedCapture>>,
    stream: &str,
) -> Result<BoundedCapture> {
    handle
        .join()
        .map_err(|_| anyhow!("Node bridge {stream} reader panicked"))?
        .with_context(|| format!("read Node bridge {stream}"))
}

fn finish_after_reader_join(
    stdout_reader: JoinHandle<std::io::Result<BoundedCapture>>,
    stderr_reader: JoinHandle<std::io::Result<BoundedCapture>>,
    result: Result<BridgeResponse>,
) -> Result<BridgeResponse> {
    let stdout_result = join_reader(stdout_reader, "stdout");
    let stderr_result = join_reader(stderr_reader, "stderr");
    stdout_result?;
    stderr_result?;
    result
}
