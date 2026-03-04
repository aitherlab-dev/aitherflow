fn main() {
    // Ensure dist/ exists for include_dir! macro (even if frontend not built yet)
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let dist = std::path::Path::new(&manifest).join("../dist");
    if !dist.exists() {
        std::fs::create_dir_all(&dist).ok();
        std::fs::write(
            dist.join("index.html"),
            "<html><body>Frontend not built. Run: pnpm build</body></html>",
        )
        .ok();
    }

    tauri_build::build()
}
