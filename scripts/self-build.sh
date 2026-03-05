#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="aitherflow"
BIN_NAME="aitherflow-beta"
LOG_FILE="$HOME/.local/share/aither-flow/build.log"

# Ensure log dir exists
mkdir -p "$(dirname "$LOG_FILE")"

# Redirect all output to log file
exec > "$LOG_FILE" 2>&1

# Kill all running instances and wait for the binary to be unlocked
BIN_PATH="$HOME/.local/bin/$BIN_NAME"
pkill -f "$BIN_PATH" 2>/dev/null || true
for i in $(seq 1 30); do
    if ! fuser "$BIN_PATH" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo "=== Self-Build: building $APP_NAME ==="
echo "=== $(date) ==="

cd "$PROJECT_DIR"

# Build the Tauri app in release mode (no-bundle — we only need the binary)
if pnpm tauri build --no-bundle; then
    echo "=== Self-Build: build successful ==="

    # Find the built binary — Tauri puts it in project root target/
    BUILT_BIN="$PROJECT_DIR/target/release/$APP_NAME"
    if [ ! -f "$BUILT_BIN" ]; then
        echo "=== Self-Build: ERROR: binary not found at $BUILT_BIN ==="
        notify-send -u critical "$APP_NAME" "Build succeeded but binary not found!" 2>/dev/null || true
        exit 1
    fi

    # Install to ~/.local/bin/
    mkdir -p "$HOME/.local/bin"
    cp "$BUILT_BIN" "$HOME/.local/bin/$BIN_NAME"
    chmod +x "$HOME/.local/bin/$BIN_NAME"
    echo "=== Self-Build: installed to ~/.local/bin/$BIN_NAME ==="

    # Install memory MCP sidecar (found via PATH by the app)
    MEMORY_BIN="$PROJECT_DIR/target/release/aither-flow-memory"
    if [ -f "$MEMORY_BIN" ]; then
        cp "$MEMORY_BIN" "$HOME/.local/bin/aither-flow-memory"
        chmod +x "$HOME/.local/bin/aither-flow-memory"
        echo "=== Self-Build: installed aither-flow-memory to ~/.local/bin/ ==="
    else
        echo "=== Self-Build: WARNING: aither-flow-memory not found, session memory won't work ==="
    fi

    # Save project dir so production binary can find us next time
    mkdir -p "$HOME/.config/aither-flow"
    echo "$PROJECT_DIR" > "$HOME/.config/aither-flow/project_dir.txt"

    # Copy icon if available
    ICON_SRC="$PROJECT_DIR/src-tauri/icons/icon.png"
    if [ -f "$ICON_SRC" ]; then
        ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
        mkdir -p "$ICON_DIR"
        cp "$ICON_SRC" "$ICON_DIR/$APP_NAME.png"
    fi

    # Create/update .desktop file
    DESKTOP_DIR="$HOME/.local/share/applications"
    mkdir -p "$DESKTOP_DIR"
    cat > "$DESKTOP_DIR/$APP_NAME.desktop" << EOF
[Desktop Entry]
Name=Aither Flow
Comment=GUI for Claude Code CLI
Exec=env GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 $HOME/.local/bin/$BIN_NAME
Icon=$APP_NAME
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=$APP_NAME
EOF

    notify-send "$APP_NAME" "Build complete, launching..." 2>/dev/null || true

    # Launch the new version (WebKitGTK needs X11 backend on Wayland)
    export GDK_BACKEND=x11
    export WEBKIT_DISABLE_COMPOSITING_MODE=1
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    nohup "$HOME/.local/bin/$BIN_NAME" >/dev/null 2>&1 &
else
    echo "=== Self-Build: BUILD FAILED ==="
    notify-send -u critical "$APP_NAME" "Build failed! Check ~/.local/share/aither-flow/build.log" 2>/dev/null || true
    exit 1
fi
