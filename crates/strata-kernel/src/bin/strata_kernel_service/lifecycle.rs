//! Daemon ownership: who is allowed to serve a state directory and an endpoint.
//!
//! Two lifetime-held advisory locks, acquired before any recovery or durable
//! construction:
//!
//! | Lock | File | Protects |
//! |---|---|---|
//! | [`OwnerLock`] | `<canonical-state-dir>/.strata-owner` | redb / journal / audit |
//! | [`EndpointClaim`] | `<socket-root>/<hash>.lock` | the socket endpoint |
//!
//! Both are needed because the socket path derives from `--socket-token` alone,
//! with no relationship to `--db`. Two daemons with different state directories
//! and one token would otherwise collide on one endpoint while each contentedly
//! held its own state lock.
//!
//! `flock` rather than an `O_EXCL` sentinel: the kernel releases an advisory
//! lock when its holder dies, so a crash leaves nothing stale to reason about.
//! The precise lifetime rule matters — an `flock` belongs to the OPEN FILE
//! DESCRIPTION, is released only when all duplicated descriptors close, is
//! inherited across `fork`, and survives `exec` unless `O_CLOEXEC` is set.
//! Rust's `OpenOptions` sets `O_CLOEXEC`, which keeps these fds out of the Node
//! bridge workers; `tests/lifecycle.rs` gates that rather than trusting it.
//!
//! **`LOCK_NB` is what makes deadlock impossible**, not the acquisition order.
//! The order (state, then endpoint) is still fixed, because it is the property
//! that would survive if these ever became blocking.

#![allow(dead_code)]

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// The production socket directory. Tests inject their own root instead — the
/// shared directory holds live daemons' sockets, and a test that removed or
/// replaced it could destroy them.
pub(super) const SOCKET_DIRECTORY: &str = "/tmp/strata-lc";

/// Longest nonce, in lowercase hex characters. Bounded so the longest possible
/// basename (`<64 hex>.<nonce>.sock`) stays inside the 96-byte socket path
/// limit even under the production root.
pub(super) const MAX_NONCE_HEX: usize = 11;

/// Why a lock could not be taken. Distinct variants because they mean different
/// things to an operator: one says another daemon is alive, the other says the
/// filesystem is not in a state we are willing to serve from.
#[derive(Debug)]
pub(super) enum LockRefusal {
    HeldByAnother,
    Unavailable(io::Error),
}

impl LockRefusal {
    pub(super) fn into_error(self, what: &str) -> anyhow::Error {
        match self {
            Self::HeldByAnother => anyhow::anyhow!("another daemon already owns {what}"),
            Self::Unavailable(error) => {
                anyhow::Error::new(error).context(format!("acquire {what}"))
            }
        }
    }
}

/// A verified, held socket directory.
///
/// The fd is held for the process lifetime so that lock and record children can
/// be opened with `openat`, which POSIX names as the mechanism for avoiding
/// pathname substitution races.
///
/// **This is not TOCTOU-free in an absolute sense, and must not be described as
/// such.** `bind()` and a socket's `chmod` are pathname-based and cannot use
/// `openat`, so [`Self::reverify`] re-checks the root's device/inode
/// immediately before each pathname operation. The guarantee is safety within
/// the declared cooperative same-UID threat model.
pub(super) struct SocketRoot {
    path: PathBuf,
    dir: std::fs::File,
    dev: u64,
    ino: u64,
}

impl SocketRoot {
    pub(super) fn production() -> Result<Self> {
        Self::open(Path::new(SOCKET_DIRECTORY))
    }

