use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc};
use uuid::Uuid;

use crate::{metrics::ServerMetrics, signal::Role};

const OUTBOUND_QUEUE_CAPACITY: usize = 32;
const OUTBOUND_BYTE_CAPACITY: usize = 256 * 1024;

pub enum OutboundMessage {
    Text(String),
    Ping,
    Pong(Vec<u8>),
    Close { code: u16, reason: String },
}

impl OutboundMessage {
    fn estimated_size(&self) -> usize {
        match self {
            Self::Text(message) => message.len(),
            Self::Ping => 1,
            Self::Pong(payload) => payload.len().max(1),
            Self::Close { reason, .. } => reason.len() + 2,
        }
    }
}

pub struct QueuedOutbound {
    message: Option<OutboundMessage>,
    _permit: OwnedSemaphorePermit,
    metrics: Arc<ServerMetrics>,
    bytes: usize,
}

impl QueuedOutbound {
    pub fn take_message(&mut self) -> OutboundMessage {
        self.message.take().expect("queued outbound message exists")
    }
}

impl Drop for QueuedOutbound {
    fn drop(&mut self) {
        self.metrics.remove_queued_signal_bytes(self.bytes);
    }
}

#[derive(Clone)]
pub struct PeerSender {
    sender: mpsc::Sender<QueuedOutbound>,
    byte_budget: Arc<Semaphore>,
    disconnected: Arc<AtomicBool>,
    disconnect_notification: Arc<Notify>,
    metrics: Arc<ServerMetrics>,
}

impl PeerSender {
    pub fn channel(metrics: Arc<ServerMetrics>) -> (Self, mpsc::Receiver<QueuedOutbound>) {
        let (sender, receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
        (
            Self {
                sender,
                byte_budget: Arc::new(Semaphore::new(OUTBOUND_BYTE_CAPACITY)),
                disconnected: Arc::new(AtomicBool::new(false)),
                disconnect_notification: Arc::new(Notify::new()),
                metrics,
            },
            receiver,
        )
    }

    pub fn try_send(&self, message: OutboundMessage) -> bool {
        if self.disconnected.load(Ordering::Acquire) {
            return false;
        }

        let bytes = message.estimated_size().max(1);
        let Ok(bytes_u32) = u32::try_from(bytes) else {
            return false;
        };
        let Ok(permit) = self.byte_budget.clone().try_acquire_many_owned(bytes_u32) else {
            return false;
        };
        self.metrics.add_queued_signal_bytes(bytes);
        self.sender
            .try_send(QueuedOutbound {
                message: Some(message),
                _permit: permit,
                metrics: self.metrics.clone(),
                bytes,
            })
            .is_ok()
    }

    pub fn disconnect(&self) {
        if !self.disconnected.swap(true, Ordering::AcqRel) {
            self.disconnect_notification.notify_one();
        }
    }

    pub async fn cancelled(&self) {
        let notified = self.disconnect_notification.notified();
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }
}

struct Peer {
    id: Uuid,
    outbound: PeerSender,
}

struct Room {
    access_code_hash: [u8; 32],
    sender: Option<Peer>,
    receivers: HashMap<Uuid, PeerSender>,
}

pub enum JoinResult {
    Joined { receiver_ids: Vec<Uuid> },
    InvalidAccessCode,
    RoleOccupied,
    RoomFull,
    ServerFull,
}

pub struct RoomRegistry {
    rooms: HashMap<String, Room>,
    max_receivers: usize,
    max_rooms: usize,
}

impl Default for RoomRegistry {
    fn default() -> Self {
        Self::new(
            crate::config::DEFAULT_MAX_RECEIVERS,
            crate::config::DEFAULT_MAX_ROOMS,
        )
    }
}

impl RoomRegistry {
    pub fn new(max_receivers: usize, max_rooms: usize) -> Self {
        Self {
            rooms: HashMap::new(),
            max_receivers,
            max_rooms,
        }
    }

    pub fn join(
        &mut self,
        room_id: &str,
        access_code_hash: [u8; 32],
        role: Role,
        peer_id: Uuid,
        outbound: PeerSender,
    ) -> JoinResult {
        if !self.rooms.contains_key(room_id) && self.rooms.len() >= self.max_rooms {
            return JoinResult::ServerFull;
        }

        let room = self
            .rooms
            .entry(room_id.to_owned())
            .or_insert_with(|| Room {
                access_code_hash,
                sender: None,
                receivers: HashMap::new(),
            });

        if !bool::from(room.access_code_hash.ct_eq(&access_code_hash)) {
            return JoinResult::InvalidAccessCode;
        }

        match role {
            Role::Send => {
                if room.sender.is_some() {
                    return JoinResult::RoleOccupied;
                }

                let receiver_ids = room.receivers.keys().copied().collect();
                room.sender = Some(Peer {
                    id: peer_id,
                    outbound,
                });
                JoinResult::Joined { receiver_ids }
            }
            Role::Recv => {
                if room.receivers.contains_key(&peer_id) {
                    return JoinResult::RoleOccupied;
                }
                if room.receivers.len() >= self.max_receivers {
                    return JoinResult::RoomFull;
                }

                room.receivers.insert(peer_id, outbound);
                JoinResult::Joined {
                    receiver_ids: Vec::new(),
                }
            }
        }
    }

    pub fn sender(&self, room_id: &str) -> Option<PeerSender> {
        self.rooms
            .get(room_id)
            .and_then(|room| room.sender.as_ref())
            .map(|peer| peer.outbound.clone())
    }

