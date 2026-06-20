#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/work-unpack}"
MERGED_FRAGMENT="$WORK_DIR/pine-docker-unpack.fragment"

mkdir -p "$WORK_DIR"
cat \
  "$ROOT_DIR/config/docker-required.fragment" \
  "$ROOT_DIR/config/unpack-hook-android12.fragment" \
  > "$MERGED_FRAGMENT"

export WORK_DIR
export FRAGMENT="$MERGED_FRAGMENT"
export KERNEL_PATCH_DIR="$ROOT_DIR/patches/kernel/unpack-hook-android12"
exec bash "$ROOT_DIR/scripts/build-pine-docker-kernel.sh"
