use std::fmt;
use std::io;
use std::os::fd::RawFd;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(super) const DEFAULT_DRAIN_GRACE: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct DrainHealth {
    pub(super) draining: bool,
    pub(super) active_requests: usize,
}

#[derive(Debug)]
struct DrainInner {
    draining_since: Option<Instant>,
    deadline: Option<Instant>,
    active_requests: usize,
    pending_stop_acks: usize,
}

#[derive(Debug)]
pub(super) struct DrainController {
    inner: Mutex<DrainInner>,
    wake: WakePipe,
    grace: Duration,
}

impl DrainController {
    pub(super) fn new(grace: Duration) -> io::Result<Self> {
        Ok(Self {
            inner: Mutex::new(DrainInner {
                draining_since: None,
                deadline: None,
                active_requests: 0,
                pending_stop_acks: 0,
            }),
            wake: WakePipe::new()?,
            grace,
        })
    }

    pub(super) fn begin_request(self: &Arc<Self>) -> Option<ActiveRequest> {
        let mut inner = self.lock_inner();
        if inner.draining_since.is_some() {
            return None;
        }
        inner.active_requests += 1;
        drop(inner);
        Some(ActiveRequest {
            controller: Arc::clone(self),
        })
    }

    pub(super) fn begin_stop(self: &Arc<Self>) -> Result<StopAcknowledgement, AlreadyDraining> {
        let now = Instant::now();
        let mut inner = self.lock_inner();
        let first = inner.draining_since.is_none();
        if first {
            inner.draining_since = Some(now);
            inner.deadline = Some(now + self.grace);
        }
        inner.pending_stop_acks += 1;
        let deadline = inner.deadline.expect("draining always has a deadline");
        drop(inner);
        if first {
            self.wake.notify();
        }
        let acknowledgement = StopAcknowledgement {
            controller: Arc::clone(self),
        };
        if first {
            Ok(acknowledgement)
        } else {
            Err(AlreadyDraining {
                deadline,
                acknowledgement,
            })
        }
    }

    pub(super) fn start_from_signal(&self) -> bool {
        let now = Instant::now();
        let mut inner = self.lock_inner();
        if inner.draining_since.is_some() {
            return false;
        }
        inner.draining_since = Some(now);
        inner.deadline = Some(now + self.grace);
        drop(inner);
        self.wake.notify();
        true
    }

    pub(super) fn health(&self) -> DrainHealth {
        let inner = self.lock_inner();
        DrainHealth {
            draining: inner.draining_since.is_some(),
            active_requests: inner.active_requests,
        }
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.lock_inner().deadline
    }

    pub(super) fn ready_to_exit(&self) -> bool {
        let inner = self.lock_inner();
        inner.draining_since.is_some() && inner.active_requests == 0 && inner.pending_stop_acks == 0
    }

    pub(super) fn remaining_active(&self) -> (usize, usize) {
        let inner = self.lock_inner();
        (inner.active_requests, inner.pending_stop_acks)
    }

    pub(super) fn wait_fd(&self) -> RawFd {
        self.wake.read_fd
    }

    pub(super) fn drain_notifications(&self) -> io::Result<()> {
        self.wake.drain()
    }

    fn finish_request(&self) {
        let mut inner = self.lock_inner();
        debug_assert!(inner.active_requests > 0);
        inner.active_requests -= 1;
        let ready = inner.draining_since.is_some()
            && inner.active_requests == 0
            && inner.pending_stop_acks == 0;
        drop(inner);
        if ready {
            self.wake.notify();
        }
    }

    fn finish_stop_acknowledgement(&self) {
        let mut inner = self.lock_inner();
        debug_assert!(inner.pending_stop_acks > 0);
        inner.pending_stop_acks -= 1;
        let ready = inner.draining_since.is_some()
            && inner.active_requests == 0
            && inner.pending_stop_acks == 0;
        drop(inner);
        if ready {
            self.wake.notify();
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, DrainInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Debug)]
pub(super) struct ActiveRequest {
    controller: Arc<DrainController>,
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.controller.finish_request();
    }
}

#[derive(Debug)]
pub(super) struct StopAcknowledgement {
    controller: Arc<DrainController>,
}

impl Drop for StopAcknowledgement {
    fn drop(&mut self) {
        self.controller.finish_stop_acknowledgement();
    }
}

pub(super) struct AlreadyDraining {
    deadline: Instant,
    acknowledgement: StopAcknowledgement,
}

impl AlreadyDraining {
    pub(super) fn deadline(&self) -> Instant {
        self.deadline
    }

    pub(super) fn into_acknowledgement(self) -> StopAcknowledgement {
        self.acknowledgement
    }
}

impl fmt::Debug for AlreadyDraining {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AlreadyDraining")
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct WakePipe {
    read_fd: RawFd,
    write_fd: RawFd,
}

impl WakePipe {
    fn new() -> io::Result<Self> {
        let mut fds = [-1; 2];
        // SAFETY: `fds` points to storage for the two descriptors returned by pipe.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if let Err(error) = configure_pipe(fds[0]).and_then(|()| configure_pipe(fds[1])) {
            // SAFETY: both descriptors were created by the successful pipe call.
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return Err(error);
        }
        Ok(Self {
            read_fd: fds[0],
            write_fd: fds[1],
        })
    }

    fn notify(&self) {
        notify_fd(self.write_fd);
    }

