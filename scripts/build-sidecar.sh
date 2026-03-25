#!/bin/bash
set -euo pipefail

# Build mcp-image-gen sidecar binary.
# Automatically enables CUDA feature when CUDA toolkit is detected.
# Usage:
#   bash scripts/build-sidecar.sh           # debug build
#   bash scripts/build-sidecar.sh --release # release build

RELEASE=""
PROFILE="debug"
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE="--release"; PROFILE="release" ;;
  esac
done

# Detect CUDA
FEATURES=""
if [ -n "${CUDA_PATH:-}" ] || [ -f "/opt/cuda/lib64/libcudart.so" ]; then
  FEATURES="--features cuda"
  # Ensure CUDA_PATH is set for the build
  export CUDA_PATH="${CUDA_PATH:-/opt/cuda}"
  echo "[sidecar] CUDA detected at $CUDA_PATH — building with GPU support"
else
  echo "[sidecar] No CUDA detected — building CPU-only"
fi

# Build
cargo build -p mcp-image-gen $RELEASE $FEATURES

# Copy to sidecar location
TARGET_TRIPLE=$(rustc -vV | grep host | cut -d' ' -f2)
DEST="src-tauri/binaries/mcp-image-gen-${TARGET_TRIPLE}"
cp "target/${PROFILE}/mcp-image-gen" "$DEST"
echo "[sidecar] Copied to $DEST"
