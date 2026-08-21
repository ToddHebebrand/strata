//! Who owns an actor's lanes, and when a newcomer may take them.
//!
//! The rule implemented here replaces an earlier "is the lane currently
//! executing?" heuristic, which was wrong in three ways: it let a fresh
//! duplicate process steal an idle but perfectly healthy lane, it let two
//! duplicates displace each other indefinitely, and it had a check/start race
//! unless admission and takeover shared one lock.
//!
//! Two decisions shape everything below.
//!
//! **Ownership is per ACTOR, not per (actor, role).** If each lane were owned
//! independently, two duplicate clients could race to a split state where one
//! owns `work` and the other owns `observation` — a configuration in which
//! neither can make progress and nothing detects the problem.
//!
//! **Where the two cases are genuinely indistinguishable, the contract is
//! rejection.** A new process presenting a fresh instance id, with the old
//! instance's sockets showing no observable HUP, is not distinguishable from a
//! live duplicate. There is no evidence that separates them, so this module
//! refuses rather than guessing — an honest error beats a coin flip that can
//! silently fence a working client.

use std::collections::BTreeMap;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::protocol::SessionRole;

/// Why a handshake was refused. Each variant is a distinct wire code because
/// they call for different client behavior: a stale generation means "you are
/// behind, reconnect", while a lane conflict means "another instance of you is
/// alive, do not fight it".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OwnershipRefusal {
    /// Same instance, but this connection is not newer than the one already
    /// bound. Retrying with a higher generation is the fix.
    StaleGeneration,
    /// A different instance of this actor still holds at least one live lane.
    LaneConflict,
}

impl OwnershipRefusal {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::StaleGeneration => "stale_generation",
            Self::LaneConflict => "lane_conflict",
        }
    }

    pub(super) fn message(self) -> &'static str {
        match self {
            Self::StaleGeneration => {
                "a connection with an equal or higher generation already owns this lane"
            }
            Self::LaneConflict => {
                "another instance of this actor still holds a live lane; \
                 it must exit before this one can take over"
            }
        }
    }

    /// Both are worth retrying, but for different reasons: a stale generation
    /// resolves as soon as the client bumps its counter, and a lane conflict
    /// resolves when the other instance actually dies.
    pub(super) fn retryable(self) -> bool {
        true
    }
}

/// One bound lane.
struct LaneOwner {
    generation: u64,
    /// Unique per binding, never reused. Cleanup compares it before removing
    /// anything, so a dying handler cannot unregister the connection that
    /// REPLACED it — the classic shutdown race where a slow exit takes its own
    /// successor down with it.
    token: u64,
    /// Retained solely to fence the old connection and to probe for HUP. Never
    /// read from: consuming bytes here would steal them from the handler that
    /// legitimately owns this socket.
    stream: UnixStream,
}

/// One actor's ownership: a single instance, with up to two lanes beneath it.
struct ActorOwner {
    client_instance: String,
    lanes: BTreeMap<SessionRole, LaneOwner>,
}

#[derive(Default)]
pub(super) struct OwnershipRegistry {
    actors: Mutex<BTreeMap<String, ActorOwner>>,
    next_token: AtomicU64,
}

/// A successful binding. Fencing the displaced connection is deliberately the
/// CALLER's job, performed after the registry lock is released — shutting a
/// socket down under the lock would let a slow syscall block every other
/// handshake on the daemon.
pub(super) struct Binding {
    pub(super) token: u64,
    pub(super) fenced: Option<UnixStream>,
}

