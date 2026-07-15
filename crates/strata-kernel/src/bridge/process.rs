use super::protocol::{
    BridgeRequest, BridgeResponse, ValidationProfile, parse_bridge_response,
    serialize_bridge_request,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

#[derive(Clone, Debug)]
pub struct NodeBridgeConfig {
    pub(crate) executable: PathBuf,
    pub(crate) arguments: Vec<OsString>,
    pub(crate) deadline: Duration,
    pub(crate) max_request_bytes: usize,
    pub(crate) max_response_bytes: usize,
    pub(crate) max_stderr_bytes: usize,
    pub(crate) max_diagnostics_bytes: usize,
    pub(crate) validation_profile: ValidationProfile,
}

impl NodeBridgeConfig {
    pub fn tsc_only(
        executable: impl Into<PathBuf>,
        arguments: Vec<OsString>,
        deadline: Duration,
        source_root: impl Into<PathBuf>,
        corpus_root: impl Into<PathBuf>,
        strict_src_only_tsc_scope: bool,
    ) -> Self {
        let source_root = source_root.into();
        let corpus_root = corpus_root.into();
        Self {
            executable: executable.into(),
            arguments,
            deadline,
            max_request_bytes: 32 * 1024 * 1024,
            max_response_bytes: 16 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
            max_diagnostics_bytes: 64 * 1024,
            validation_profile: ValidationProfile::tsc_only(
                source_root.to_string_lossy(),
                corpus_root.to_string_lossy(),
                strict_src_only_tsc_scope,
            ),
        }
    }
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
        let deadline = Instant::now()
            .checked_add(self.config.deadline)
            .ok_or_else(|| anyhow!("Node bridge deadline is too large"))?;

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
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Node bridge stdin pipe was not created"))?;

        // Both readers start before any potentially blocking stdin write or wait.
        let stdout_reader = spawn_bounded_reader(stdout, self.config.max_response_bytes);
        let stderr_reader = spawn_bounded_reader(stderr, self.config.max_stderr_bytes);
        let mut stdin_writer = Some(spawn_request_writer(stdin, request_bytes));
        let mut write_result = None;
        let mut timed_out = false;
        let mut lifecycle_error = None;
        let mut status = None;

        match wait_for_writer_or_child(&mut child, stdin_writer.as_ref().unwrap(), deadline) {
            Ok(InitialEvent::ChildExited(exit_status)) => status = Some(exit_status),
            Ok(InitialEvent::WriterFinished) => {
                let result = join_writer(stdin_writer.take().unwrap());
                if result.is_err() {
                    write_result = Some(result);
                    match child
                        .try_wait()
                        .context("poll Node bridge child after write failure")
                    {
                        Ok(Some(exit_status)) => status = Some(exit_status),
                        Ok(None) => {
                            if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(cleanup_error);
                            }
                        }
                        Err(error) => {
                            lifecycle_error = Some(error);
                            if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(with_cleanup_error(
                                    lifecycle_error.take().unwrap(),
                                    cleanup_error,
                                ));
                            }
                        }
                    }
                } else {
                    write_result = Some(Ok(()));
                    match child.wait_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(Some(exit_status)) => status = Some(exit_status),
                        Ok(None) => {
                            timed_out = true;
                            if let Err(error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(error);
                            }
                        }
                        Err(error) => {
                            lifecycle_error =
                                Some(anyhow!(error).context("wait for Node bridge child"));
                            if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(with_cleanup_error(
                                    lifecycle_error.take().unwrap(),
                                    cleanup_error,
                                ));
                            }
                        }
                    }
                }
            }
            Ok(InitialEvent::DeadlineReached) => {
                timed_out = true;
                if let Err(error) = kill_and_reap(&mut child) {
                    lifecycle_error = Some(error);
                }
            }
            Err(error) => {
                lifecycle_error = Some(error);
                if let Err(cleanup_error) = kill_and_reap(&mut child) {
                    lifecycle_error = Some(with_cleanup_error(
                        lifecycle_error.take().unwrap(),
                        cleanup_error,
                    ));
                }
            }
        }

        if write_result.is_none() {
            write_result = Some(join_writer(stdin_writer.take().unwrap()));
        }

        let (stdout_result, stderr_result) = join_reader_pair(stdout_reader, stderr_reader);
        resolve_lifecycle_result(timed_out, lifecycle_error)?;
        let stdout_capture = stdout_result?;
        let stderr_capture = stderr_result?;

        if stderr_capture.over_limit {
            bail!("Node bridge stderr exceeded configured byte limit");
        }
        if stdout_capture.over_limit {
            bail!("Node bridge stdout response exceeded configured byte limit");
        }

        if let Some(status) = &status
            && !status.success()
        {
            let stderr = String::from_utf8_lossy(&stderr_capture.bytes);
            bail!(
                "Node bridge exited with nonzero status {status}: {}",
                stderr.trim()
            );
        }
        write_result.expect("writer result is always collected")?;
        ensure!(
            status.is_some(),
            "Node bridge child status was not collected"
        );

        parse_bridge_response(
            &stdout_capture.bytes,
            request,
            self.config.max_diagnostics_bytes,
        )
    }
}