    fn drain(&self) -> io::Result<()> {
        let mut bytes = [0_u8; 128];
        loop {
            // SAFETY: `bytes` is valid writable storage and read_fd remains owned.
            let read = unsafe { libc::read(self.read_fd, bytes.as_mut_ptr().cast(), bytes.len()) };
            if read > 0 {
                continue;
            }
            if read == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EAGAIN) => return Ok(()),
                Some(libc::EINTR) => continue,
                _ => return Err(error),
            }
        }
    }
}

impl Drop for WakePipe {
    fn drop(&mut self) {
        // SAFETY: these descriptors are uniquely owned by this WakePipe.
        unsafe {
            libc::close(self.read_fd);
            libc::close(self.write_fd);
        }
    }
}

fn configure_pipe(fd: RawFd) -> io::Result<()> {
    // SAFETY: fd is a live descriptor created by pipe.
    let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if status_flags == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is live and the flags preserve all existing status bits.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, status_flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a live descriptor created by pipe.
    let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if descriptor_flags == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is live and the flags preserve all existing descriptor bits.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, descriptor_flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn notify_fd(fd: RawFd) {
    let saved_errno = errno();
    let byte = [1_u8];
    // SAFETY: `byte` is readable for one byte. A stale fd is prevented by the
    // signal-registration lifecycle introduced with the signal bridge.
    let _ = unsafe { libc::write(fd, byte.as_ptr().cast(), byte.len()) };
    set_errno(saved_errno);
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn errno() -> libc::c_int {
    // SAFETY: __error returns this thread's errno location.
    unsafe { *libc::__error() }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn set_errno(value: libc::c_int) {
    // SAFETY: __error returns this thread's errno location.
    unsafe { *libc::__error() = value };
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn errno() -> libc::c_int {
    // SAFETY: __errno_location returns this thread's errno location.
    unsafe { *libc::__errno_location() }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn set_errno(value: libc::c_int) {
    // SAFETY: __errno_location returns this thread's errno location.
    unsafe { *libc::__errno_location() = value };
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::{DrainController, DrainHealth};

    #[test]
    fn transition_and_request_start_are_one_atomic_decision() {
        let drain = Arc::new(DrainController::new(Duration::from_secs(30)).unwrap());
        let request = drain.begin_request().expect("running accepts work");
        let stop = drain.begin_stop().expect("first stop is accepted");

        assert!(drain.begin_request().is_none());
        assert_eq!(
            drain.health(),
            DrainHealth {
                draining: true,
                active_requests: 1,
            }
        );
        assert!(!drain.ready_to_exit(), "request and stop reply remain");
        drop(stop);
        assert!(!drain.ready_to_exit(), "request remains outstanding");
        drop(request);
        assert!(drain.ready_to_exit());
    }

    #[test]
    fn repeated_stop_keeps_the_first_deadline_and_has_its_own_ack_guard() {
        let drain = Arc::new(DrainController::new(Duration::from_millis(400)).unwrap());
        let first = drain.begin_stop().unwrap();
        let deadline = drain.deadline().unwrap();
        let repeated = drain.begin_stop().unwrap_err();

        assert_eq!(repeated.deadline(), deadline);
        assert!(!drain.ready_to_exit());
        drop(first);
        assert!(
            !drain.ready_to_exit(),
            "repeated reply is still outstanding"
        );
        drop(repeated.into_acknowledgement());
        assert!(drain.ready_to_exit());
    }

    #[test]
    fn signal_starts_drain_once_without_creating_an_acknowledgement() {
        let drain = DrainController::new(Duration::from_millis(400)).unwrap();
        assert!(drain.start_from_signal());
        let deadline = drain.deadline().unwrap();
        assert!(!drain.start_from_signal());
        assert_eq!(drain.deadline(), Some(deadline));
        assert!(drain.ready_to_exit());
    }

    #[test]
    fn dropping_the_last_guard_wakes_the_wait_fd() {
        let drain = Arc::new(DrainController::new(Duration::from_secs(30)).unwrap());
        drain.drain_notifications().unwrap();
        let request = drain.begin_request().unwrap();
        let stop = drain.begin_stop().unwrap();
        drain.drain_notifications().unwrap();
        drop(stop);
        assert!(!fd_is_readable(drain.wait_fd()));
        drop(request);
        assert!(fd_is_readable(drain.wait_fd()));
    }

    #[test]
    fn wake_pipe_is_nonblocking_close_on_exec_and_preserves_errno() {
        let drain = DrainController::new(Duration::from_secs(30)).unwrap();
        for fd in [drain.wake.read_fd, drain.wake.write_fd] {
            // SAFETY: both descriptors remain owned by `drain` during the calls.
            let status = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            // SAFETY: both descriptors remain owned by `drain` during the calls.
            let descriptor = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert_ne!(status, -1);
            assert_ne!(descriptor, -1);
            assert_ne!(status & libc::O_NONBLOCK, 0);
            assert_ne!(descriptor & libc::FD_CLOEXEC, 0);
        }

        super::set_errno(libc::ENOENT);
        drain.wake.notify();
        assert_eq!(super::errno(), libc::ENOENT);
    }

    fn fd_is_readable(fd: std::os::fd::RawFd) -> bool {
        let mut descriptor = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `descriptor` points to one initialized pollfd for this call.
        unsafe { libc::poll(&mut descriptor, 1, 0) == 1 && descriptor.revents & libc::POLLIN != 0 }
    }
}
