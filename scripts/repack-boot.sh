#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 BASE_BOOT KERNEL_IMAGE OUT_BOOT" >&2
  exit 2
fi

BASE_BOOT="$1"
KERNEL_IMAGE="$2"
OUT_BOOT="$3"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNPACK_BOOTIMG="$ROOT_DIR/tools/mkbootimg/unpack_bootimg.py"
MKBOOTIMG="$ROOT_DIR/tools/mkbootimg/mkbootimg.py"

if [[ ! -f "$BASE_BOOT" ]]; then
  echo "missing base boot: $BASE_BOOT" >&2
  exit 1
fi

if [[ ! -f "$KERNEL_IMAGE" ]]; then
  echo "missing kernel image: $KERNEL_IMAGE" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

UNPACK_DIR="$TMP_DIR/unpack"
ARGS_FILE="$TMP_DIR/mkbootimg.args"
mkdir -p "$UNPACK_DIR" "$(dirname "$OUT_BOOT")"

python3 "$UNPACK_BOOTIMG" --boot_img "$BASE_BOOT" --out "$UNPACK_DIR" --format mkbootimg -0 > "$ARGS_FILE"
cp -f "$KERNEL_IMAGE" "$UNPACK_DIR/kernel"

mapfile -d '' -t MKBOOTIMG_ARGS < "$ARGS_FILE"
python3 "$MKBOOTIMG" "${MKBOOTIMG_ARGS[@]}" --output "$OUT_BOOT"
sha256sum "$OUT_BOOT" > "$OUT_BOOT.sha256"

echo "repacked: $OUT_BOOT"
cat "$OUT_BOOT.sha256"
