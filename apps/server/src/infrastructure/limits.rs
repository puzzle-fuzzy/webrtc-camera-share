use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::time::Instant;

const SIGNAL_WINDOW: Duration = Duration::from_secs(1);
const MAX_SIGNAL_MESSAGES_PER_WINDOW: usize = 64;
const MAX_SIGNAL_BYTES_PER_WINDOW: usize = 256 * 1024;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(5 * 60);
const AUTH_BLOCK_DURATION: Duration = Duration::from_secs(15 * 60);
const AUTH_ENTRY_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_AUTH_FAILURES: u32 = 8;
const MAX_AUTH_ENTRIES: usize = 4_096;
const TURN_CREDENTIAL_WINDOW: Duration = Duration::from_secs(10 * 60);
const TURN_CREDENTIAL_ENTRY_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_TURN_CREDENTIALS_PER_WINDOW: u32 = 64;
const MAX_TURN_CREDENTIAL_ENTRIES: usize = 4_096;

pub(crate) struct SignalBudget {
    window_started: Instant,
    messages: usize,
    bytes: usize,
}

impl SignalBudget {
    pub(crate) fn new() -> Self {
        Self {
            window_started: Instant::now(),
            messages: 0,
            bytes: 0,
        }
    }

    pub(crate) fn allow(&mut self, bytes: usize) -> bool {
        if self.window_started.elapsed() >= SIGNAL_WINDOW {
            self.window_started = Instant::now();
            self.messages = 0;
            self.bytes = 0;
        }
        self.messages = self.messages.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        self.messages <= MAX_SIGNAL_MESSAGES_PER_WINDOW && self.bytes <= MAX_SIGNAL_BYTES_PER_WINDOW
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct AuthenticationKey {
    ip: IpAddr,
    room_id: String,
}

struct AuthenticationEntry {
    failures: u32,
    window_started: Instant,
    blocked_until: Option<Instant>,
    last_seen: Instant,
}

struct AuthenticationState {
    entries: HashMap<AuthenticationKey, AuthenticationEntry>,
    last_pruned: Instant,
}

pub(crate) struct AuthenticationLimiter {
    state: Mutex<AuthenticationState>,
}

impl AuthenticationLimiter {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(AuthenticationState {
                entries: HashMap::new(),
                last_pruned: Instant::now(),
            }),
        }
    }

    pub(crate) fn is_blocked(&self, ip: IpAddr, room_id: &str) -> bool {
        let now = Instant::now();
        let mut state = self
            .state
            .lock()
            .expect("authentication limiter lock poisoned");
        Self::prune_if_due(&mut state, now);
        let key = AuthenticationKey {
            ip,
            room_id: room_id.to_owned(),
        };
        let Some(entry) = state.entries.get_mut(&key) else {
            return false;
        };
        entry.last_seen = now;
        if entry
            .blocked_until
            .is_some_and(|blocked_until| now < blocked_until)
        {
            return true;
        }
        if now.duration_since(entry.window_started) >= AUTH_FAILURE_WINDOW {
            entry.failures = 0;
            entry.window_started = now;
            entry.blocked_until = None;
        }
        false
    }

    pub(crate) fn record_failure(&self, ip: IpAddr, room_id: &str) {
        let now = Instant::now();
        let mut state = self
            .state
            .lock()
            .expect("authentication limiter lock poisoned");
        Self::prune_if_due(&mut state, now);
        let key = AuthenticationKey {
            ip,
            room_id: room_id.to_owned(),
        };
        if !state.entries.contains_key(&key)
            && state.entries.len() >= MAX_AUTH_ENTRIES
            && let Some(evicted) = state.entries.keys().next().cloned()
        {
            state.entries.remove(&evicted);
        }
        let entry = state.entries.entry(key).or_insert(AuthenticationEntry {
            failures: 0,
            window_started: now,
            blocked_until: None,
            last_seen: now,
        });
        if now.duration_since(entry.window_started) >= AUTH_FAILURE_WINDOW {
            entry.failures = 0;
            entry.window_started = now;
        }
        entry.failures = entry.failures.saturating_add(1);
        entry.last_seen = now;
        if entry.failures >= MAX_AUTH_FAILURES {
            entry.blocked_until = now.checked_add(AUTH_BLOCK_DURATION);
        }
    }

    pub(crate) fn record_success(&self, ip: IpAddr, room_id: &str) {
        self.state
            .lock()
            .expect("authentication limiter lock poisoned")
            .entries
            .remove(&AuthenticationKey {
                ip,
                room_id: room_id.to_owned(),
            });
    }

    fn prune_if_due(state: &mut AuthenticationState, now: Instant) {
        if now.duration_since(state.last_pruned) < Duration::from_secs(60) {
            return;
        }
        state.entries.retain(|_, entry| {
            now.checked_duration_since(entry.last_seen)
                .is_some_and(|age| age < AUTH_ENTRY_TTL)
        });
        state.last_pruned = now;
    }
}

struct TurnCredentialEntry {
    issued: u32,
    window_started: Instant,
    last_seen: Instant,
}