enum InitialEvent {
    ChildExited(ExitStatus),
    WriterFinished,
    DeadlineReached,
}

fn wait_for_writer_or_child(
    child: &mut Child,
    writer: &JoinHandle<Result<()>>,
    deadline: Instant,
) -> Result<InitialEvent> {
    const POLL_INTERVAL: Duration = Duration::from_millis(2);

    loop {
        if let Some(status) = child.try_wait().context("poll Node bridge child status")? {
            return Ok(InitialEvent::ChildExited(status));
        }
        if writer.is_finished() {
            return Ok(InitialEvent::WriterFinished);
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(InitialEvent::DeadlineReached);
        }
        thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

fn spawn_request_writer(mut stdin: ChildStdin, request: Vec<u8>) -> JoinHandle<Result<()>> {
    thread::spawn(move || {
        stdin
            .write_all(&request)
            .context("write Node bridge request")?;
        stdin.flush().context("flush Node bridge request")?;
        drop(stdin);
        Ok(())
    })
}

fn join_writer(handle: JoinHandle<Result<()>>) -> Result<()> {
    handle
        .join()
        .map_err(|_| anyhow!("Node bridge stdin writer panicked"))?
}

fn kill_and_reap(child: &mut Child) -> Result<ExitStatus> {
    let kill_result = child.kill();
    let reap_result = child.wait();
    match (kill_result, reap_result) {
        (_, Ok(status)) => Ok(status),
        (Ok(()), Err(error)) => Err(anyhow!(error).context("reap Node bridge child")),
        (Err(kill_error), Err(reap_error)) => Err(anyhow!(
            "kill Node bridge child failed: {kill_error}; reap also failed: {reap_error}"
        )),
    }
}

fn with_cleanup_error(primary: anyhow::Error, cleanup: anyhow::Error) -> anyhow::Error {
    anyhow!("{primary:#}; child cleanup also failed: {cleanup:#}")
}

fn resolve_lifecycle_result(timed_out: bool, lifecycle_error: Option<anyhow::Error>) -> Result<()> {
    match (timed_out, lifecycle_error) {
        (true, Some(error)) => Err(anyhow!(
            "Node bridge deadline exceeded; child cleanup failed: {error:#}"
        )),
        (true, None) => bail!("Node bridge deadline exceeded; child was killed and reaped"),
        (false, Some(error)) => Err(error),
        (false, None) => Ok(()),
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

fn join_reader_pair(
    stdout_reader: JoinHandle<std::io::Result<BoundedCapture>>,
    stderr_reader: JoinHandle<std::io::Result<BoundedCapture>>,
) -> (Result<BoundedCapture>, Result<BoundedCapture>) {
    let stdout_result = join_reader(stdout_reader, "stdout");
    let stderr_result = join_reader(stderr_reader, "stderr");
    (stdout_result, stderr_result)
}

#[cfg(test)]
mod tests {
    use super::{BoundedCapture, join_reader_pair, resolve_lifecycle_result};
    use anyhow::anyhow;
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn reader_pair_join_waits_for_stderr_after_stdout_fails() {
        let stderr_finished = Arc::new(AtomicBool::new(false));
        let stdout_reader =
            thread::spawn(|| Err::<BoundedCapture, _>(io::Error::other("stdout read failed")));
        let stderr_finished_in_thread = Arc::clone(&stderr_finished);
        let stderr_reader = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            stderr_finished_in_thread.store(true, Ordering::SeqCst);
            Ok(BoundedCapture {
                bytes: Vec::new(),
                over_limit: false,
            })
        });

        let (stdout_result, stderr_result) = join_reader_pair(stdout_reader, stderr_reader);

        assert!(stdout_result.is_err());
        assert!(stderr_result.is_ok());
        assert!(stderr_finished.load(Ordering::SeqCst));
    }

    #[test]
    fn timeout_cleanup_failure_is_not_hidden_by_successful_cleanup_text() {
        let error = resolve_lifecycle_result(true, Some(anyhow!("synthetic kill failure")))
            .unwrap_err()
            .to_string();

        assert!(error.contains("deadline"), "{error}");
        assert!(error.contains("cleanup"), "{error}");
        assert!(error.contains("synthetic kill failure"), "{error}");
        assert!(!error.contains("was killed and reaped"), "{error}");
    }
}
