use std::fs::OpenOptions;
use std::ops::{Deref, DerefMut};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LockResult, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use anyhow::{Context, Result, bail};

pub(super) const LOCK_PROTOCOL: u32 = 1;
pub(super) const LOCK_JOURNAL: u32 = 2;
pub(super) const LOCK_AUDIT: u32 = 3;
const MAGIC: [u8; 8] = *b"STRATALK";
const VERSION: u32 = 1;
const DEFAULT_CAPACITY: usize = 65_536;

#[repr(C)]
struct Header {
    magic: [u8; 8],
    version: u32,
    header_bytes: u32,
    capacity: u64,
    sample_bytes: u64,
    next: AtomicU64,
    dropped: AtomicU64,
    noop_iterations: u64,
    noop_total_ns: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(C)]
struct Sample {
    lock_id: u32,
    reserved: u32,
    wait_ns: u64,
    hold_ns: u64,
}

struct Mapping {
    pointer: NonNull<u8>,
    length: usize,
}

// Each sample index is claimed exactly once with `next.fetch_add`; header
// counters are atomic and the immutable mapping metadata never changes.
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: this exact mapping was returned by mmap and remains live for
        // `self.length` bytes until this final owner is dropped.
        unsafe {
            libc::msync(self.pointer.as_ptr().cast(), self.length, libc::MS_SYNC);
            libc::munmap(self.pointer.as_ptr().cast(), self.length);
        }
    }
}

#[derive(Clone)]
pub(super) struct LockSampler {
    mapping: Arc<Mapping>,
}

impl LockSampler {
    pub(super) fn create(path: &Path) -> Result<Self> {
        Self::create_with_capacity(path, DEFAULT_CAPACITY)
    }

    fn create_with_capacity(path: &Path, capacity: usize) -> Result<Self> {
        if capacity == 0 {
            bail!("lock sample capacity must be positive");
        }
        let length = std::mem::size_of::<Header>()
            .checked_add(
                capacity
                    .checked_mul(std::mem::size_of::<Sample>())
                    .context("lock sample capacity overflow")?,
            )
            .context("lock sample file size overflow")?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("create lock sample file {}", path.display()))?;
        file.set_len(u64::try_from(length).context("lock sample file is too large")?)?;
        // SAFETY: `file` is open read/write and has just been extended to
        // `length`; MAP_SHARED makes samples visible in the artifact even on a
        // later forced process exit.
        let raw = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if raw == libc::MAP_FAILED {
            return Err(std::io::Error::last_os_error()).context("mmap lock sample file");
        }
        let pointer = NonNull::new(raw.cast::<u8>()).context("mmap returned a null pointer")?;
        let (noop_iterations, noop_total_ns) = measure_noop_clock_cost();
        let header = Header {
            magic: MAGIC,
            version: VERSION,
            header_bytes: std::mem::size_of::<Header>() as u32,
            capacity: capacity as u64,
            sample_bytes: std::mem::size_of::<Sample>() as u64,
            next: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            noop_iterations,
            noop_total_ns,
        };
        // SAFETY: mmap is suitably page-aligned, writable, and large enough
        // for Header followed by `capacity` Sample slots.
        unsafe { pointer.cast::<Header>().as_ptr().write(header) };
        Ok(Self {
            mapping: Arc::new(Mapping { pointer, length }),
        })
    }

    fn header(&self) -> &Header {
        // SAFETY: the mapping begins with the initialized Header for its whole
        // lifetime, and header mutation occurs only through atomics.
        unsafe { self.mapping.pointer.cast::<Header>().as_ref() }
    }

    fn record(&self, lock_id: u32, wait_ns: u64, hold_ns: u64) {
        let header = self.header();
        let index = header.next.fetch_add(1, Ordering::Relaxed);
        if index >= header.capacity {
            header.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let offset = std::mem::size_of::<Header>() + index as usize * std::mem::size_of::<Sample>();
        let sample = Sample {
            lock_id,
            reserved: 0,
            wait_ns,
            hold_ns,
        };
        // SAFETY: the unique atomic index owns this in-bounds slot, so no
        // other thread writes it.
        unsafe {
            self.mapping
                .pointer
                .as_ptr()
                .add(offset)
                .cast::<Sample>()
                .write(sample)
        };
    }

    #[cfg(test)]
    fn snapshot(&self) -> (Vec<Sample>, u64) {
        let header = self.header();
        let count = header.next.load(Ordering::Acquire).min(header.capacity) as usize;
        let mut samples = Vec::with_capacity(count);
        for index in 0..count {
            let offset = std::mem::size_of::<Header>() + index * std::mem::size_of::<Sample>();
            // SAFETY: slots below the acquired count were uniquely initialized
            // before their recording call returned.
            samples.push(unsafe {
                self.mapping
                    .pointer
                    .as_ptr()
                    .add(offset)
                    .cast::<Sample>()
                    .read()
            });
        }
        (samples, header.dropped.load(Ordering::Acquire))
    }
}

