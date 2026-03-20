use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB

/// Fetch a web page and extract its text content.
pub async fn fetch_article(url: &str) -> Result<String, String> {
    validate_url(url)?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}: {url}", response.status()));
    }

    // Check Content-Length if available
    if let Some(len) = response.content_length() {
        if len > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response too large ({} MB, limit {} MB)",
                len / 1024 / 1024,
                MAX_RESPONSE_SIZE / 1024 / 1024
            ));
        }
    }

    // Read body in chunks with size limit
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() as u64 > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response too large (>{} MB, limit {} MB)",
                MAX_RESPONSE_SIZE / 1024 / 1024,
                MAX_RESPONSE_SIZE / 1024 / 1024
            ));
        }
    }
    let html = String::from_utf8_lossy(&body);
    let text = html2text::from_read(html.as_bytes(), 200)
        .map_err(|e| format!("Failed to convert HTML to text: {e}"))?;

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err(format!("No text content found at: {url}"));
    }

    Ok(trimmed)
}

/// Validate URL: must be http/https, not localhost or internal IPs.
fn validate_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http:// and https:// URLs are supported".into());
    }

    // Extract host portion
    let host = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");

    let host_lower = host.to_lowercase();

    // Block localhost
    if host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "0.0.0.0" || host_lower == "[::1]" {
        return Err("Localhost URLs are not allowed".into());
    }

    // Block AWS metadata endpoint and link-local
    if host_lower.starts_with("169.254.") || host_lower.starts_with("10.") || host_lower.starts_with("192.168.") {
        return Err("Internal/private IP addresses are not allowed".into());
    }

    // Block 172.16.0.0/12
    if host_lower.starts_with("172.") {
        if let Some(second) = host_lower.strip_prefix("172.").and_then(|r| r.split('.').next()) {
            if let Ok(n) = second.parse::<u8>() {
                if (16..=31).contains(&n) {
                    return Err("Internal/private IP addresses are not allowed".into());
                }
            }
        }
    }

    // Block IPv6 private ranges: fc00::/7 (ULA), fe80::/10 (link-local)
    // and IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, etc.)
    let bare_host = host_lower.trim_start_matches('[').trim_end_matches(']');
    if bare_host.starts_with("fc")
        || bare_host.starts_with("fd")
        || bare_host.starts_with("fe80")
        || bare_host.starts_with("::ffff:")
    {
        return Err("Internal/private IPv6 addresses are not allowed".into());
    }

    Ok(())
}
