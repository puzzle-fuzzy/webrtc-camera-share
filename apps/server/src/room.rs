use std::collections::HashMap;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::signal::Role;

pub const DEFAULT_MAX_RECEIVERS: usize = 8;

pub type PeerSender = UnboundedSender<String>;

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
}

pub struct RoomRegistry {
    rooms: HashMap<String, Room>,
    max_receivers: usize,
}

impl Default for RoomRegistry {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_RECEIVERS)
    }
}

impl RoomRegistry {
    pub fn new(max_receivers: usize) -> Self {
        Self {
            rooms: HashMap::new(),
            max_receivers,
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
    use tokio::sync::mpsc;

    use super::*;

    fn peer() -> (Uuid, PeerSender) {
        let (outbound, _messages) = mpsc::unbounded_channel();
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
        let mut rooms = RoomRegistry::new(2);
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
}