impl OwnershipRegistry {
    /// Applies the ownership rule to one handshake.
    ///
    /// The arms, in the order they are decided:
    ///
    /// 1. Nobody owns this actor — bind.
    /// 2. Same instance, same lane, strictly higher generation — bind and
    ///    fence the old connection, whether it is idle or mid-request. A
    ///    reconnecting client is authoritative about its own newer connection.
    /// 3. Same instance, same lane, equal or lower generation — stale.
    /// 4. Same instance, a lane it does not yet hold — bind alongside.
    /// 5. Different instance — permitted ONLY on positive transport evidence
    ///    that every lane of the old instance is dead. Never on a lane merely
    ///    looking idle.
    pub(super) fn bind(
        self: &Arc<Self>,
        actor: &str,
        role: SessionRole,
        client_instance: &str,
        generation: u64,
        stream: &UnixStream,
    ) -> Result<Binding, OwnershipRefusal> {
        let mut actors = self
            .actors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let token = self.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        let owned = stream
            .try_clone()
            .map_err(|_| OwnershipRefusal::LaneConflict)?;

        let Some(existing) = actors.get_mut(actor) else {
            // Arm 1.
            let mut lanes = BTreeMap::new();
            lanes.insert(
                role,
                LaneOwner {
                    generation,
                    token,
                    stream: owned,
                },
            );
            actors.insert(
                actor.to_owned(),
                ActorOwner {
                    client_instance: client_instance.to_owned(),
                    lanes,
                },
            );
            return Ok(Binding {
                token,
                fenced: None,
            });
        };

        if existing.client_instance == client_instance {
            match existing.lanes.get(&role) {
                // Arm 2.
                Some(previous) if generation > previous.generation => {
                    let displaced = existing.lanes.insert(
                        role,
                        LaneOwner {
                            generation,
                            token,
                            stream: owned,
                        },
                    );
                    return Ok(Binding {
                        token,
                        fenced: displaced.map(|lane| lane.stream),
                    });
                }
                // Arm 3.
                Some(_) => return Err(OwnershipRefusal::StaleGeneration),
                // Arm 4.
                None => {
                    existing.lanes.insert(
                        role,
                        LaneOwner {
                            generation,
                            token,
                            stream: owned,
                        },
                    );
                    return Ok(Binding {
                        token,
                        fenced: None,
                    });
                }
            }
        }

        // Arm 5. A different instance. The ONLY thing that admits it is
        // positive evidence that every lane of the incumbent is dead. "Looks
        // idle" is not evidence, and neither is "has not sent anything lately".
        if existing
            .lanes
            .values()
            .any(|lane| peer_is_alive(&lane.stream))
        {
            return Err(OwnershipRefusal::LaneConflict);
        }

        // Every incumbent lane showed HUP. Replace the actor's binding
        // wholesale, and fence whatever sockets remain so a zombie handler
        // cannot keep serving.
        let stale = std::mem::take(&mut existing.lanes);
        existing.client_instance = client_instance.to_owned();
        existing.lanes.insert(
            role,
            LaneOwner {
                generation,
                token,
                stream: owned,
            },
        );
        // Only one socket can be handed back for fencing; the rest are already
        // dead by the test just performed, and dropping them closes the
        // daemon's side.
        Ok(Binding {
            token,
            fenced: stale.into_values().next().map(|lane| lane.stream),
        })
    }

    /// Removes a lane binding IF this handler still owns it.
    ///
    /// The token comparison is the point. Without it, a handler that has been
    /// fenced and is unwinding would remove the entry its replacement just
    /// installed, leaving the actor unowned while a live connection believes
    /// it holds the lane.
    pub(super) fn release(&self, actor: &str, role: SessionRole, token: u64) {
        let mut actors = self
            .actors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(existing) = actors.get_mut(actor) else {
            return;
        };
        if existing.lanes.get(&role).is_some_and(|lane| lane.token == token) {
            existing.lanes.remove(&role);
        }
        if existing.lanes.is_empty() {
            actors.remove(actor);
        }
    }
}

/// Non-consuming liveness probe: is the peer still there?
///
/// `MSG_PEEK | MSG_DONTWAIT` is load-bearing in both halves. `MSG_PEEK` leaves
/// any pending bytes in the socket buffer, so this cannot steal a request from
/// the handler that owns the connection; `MSG_DONTWAIT` keeps a healthy but
/// quiet peer from blocking the registry.
///
/// Reads deliberately conservatively: anything ambiguous counts as ALIVE, so
/// an uncertain probe refuses a takeover rather than fencing a client that may
/// still be working.
fn peer_is_alive(stream: &UnixStream) -> bool {
    let mut byte = [0_u8; 1];
    let read = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            byte.as_mut_ptr().cast::<libc::c_void>(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if read > 0 {
        // Unread bytes waiting: the peer is not merely alive, it is talking.
        return true;
    }
    if read == 0 {
        // Orderly shutdown. This is the positive HUP evidence the rule needs.
        return false;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        // Connected, nothing pending. Alive and quiet.
        Some(code) if code == libc::EAGAIN || code == libc::EWOULDBLOCK => true,
        // The peer went away abruptly. Also positive evidence.
        Some(code) if code == libc::ECONNRESET || code == libc::ENOTCONN || code == libc::EPIPE => {
            false
        }
        // Interrupted, or something unmodelled. Assume alive: refusing a
        // takeover is recoverable, wrongly fencing a live client is not.
        _ => true,
    }
}
