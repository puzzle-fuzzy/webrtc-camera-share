use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

pub const DEFAULT_MAX_CONNECTIONS: usize = 256;
pub const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 32;
pub const DEFAULT_MAX_RECEIVERS: usize = 8;
pub const DEFAULT_MAX_ROOMS: usize = 128;
const MAX_CONNECTIONS_LIMIT: usize = 4_096;
const MAX_CONNECTIONS_PER_IP_LIMIT: usize = 256;
const MAX_RECEIVERS_LIMIT: usize = 8;
const MAX_ROOMS_LIMIT: usize = 1_024;
const DEFAULT_TURN_TTL_SECONDS: u64 = 3_600;
const MIN_TURN_TTL_SECONDS: u64 = 300;
const MAX_TURN_TTL_SECONDS: u64 = 86_400;

#[derive(Clone, Debug)]
pub struct ResourceLimits {
    pub max_connections: usize,
    pub max_connections_per_ip: usize,
    pub max_receivers: usize,
    pub max_rooms: usize,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_MAX_CONNECTIONS,
            max_connections_per_ip: DEFAULT_MAX_CONNECTIONS_PER_IP,
            max_receivers: DEFAULT_MAX_RECEIVERS,
            max_rooms: DEFAULT_MAX_ROOMS,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum IceServerUrls {
    One(String),
    Many(Vec<String>),
}

impl IceServerUrls {
    fn values(&self) -> Vec<&str> {
        match self {
            Self::One(url) => vec![url],
            Self::Many(urls) => urls.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IceServerConfig {
    pub urls: IceServerUrls,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Clone)]
pub struct TurnConfig {
    urls: IceServerUrls,
    shared_secret: String,
    ttl: Duration,
}

impl TurnConfig {
    pub fn ephemeral_server(
        &self,
        now: SystemTime,
        identity: &str,
    ) -> Result<IceServerConfig, String> {
        let expires_at = now
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间早于 Unix epoch，无法生成 TURN 凭据".to_owned())?
            .checked_add(self.ttl)
            .ok_or_else(|| "TURN 凭据过期时间溢出".to_owned())?
            .as_secs();
        let username = format!("{expires_at}:{identity}");
        let mut hmac = Hmac::<Sha1>::new_from_slice(self.shared_secret.as_bytes())
            .map_err(|_| "TURN shared secret 无效".to_owned())?;
        hmac.update(username.as_bytes());
        let credential = STANDARD.encode(hmac.finalize().into_bytes());

        Ok(IceServerConfig {
            urls: self.urls.clone(),
            username: Some(username),
            credential: Some(credential),
        })
    }
}

pub struct Config {
    pub address: SocketAddr,
    pub web_dist: PathBuf,
    pub limits: ResourceLimits,
    pub ice_servers: Vec<IceServerConfig>,
    pub turn: Option<TurnConfig>,
    pub trust_proxy: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = parse_port(&env::var("PORT").unwrap_or_else(|_| "5011".to_owned()))?;
        let address = format!("{host}:{port}")
            .parse::<SocketAddr>()
            .map_err(|_| format!("HOST 不是有效的 IP 地址：{host}"))?;
        let limits = ResourceLimits {
            max_connections: parse_bounded_usize(
                "MAX_CONNECTIONS",
                DEFAULT_MAX_CONNECTIONS,
                MAX_CONNECTIONS_LIMIT,
            )?,
            max_connections_per_ip: parse_bounded_usize(
                "MAX_CONNECTIONS_PER_IP",
                DEFAULT_MAX_CONNECTIONS_PER_IP,
                MAX_CONNECTIONS_PER_IP_LIMIT,
            )?,
            max_receivers: parse_bounded_usize(
                "MAX_RECEIVERS",
                DEFAULT_MAX_RECEIVERS,
                MAX_RECEIVERS_LIMIT,
            )?,
            max_rooms: parse_bounded_usize("MAX_ROOMS", DEFAULT_MAX_ROOMS, MAX_ROOMS_LIMIT)?,
        };
        if limits.max_connections_per_ip > limits.max_connections {
            return Err("MAX_CONNECTIONS_PER_IP 不能大于 MAX_CONNECTIONS".to_owned());
        }
        if limits.max_rooms > limits.max_connections {
            return Err("MAX_ROOMS 不能大于 MAX_CONNECTIONS".to_owned());
        }

        Ok(Self {
            address,
            web_dist: resolve_web_dist()?,
            limits,
            ice_servers: parse_ice_servers()?,
            turn: parse_turn_config()?,
            trust_proxy: parse_bool("TRUST_PROXY", false)?,
        })
    }
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| "PORT 必须是 1 到 65535 之间的整数".to_owned())
}

fn parse_bounded_usize(name: &str, default: usize, maximum: usize) -> Result<usize, String> {
    let Some(value) = env::var_os(name) else {
        return Ok(default);
    };
    value
        .to_string_lossy()
        .parse::<usize>()
        .ok()
        .filter(|value| (1..=maximum).contains(value))
        .ok_or_else(|| format!("{name} 必须是 1 到 {maximum} 之间的整数"))
}

fn parse_bool(name: &str, default: bool) -> Result<bool, String> {
    let Some(value) = env::var_os(name) else {
        return Ok(default);
    };
    match value.to_string_lossy().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!("{name} 必须是 true 或 false")),
    }
}

