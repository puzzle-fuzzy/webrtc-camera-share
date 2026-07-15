use std::{env, net::SocketAddr, path::PathBuf};

pub struct Config {
    pub address: SocketAddr,
    pub web_dist: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = parse_port(&env::var("PORT").unwrap_or_else(|_| "5011".to_owned()))?;
        let address = format!("{host}:{port}")
            .parse::<SocketAddr>()
            .map_err(|_| format!("HOST 不是有效的 IP 地址：{host}"))?;
        let web_dist = env::var_os("WEB_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("apps/web/dist"));

        Ok(Self { address, web_dist })
    }
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| "PORT 必须是 1 到 65535 之间的整数".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{Config, parse_port};

    #[test]
    fn config_shape_is_stable() {
        let config = Config {
            address: "127.0.0.1:5011".parse().expect("valid address"),
            web_dist: "apps/web/dist".into(),
        };

        assert_eq!(config.address.port(), 5011);
        assert_eq!(config.web_dist.to_string_lossy(), "apps/web/dist");
    }

    #[test]
    fn rejects_invalid_ports() {
        assert_eq!(parse_port("5011").expect("valid port"), 5011);
        assert!(parse_port("0").is_err());
        assert!(parse_port("65536").is_err());
        assert!(parse_port("not-a-port").is_err());
    }
}
