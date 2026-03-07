use std::collections::HashMap;
use std::path::PathBuf;

use crate::config;

// Track dev server PIDs per project path
static DEV_SERVER_PIDS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[tauri::command]
pub async fn self_build(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let exe =
            std::env::current_exe().map_err(|e| format!("Cannot get exe path: {e}"))?;
        let exe_dir = exe
            .parent()
            .ok_or_else(|| "Cannot get exe dir".to_string())?;

        // In dev mode: exe is in src-tauri/target/debug/, project is 3 levels up
        let mut candidates = vec![
            exe_dir.join("../../../scripts/self-build.sh"),
            exe_dir.join("../../scripts/self-build.sh"),
        ];

        // AITHERFLOW_DIR env var for custom install location
        if let Ok(dir) = std::env::var("AITHERFLOW_DIR") {
            candidates.push(PathBuf::from(dir).join("scripts/self-build.sh"));
        }

        // Fallback: saved project path in config
        let proj_file = config::config_dir().join("project_dir.txt");
        if let Ok(path) = std::fs::read_to_string(&proj_file) {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("scripts/self-build.sh"));
            }
        }

        let script_path = candidates
            .into_iter()
            .map(|p| p.canonicalize().unwrap_or(p))
            .find(|p| p.exists())
            .ok_or_else(|| "self-build.sh not found".to_string())?;

        // Verify script is under $HOME (canonicalized to prevent symlink bypass)
        let home = PathBuf::from(
            std::env::var("HOME").map_err(|_| "HOME not set".to_string())?
        );
        let home = home.canonicalize().unwrap_or(home);
        let script_resolved = script_path.canonicalize().unwrap_or(script_path.clone());
        if !script_resolved.starts_with(&home) {
            return Err(format!(
                "self-build.sh must be under HOME ({}), found: {}",
                home.display(),
                script_resolved.display()
            ));
        }

        // Launch detached process (survives after app exit)
        std::process::Command::new("bash")
            .arg(&script_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch self-build: {e}"))?;

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Close the app so the binary gets unlocked
    app.exit(0);

    Ok(())
}

#[tauri::command]
pub async fn self_dev(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let project_dir = PathBuf::from(&project_path);
        if !project_dir.exists() {
            return Err(format!("Project dir not found: {project_path}"));
        }

        // Canonicalize to resolve symlinks before checking
        let project_dir = project_dir
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?;

        // Verify resolved path is under $HOME
        let home = PathBuf::from(
            std::env::var("HOME").map_err(|_| "HOME not set".to_string())?
        );
        let home = home
            .canonicalize()
            .unwrap_or(home);
        if !project_dir.starts_with(&home) {
            return Err(format!(
                "Project dir must be under HOME ({}), found: {}",
                home.display(),
                project_dir.display()
            ));
        }

        // Read package.json
        let pkg_json_path = project_dir.join("package.json");
        if !pkg_json_path.exists() {
            return Err("No package.json found in project directory".to_string());
        }

        let pkg_content = std::fs::read_to_string(&pkg_json_path)
            .map_err(|e| format!("Cannot read package.json: {e}"))?;
        let pkg: serde_json::Value = serde_json::from_str(&pkg_content)
            .map_err(|e| format!("Cannot parse package.json: {e}"))?;

        // Check if it's a Tauri project
        let is_tauri = ["dependencies", "devDependencies"].iter().any(|section| {
            pkg.get(section)
                .and_then(|v| v.as_object())
                .map(|deps| deps.keys().any(|k| k.starts_with("@tauri-apps/")))
                .unwrap_or(false)
        });

        // Detect package manager by lock file
        let pm = if project_dir.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if project_dir.join("yarn.lock").exists() {
            "yarn"
        } else if project_dir.join("bun.lockb").exists()
            || project_dir.join("bun.lock").exists()
        {
            "bun"
        } else {
            "npm"
        };

        let (cmd_name, cmd_args) = if is_tauri {
            (pm.to_string(), vec!["tauri".to_string(), "dev".to_string()])
        } else {
            let has_dev = pkg
                .get("scripts")
                .and_then(|s| s.get("dev"))
                .is_some();
            if has_dev {
                (pm.to_string(), vec!["run".to_string(), "dev".to_string()])
            } else {
                return Err("No 'dev' script in package.json".to_string());
            }
        };

        let display = format!("{} {}", cmd_name, cmd_args.join(" "));

        let mut dev_cmd = std::process::Command::new(&cmd_name);
        dev_cmd.args(&cmd_args).current_dir(&project_dir);

        // WebKitGTK workarounds for Tauri projects (Linux-only)
        #[cfg(target_os = "linux")]
        if is_tauri {
            dev_cmd
                .env("GDK_BACKEND", "x11")
                .env("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
                .env("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        // Create new process group so we can kill all children later
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            dev_cmd.process_group(0);
        }

        let child = dev_cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch '{display}': {e}"))?;

        // Save PID for stop_dev
        let mut pids = DEV_SERVER_PIDS.lock().unwrap_or_else(|e| e.into_inner());
        pids.insert(project_path, child.id());

        Ok::<String, String>(display)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn stop_dev(project_path: String) -> Result<(), String> {
    let pid = {
        let mut pids = DEV_SERVER_PIDS.lock().unwrap_or_else(|e| e.into_inner());
        pids.remove(&project_path)
    };

    if let Some(pid) = pid {
        tokio::task::spawn_blocking(move || {
            // Kill process group to stop all children (vite, cargo, etc.)
            let group_ok = std::process::Command::new("kill")
                .args(["--", &format!("-{pid}")])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            // Fallback: kill direct process only if group kill failed
            if !group_ok {
                if let Err(e) = std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .output()
                {
                    eprintln!("[devtools] Failed to kill dev server process {pid}: {e}");
                }
            }
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))?;
        Ok(())
    } else {
        Err("No dev server running for this project".to_string())
    }
}
