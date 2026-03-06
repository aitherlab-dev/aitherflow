use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

use super::WebState;

/// Max failed auth attempts per IP before blocking.
const MAX_FAILURES: u32 = 10;
/// Window in seconds — failures older than this are forgotten.
const WINDOW_SECS: u64 = 300; // 5 minutes
/// One-time auth codes expire after 5 minutes.
const CODE_TTL_SECS: u64 = 300;
/// Session cookies expire after 7 days.
const SESSION_TTL_SECS: u64 = 7 * 24 * 3600;

fn generate_hex(len: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..len).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Rate Limiter ────────────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct RateLimiter {
    failures: Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    async fn record_failure(&self, ip: IpAddr) -> bool {
        let mut map = self.failures.lock().await;
        let now = Instant::now();
        let entry = map.entry(ip).or_insert((0, now));
        if now.duration_since(entry.1).as_secs() > WINDOW_SECS {
            *entry = (1, now);
            return false;
        }
        entry.0 += 1;
        entry.0 >= MAX_FAILURES
    }

    async fn is_blocked(&self, ip: IpAddr) -> bool {
        let mut map = self.failures.lock().await;
        if let Some(entry) = map.get(&ip) {
            let now = Instant::now();
            if now.duration_since(entry.1).as_secs() > WINDOW_SECS {
                map.remove(&ip);
                return false;
            }
            return entry.0 >= MAX_FAILURES;
        }
        false
    }

    async fn clear(&self, ip: IpAddr) {
        self.failures.lock().await.remove(&ip);
    }
}

// ── Session Store ───────────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct SessionStore {
    /// One-time auth codes → creation time
    codes: Arc<Mutex<HashMap<String, Instant>>>,
    /// Active session tokens → creation time
    sessions: Arc<Mutex<HashMap<String, Instant>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new session directly (e.g. when master token is verified).
    pub async fn create_session(&self) -> String {
        let session_token = generate_hex(32);
        self.sessions
            .lock()
            .await
            .insert(session_token.clone(), Instant::now());
        session_token
    }

    /// Create a one-time auth code (valid for 5 minutes).
    pub async fn create_code(&self) -> String {
        let code = generate_hex(16); // 32 hex chars
        self.codes.lock().await.insert(code.clone(), Instant::now());
        code
    }

    /// Validate and consume a one-time code. Returns a session token on success.
    pub async fn exchange_code(&self, code: &str) -> Option<String> {
        let mut codes = self.codes.lock().await;
        if let Some(created) = codes.remove(code) {
            if Instant::now().duration_since(created).as_secs() <= CODE_TTL_SECS {
                let session_token = generate_hex(32); // 64 hex chars
                self.sessions
                    .lock()
                    .await
                    .insert(session_token.clone(), Instant::now());
                return Some(session_token);
            }
        }
        None
    }

    /// Check if a session token is valid.
    async fn validate_session(&self, token: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        if let Some(created) = sessions.get(token) {
            if Instant::now().duration_since(*created).as_secs() <= SESSION_TTL_SECS {
                return true;
            }
            // Expired — remove
            sessions.remove(token);
        }
        false
    }

    /// Remove all expired codes and sessions.
    pub async fn cleanup_expired(&self) {
        let now = Instant::now();
        {
            let mut codes = self.codes.lock().await;
            codes.retain(|_, created| now.duration_since(*created).as_secs() <= CODE_TTL_SECS);
        }
        {
            let mut sessions = self.sessions.lock().await;
            sessions
                .retain(|_, created| now.duration_since(*created).as_secs() <= SESSION_TTL_SECS);
        }
    }

    /// Spawn a background task that periodically cleans up expired entries.
    pub fn spawn_cleanup_task(&self) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
            loop {
                interval.tick().await;
                store.cleanup_expired().await;
            }
        });
    }
}

// ── Token extraction ────────────────────────────────────────────────

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

/// Extract session token from cookie.
fn extract_session_cookie(req: &Request<Body>) -> Option<String> {
    let cookie_header = req.headers().get("cookie")?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix("af_session=") {
            return Some(val.to_string());
        }
    }
    None
}