    /// Creates the directory if absent and verifies it, holding an fd.
    ///
    /// `mkdir(0700)` gives the directory correct permissions atomically at
    /// creation, so there is no window where it exists with looser modes.
    pub(super) fn open(path: &Path) -> Result<Self> {
        let raw = std::ffi::CString::new(path.as_os_str().as_bytes())
            .context("socket root path contains an interior NUL")?;
        // EEXIST is expected on every start after the first.
        if unsafe { libc::mkdir(raw.as_ptr(), 0o700) } != 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error).context(format!("create socket root {}", path.display()));
            }
        }

        let dir = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .with_context(|| format!("open socket root {}", path.display()))?;

        // fstat the FD, never the path: a path-based check can be redirected
        // between the check and its use.
        let meta = dir.metadata().context("stat socket root")?;
        if !meta.is_dir() {
            bail!("socket root is not a real directory; refusing to serve");
        }
        if meta.uid() != unsafe { libc::geteuid() } {
            bail!("socket root is not owned by this user; refusing to serve");
        }
        // Deliberately NOT a silent repair. If the directory already existed
        // with group or other access, another UID could have planted names
        // inside it before we hardened it -- which would invalidate the
        // namespace invariant that reclamation depends on. Refuse instead.
        if meta.mode() & 0o077 != 0 {
            bail!(
                "socket root is group- or world-accessible; refusing to serve. \
                 Remove it and let the daemon recreate it."
            );
        }
        // Normalize the mode through the FD, so the chmod cannot be redirected.
        if unsafe { libc::fchmod(dir.as_raw_fd(), 0o700) } != 0 {
            return Err(io::Error::last_os_error()).context("protect socket root");
        }

        Ok(Self {
            path: path.to_owned(),
            dev: meta.dev(),
            ino: meta.ino(),
            dir,
        })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// Confirms the root path still names the directory we hold.
    ///
    /// Called immediately before every PATHNAME operation — `bind` and the
    /// socket `chmod` — because those cannot go through the held fd.
    pub(super) fn reverify(&self) -> Result<()> {
        let meta = std::fs::symlink_metadata(&self.path)
            .with_context(|| format!("re-stat socket root {}", self.path.display()))?;
        if meta.dev() != self.dev || meta.ino() != self.ino {
            bail!("socket root was replaced while serving; refusing to continue");
        }
        Ok(())
    }

    pub(super) fn lock_name(hash: &str) -> String {
        format!("{hash}.lock")
    }

    pub(super) fn record_name(hash: &str) -> String {
        format!("{hash}.record")
    }

    pub(super) fn socket_name(hash: &str, nonce: &str) -> String {
        format!("{hash}.{nonce}.sock")
    }

    pub(super) fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    /// Opens a child relative to the held directory fd.
    fn open_child(&self, name: &str, flags: libc::c_int, mode: libc::mode_t) -> io::Result<std::fs::File> {
        let raw = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains NUL"))?;
        let fd = unsafe {
            libc::openat(
                self.dir.as_raw_fd(),
                raw.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                libc::c_uint::from(mode),
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `openat` just returned this descriptor and nothing else owns
        // it, so handing ownership to `File` is the only claim on it.
        Ok(unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fd) })
    }

    /// Unlinks a child relative to the held fd, if it is still what we expect.
    pub(super) fn unlink_child(&self, name: &str) -> io::Result<()> {
        let raw = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains NUL"))?;
        if unsafe { libc::unlinkat(self.dir.as_raw_fd(), raw.as_ptr(), 0) } != 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        Ok(())
    }

    /// True when `name` currently names a socket in this root.
    pub(super) fn child_is_socket(&self, name: &str) -> bool {
        use std::os::unix::fs::FileTypeExt;
        self.join(name)
            .symlink_metadata()
            .map(|meta| meta.file_type().is_socket())
            .unwrap_or(false)
    }
}

/// The state directory, with symlinks and `..` resolved.
///
/// A newtype rather than a `&Path` so that passing an unresolved path to
/// [`OwnerLock::acquire`] is a compile error. An earlier draft defined a
/// canonicalization helper and then never called it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CanonicalStateDir(PathBuf);

