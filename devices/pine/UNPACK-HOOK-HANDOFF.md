# Redmi 7A pine unpack hook handoff

更新时间：2026-06-15

## 目标

把当前 7A / `pine` 的 Android 12 ROM 线扩展成内部授权脱壳测试环境，当前主线为 ROM/AOSP/ART 源码级修改：

- 上传 APK
- 安装到 7A
- 启用 ART dump 属性
- 启动应用
- 由 patched ART 在 `RegisterDexFile` 注册点写出 DEX
- 回传 DEX 输出包

面板和文档均注明：仅用于内部授权测试，禁止用于非法目的。

## 当前基线

- ROM：`PixelExtended_pine-12.0-20220227-0902-OFFICIAL`
- ROM 源码基线：`PixelExtended/manifest@snow`
- ART 补丁兼容参考：`android-12.0.0_r32`
- Build ID：`SQ1D.220205.004`
- Security patch：`2022-02-05`
- Android：12 / SDK 31
- Kernel：`4.9.297-perf/pine-g3ce83b96c7ea`
- ADB：历史可用地址 `192.168.2.103:5555`
- Root：历史可用入口 `/debug_ramdisk/su`
- Docker：已验证 `29.5.2`、bridge/DNS/Web panel 可用

当前 ART 源码参考 checkout：

```text
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.external\art-android-12.0.0_r32
```

该 checkout 为 `platform/art@android-12.0.0_r32`，当前 commit `00c84f21871a8df8c4acfd9469be80095f6c6a7d`。

2026-06-15 接驳修正：旧 workflow 曾默认使用 `android.googlesource.com/platform/manifest@android-12.0.0_r32` 构建热更新，这只能验证 ART patch 兼容性，不能作为 103 当前 ROM 的最终源码基线。后续 ROM/ART 热更新必须以 XDA V4.2 指向的 `PixelExtended/manifest@snow` 为证据来源。

XDA V4.2 证据：

```text
Thread: [CLOSED] 64bit - 12S - Official PixelExtended V4.2 Rom Update for Redmi 7A[pine] - 27/02/22
ROM: PixelExtended_pine-12.0-20220227-0902-OFFICIAL
Device Source code: https://github.com/PixelExtended-Devices
Kernel Source code: https://github.com/hsx02/kernel_xiaomi_sdm439
Source code: https://github.com/PixelExtended
```

2026-06-16 构建修正：直接 `repo sync PixelExtended/manifest@snow` 会失败，因为当前公开 manifest 中部分 overlay 已断链：

```text
PixelExtended/build: missing refs/heads/snow
gitlab.pixelexperience.org/android/external_faceunlock: DNS unavailable
```

因此 ART 热更新 workflow 现在先拉取并归档 `PixelExtended/manifest@snow`，确认其默认 AOSP tag 为 `android-12.1.0_r22`，再用该 tag materialize AOSP build tree 来构建 `com.android.art`。`RegisterDexFile` patch 已本地验证可干净应用到 `platform/art@android-12.1.0_r22`。

## 关键判断

`devices/pine/current.config` 已有：

```text
CONFIG_BPF=y
CONFIG_BPF_SYSCALL=y
CONFIG_PERF_EVENTS=y
CONFIG_TRACEPOINTS=y
CONFIG_FTRACE=y
CONFIG_RING_BUFFER=y
```

但当前缺：

```text
# CONFIG_KPROBES is not set
# CONFIG_UPROBES is not set
# CONFIG_BPF_JIT is not set
```

Linux 4.9 没有新版 BPF ringbuf map，所以不能直接照搬 Android 13-17 的 ringbuf eBPF DEX dumper。pine 当前主线必须是 ROM/ART 侧 hook backend，内核 hook 只作为辅助观测能力。

2026-06-15 公开 Actions run `27521473658` 已确认：内核编译和 boot repack 成功，`boot-pine-unpack-hook.img` SHA256 为 `797a2aaa39bddb50ad6f7772b3f0755d25f16d5385604574947667d227b82874`；失败点只是 workflow 过度要求 `CONFIG_UPROBES=y`。该 4.9 tree 最终配置保留 `CONFIG_KPROBES=y`、`CONFIG_KPROBE_EVENT=y`、`CONFIG_BPF_JIT=y`、`CONFIG_PERF_EVENTS=y`、`CONFIG_TRACEPOINTS=y`，但 `# CONFIG_UPROBES is not set`。后续校验已把 UPROBES 改成 warning。

2026-06-15 公开 Actions run `27522588739` 已成功生成辅助 hook boot artifact `pine-internal-unpack-hook`。本地已拉回：

```text
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\artifacts\pine-internal-unpack-hook-27522588739
```

关键产物：

```text
boot-pine-unpack-hook.img
boot-pine-unpack-hook.img.sha256
config-docker-final
pine-internal-unpack-panel.zip
pine-unpack-hook-build-manifest.env
```

最终 `boot-pine-unpack-hook.img` SHA256：

```text
fd3393cc62819d3d9d0de094ce6ccc5b118f6029220cb646d793e8bae26cc0e5
```