fn resolve_web_dist() -> Result<PathBuf, String> {
    let current_dir = env::current_dir().map_err(|error| format!("无法读取当前目录：{error}"))?;
    if let Some(configured) = env::var_os("WEB_DIST") {
        return absolute_path(PathBuf::from(configured), &current_dir);
    }

    let mut candidates = vec![current_dir.join("apps/web/dist")];
    if let Ok(executable) = env::current_exe() {
        candidates.extend(
            executable
                .ancestors()
                .map(|ancestor| ancestor.join("apps/web/dist")),
        );
    }
    candidates.extend(
        current_dir
            .ancestors()
            .map(|ancestor| ancestor.join("apps/web/dist")),
    );

    if let Some(candidate) = candidates
        .iter()
        .find(|candidate| candidate.join("index.html").is_file())
    {
        return Ok(candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.to_path_buf()));
    }

    absolute_path(current_dir.join("apps/web/dist"), &current_dir)
}

fn absolute_path(path: PathBuf, current_dir: &std::path::Path) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path
    } else {
        current_dir.join(path)
    };
    std::path::absolute(path).map_err(|error| format!("无法解析 WEB_DIST：{error}"))
}

fn parse_ice_servers() -> Result<Vec<IceServerConfig>, String> {
    let servers = match env::var("ICE_SERVERS_JSON") {
        Ok(value) => serde_json::from_str::<Vec<IceServerConfig>>(&value)
            .map_err(|error| format!("ICE_SERVERS_JSON 格式无效：{error}"))?,
        Err(_) => default_ice_servers(),
    };
    validate_ice_servers(&servers)?;
    Ok(servers)
}