/// Extract bearer token from Authorization header or query param.
fn extract_bearer(req: &Request<Body>) -> Option<String> {
    if let Some(auth) = req.headers().get("authorization") {
        if let Ok(val) = auth.to_str() {
            if let Some(token) = val.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(val) = pair.strip_prefix("token=") {
                return Some(percent_decode(val));
            }
        }
    }
    None
}

// ── CSRF Origin check ──────────────────────────────────────────────

/// Check that Origin (or Referer) header matches the request Host.
/// Returns `true` if there's no Origin/Referer (e.g. same-origin non-fetch requests)
/// or if the origin host matches the Host header.
fn check_origin_matches_host(req: &Request<Body>) -> bool {
    let host = match req.headers().get("host").and_then(|h| h.to_str().ok()) {
        Some(h) => h,
        None => return true, // No Host header — can't validate
    };
    // Strip port from host for comparison
    let host_name = host.split(':').next().unwrap_or(host);

    // Try Origin first, then Referer
    let origin_value = req
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .or_else(|| {
            req.headers()
                .get("referer")
                .and_then(|h| h.to_str().ok())
        });

    match origin_value {
        None => true, // No Origin/Referer — allow (non-browser clients, same-origin GET, etc.)
        Some(origin) => {
            // Extract host from Origin URL (e.g., "http://localhost:3080" → "localhost")
            if let Some(after_scheme) = origin
                .strip_prefix("http://")
                .or_else(|| origin.strip_prefix("https://"))
            {
                let origin_host = after_scheme.split('/').next().unwrap_or(after_scheme);
                let origin_name = origin_host.split(':').next().unwrap_or(origin_host);
                origin_name.eq_ignore_ascii_case(host_name)
            } else {
                // Malformed origin
                false
            }
        }
    }
}

// ── Auth middleware ──────────────────────────────────────────────────

/// Middleware: cookie session → Bearer token → reject.
/// Skips auth for static files and the /auth endpoint.
pub async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    connect_info: ConnectInfo<std::net::SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = req.uri().path();

    // If a page request (not API) arrives with ?token= in the URL,
    // validate it, issue a session cookie, and redirect to clean URL.
    // This prevents the master token from lingering in browser history.
    if !path.starts_with("/api/") && !path.starts_with("/ws") {
        if let Some(bearer) = extract_bearer(&req) {
            if bearer.as_bytes().ct_eq(state.auth_token.as_bytes()).into() {
                let session_token = state.session_store.create_session().await;
                let cookie = format!(
                    "af_session={session_token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800"
                );
                let redirect_uri = path.to_string();
                return Ok(Response::builder()
                    .status(StatusCode::FOUND)
                    .header("location", redirect_uri)
                    .header("set-cookie", cookie)
                    .body(Body::empty())
                    .unwrap());
            }
        }
        return Ok(next.run(req).await);
    }

    let ip = connect_info.0.ip();

    if state.rate_limiter.is_blocked(ip).await {
        eprintln!("[auth] Blocked request from {ip} (too many failures)");
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    // 1. Check session cookie
    if let Some(session_token) = extract_session_cookie(&req) {
        if state.session_store.validate_session(&session_token).await {
            // CSRF: cookie-based auth requires Origin/Referer to match Host
            if !check_origin_matches_host(&req) {
                eprintln!("[auth] CSRF check failed: Origin/Referer mismatch for cookie auth from {ip}");
                return Err(StatusCode::FORBIDDEN);
            }
            state.rate_limiter.clear(ip).await;
            return Ok(next.run(req).await);
        }
    }

    // 2. Check Bearer token (master auth token) — no CSRF check needed (explicit auth)
    if let Some(bearer) = extract_bearer(&req) {
        if bearer.as_bytes().ct_eq(state.auth_token.as_bytes()).into() {
            state.rate_limiter.clear(ip).await;
            return Ok(next.run(req).await);
        }
    }

    // Failed
    let blocked = state.rate_limiter.record_failure(ip).await;
    if blocked {
        eprintln!("[auth] IP {ip} blocked after {MAX_FAILURES} failed attempts");
    }
    Err(StatusCode::UNAUTHORIZED)
}