    pub fn receiver(&self, room_id: &str, peer_id: Uuid) -> Option<PeerSender> {
        self.rooms
            .get(room_id)
            .and_then(|room| room.receivers.get(&peer_id))
            .cloned()
    }

    pub fn leave(&mut self, room_id: &str, role: Role, peer_id: Uuid) -> Vec<PeerSender> {
        let Some(room) = self.rooms.get_mut(room_id) else {
            return Vec::new();
        };

        let notify = match role {
            Role::Send => {
                if room.sender.as_ref().is_some_and(|peer| peer.id == peer_id) {
                    room.sender = None;
                    room.receivers.values().cloned().collect()
                } else {
                    Vec::new()
                }
            }
            Role::Recv => {
                room.receivers.remove(&peer_id);
                room.sender
                    .as_ref()
                    .map(|peer| vec![peer.outbound.clone()])
                    .unwrap_or_default()
            }
        };

        if room.sender.is_none() && room.receivers.is_empty() {
            self.rooms.remove(room_id);
        }

        notify
    }

    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    pub fn peer_count(&self) -> usize {
        self.rooms
            .values()
            .map(|room| usize::from(room.sender.is_some()) + room.receivers.len())
            .sum()
    }
}

pub fn normalize_room_id(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let bytes = normalized.as_bytes();
    let valid_length = (3..=32).contains(&bytes.len());
    let valid_edge = bytes
        .first()
        .zip(bytes.last())
        .is_some_and(|(first, last)| first.is_ascii_alphanumeric() && last.is_ascii_alphanumeric());
    let valid_chars = bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');

    (valid_length && valid_edge && valid_chars).then_some(normalized)
}

pub fn is_valid_access_code(value: &str) -> bool {
    (6..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub fn hash_access_code(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> (Uuid, PeerSender) {
        let (outbound, _messages) = PeerSender::channel(Arc::new(ServerMetrics::default()));
        (Uuid::new_v4(), outbound)
    }

    #[test]
    fn validates_session_values() {
        assert_eq!(
            normalize_room_id("  Demo-Room  ").as_deref(),
            Some("demo-room")
        );
        assert_eq!(normalize_room_id("ab"), None);
        assert_eq!(normalize_room_id("invalid_room"), None);
        assert!(is_valid_access_code("Demo2026"));
        assert!(!is_valid_access_code("short"));
        assert!(!is_valid_access_code("包含中文123"));
    }

    #[test]
    fn keeps_one_sender_and_caps_receivers() {
        let mut rooms = RoomRegistry::new(2, 2);
        let key = hash_access_code("123456");
        let wrong_key = hash_access_code("654321");
        let (sender_id, sender) = peer();
        let (receiver_a_id, receiver_a) = peer();
        let (receiver_b_id, receiver_b) = peer();
        let (receiver_c_id, receiver_c) = peer();
        let (duplicate_id, duplicate) = peer();

        assert!(matches!(
            rooms.join("demo-room", key, Role::Send, sender_id, sender),
            JoinResult::Joined { .. }
        ));
        assert!(matches!(
            rooms.join("demo-room", key, Role::Recv, receiver_a_id, receiver_a),
            JoinResult::Joined { .. }
        ));
        assert!(matches!(
            rooms.join("demo-room", key, Role::Recv, receiver_b_id, receiver_b),
            JoinResult::Joined { .. }
        ));
        assert!(matches!(
            rooms.join("demo-room", key, Role::Recv, receiver_c_id, receiver_c),
            JoinResult::RoomFull
        ));
        assert!(matches!(
            rooms.join("demo-room", key, Role::Send, duplicate_id, duplicate),
            JoinResult::RoleOccupied
        ));

        let (_, intruder) = peer();
        assert!(matches!(
            rooms.join("demo-room", wrong_key, Role::Recv, Uuid::new_v4(), intruder),
            JoinResult::InvalidAccessCode
        ));
        assert_eq!(rooms.room_count(), 1);
        assert_eq!(rooms.peer_count(), 3);

        rooms.leave("demo-room", Role::Send, sender_id);
        rooms.leave("demo-room", Role::Recv, receiver_a_id);
        rooms.leave("demo-room", Role::Recv, receiver_b_id);
        assert_eq!(rooms.room_count(), 0);
    }

    #[test]
    fn caps_the_number_of_rooms() {
        let mut rooms = RoomRegistry::new(1, 1);
        let key = hash_access_code("123456");
        let (first_id, first) = peer();
        let (second_id, second) = peer();

        assert!(matches!(
            rooms.join("first-room", key, Role::Send, first_id, first),
            JoinResult::Joined { .. }
        ));
        assert!(matches!(
            rooms.join("second-room", key, Role::Send, second_id, second),
            JoinResult::ServerFull
        ));
    }

    #[test]
    fn caps_each_peer_queue_by_bytes() {
        let metrics = Arc::new(ServerMetrics::default());
        let (peer, receiver) = PeerSender::channel(metrics.clone());
        let payload = "x".repeat(64 * 1024);

        for _ in 0..4 {
            assert!(peer.try_send(OutboundMessage::Text(payload.clone())));
        }
        assert!(!peer.try_send(OutboundMessage::Text(payload)));
        assert_eq!(metrics.queued_signal_bytes(), OUTBOUND_BYTE_CAPACITY);

        drop(receiver);
        assert_eq!(metrics.queued_signal_bytes(), 0);
    }
}
