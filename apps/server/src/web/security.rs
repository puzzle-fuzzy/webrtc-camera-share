use std::net::IpAddr;

use axum::{
    body::Body,
    http::{
        HeaderMap, HeaderName, HeaderValue, Request,
        header::{CACHE_CONTROL, REFERRER_POLICY},
    },
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

pub(crate) fn client_ip(headers: &HeaderMap, direct_ip: IpAddr, trust_proxy: bool) -> IpAddr {
    if !trust_proxy {
        return direct_ip;
    }

    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<IpAddr>().ok())
        })
        .unwrap_or(direct_ip)
}

pub(crate) async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let asset_request = request.uri().path().starts_with("/assets/");
    let request_id = Uuid::new_v4().to_string();
    let mut response = next.run(request).await;
    let immutable_asset = asset_request && response.status().is_success();
    let headers = response.headers_mut();
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static(if immutable_asset {
            "public, max-age=31536000, immutable"
        } else {
            "no-store"
        }),
    );
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(self), microphone=()"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("x-request-id"),
        HeaderValue::from_str(&request_id).expect("UUID is a valid header value"),
    );
    response
}
