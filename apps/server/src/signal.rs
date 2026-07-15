use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Send,
    Recv,
}

impl std::fmt::Display for Role {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Send => formatter.write_str("send"),
            Self::Recv => formatter.write_str("recv"),
        }
    }
}

pub struct ValidatedSignal {
    pub value: Value,
    pub target_peer_id: Option<Uuid>,
}

pub fn parse_client_signal(role: Role, message: &str) -> Result<ValidatedSignal, String> {
    let value =
        serde_json::from_str::<Value>(message).map_err(|_| "信令不是有效的 JSON".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "信令必须是 JSON 对象".to_owned())?;

    let signal_kind_count = ["sdp", "ice", "type"]
        .iter()
        .filter(|key| object.contains_key(**key))
        .count();
    if signal_kind_count != 1 {
        return Err("信令必须且只能包含一种消息类型".to_owned());
    }

    if let Some(sdp_value) = object.get("sdp") {
        return parse_sdp(role, object, sdp_value);
    }

    if let Some(ice_value) = object.get("ice") {
        return parse_ice(role, object, ice_value);
    }

    if matches!(role, Role::Recv)
        && object.get("type").and_then(Value::as_str) == Some("receiver-ready")
    {
        return Ok(ValidatedSignal {
            value: json!({ "type": "receiver-ready" }),
            target_peer_id: None,
        });
    }

    Err(format!("{role} 角色不能发送该控制消息"))
}

fn parse_sdp(
    role: Role,
    object: &Map<String, Value>,
    value: &Value,
) -> Result<ValidatedSignal, String> {
    let expected_type = match role {
        Role::Send => "offer",
        Role::Recv => "answer",
    };
    let sdp = value
        .as_object()
        .ok_or_else(|| "SDP 信令格式无效".to_owned())?;
    let description = sdp
        .get("sdp")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());

    if sdp.get("type").and_then(Value::as_str) != Some(expected_type) || description.is_none() {
        return Err(format!("{role} 角色只能发送有效的 {expected_type} SDP"));
    }

    let target_peer_id = target_peer_id(role, object)?;
    let mut normalized = json!({
        "sdp": {
            "type": expected_type,
            "sdp": description.expect("description was validated"),
        }
    });
    insert_peer_id(&mut normalized, target_peer_id);

    Ok(ValidatedSignal {
        value: normalized,
        target_peer_id,
    })
}

fn parse_ice(
    role: Role,
    object: &Map<String, Value>,
    value: &Value,
) -> Result<ValidatedSignal, String> {
    let ice = value
        .as_object()
        .ok_or_else(|| "ICE candidate 格式无效".to_owned())?;
    let candidate = ice
        .get("candidate")
        .and_then(Value::as_str)
        .ok_or_else(|| "ICE candidate 格式无效".to_owned())?;

    let mut normalized_ice =
        Map::from_iter([("candidate".to_owned(), Value::String(candidate.to_owned()))]);
    copy_optional_string_or_null(ice, &mut normalized_ice, "sdpMid");
    copy_optional_number_or_null(ice, &mut normalized_ice, "sdpMLineIndex");
    copy_optional_string_or_null(ice, &mut normalized_ice, "usernameFragment");

    let target_peer_id = target_peer_id(role, object)?;
    let mut normalized = Value::Object(Map::from_iter([(
        "ice".to_owned(),
        Value::Object(normalized_ice),
    )]));
    insert_peer_id(&mut normalized, target_peer_id);

    Ok(ValidatedSignal {
        value: normalized,
        target_peer_id,
    })
}

fn target_peer_id(role: Role, object: &Map<String, Value>) -> Result<Option<Uuid>, String> {
    if matches!(role, Role::Recv) {
        return Ok(None);
    }

    object
        .get("peerId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(Some)
        .ok_or_else(|| "发送端信令缺少有效的 peerId".to_owned())
}

fn insert_peer_id(value: &mut Value, peer_id: Option<Uuid>) {
    if let (Some(object), Some(peer_id)) = (value.as_object_mut(), peer_id) {
        object.insert("peerId".to_owned(), Value::String(peer_id.to_string()));
    }
}

fn copy_optional_string_or_null(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source
        .get(key)
        .filter(|value| value.is_string() || value.is_null())
    {
        target.insert(key.to_owned(), value.clone());
    }
}

fn copy_optional_number_or_null(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source
        .get(key)
        .filter(|value| value.is_number() || value.is_null())
    {
        target.insert(key.to_owned(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEER_ID: &str = "12345678-1234-1234-1234-123456789abc";

    #[test]
    fn accepts_expected_sdp_direction() {
        let signal = parse_client_signal(
            Role::Send,
            &json!({ "peerId": PEER_ID, "sdp": { "type": "offer", "sdp": "v=0" } }).to_string(),
        )
        .expect("valid offer");
        assert_eq!(signal.target_peer_id.expect("peer id").to_string(), PEER_ID);
        assert_eq!(signal.value["sdp"]["type"], "offer");

        let answer = parse_client_signal(
            Role::Recv,
            &json!({ "sdp": { "type": "answer", "sdp": "v=0" } }).to_string(),
        )
        .expect("valid answer");
        assert!(answer.target_peer_id.is_none());
    }

    #[test]
    fn rejects_wrong_direction_and_ambiguous_messages() {
        assert!(
            parse_client_signal(
                Role::Send,
                &json!({ "sdp": { "type": "answer", "sdp": "v=0" } }).to_string(),
            )
            .is_err()
        );
        assert!(
            parse_client_signal(Role::Send, &json!({ "sdp": {}, "ice": {} }).to_string(),).is_err()
        );
    }

    #[test]
    fn normalizes_ice_and_receiver_ready() {
        let signal = parse_client_signal(
            Role::Recv,
            &json!({
                "ice": {
                    "candidate": "candidate:1",
                    "sdpMid": "0",
                    "sdpMLineIndex": 0,
                    "unknown": "ignored"
                }
            })
            .to_string(),
        )
        .expect("valid ICE candidate");
        assert!(signal.value["ice"].get("unknown").is_none());
        assert_eq!(signal.value["ice"]["sdpMLineIndex"], 0);

        let ready = parse_client_signal(Role::Recv, r#"{"type":"receiver-ready"}"#)
            .expect("receiver ready");
        assert_eq!(ready.value["type"], "receiver-ready");
    }
}
