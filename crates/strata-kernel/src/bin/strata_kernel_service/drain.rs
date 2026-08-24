use std::fmt;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(super) const DEFAULT_DRAIN_GRACE_MS: u64 = 30_000;

static SIGNAL_REGISTRATION: Mutex<()> = Mutex::new(());
static SIGNAL_WAKE_FD: AtomicI32 = AtomicI32::new(-1);
static SIGNAL_PENDING: AtomicBool = AtomicBool::new(false);
static SIGNAL_HANDLER_ACTIVE: AtomicUsize = AtomicUsize::new(0);

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
        debug_assert!(inner.deadline.is_some());
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

    pub(super) fn wake_write_fd(&self) -> RawFd {
        self.wake.write_fd
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

pub(super) struct SignalRegistration {
    _ownership: MutexGuard<'static, ()>,
    previous_sigterm: libc::sigaction,
    previous_sigint: libc::sigaction,
}

impl SignalRegistration {
    pub(super) fn install(wake_fd: RawFd) -> io::Result<Self> {
        let ownership = SIGNAL_REGISTRATION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_mask = block_shutdown_signals()?;
        let result = install_signal_actions(wake_fd);
        restore_signal_mask(&previous_mask);
        let (previous_sigterm, previous_sigint) = result?;
        Ok(Self {
            _ownership: ownership,
            previous_sigterm,
            previous_sigint,
        })
    }

    pub(super) fn take_pending(&self) -> bool {
        SIGNAL_PENDING.swap(false, Ordering::AcqRel)
    }
}

impl Drop for SignalRegistration {
    fn drop(&mut self) {
        let previous_mask = block_shutdown_signals().ok();
        // SAFETY: both values were returned by successful sigaction calls for
        // these signals, and registration ownership is process-global.
        unsafe {
            libc::sigaction(libc::SIGTERM, &self.previous_sigterm, std::ptr::null_mut());
            libc::sigaction(libc::SIGINT, &self.previous_sigint, std::ptr::null_mut());
        }
        SIGNAL_WAKE_FD.store(-1, Ordering::Release);
        SIGNAL_PENDING.store(false, Ordering::Release);
        while SIGNAL_HANDLER_ACTIVE.load(Ordering::Acquire) != 0 {
            std::hint::spin_loop();
        }
        if let Some(previous_mask) = previous_mask {
            restore_signal_mask(&previous_mask);
        }
    }
}

extern "C" fn shutdown_signal_handler(_signal: libc::c_int) {
    SIGNAL_HANDLER_ACTIVE.fetch_add(1, Ordering::AcqRel);
    SIGNAL_PENDING.store(true, Ordering::Release);
    let fd = SIGNAL_WAKE_FD.load(Ordering::Acquire);
    if fd >= 0 {
        notify_fd(fd);
    }
    SIGNAL_HANDLER_ACTIVE.fetch_sub(1, Ordering::AcqRel);
}

fn install_signal_actions(wake_fd: RawFd) -> io::Result<(libc::sigaction, libc::sigaction)> {
    // SAFETY: zero is a valid starting representation for sigaction before all
    // fields used by the kernel are initialized below.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = shutdown_signal_handler as usize;
    action.sa_flags = 0;
    // SAFETY: sa_mask is initialized storage owned by action.
    if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: zeroed sigaction values are output storage for sigaction.
    let mut previous_sigterm: libc::sigaction = unsafe { std::mem::zeroed() };
    let mut previous_sigint: libc::sigaction = unsafe { std::mem::zeroed() };
    SIGNAL_WAKE_FD.store(wake_fd, Ordering::Release);
    SIGNAL_PENDING.store(false, Ordering::Release);
    // SAFETY: action is fully initialized and previous_sigterm is writable.
    if unsafe { libc::sigaction(libc::SIGTERM, &action, &mut previous_sigterm) } != 0 {
        SIGNAL_WAKE_FD.store(-1, Ordering::Release);
        return Err(io::Error::last_os_error());
    }
    // SAFETY: action is fully initialized and previous_sigint is writable.
    if unsafe { libc::sigaction(libc::SIGINT, &action, &mut previous_sigint) } != 0 {
        // SAFETY: previous_sigterm was populated by the successful call above.
        unsafe {
            libc::sigaction(libc::SIGTERM, &previous_sigterm, std::ptr::null_mut());
        }
        SIGNAL_WAKE_FD.store(-1, Ordering::Release);
        return Err(io::Error::last_os_error());
    }
    Ok((previous_sigterm, previous_sigint))
}

fn block_shutdown_signals() -> io::Result<libc::sigset_t> {
    // SAFETY: both values are immediately initialized through libc below.
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: set is writable and then remains initialized for each call.
    let result = unsafe {
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut previous)
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    Ok(previous)
}

fn restore_signal_mask(previous: &libc::sigset_t) {
    // SAFETY: previous came from pthread_sigmask and remains valid for this call.
    unsafe {
        libc::pthread_sigmask(libc::SIG_SETMASK, previous, std::ptr::null_mut());
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
    acknowledgement: StopAcknowledgement,
}

impl AlreadyDraining {
    pub(super) fn into_acknowledgement(self) -> StopAcknowledgement {
        self.acknowledgement
    }
}

impl fmt::Debug for AlreadyDraining {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AlreadyDraining")
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

        assert_eq!(drain.deadline(), Some(deadline));
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

    #[test]
    fn signal_registration_restores_handlers_before_the_wake_fd_can_be_reused() {
        // SAFETY: these are output slots for sigaction queries.
        let mut before_term: libc::sigaction = unsafe { std::mem::zeroed() };
        let mut before_int: libc::sigaction = unsafe { std::mem::zeroed() };
        // SAFETY: null action queries the current process-wide disposition.
        unsafe {
            libc::sigaction(libc::SIGTERM, std::ptr::null(), &mut before_term);
            libc::sigaction(libc::SIGINT, std::ptr::null(), &mut before_int);
        }
        let drain = DrainController::new(Duration::from_secs(30)).unwrap();
        let registration = super::SignalRegistration::install(drain.wake_write_fd()).unwrap();
        assert_eq!(
            super::SIGNAL_WAKE_FD.load(std::sync::atomic::Ordering::Acquire),
            drain.wake_write_fd()
        );
        drop(registration);
        assert_eq!(
            super::SIGNAL_WAKE_FD.load(std::sync::atomic::Ordering::Acquire),
            -1
        );
        // SAFETY: these are output slots for sigaction queries.
        let mut after_term: libc::sigaction = unsafe { std::mem::zeroed() };
        let mut after_int: libc::sigaction = unsafe { std::mem::zeroed() };
        // SAFETY: null action queries the restored dispositions.
        unsafe {
            libc::sigaction(libc::SIGTERM, std::ptr::null(), &mut after_term);
            libc::sigaction(libc::SIGINT, std::ptr::null(), &mut after_int);
        }
        assert_eq!(after_term.sa_sigaction, before_term.sa_sigaction);
        assert_eq!(after_int.sa_sigaction, before_int.sa_sigaction);
        let old_write_fd = drain.wake_write_fd();
        drop(drain);
        let replacement = super::WakePipe::new().unwrap();
        if replacement.read_fd == old_write_fd || replacement.write_fd == old_write_fd {
            assert_eq!(
                super::SIGNAL_WAKE_FD.load(std::sync::atomic::Ordering::Acquire),
                -1,
                "a reused descriptor must not remain published"
            );
        }
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