fn measure_noop_clock_cost() -> (u64, u64) {
    const ITERATIONS: u64 = 10_000;
    let mut total = 0_u64;
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        total = total.saturating_add(nanos(started.elapsed()));
    }
    (ITERATIONS, total)
}

fn nanos(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

pub(super) struct TimedMutex<T> {
    inner: Mutex<T>,
    lock_id: u32,
    sampler: Option<LockSampler>,
}

impl<T> TimedMutex<T> {
    pub(super) fn new(value: T, lock_id: u32, sampler: Option<LockSampler>) -> Self {
        Self {
            inner: Mutex::new(value),
            lock_id,
            sampler,
        }
    }

    pub(super) fn lock(&self) -> LockResult<TimedMutexGuard<'_, T>> {
        let waiting_since = Instant::now();
        match self.inner.lock() {
            Ok(guard) => Ok(self.wrap(guard, waiting_since)),
            Err(poisoned) => Err(PoisonError::new(self.wrap(poisoned.into_inner(), waiting_since))),
        }
    }

    fn wrap<'a>(&'a self, guard: MutexGuard<'a, T>, waiting_since: Instant) -> TimedMutexGuard<'a, T> {
        TimedMutexGuard {
            guard: Some(guard),
            sampler: self.sampler.clone(),
            lock_id: self.lock_id,
            wait_ns: nanos(waiting_since.elapsed()),
            acquired_at: Instant::now(),
        }
    }
}

pub(super) struct TimedMutexGuard<'a, T> {
    guard: Option<MutexGuard<'a, T>>,
    sampler: Option<LockSampler>,
    lock_id: u32,
    wait_ns: u64,
    acquired_at: Instant,
}

impl<T> Deref for TimedMutexGuard<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.guard.as_deref().expect("timed mutex guard is live")
    }
}

impl<T> DerefMut for TimedMutexGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard.as_deref_mut().expect("timed mutex guard is live")
    }
}

impl<T> Drop for TimedMutexGuard<'_, T> {
    fn drop(&mut self) {
        let hold_ns = nanos(self.acquired_at.elapsed());
        drop(self.guard.take());
        if let Some(sampler) = &self.sampler {
            sampler.record(self.lock_id, self.wait_ns, hold_ns);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::{Header, LOCK_PROTOCOL, LockSampler, Sample, TimedMutex};

    #[test]
    fn guard_drop_records_wait_and_hold_exactly_once() {
        let directory = TempDir::new().unwrap();
        let sampler = LockSampler::create_with_capacity(&directory.path().join("samples.bin"), 4)
            .unwrap();
        let mutex = TimedMutex::new((), LOCK_PROTOCOL, Some(sampler.clone()));
        {
            let _guard = mutex.lock().unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let (samples, dropped) = sampler.snapshot();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].lock_id, LOCK_PROTOCOL);
        assert!(samples[0].hold_ns >= 1_000_000);
        assert!(samples[0].wait_ns < samples[0].hold_ns);
        assert_eq!(dropped, 0);
    }

    #[test]
    fn wait_and_hold_are_measured_as_separate_intervals() {
        let directory = TempDir::new().unwrap();
        let sampler = LockSampler::create_with_capacity(&directory.path().join("samples.bin"), 4)
            .unwrap();
        let mutex = Arc::new(TimedMutex::new((), LOCK_PROTOCOL, Some(sampler.clone())));
        let held = mutex.lock().unwrap();
        let contender = Arc::clone(&mutex);
        let thread = std::thread::spawn(move || {
            let _guard = contender.lock().unwrap();
            std::thread::sleep(Duration::from_millis(1));
        });
        std::thread::sleep(Duration::from_millis(3));
        drop(held);
        thread.join().unwrap();
        let (samples, _) = sampler.snapshot();
        assert_eq!(samples.len(), 2);
        assert!(samples.iter().any(|sample| sample.wait_ns >= 2_000_000));
        assert!(samples.iter().any(|sample| sample.hold_ns >= 500_000));
    }

    #[test]
    fn sample_file_is_fixed_size_and_overflow_is_counted() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("samples.bin");
        let sampler = LockSampler::create_with_capacity(&path, 2).unwrap();
        sampler.record(1, 2, 3);
        sampler.record(2, 3, 4);
        sampler.record(3, 4, 5);
        let (samples, dropped) = sampler.snapshot();
        assert_eq!(samples.len(), 2);
        assert_eq!(dropped, 1);
        assert_eq!(
            std::fs::metadata(path).unwrap().len() as usize,
            std::mem::size_of::<Header>() + 2 * std::mem::size_of::<Sample>()
        );
        assert_eq!(sampler.header().noop_iterations, 10_000);
    }
}
