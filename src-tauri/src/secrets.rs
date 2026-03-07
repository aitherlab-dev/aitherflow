use keyring::Entry;

const SERVICE: &str = "aitherflow";

/// Store a secret in the system keyring. Returns Ok(true) if stored,
/// Ok(false) if keyring is unavailable (falls back silently).
pub fn set_secret(key: &str, value: &str) -> Result<bool, String> {
    if value.is_empty() {
        return delete_secret(key).map(|_| true);
    }
    match Entry::new(SERVICE, key) {
        Ok(entry) => {
            entry
                .set_password(value)
                .map_err(|e| format!("Failed to store secret '{key}': {e}"))?;
            Ok(true)
        }
        Err(e) => {
            eprintln!("[secrets] Keyring unavailable for '{key}': {e}");
            Ok(false)
        }
    }
}

/// Retrieve a secret from the system keyring. Returns None if not found
/// or keyring unavailable.
pub fn get_secret(key: &str) -> Option<String> {
    match Entry::new(SERVICE, key) {
        Ok(entry) => match entry.get_password() {
            Ok(pw) => Some(pw),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                eprintln!("[secrets] Failed to read '{key}': {e}");
                None
            }
        },
        Err(e) => {
            eprintln!("[secrets] Keyring unavailable for '{key}': {e}");
            None
        }
    }
}

/// Delete a secret from the keyring. Ignores "not found" errors.
pub fn delete_secret(key: &str) -> Result<(), String> {
    match Entry::new(SERVICE, key) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Failed to delete secret '{key}': {e}")),
        },
        Err(_) => Ok(()),
    }
}