impl CanonicalStateDir {
    /// Canonicalizes the PARENT: the database file itself may not exist yet on
    /// a first run.
    pub(super) fn resolve(db_path: &Path) -> Result<Self> {
        let parent = db_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .context("state path has no parent directory")?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create state directory {}", parent.display()))?;
        Ok(Self(parent.canonicalize().with_context(|| {
            format!("canonicalize state directory {}", parent.display())
        })?))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

/// Verifies an already-open lock file is a private, single-linked regular file,
/// then takes the advisory lock.
///
/// The mode check is not redundant with `.mode(0o600)`: that applies ONLY when
/// the file is created, so an existing lock file's permissions must be checked
/// rather than assumed.
fn lock_verified(file: std::fs::File) -> Result<std::fs::File, LockRefusal> {
    let meta = file.metadata().map_err(LockRefusal::Unavailable)?;
    let unacceptable = !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1;
    if unacceptable {
        return Err(LockRefusal::Unavailable(io::Error::new(
            io::ErrorKind::InvalidData,
            "lock file is not a private, single-linked regular file",
        )));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = io::Error::last_os_error();
        return match error.kind() {
            io::ErrorKind::WouldBlock => Err(LockRefusal::HeldByAnother),
            _ => Err(LockRefusal::Unavailable(error)),
        };
    }
    Ok(file)
}

/// Ownership of a state directory, held for the process lifetime.
pub(super) struct OwnerLock {
    file: std::fs::File,
}

impl OwnerLock {
    pub(super) fn acquire(dir: &CanonicalStateDir) -> Result<Self, LockRefusal> {
        let path = dir.path().join(".strata-owner");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(LockRefusal::Unavailable)?;
        lock_verified(file).map(|file| Self { file })
    }

    /// Writes diagnostic PID and epoch through the held fd.
    ///
    /// Diagnostics only, never authority — PID reuse and stale files make a PID
    /// a hint. Called only once BOTH locks are held and the epoch is real, so a
    /// daemon that wins one lock and loses the other leaves nothing misleading.
    pub(super) fn publish_diagnostics(&self, pid: u32, service_epoch: u64) -> Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        let mut file = &self.file;
        file.seek(SeekFrom::Start(0)).context("seek owner lock")?;
        file.set_len(0).context("truncate owner lock")?;
        writeln!(file, r#"{{"pid":{pid},"serviceEpoch":"{service_epoch}"}}"#)
            .context("write owner diagnostics")?;
        file.flush().context("flush owner diagnostics")?;
        Ok(())
    }
}

/// Ownership of one socket endpoint, held for the process lifetime.
pub(super) struct EndpointClaim {
    file: std::fs::File,
}

impl EndpointClaim {
    pub(super) fn acquire(root: &SocketRoot, token_hash: &str) -> Result<Self, LockRefusal> {
        let file = root
            .open_child(
                &SocketRoot::lock_name(token_hash),
                libc::O_RDWR | libc::O_CREAT,
                0o600,
            )
            .map_err(LockRefusal::Unavailable)?;
        lock_verified(file).map(|file| Self { file })
    }
}

/// The record naming the socket this token is currently bound to.
///
/// A SEPARATE file from the lock, and that separation is load-bearing: the
/// record is replaced by `rename`, and renaming over the lock file would
/// replace the very inode the `flock` protects.
///
/// Versioned and fail-closed — an unreadable or unrecognized record is treated
/// as "no predecessor to reclaim", never as permission to guess.
pub(super) struct EndpointRecord;

impl EndpointRecord {
    /// Reads the recorded predecessor's basename, if there is a usable one.
    pub(super) fn read(root: &SocketRoot, token_hash: &str) -> Option<String> {
        let raw = std::fs::read_to_string(root.join(&SocketRoot::record_name(token_hash))).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
        if parsed.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
            return None;
        }
        let name = parsed.get("socket")?.as_str()?.to_owned();
        // Only a name this token could legitimately own is actionable.
        if name.starts_with(&format!("{token_hash}.")) && name.ends_with(".sock") {
            Some(name)
        } else {
            None
        }
    }

    /// Publishes the new record durably: temp file, fsync, rename, then sync
    /// the directory so the rename itself is durable.
    ///
    /// Called BEFORE binding. That ordering is what makes every crash point
    /// exactly recoverable — a crash after this leaves a record naming the
    /// exact socket, and a crash before it leaves no new socket at all.
    pub(super) fn publish(root: &SocketRoot, token_hash: &str, socket_name: &str) -> Result<()> {
        use std::io::Write;
        let temp = root.join(&format!("{token_hash}.record.tmp"));
        {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temp)
                .context("create endpoint record")?;
            let body = serde_json::json!({ "version": 1, "socket": socket_name });
            file.write_all(serde_json::to_string(&body)?.as_bytes())
                .context("write endpoint record")?;
            file.sync_data().context("sync endpoint record")?;
        }
        std::fs::rename(&temp, root.join(&SocketRoot::record_name(token_hash)))
            .context("publish endpoint record")?;
        // Make the rename itself durable, not just the bytes.
        if let Ok(dir) = std::fs::File::open(root.path()) {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}

/// The bound socket, unlinked on drop.
///
/// D-3a adds no graceful shutdown — that is D-3b — so this is exercised
/// directly in tests rather than through a process-level clean exit.
pub(super) struct BoundEndpoint {
    root: std::sync::Arc<SocketRoot>,
    name: String,
    path: PathBuf,
}

impl BoundEndpoint {
    pub(super) fn bind(
        root: &std::sync::Arc<SocketRoot>,
        token_hash: &str,
        nonce: &str,
    ) -> Result<(Self, std::os::unix::net::UnixListener)> {
        let name = SocketRoot::socket_name(token_hash, nonce);
        let path = root.join(&name);
        // `bind` is pathname-based and cannot go through the held fd, so
        // confirm the root is still the directory we verified.
        root.reverify()?;
        let listener = std::os::unix::net::UnixListener::bind(&path)
            .with_context(|| format!("bind {}", path.display()))?;
        root.reverify()?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .context("protect local service Unix socket")?;
        Ok((
            Self {
                root: std::sync::Arc::clone(root),
                name,
                path,
            },
            listener,
        ))
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for BoundEndpoint {
    fn drop(&mut self) {
        // Only remove it if it is still a socket in the root we hold.
        if self.root.child_is_socket(&self.name) {
            let _ = self.root.unlink_child(&self.name);
        }
    }
}

/// A fresh incarnation nonce, bounded so the basename fits the socket path
/// limit.
pub(super) fn fresh_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..MAX_NONCE_HEX].to_owned()
}

/// Reclaims the exact recorded predecessor, if it is still there.
///
/// Deliberately NOT a directory sweep. A wildcard sweep would need a `read_dir`
/// traversal that cannot be meaningfully bounded, and it would delete sockets
/// this daemon has no record of ever creating. Exact reclamation is one
/// `unlinkat` and touches nothing it cannot name.
pub(super) fn reclaim_recorded_predecessor(root: &SocketRoot, token_hash: &str) -> Result<()> {
    let Some(name) = EndpointRecord::read(root, token_hash) else {
        return Ok(());
    };
    if !root.child_is_socket(&name) {
        // The record names something absent, or something that is not a socket.
        // Either way it is not ours to remove.
        return Ok(());
    }
    root.unlink_child(&name)
        .with_context(|| format!("reclaim recorded predecessor {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt;

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn a_second_holder_is_refused_and_a_dead_holder_leaves_nothing_behind() {
        let dir = temp_root();
        let canonical = CanonicalStateDir::resolve(&dir.path().join("kernel.redb")).unwrap();
        let first = OwnerLock::acquire(&canonical).expect("first holder wins");
        assert!(matches!(
            OwnerLock::acquire(&canonical),
            Err(LockRefusal::HeldByAnother)
        ));
        drop(first);
        // The kernel released it. There is no stale sentinel to clean up --
        // which is the whole reason this is flock and not an O_EXCL file.
        assert!(OwnerLock::acquire(&canonical).is_ok());
    }

    #[test]
    fn two_spellings_of_one_state_dir_resolve_to_one_identity() {
        let dir = temp_root();
        let nested = dir.path().join("state");
        std::fs::create_dir_all(&nested).unwrap();
        let direct = CanonicalStateDir::resolve(&nested.join("kernel.redb")).unwrap();
        let indirect =
            CanonicalStateDir::resolve(&nested.join("..").join("state").join("kernel.redb"))
                .unwrap();
        assert_eq!(direct, indirect);
    }

    #[test]
    fn the_endpoint_lock_is_independent_of_the_state_lock() {
        // The defect that forced two locks: the socket path derives from the
        // token alone, so one endpoint can be contended by daemons whose state
        // directories differ.
        let dir = temp_root();
        // Let SocketRoot create the directory, as production does, so mkdir's
        // atomic 0700 applies. Handing it a pre-existing directory with default
        // permissions is refused -- which is the rule working, not a bug.
        let root = SocketRoot::open(&dir.path().join("root")).unwrap();
        let hash = "a".repeat(64);
        let first = EndpointClaim::acquire(&root, &hash).expect("first claim wins");
        assert!(matches!(
            EndpointClaim::acquire(&root, &hash),
            Err(LockRefusal::HeldByAnother)
        ));
        drop(first);
        assert!(EndpointClaim::acquire(&root, &hash).is_ok());
    }

    #[test]
    fn a_lock_file_with_loose_permissions_is_refused() {
        // `.mode(0o600)` applies only on CREATE, so an existing file's mode
        // must be checked rather than assumed.
        let dir = temp_root();
        let root = SocketRoot::open(&dir.path().join("root")).unwrap();
        let hash = "b".repeat(64);
        let path = root.join(&SocketRoot::lock_name(&hash));
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, Permissions::from_mode(0o666)).unwrap();
        assert!(matches!(
            EndpointClaim::acquire(&root, &hash),
            Err(LockRefusal::Unavailable(_))
        ));
    }

    #[test]
    fn a_group_accessible_root_is_refused_rather_than_silently_repaired() {
        // Quietly tightening a directory another UID could already have written
        // to would invalidate the namespace invariant reclamation rests on.
        let dir = temp_root();
        let loose = dir.path().join("loose");
        std::fs::create_dir(&loose).unwrap();
        std::fs::set_permissions(&loose, Permissions::from_mode(0o755)).unwrap();
        let error = match SocketRoot::open(&loose) {
            Ok(_) => panic!("a group-accessible root was accepted"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("group- or world-accessible"), "{error}");
    }

    #[test]
    fn a_symlinked_root_is_refused_and_its_target_is_not_chmodded() {
        let dir = temp_root();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, Permissions::from_mode(0o755)).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(SocketRoot::open(&link).is_err(), "a symlinked root was accepted");
        // The chmod must not have been redirected through the link.
        let mode = std::fs::metadata(&target).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o755, "chmod followed the symlink to its target");
    }

    #[test]
    fn reverify_detects_a_replaced_root() {
        let dir = temp_root();
        let path = dir.path().join("root");
        let root = SocketRoot::open(&path).unwrap();
        root.reverify().expect("unchanged root reverifies");

        std::fs::remove_dir_all(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, Permissions::from_mode(0o700)).unwrap();
        assert!(root.reverify().is_err(), "a replaced root was not detected");
    }
}

/// How a `health` probe ended, and the exit code it maps to.
///
/// Distinct outcomes rather than a boolean, because they tell an operator
/// different things: "nothing is there" is a different situation from "something
/// is there and will not talk to me".
pub(super) enum HealthOutcome {
    Healthy,
    Draining,
    Absent,
    Unreachable(String),
    TimedOut,
}

impl HealthOutcome {
    pub(super) fn exit_code(&self) -> i32 {
        match self {
            Self::Healthy => 0,
            // Defined here, unreachable until D-3b gives `draining` a live
            // value. Fixed now so the matrix does not change between slices.
            Self::Draining => 5,
            Self::Absent => 3,
            Self::Unreachable(_) => 4,
            Self::TimedOut => 6,
        }
    }
}

/// Connects with a real deadline.
///
/// `UnixStream::connect` blocks, and setting read/write timeouts AFTERWARDS
/// does not bound it — so the socket is created non-blocking and `poll`ed for
/// writability. That distinction matters for a peer that accepts and then
/// stalls, which is precisely the case a post-connect timeout would miss.
fn connect_deadlined(path: &Path, deadline: Duration) -> Result<std::os::unix::net::UnixStream> {
    use std::os::fd::FromRawFd;

    let raw = std::ffi::CString::new(path.as_os_str().as_bytes())
        .context("socket path contains an interior NUL")?;
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error()).context("create probe socket");
    }
    // SAFETY: `socket` just returned this descriptor and nothing else owns it.
    let stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
    stream.set_nonblocking(true).context("set probe non-blocking")?;

    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = raw.as_bytes();
    if bytes.len() >= address.sun_path.len() {
        bail!("socket path is too long for sockaddr_un");
    }
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let connected = unsafe {
        libc::connect(
            fd,
            std::ptr::addr_of!(address).cast::<libc::sockaddr>(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if connected != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock
            && error.raw_os_error() != Some(libc::EINPROGRESS)
        {
            return Err(error).context("connect");
        }
        let mut poll_fd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let ready = unsafe {
            libc::poll(
                std::ptr::addr_of_mut!(poll_fd),
                1,
                deadline.as_millis() as libc::c_int,
            )
        };
        if ready == 0 {
            bail!("connect timed out");
        }
        if ready < 0 {
            return Err(io::Error::last_os_error()).context("poll for connect");
        }
    }
    stream.set_nonblocking(false).context("restore blocking mode")?;
    stream
        .set_read_timeout(Some(deadline))
        .context("set probe read timeout")?;
    stream
        .set_write_timeout(Some(deadline))
        .context("set probe write timeout")?;
    Ok(stream)
}

/// Probes an endpoint's health, bounded end to end.
pub(super) fn probe_health(path: &Path, deadline: Duration) -> HealthOutcome {
    use std::io::{Read, Write};

    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return HealthOutcome::Absent,
        Err(error) => return HealthOutcome::Unreachable(error.to_string()),
        Ok(meta) => {
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return HealthOutcome::Unreachable("path is not a socket".to_owned());
            }
        }
    }

