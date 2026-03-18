use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// Validate a git branch name: reject traversal, spaces, and shell-dangerous characters.
fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.contains("..") || name.contains('/') && name.contains("..") {
        return Err(format!("Invalid branch name (path traversal): {name}"));
    }
    // Reject characters dangerous for shell injection or invalid for git refs
    let forbidden = [' ', '\t', '\n', '~', '^', ':', '\\', '*', '?', '[', '\x7f'];
    for ch in forbidden {
        if name.contains(ch) {
            return Err(format!("Invalid branch name (forbidden char '{ch}'): {name}"));
        }
    }
    if name.starts_with('-') || name.starts_with('.') || name.ends_with('.') || name.ends_with(".lock") {
        return Err(format!("Invalid branch name: {name}"));
    }
    Ok(())
}

/// A single git worktree entry
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub is_bare: bool,
}

/// Git status summary for a worktree
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub changed_files: u32,
    pub untracked_files: u32,
    pub staged_files: u32,
    pub last_commit: String,
}

/// List all worktrees for the git repo at `project_path`.
#[tauri::command]
pub async fn get_worktrees(project_path: String) -> Result<Vec<WorktreeEntry>, String> {
    tokio::task::spawn_blocking(move || {
        crate::files::validate_path_safe(Path::new(&project_path))?;
        let output = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to run git worktree list: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree list failed: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_branch = String::new();
        let mut is_bare = false;

        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                // Save previous entry if exists
                if let Some(prev_path) = current_path.take() {
                    entries.push(WorktreeEntry {
                        path: prev_path,
                        branch: std::mem::take(&mut current_branch),
                        is_bare,
                    });
                    is_bare = false;
                }
                current_path = Some(path.to_string());
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                // "branch refs/heads/main" → "main"
                current_branch = branch_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch_ref)
                    .to_string();
            } else if line == "bare" {
                is_bare = true;
            } else if line == "detached" {
                current_branch = "(detached)".to_string();
            }
        }

        // Don't forget the last entry
        if let Some(path) = current_path {
            entries.push(WorktreeEntry {
                path,
                branch: current_branch,
                is_bare,
            });
        }

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Get git status summary for a specific directory.
#[tauri::command]
pub async fn get_git_status(project_path: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || {
        let dir = Path::new(&project_path);
        crate::files::validate_path_safe(dir)?;

        // Current branch
        let branch_output = Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(dir)
            .output()
            .map_err(|e| format!("git branch failed: {e}"))?;
        let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();

        // Status counts
        let status_output = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(dir)
            .output()
            .map_err(|e| format!("git status failed: {e}"))?;
        let status_text = String::from_utf8_lossy(&status_output.stdout);

        let mut changed: u32 = 0;
        let mut untracked: u32 = 0;
        let mut staged: u32 = 0;

        for line in status_text.lines() {
            if line.len() < 2 {
                continue;
            }
            let bytes = line.as_bytes();
            let x = bytes[0]; // index (staged)
            let y = bytes[1]; // working tree

            if x == b'?' {
                untracked += 1;
            } else {
                if x != b' ' && x != b'?' {
                    staged += 1;
                }
                if y != b' ' && y != b'?' {
                    changed += 1;
                }
            }
        }

        // Last commit (short)
        let log_output = Command::new("git")
            .args(["log", "-1", "--format=%s", "--no-decorate"])
            .current_dir(dir)
            .output()
            .map_err(|e| format!("git log failed: {e}"))?;
        let last_commit = String::from_utf8_lossy(&log_output.stdout).trim().to_string();

        Ok(GitStatus {
            branch,
            changed_files: changed,
            untracked_files: untracked,
            staged_files: staged,
            last_commit,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// A changed file entry from `git status --short`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Two-char status code, e.g. "M ", " M", "??", "A ", "D "
    pub status: String,
    /// Relative file path
    pub path: String,
}

/// A recent commit entry.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommit {
    pub hash: String,
    pub message: String,
    pub relative_time: String,
}

/// Detailed info for a single worktree directory.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDetails {
    pub changed_files: Vec<ChangedFile>,
    pub recent_commits: Vec<RecentCommit>,
}

/// Get changed files and recent commits for a worktree directory.
#[tauri::command]
pub async fn get_worktree_details(
    worktree_path: String,
    commit_count: Option<u32>,
) -> Result<WorktreeDetails, String> {
    tokio::task::spawn_blocking(move || {
        let dir = Path::new(&worktree_path);
        crate::files::validate_path_safe(dir)?;
        let n = commit_count.unwrap_or(5);

        // Changed files via git status --short
        let status_output = Command::new("git")
            .args(["status", "--short"])
            .current_dir(dir)
            .output()
            .map_err(|e| format!("git status failed: {e}"))?;

        let status_text = String::from_utf8_lossy(&status_output.stdout);
        let changed_files: Vec<ChangedFile> = status_text
            .lines()
            .filter(|line| line.len() >= 4)
            .map(|line| {
                let status = line[..2].to_string();
                let path = line[3..].to_string();
                ChangedFile { status, path }
            })
            .collect();

        // Recent commits via git log
        let log_output = Command::new("git")
            .args([
                "log",
                &format!("-{n}"),
                "--format=%h\t%s\t%cr",
                "--no-decorate",
            ])
            .current_dir(dir)
            .output()
            .map_err(|e| format!("git log failed: {e}"))?;

        let log_text = String::from_utf8_lossy(&log_output.stdout);
        let recent_commits: Vec<RecentCommit> = log_text
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\t');
                let hash = parts.next()?.to_string();
                let message = parts.next()?.to_string();
                let relative_time = parts.next()?.to_string();
                Some(RecentCommit {
                    hash,
                    message,
                    relative_time,
                })
            })
            .collect();

        Ok(WorktreeDetails {
            changed_files,
            recent_commits,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Result of creating a worktree.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeResult {
    pub path: String,
    pub branch: String,
}

/// Options for creating a worktree.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeOptions {
    pub project_path: String,
    pub branch_name: String,
    /// If true, create a new branch (-b). If false, checkout existing branch.
    pub create_branch: bool,
}

/// Create a new git worktree. The worktree directory is placed next to the project
/// as `<project_dir>-<branch_name>`.
#[tauri::command]
pub async fn create_worktree(options: CreateWorktreeOptions) -> Result<CreateWorktreeResult, String> {
    tokio::task::spawn_blocking(move || {
        let project = Path::new(&options.project_path);
        crate::files::validate_path_safe(project)?;
        validate_branch_name(&options.branch_name)?;

        let parent = project
            .parent()
            .ok_or_else(|| "Cannot determine parent directory".to_string())?;
        let project_name = project
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project");

        let worktree_dir = parent.join(format!("{}-{}", project_name, options.branch_name));
        let worktree_path = worktree_dir.to_string_lossy().to_string();

        let mut args = vec!["worktree", "add"];
        if options.create_branch {
            args.push("-b");
            args.push(&options.branch_name);
        }
        args.push("--");
        args.push(&worktree_path);
        if !options.create_branch {
            args.push(&options.branch_name);
        }

        let output = Command::new("git")
            .args(&args)
            .current_dir(&options.project_path)
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {stderr}"));
        }

        Ok(CreateWorktreeResult {
            path: worktree_path,
            branch: options.branch_name,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Remove a git worktree and its associated branch.
#[tauri::command]
pub async fn remove_worktree(project_path: String, worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::files::validate_path_safe(Path::new(&project_path))?;
        crate::files::validate_path_safe(Path::new(&worktree_path))?;

        // First, find which branch is attached to this worktree
        let list_output = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to run git worktree list: {e}"))?;

        let list_text = String::from_utf8_lossy(&list_output.stdout);
        let mut branch_to_delete: Option<String> = None;
        let mut found_path = false;

        for line in list_text.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                found_path = path == worktree_path;
            } else if found_path {
                if let Some(branch_ref) = line.strip_prefix("branch ") {
                    branch_to_delete = Some(
                        branch_ref
                            .strip_prefix("refs/heads/")
                            .unwrap_or(branch_ref)
                            .to_string(),
                    );
                    break;
                } else if line.is_empty() {
                    break;
                }
            }
        }

        // Remove the worktree
        let output = Command::new("git")
            .args(["worktree", "remove", &worktree_path, "--force"])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to run git worktree remove: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree remove failed: {stderr}"));
        }

        // Delete the branch that was attached to this worktree
        if let Some(branch) = branch_to_delete {
            let del_output = Command::new("git")
                .args(["branch", "-d", &branch])
                .current_dir(&project_path)
                .output()
                .map_err(|e| format!("Failed to delete branch: {e}"))?;

            if !del_output.status.success() {
                let stderr = String::from_utf8_lossy(&del_output.stderr);
                eprintln!("Could not delete branch '{branch}': {stderr}");
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
