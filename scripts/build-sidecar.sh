#!/usr/bin/env bash
# Build the aither-flow-memory sidecar binary and place it where Tauri expects.
# Tauri externalBin requires: binaries/<name>-<target-triple>
set -euo pipefail

TARGET="${1:-$(rustc -vV | grep host | cut -d' ' -f2)}"
PROFILE="${2:-release}"

echo "[sidecar] Building aither-flow-memory ($PROFILE, $TARGET)..."

if [ "$PROFILE" = "release" ]; then
    cargo build -p aither-flow-memory --release --target "$TARGET"
    SRC="target/$TARGET/release/aither-flow-memory"
else
    cargo build -p aither-flow-memory --target "$TARGET"
    SRC="target/$TARGET/debug/aither-flow-memory"
fi

DEST="src-tauri/binaries/aither-flow-memory-$TARGET"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "[sidecar] Copied to $DEST"
