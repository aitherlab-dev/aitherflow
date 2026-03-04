use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

use super::WebState;

fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Extract token from Authorization header or `token` query param.
fn extract_token(req: &Request<Body>) -> Option<String> {
    // Check Authorization: Bearer <token>
    if let Some(auth) = req.headers().get("authorization") {
        if let Ok(val) = auth.to_str() {
            if let Some(token) = val.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    // Check ?token=<token> query parameter (for WebSocket & initial page load)
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(val) = pair.strip_prefix("token=") {
                // Simple percent-decode (tokens are hex, so this is mostly a no-op)
                return Some(percent_decode(val));
            }
        }
    }

    None
}

/// Middleware that checks for a valid auth token.
///
/// Skips auth for static file serving (paths without /api/ and /ws).
pub async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = req.uri().path();

    // Skip auth for static files (frontend assets)
    if !path.starts_with("/api/") && !path.starts_with("/ws") {
        return Ok(next.run(req).await);
    }

    match extract_token(&req) {
        Some(token) if token == state.auth_token => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