fn validate_ice_servers(servers: &[IceServerConfig]) -> Result<(), String> {
    if servers.is_empty() {
        return Err("ICE_SERVERS_JSON 至少需要一个 ICE server".to_owned());
    }

    for server in servers {
        let urls = server.urls.values();
        if urls.is_empty() || urls.iter().any(|url| url.trim().is_empty()) {
            return Err("ICE server 的 urls 不能为空".to_owned());
        }
        if server.username.is_some() || server.credential.is_some() {
            return Err("ICE_SERVERS_JSON 不允许包含凭据".to_owned());
        }
        if urls
            .iter()
            .any(|url| url.starts_with("turn:") || url.starts_with("turns:"))
        {
            return Err(
                "ICE_SERVERS_JSON 只允许 STUN；TURN 请使用 TURN_URLS_JSON 和 TURN_SHARED_SECRET"
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn parse_turn_config() -> Result<Option<TurnConfig>, String> {
    let urls = env::var("TURN_URLS_JSON").ok();
    let shared_secret = env::var("TURN_SHARED_SECRET").ok();
    match (urls, shared_secret) {
        (None, None) => Ok(None),
        (Some(_), None) => Err("配置 TURN_URLS_JSON 时必须同时配置 TURN_SHARED_SECRET".to_owned()),
        (None, Some(_)) => Err("配置 TURN_SHARED_SECRET 时必须同时配置 TURN_URLS_JSON".to_owned()),
        (Some(urls), Some(shared_secret)) => {
            if shared_secret.trim().len() < 16 {
                return Err("TURN_SHARED_SECRET 至少需要 16 个字符".to_owned());
            }
            let urls = serde_json::from_str::<IceServerUrls>(&urls)
                .map_err(|error| format!("TURN_URLS_JSON 格式无效：{error}"))?;
            let values = urls.values();
            if values.is_empty()
                || values
                    .iter()
                    .any(|url| !(url.starts_with("turn:") || url.starts_with("turns:")))
            {
                return Err("TURN_URLS_JSON 只能包含非空的 turn: 或 turns: URL".to_owned());
            }
            let ttl_seconds = parse_bounded_u64(
                "TURN_TTL_SECONDS",
                DEFAULT_TURN_TTL_SECONDS,
                MIN_TURN_TTL_SECONDS,
                MAX_TURN_TTL_SECONDS,
            )?;
            Ok(Some(TurnConfig {
                urls,
                shared_secret,
                ttl: Duration::from_secs(ttl_seconds),
            }))
        }
    }
}

fn parse_bounded_u64(name: &str, default: u64, minimum: u64, maximum: u64) -> Result<u64, String> {
    let Some(value) = env::var_os(name) else {
        return Ok(default);
    };
    value
        .to_string_lossy()
        .parse::<u64>()
        .ok()
        .filter(|value| (minimum..=maximum).contains(value))
        .ok_or_else(|| format!("{name} 必须是 {minimum} 到 {maximum} 之间的整数"))
}

pub(crate) fn default_ice_servers() -> Vec<IceServerConfig> {
    vec![IceServerConfig {
        urls: IceServerUrls::Many(vec![
            "stun:stun.l.google.com:19302".to_owned(),
            "stun:stun1.l.google.com:19302".to_owned(),
            "stun:stun.services.mozilla.com".to_owned(),
        ]),
        username: None,
        credential: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_limit_defaults_are_bounded() {
        let limits = ResourceLimits::default();
        assert!(limits.max_connections > limits.max_connections_per_ip);
        assert!(limits.max_rooms <= limits.max_connections);
        assert_eq!(limits.max_receivers, 8);
    }

    #[test]
    fn rejects_invalid_ports() {
        assert_eq!(parse_port("5011").expect("valid port"), 5011);
        assert!(parse_port("0").is_err());
        assert!(parse_port("65536").is_err());
        assert!(parse_port("not-a-port").is_err());
    }

    #[test]
    fn rejects_static_turn_credentials_in_public_configuration() {
        let server = IceServerConfig {
            urls: IceServerUrls::One("turn:turn.example.com:3478".to_owned()),
            username: None,
            credential: None,
        };
        assert!(validate_ice_servers(&[server]).is_err());
    }

    #[test]
    fn generates_coturn_compatible_ephemeral_credentials() {
        let turn = TurnConfig {
            urls: IceServerUrls::One("turns:turn.example.com:5349".to_owned()),
            shared_secret: "0123456789abcdef".to_owned(),
            ttl: Duration::from_secs(3_600),
        };
        let server = turn
            .ephemeral_server(UNIX_EPOCH + Duration::from_secs(1_000), "camera-share")
            .expect("ephemeral TURN server");
        assert_eq!(server.username.as_deref(), Some("4600:camera-share"));
        assert_eq!(
            server.credential.as_deref(),
            Some("0+nEZmta9rUoejsKJGUY3/cLHK8=")
        );
    }
}