    let mut stream = match connect_deadlined(path, deadline) {
        Ok(stream) => stream,
        Err(error) => {
            let text = format!("{error:#}");
            return if text.contains("timed out") {
                HealthOutcome::TimedOut
            } else {
                HealthOutcome::Unreachable(text)
            };
        }
    };

    let mut frame =
        serde_json::to_vec(&serde_json::json!({"protocolVersion": 2, "type": "health"}))
            .unwrap_or_default();
    frame.push(b'\n');
    if let Err(error) = stream.write_all(&frame) {
        return HealthOutcome::Unreachable(error.to_string());
    }

    let mut buffer = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => {
                return HealthOutcome::Unreachable("endpoint closed without replying".to_owned());
            }
            Ok(_) => {
                buffer.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
                if buffer.len() > MAX_HEALTH_REPLY_BYTES {
                    return HealthOutcome::Unreachable("reply exceeded its bound".to_owned());
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return HealthOutcome::TimedOut;
            }
            Err(error) => return HealthOutcome::Unreachable(error.to_string()),
        }
    }

    let parsed: serde_json::Value = match serde_json::from_slice(&buffer[..buffer.len() - 1]) {
        Ok(value) => value,
        Err(error) => return HealthOutcome::Unreachable(error.to_string()),
    };
    if parsed.get("type").and_then(serde_json::Value::as_str) != Some("health_ok") {
        return HealthOutcome::Unreachable("endpoint did not speak this protocol".to_owned());
    }
    if parsed.get("draining").and_then(serde_json::Value::as_bool) == Some(true) {
        return HealthOutcome::Draining;
    }
    HealthOutcome::Healthy
}

const MAX_HEALTH_REPLY_BYTES: usize = 4 * 1024;

/// Resolves the socket a token is currently bound to, via the stable record.
///
/// With per-incarnation names the path is no longer derivable from the token
/// alone, so this is how an operator who knows only the token finds the daemon.
pub(super) fn resolve_socket_for_token(root: &SocketRoot, token_hash: &str) -> Option<PathBuf> {
    EndpointRecord::read(root, token_hash).map(|name| root.join(&name))
}