## ART 源码补丁

已落地的正式补丁：

```text
devices/pine/patches/art/android-12.0.0_r32/pine-art-registerdexfile-dump.patch
```

补丁落点：

```text
art/runtime/class_linker.cc
ClassLinker::RegisterDexFile(const DexFile& dex_file, ObjPtr<mirror::ClassLoader> class_loader)
```

行为：

- 仅在非 boot class loader 的 DexFile 首次注册成功后触发。
- 通过 `debug.pine.art_dexdump=1` 或 `persist.sys.pine_art_dexdump=1` 开启。
- 通过 `debug.pine.art_dexdump_pkg=<package>` 或 `persist.sys.pine_art_dexdump_pkg=<package>` 限定目标包。
- 从 `dex_file.Begin()` 和 `dex_file.Size()` 写出原始 DEX。
- 输出到目标应用自己可写目录：`/data/user/0/<package>/cache/pine-art-dumps/`。

应用到完整 ROM 源码树：

```bash
bash devices/pine/scripts/apply-pine-art-patch.sh "$ANDROID_BUILD_TOP/art"
```

或者手工：

```bash
git -C "$ANDROID_BUILD_TOP/art" apply devices/pine/patches/art/android-12.0.0_r32/pine-art-registerdexfile-dump.patch
```

旧的 `/data/local/tmp/pine-art-dexdump` 进程扫描器不再是主线，只保留为手动 fallback；`.github/workflows/build-pine-art-dexdump.yml` 已改为仅 `workflow_dispatch`。

2026-06-15 公开 Actions run `27522588750` 已成功验证 ART patch 可干净应用到 `android-12.0.0_r32`。本地已拉回：

```text
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\artifacts\pine-art-rom-patch-verify-27522588750
```

其中 `pine-art-registerdexfile-dump.patch` / `applied-art.diff` SHA256：

```text
59981a99e42dd882b531a9e93895212246c027ae374fca70f3c3e02c9930097f
```

2026-06-15 已新增 ART 热更新构建入口：

```text
.github/workflows/build-pine-art-rom.yml
devices/pine/scripts/install-pine-art-hotupdate.ps1
```

该 workflow 使用 `PixelExtended/manifest@snow` 作为 ROM 基线证据，实际同步该 manifest 声明的 `android-12.1.0_r22` AOSP build tree，给最终 `art` 仓库应用 `RegisterDexFile` dump patch，默认构建 `module_arm64-userdebug` 的 `com.android.art`，输出 artifact：

```text
pine-art-hotupdate
```

接驳后的 workflow 已加防呆检查：默认 `manifest_url=https://github.com/PixelExtended/manifest`、`manifest_branch=snow`，如果传入其它 manifest 或分支会 fail-fast。artifact 内会保留 `pine-pixelextended-default.xml` 和 `pine-pixelextended-snippets.tar.gz`，用于交叉核对 ROM 基线来源。

本地热更新入口：

```powershell
powershell -ExecutionPolicy Bypass -File devices/pine/scripts/install-pine-art-hotupdate.ps1 -ApexPath <com.android.art.apex>
```

脚本先把 APEX 推到：

```text
/sdcard/pine-art-hotupdate/
```

然后优先尝试 `adb install --staged --apex`。如果 ROM 签名不接受 staged APEX，且 root shell 可用，则备份 `/system/apex/com.android.art.apex` 到 `/data/local/tmp/pine-art-hotupdate-backup-<timestamp>` 后尝试替换式热更新。替换后必须重启才会让 ART APEX 生效。

## xiaojianbang stealth hook 结论

用户给出的参考项目：

```text
https://github.com/xiaojianbang8888/xiaojianbang-stealth-hook
```

已核对 README。它提供：

```text
xiaojianbang-stealth-hook.kpm
xiaojianbang_hook
```

它的定位是 KernelPatch/APatch KPM + ARM64 硬件断点 hook，要求：

```text
5.4+ Android GKI kernel
KernelPatch 0.13.x
APatch
```

当前 7A / `pine` 是 Android 12 + 4.9 非 GKI 内核，所以这个项目不能原样接进当前 ROM/kernel。现在只把它作为 hook primitive 参考和后续 GKI/APatch 迁移候选；当前落地仍以 `unpack-hook-android12.fragment` + pine 兼容 dumper backend 为主。

## 新增文件

- `devices/pine/config/unpack-hook-android12.fragment`
- `devices/pine/patches/art/android-12.0.0_r32/pine-art-registerdexfile-dump.patch`
- `devices/pine/scripts/apply-pine-art-patch.sh`
- `devices/pine/scripts/build-pine-unpack-kernel.sh`
- `devices/pine/scripts/install-pine-art-hotupdate.ps1`
- `devices/pine/unpack-system/device/pine-run-dumper.sh`
- `devices/pine/unpack-system/panel/server.js`
- `devices/pine/unpack-system/panel/package.json`
- `devices/pine/unpack-system/README.md`

## 构建内核

Linux/GitHub Actions 环境执行：

