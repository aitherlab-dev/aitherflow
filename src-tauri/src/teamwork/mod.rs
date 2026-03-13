pub mod mailbox;
pub mod tasks;
pub mod team;

/// Validate that a name (team, agent_id, task_id) is safe for use in file paths.
/// Rejects path separators, traversal components, and empty strings.
fn validate_name(name: &str, label: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if name.contains('/')
        || name.contains('\\')
        || name == ".."
        || name == "."
        || name.contains('\0')
    {
        return Err(format!("Invalid {label}: '{name}'"));
    }
    Ok(())
}
