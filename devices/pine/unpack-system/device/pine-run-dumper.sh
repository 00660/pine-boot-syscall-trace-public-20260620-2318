#!/system/bin/sh
set -eu

PACKAGE=""
OUT=""
SECONDS_TO_RUN="45"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package)
      PACKAGE="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    --seconds)
      SECONDS_TO_RUN="${2:-45}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$PACKAGE" ] || [ -z "$OUT" ]; then
  echo "usage: pine-run-dumper.sh --package <package> --out <dir> [--seconds 45]" >&2
  exit 2
fi

case "$PACKAGE" in
  *[!A-Za-z0-9._]* | "" | .* | *..* | *.)
    echo "invalid package: $PACKAGE" >&2
    exit 2
    ;;
esac

mkdir -p "$OUT"
NATIVE_TRACE_LOG="$OUT/native-syscall-trace.log"

disable_native_syscall_trace() {
  [ -w /proc/pine_syscall_trace ] && echo 0 >/proc/pine_syscall_trace 2>/dev/null || true
}

detect_app_uid() {
  uid="$(cmd package list packages -U "$PACKAGE" 2>/dev/null | sed -n 's/.* uid:\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  [ -n "$uid" ] || uid="$(dumpsys package "$PACKAGE" 2>/dev/null | sed -n 's/.*userId=\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  printf '%s\n' "$uid" | tr -cd '0-9'
}

enable_native_syscall_trace() {
  [ -w /proc/pine_syscall_trace ] || return 0
  app_uid="$(detect_app_uid)"
  [ -n "$app_uid" ] || return 0
  echo "uid $app_uid" >/proc/pine_syscall_trace 2>/dev/null || true
}

collect_native_syscall_trace() {
  [ -r /proc/pine_syscall_trace ] || return 0
  dmesg 2>/dev/null | grep 'pine_syscall_trace ' | tail -n 5000 > "$NATIVE_TRACE_LOG" 2>/dev/null || true
}

trap 'disable_native_syscall_trace' EXIT

{
  echo "package=$PACKAGE"
  echo "out=$OUT"
  echo "seconds=$SECONDS_TO_RUN"
  echo "date=$(date 2>/dev/null || true)"
  echo "kernel=$(uname -a 2>/dev/null || true)"
  echo "android=$(getprop ro.build.version.release 2>/dev/null || true)"
  echo "sdk=$(getprop ro.build.version.sdk 2>/dev/null || true)"
  echo "fingerprint=$(getprop ro.build.fingerprint 2>/dev/null || true)"
  echo "config_hooks="
  if [ -r /proc/config.gz ]; then
    zcat /proc/config.gz 2>/dev/null | grep -E 'CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|KPROBES|KPROBE_EVENTS|UPROBES|UPROBE_EVENTS|PERF_EVENTS|TRACEPOINTS|FTRACE|TRACEFS_FS|DEBUG_FS)=' || true
  else
    echo "/proc/config.gz not readable"
  fi
  echo "tracefs="
  ls -ld /sys/kernel/tracing /sys/kernel/debug/tracing 2>/dev/null || true
  echo "pine_syscall_trace="
  cat /proc/pine_syscall_trace 2>/dev/null || true
  echo "libart="
  ls -l /apex/com.android.art/lib64/libart.so /system/lib64/libart.so 2>/dev/null || true
  echo "pm_path="
  pm path "$PACKAGE" 2>/dev/null || true
  echo "rom_art_props="
  getprop debug.pine.art_dexdump 2>/dev/null || true
  getprop debug.pine.art_dexdump_pkg 2>/dev/null || true
} > "$OUT/diagnostics.txt"

enable_native_syscall_trace

collect_rom_art_dumps() {
  dest="$OUT/rom-art-dumps"
  mkdir -p "$dest"
  deadline=$(( $(date +%s) + SECONDS_TO_RUN ))
  found=0

  while :; do
    for source_dir in /data/user/*/"$PACKAGE"/cache/pine-art-dumps /data/data/"$PACKAGE"/cache/pine-art-dumps; do
      if [ -d "$source_dir" ]; then
        find "$source_dir" -type f \( -name '*.dex' -o -name '*.meta' \) -exec cp -p {} "$dest"/ \; 2>/dev/null || true
      fi
    done

    found="$(find "$dest" -type f -name '*.dex' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${found:-0}" -gt 0 ]; then
      {
        echo "rom_art_dump_dir=$dest"
        echo "rom_art_dumped=$found"
      } >> "$OUT/diagnostics.txt"
      return 0
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      break
    fi
    sleep 2
  done

  echo "rom_art_dumped=0" >> "$OUT/diagnostics.txt"
  return 1
}

if collect_rom_art_dumps; then
  collect_native_syscall_trace
  exit 0
fi

if [ -x /data/local/tmp/pine-art-dexdump ]; then
  /data/local/tmp/pine-art-dexdump --package "$PACKAGE" --out "$OUT" --seconds "$SECONDS_TO_RUN"
  collect_native_syscall_trace
  exit $?
fi

if [ -x /data/local/tmp/eBPFDexDumper ]; then
  (
    /data/local/tmp/eBPFDexDumper dump -n "$PACKAGE" -o "$OUT" > "$OUT/eBPFDexDumper.log" 2>&1
  ) &
  dump_pid="$!"
  sleep "$SECONDS_TO_RUN"
  kill -INT "$dump_pid" 2>/dev/null || true
  wait "$dump_pid" 2>/dev/null || true
  collect_native_syscall_trace
  exit 0
fi

if [ -x /data/local/tmp/xiaojianbang_hook ]; then
  cat > "$OUT/XIAOJIANBANG-HOOK-NOTE.txt" <<'EOF'
xiaojianbang_hook is present, but it is a low-level ARM64 HWBP tracing tool,
not a DEX dumper by itself.

The upstream project requires:

- 5.4+ Android GKI kernel
- KernelPatch 0.13.x / APatch KPM loader
- xiaojianbang-stealth-hook.kpm loaded through APatch

The current Redmi 7A / pine baseline is Android 12 with a 4.9 non-GKI kernel,
so this tool is not treated as a working DEX output backend here. Keep it as a
reference or porting candidate only unless the 7A is moved to a compatible
GKI/APatch kernel line.
EOF
  exit 21
fi

cat > "$OUT/README-NO-DUMPER.txt" <<'EOF'
No device dumper backend was found.

Expected one of:

- ROM ART patch enabled by debug.pine.art_dexdump=1
- /data/local/tmp/pine-art-dexdump
- /data/local/tmp/eBPFDexDumper
- /data/local/tmp/xiaojianbang_hook plus a compatible GKI/APatch kernel and a
  DEX-writing integration layer

For the current Redmi 7A / pine Android 12 kernel 4.9 baseline, the newer
Android 13-17 eBPF ringbuf dumper cannot be assumed to work. The preferred
path is rebuilding the ROM with the android-12.0.0_r32 ART patch, then letting
this wrapper collect DEX files from the target app cache.
EOF

exit 20
