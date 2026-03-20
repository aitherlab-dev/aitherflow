/// Fetch a web page and extract its text content.
pub async fn fetch_article(url: &str) -> Result<String, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to fetch URL: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}: {url}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    let text = html2text::from_read(html.as_bytes(), 200)
        .map_err(|e| format!("Failed to convert HTML to text: {e}"))?;

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err(format!("No text content found at: {url}"));
    }

    Ok(trimmed)
}
