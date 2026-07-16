use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

#[derive(Default)]
pub struct ServerMetrics {
    authentication_failures: AtomicU64,
    authentication_blocks: AtomicU64,
    connection_rejections: AtomicU64,
    outbound_overloads: AtomicU64,
    queued_signal_bytes: AtomicUsize,
    rate_limited_connections: AtomicU64,
    routed_signals: AtomicU64,
    turn_credential_rejections: AtomicU64,
}

impl ServerMetrics {
    pub fn record_authentication_failure(&self) {
        self.authentication_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_authentication_block(&self) {
        self.authentication_blocks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_connection_rejection(&self) {
        self.connection_rejections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_outbound_overload(&self) {
        self.outbound_overloads.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_queued_signal_bytes(&self, bytes: usize) {
        self.queued_signal_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn remove_queued_signal_bytes(&self, bytes: usize) {
        self.queued_signal_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }

    pub fn record_rate_limited_connection(&self) {
        self.rate_limited_connections
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_routed_signal(&self) {
        self.routed_signals.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_turn_credential_rejection(&self) {
        self.turn_credential_rejections
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn authentication_failures(&self) -> u64 {
        self.authentication_failures.load(Ordering::Relaxed)
    }

    pub fn authentication_blocks(&self) -> u64 {
        self.authentication_blocks.load(Ordering::Relaxed)
    }

    pub fn connection_rejections(&self) -> u64 {
        self.connection_rejections.load(Ordering::Relaxed)
    }

    pub fn outbound_overloads(&self) -> u64 {
        self.outbound_overloads.load(Ordering::Relaxed)
    }

    pub fn queued_signal_bytes(&self) -> usize {
        self.queued_signal_bytes.load(Ordering::Relaxed)
    }

    pub fn rate_limited_connections(&self) -> u64 {
        self.rate_limited_connections.load(Ordering::Relaxed)
    }

    pub fn routed_signals(&self) -> u64 {
        self.routed_signals.load(Ordering::Relaxed)
    }

    pub fn turn_credential_rejections(&self) -> u64 {
        self.turn_credential_rejections.load(Ordering::Relaxed)
    }
}
