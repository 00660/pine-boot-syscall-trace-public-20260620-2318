# Redmi 7A / pine internal unpack panel

仅用于内部授权测试与自有样本分析，禁止用于非法目的、未授权应用或第三方数据。

## Scope

Target baseline from the current pine handoff:

- Device: Redmi 7A `pine`
- ROM: `PixelExtended_pine-12.0-20220227-0902-OFFICIAL`
- Android: 12 / SDK 31
- Kernel: `4.9.297-perf/pine-g3ce83b96c7ea`
- ADB: `192.168.2.103:5555`
- Root entry observed earlier: `/debug_ramdisk/su`

This panel is a local PC-side ADB controller. It uploads an APK, installs it on the 7A, enables the ROM ART dump switch, starts the package, runs the device-side wrapper, and returns a tar.gz of the dumper output.

## ROM ART Patch

The primary backend for this ROM line is an ART source patch, not an external injection layer.

- Baseline: PixelExtended `snow`, AOSP/ART tag `android-12.0.0_r32`, build id `SQ1D.220205.004`.
- Patch file: `devices/pine/patches/art/android-12.0.0_r32/pine-art-registerdexfile-dump.patch`.
- Hook point: `ClassLinker::RegisterDexFile` in `runtime/class_linker.cc`.
- Switch: `debug.pine.art_dexdump=1` plus `debug.pine.art_dexdump_pkg=<package>`.
- Output inside target app: `/data/user/0/<package>/cache/pine-art-dumps/`.

The patch writes the registered DEX bytes from `DexFile::Begin()` and `DexFile::Size()` after the target package loads a DEX through ART. The device wrapper then copies those files into the job output directory before the archive is pulled back.

## Run

```powershell
cd C:\Users\16547\Desktop\android-docker-boot-builder-github-work\devices\pine\unpack-system\panel
$env:ADB_SERIAL='192.168.2.103:5555'
$env:PINE_ROOT_SU='/debug_ramdisk/su'
node server.js
```

Open:

```text
http://127.0.0.1:8787/
```

If package auto-detection is unavailable on the PC, type the package name in the form.

## Device backend contract

The panel deploys:

```text
/data/local/tmp/pine-run-dumper.sh
```

Preferred path after flashing a ROM built with the ART patch:

```text
debug.pine.art_dexdump=1
debug.pine.art_dexdump_pkg=<package>
/data/user/0/<package>/cache/pine-art-dumps/*.dex
```

The wrapper first waits for and collects those ROM ART dumps. External binaries remain fallback only:

```text
/data/local/tmp/pine-art-dexdump
/data/local/tmp/eBPFDexDumper
```

For this Android 12 / Linux 4.9 pine baseline, do not assume the Android 13-17 eBPF ringbuf dumper works unchanged. Build the ROM with the ART patch first; use kernel/perf/tracefs only as auxiliary observability.

## xiaojianbang stealth hook note

Reference:

```text
https://github.com/xiaojianbang8888/xiaojianbang-stealth-hook
```

That project provides:

```text
release/xiaojianbang-stealth-hook.kpm
release/xiaojianbang_hook
```

It is a low-level ARM64 HWBP hook framework based on KernelPatch/APatch KPM. It is not a DEX dumper by itself. Its documented device requirement is `5.4+ GKI` plus KernelPatch/APatch. The current Redmi 7A `pine` baseline is Android 12 with a 4.9 non-GKI kernel, so it cannot be used as-is on this ROM/kernel line.

If the 7A is later moved to a compatible GKI/APatch kernel, `xiaojianbang_hook` can become the hook primitive behind a custom DEX-writing backend. Until then, keep the panel backend contract at `/data/local/tmp/pine-art-dexdump` or another pine-compatible dumper that writes files into the requested output directory.

## Build hook kernel

Build the Docker + hook kernel on Linux/GitHub Actions:

```bash
bash devices/pine/scripts/build-pine-unpack-kernel.sh
```

The script merges:

```text
devices/pine/config/docker-required.fragment
devices/pine/config/unpack-hook-android12.fragment
```

Verify final config before flashing:

```sh
zcat /proc/config.gz | egrep 'CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|KPROBES|KPROBE_EVENTS|UPROBES|UPROBE_EVENTS|PERF_EVENTS|TRACEPOINTS|FTRACE|TRACEFS_FS|DEBUG_FS)='
```

Expected key values:

```text
CONFIG_KPROBES=y
CONFIG_KPROBE_EVENT=y
CONFIG_BPF_SYSCALL=y
CONFIG_BPF_JIT=y
CONFIG_PERF_EVENTS=y
CONFIG_TRACEPOINTS=y
```

`CONFIG_UPROBES` and `CONFIG_UPROBE_EVENTS` are requested by the fragment but are not hard requirements for this 4.9 tree. The current primary dump path is the ROM ART patch.

## Output

Each job downloads:

```text
downloads/<job>-<package>-dex.tar.gz
```

The archive includes `rom-art-dumps/*.dex` when the ROM ART patch succeeds, and always includes diagnostics from the device wrapper.