```bash
bash devices/pine/scripts/build-pine-unpack-kernel.sh
```

它会合并：

```text
devices/pine/config/docker-required.fragment
devices/pine/config/unpack-hook-android12.fragment
```

必须保持原 Docker/VINTF 约束，尤其是：

```text
# CONFIG_FHANDLE is not set
# CONFIG_USER_NS is not set
```

刷入前检查最终 `.config`，确认 hook 必需项存在，同时不要破坏已验证 Docker baseline。

## 面板运行

```powershell
cd C:\Users\16547\Desktop\android-docker-boot-builder-github-work\devices\pine\unpack-system\panel
$env:ADB_SERIAL='192.168.2.103:5555'
$env:PINE_ROOT_SU='/debug_ramdisk/su'
node server.js
```

打开：

```text
http://127.0.0.1:8787/
```

面板会自动部署：

```text
/data/local/tmp/pine-run-dumper.sh
```

安装 APK 后，面板会在启动目标应用前设置：

```sh
setprop debug.pine.art_dexdump_pkg <package>
setprop debug.pine.art_dexdump 1
```

然后调用：

```text
/data/local/tmp/pine-run-dumper.sh --package <package> --out <remote-out> --seconds 45
```

## 设备端输出回收

```text
/data/local/tmp/pine-run-dumper.sh
```

优先回收 ROM ART patch 写出的文件：

```text
/data/user/0/<package>/cache/pine-art-dumps/*.dex
/data/user/0/<package>/cache/pine-art-dumps/*.meta
```

并复制到任务输出：

```text
<remote-out>/rom-art-dumps/
```

如果 ROM ART 输出不存在，才会尝试 fallback：

```text
/data/local/tmp/pine-art-dexdump
/data/local/tmp/eBPFDexDumper
/data/local/tmp/xiaojianbang_hook
```

其中 `xiaojianbang_hook` 只会被识别并写入兼容性说明，不会被误当作 DEX dumper。它需要另写 DEX 输出集成层，且当前 4.9 非 GKI 线不满足其官方环境要求。

## 验证清单

真机上线后按这个顺序验证：

```sh
adb connect 192.168.2.103:5555
adb -s 192.168.2.103:5555 shell /debug_ramdisk/su -c 'zcat /proc/config.gz | egrep "CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|KPROBES|KPROBE_EVENTS|UPROBES|UPROBE_EVENTS|PERF_EVENTS|TRACEPOINTS|FTRACE|TRACEFS_FS|DEBUG_FS)="'
adb -s 192.168.2.103:5555 shell /debug_ramdisk/su -c 'ls -ld /sys/kernel/tracing /sys/kernel/debug/tracing'
```

再启动本地面板上传一个自有测试 APK，下载 `downloads/<job>-<package>-dex.tar.gz`，确认里面有目标 DEX 和 `diagnostics.txt`。

ROM ART patch 验证重点：

```sh
adb -s 192.168.2.103:5555 shell /debug_ramdisk/su -c 'getprop debug.pine.art_dexdump; getprop debug.pine.art_dexdump_pkg'
adb -s 192.168.2.103:5555 shell /debug_ramdisk/su -c 'find /data/user/0/<package>/cache/pine-art-dumps -maxdepth 1 -type f -print 2>/dev/null'
```

## 2026-06-16 ART Actions 磁盘修正

- 提交 `30d5eec5546001af85656a24c228736d6eda6013` 已禁用 ccache。
- 公开构建 run `27565000487` 在 `soong bootstrap` 阶段被 runner shutdown/cancel，日志为 `soong bootstrap failed with: signal: killed`。
- 后续用 `build_jobs=1` 重跑 run `27565985867`，已避开 bootstrap kill，进入 ART 编译后在 `[93% 10275/10954]` 失败。
- 关键失败行：`fatal error: error in backend: IO failure on output stream: No space left on device`。
- 这次不是 ART patch 编译错误，根因是 GitHub hosted runner 磁盘被 AOSP 工作树、repo 元数据和 `out/` 同时占满。
- `.github/workflows/build-pine-art-rom.yml` 已在 `Apply pine ART RegisterDexFile patch` 之后新增 `Prune repo metadata before ART build`，删除 `android/.repo` 和各项目 `.git` 元数据后再进入 Soong 编译。
- `Build ART hot update targets` 现在会在编译前和退出时打印 `df -h`、`out`、`out/soong`、`out/target` 大小，便于继续判断是否仍需要缩小目标或进一步清理。

## 备份

变更前快照：

```text
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-unpack-20260614-201404
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-rom-20260615-090544
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-rom-20260615-092620
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-boot-validate-20260615-113507
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-final-artifacts-20260615-115854
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-rom-art-build-20260615-154314
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-xda-baseline-20260615-234706
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-r22-workflow-20260616-000937
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-envsetup-nounset-20260616-003142
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-module-arm64-20260616-004622
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-ccache-workspace-20260616-011623
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-disable-ccache-20260616-014220
C:\Users\16547\Desktop\android-docker-boot-builder-github-work\.backups\pine-art-disk-prune-20260616-064951
```