struct TurnCredentialState {
    entries: HashMap<IpAddr, TurnCredentialEntry>,
    last_pruned: Instant,
}

pub(crate) struct TurnCredentialLimiter {
    state: Mutex<TurnCredentialState>,
}

impl TurnCredentialLimiter {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(TurnCredentialState {
                entries: HashMap::new(),
                last_pruned: Instant::now(),
            }),
        }
    }

    pub(crate) fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut state = self
            .state
            .lock()
            .expect("TURN credential limiter lock poisoned");
        if now.duration_since(state.last_pruned) >= Duration::from_secs(60) {
            state.entries.retain(|_, entry| {
                now.checked_duration_since(entry.last_seen)
                    .is_some_and(|age| age < TURN_CREDENTIAL_ENTRY_TTL)
            });
            state.last_pruned = now;
        }
        if !state.entries.contains_key(&ip)
            && state.entries.len() >= MAX_TURN_CREDENTIAL_ENTRIES
            && let Some(evicted) = state.entries.keys().next().copied()
        {
            state.entries.remove(&evicted);
        }

        let entry = state.entries.entry(ip).or_insert(TurnCredentialEntry {
            issued: 0,
            window_started: now,
            last_seen: now,
        });
        if now.duration_since(entry.window_started) >= TURN_CREDENTIAL_WINDOW {
            entry.issued = 0;
            entry.window_started = now;
        }
        entry.last_seen = now;
        if entry.issued >= MAX_TURN_CREDENTIALS_PER_WINDOW {
            return false;
        }
        entry.issued += 1;
        true
    }
}

struct ConnectionCounts {
    total: usize,
    by_ip: HashMap<IpAddr, usize>,
}

pub(crate) struct ConnectionLimiter {
    counts: Mutex<ConnectionCounts>,
    max_total: usize,
    max_per_ip: usize,
}

impl ConnectionLimiter {
    pub(crate) fn new(max_total: usize, max_per_ip: usize) -> Self {
        Self {
            counts: Mutex::new(ConnectionCounts {
                total: 0,
                by_ip: HashMap::new(),
            }),
            max_total,
            max_per_ip,
        }
    }

    pub(crate) fn acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ConnectionLease> {
        let mut counts = self
            .counts
            .lock()
            .expect("connection limiter lock poisoned");
        let current_for_ip = counts.by_ip.get(&ip).copied().unwrap_or_default();
        if counts.total >= self.max_total || current_for_ip >= self.max_per_ip {
            return None;
        }
        counts.total += 1;
        *counts.by_ip.entry(ip).or_default() += 1;
        drop(counts);
        Some(ConnectionLease {
            limiter: self.clone(),
            ip,
        })
    }

    pub(crate) fn active_count(&self) -> usize {
        self.counts
            .lock()
            .expect("connection limiter lock poisoned")
            .total
    }
}

pub(crate) struct ConnectionLease {
    limiter: Arc<ConnectionLimiter>,
    ip: IpAddr,
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        let mut counts = self
            .limiter
            .counts
            .lock()
            .expect("connection limiter lock poisoned");
        counts.total = counts.total.saturating_sub(1);
        if let Some(count) = counts.by_ip.get_mut(&self.ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.by_ip.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_connections_globally_and_per_ip() {
        let limiter = Arc::new(ConnectionLimiter::new(2, 1));
        let first_ip = "127.0.0.1".parse().expect("IP");
        let second_ip = "127.0.0.2".parse().expect("IP");
        let first = limiter.acquire(first_ip).expect("first connection");
        assert!(limiter.acquire(first_ip).is_none());
        let second = limiter.acquire(second_ip).expect("second connection");
        assert!(limiter.acquire("127.0.0.3".parse().expect("IP")).is_none());
        drop(first);
        assert!(limiter.acquire(first_ip).is_some());
        drop(second);
    }

    #[test]
    fn rate_budget_is_bounded() {
        let mut budget = SignalBudget::new();
        for _ in 0..MAX_SIGNAL_MESSAGES_PER_WINDOW {
            assert!(budget.allow(1));
        }
        assert!(!budget.allow(1));
    }

    #[test]
    fn blocks_repeated_authentication_failures_and_clears_successes() {
        let limiter = AuthenticationLimiter::new();
        let ip = "127.0.0.1".parse().expect("IP");
        for _ in 0..MAX_AUTH_FAILURES {
            assert!(!limiter.is_blocked(ip, "private-room"));
            limiter.record_failure(ip, "private-room");
        }
        assert!(limiter.is_blocked(ip, "private-room"));

        limiter.record_success(ip, "private-room");
        assert!(!limiter.is_blocked(ip, "private-room"));
    }

    #[test]
    fn limits_turn_credential_issuance_per_ip() {
        let limiter = TurnCredentialLimiter::new();
        let ip = "127.0.0.1".parse().expect("IP");
        for _ in 0..MAX_TURN_CREDENTIALS_PER_WINDOW {
            assert!(limiter.allow(ip));
        }
        assert!(!limiter.allow(ip));
        assert!(limiter.allow("127.0.0.2".parse().expect("IP")));
    }
}
