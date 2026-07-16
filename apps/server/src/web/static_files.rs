use std::path::PathBuf;

use axum::Router;

#[cfg(not(feature = "embed-web"))]
use tower_http::services::{ServeDir, ServeFile};

#[cfg(feature = "embed-web")]
use {
    axum::{
        body::Body,
        http::{StatusCode, Uri, header::CONTENT_TYPE},
        response::{IntoResponse, Response},
    },
    rust_embed::RustEmbed,
};

#[cfg(feature = "embed-web")]
#[derive(RustEmbed)]
#[folder = "../web/dist/"]
struct WebAssets;

#[cfg(not(feature = "embed-web"))]
pub(crate) fn mount<S>(router: Router<S>, web_dist: PathBuf) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let index_path = web_dist.join("index.html");
    router
        .nest_service("/assets", ServeDir::new(web_dist.join("assets")))
        .fallback_service(ServeFile::new(index_path))
}

#[cfg(feature = "embed-web")]
pub(crate) fn mount<S>(router: Router<S>, _web_dist: PathBuf) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.fallback(embedded_asset)
}

#[cfg(not(feature = "embed-web"))]
pub(crate) fn is_ready(web_dist: &std::path::Path) -> bool {
    web_dist.join("index.html").is_file()
}

#[cfg(feature = "embed-web")]
pub(crate) fn is_ready(_web_dist: &std::path::Path) -> bool {
    WebAssets::get("index.html").is_some()
}

#[cfg(feature = "embed-web")]
async fn embedded_asset(uri: Uri) -> Response {
    let request_path = uri.path().trim_start_matches('/');
    let asset_path = if request_path.starts_with("assets/") {
        request_path
    } else {
        "index.html"
    };

    let Some(asset) = WebAssets::get(asset_path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = mime_guess::from_path(asset_path).first_or_octet_stream();
    Response::builder()
        .header(CONTENT_TYPE, content_type.as_ref())
        .body(Body::from(asset.data))
        .expect("embedded asset response is valid")
}
