use std::{env, net::SocketAddr, path::PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_CONNECTIONS: usize = 256;
pub const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 32;
pub const DEFAULT_MAX_RECEIVERS: usize = 8;
pub const DEFAULT_MAX_ROOMS: usize = 128;

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

pub struct Config {
    pub address: SocketAddr,
    pub web_dist: PathBuf,
    pub limits: ResourceLimits,
    pub ice_servers: Vec<IceServerConfig>,
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
            max_connections: parse_positive_usize("MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS)?,
            max_connections_per_ip: parse_positive_usize(
                "MAX_CONNECTIONS_PER_IP",
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            max_receivers: parse_positive_usize("MAX_RECEIVERS", DEFAULT_MAX_RECEIVERS)?,
            max_rooms: parse_positive_usize("MAX_ROOMS", DEFAULT_MAX_ROOMS)?,
        };
        if limits.max_connections_per_ip > limits.max_connections {
            return Err("MAX_CONNECTIONS_PER_IP 不能大于 MAX_CONNECTIONS".to_owned());
        }

        Ok(Self {
            address,
            web_dist: resolve_web_dist()?,
            limits,
            ice_servers: parse_ice_servers()?,
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

fn parse_positive_usize(name: &str, default: usize) -> Result<usize, String> {
    let Some(value) = env::var_os(name) else {
        return Ok(default);
    };
    value
        .to_string_lossy()
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} 必须是正整数"))
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
        let uses_turn = urls
            .iter()
            .any(|url| url.starts_with("turn:") || url.starts_with("turns:"));
        if uses_turn
            && (server.username.as_deref().unwrap_or_default().is_empty()
                || server.credential.as_deref().unwrap_or_default().is_empty())
        {
            return Err("TURN server 必须同时配置 username 和 credential".to_owned());
        }
    }
    Ok(())
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
    fn validates_turn_credentials() {
        let server = IceServerConfig {
            urls: IceServerUrls::One("turn:turn.example.com:3478".to_owned()),
            username: None,
            credential: None,
        };
        assert!(validate_ice_servers(&[server]).is_err());

        let server = IceServerConfig {
            urls: IceServerUrls::One("turns:turn.example.com:5349".to_owned()),
            username: Some("user".to_owned()),
            credential: Some("secret".to_owned()),
        };
        assert!(validate_ice_servers(&[server]).is_ok());
    }
}
