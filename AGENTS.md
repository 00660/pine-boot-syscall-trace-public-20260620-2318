# 项目全局约束

## Pine Boot / Magisk 修补

- 后续所有 pine boot 构建产物必须先保持为 GitHub Actions 下载的 clean boot artifact。
- 需要 root/Magisk 版本时，必须使用手机 `/sdcard/Download/` 目录中官方 Magisk APK 自带的修补程序进行修补。
- 后续 boot 更新流程固定为：先把 clean boot 推送到手机 `/sdcard/Download/`，等待用户手动用手机官方 Magisk 修补；用户明确说“修补好了”后，才能校验最新 `magisk_patched-30700_*.img` 并刷写。
- 不要手工拼接 Magisk ramdisk、不要自行改写 `skip_initramfs`/`want_initramfs`、不要自行 padding/truncate 成 64M 后当作修补结果交付。
- 修补后的 boot 只以官方 Magisk 修补输出为准；交付或刷写前必须校验文件路径、大小、SHA256、目标设备属性 `device=pine`。

## Pine 内核策略验证

- 验证 `/proc/pine_syscall_trace` 时默认只对目标应用 UID 使用 `uid <app_uid> <mode>`；不要用全局 `all proc` 或 `all hide` 做测试，除非用户明确要求并接受 framework/zygote 软重启风险。
- 每次 hook 验证结束必须立即写 `0` 关闭 `/proc/pine_syscall_trace`，并读取状态确认 `enabled=0`、`policy=0`。

## 时间表达

- 查询 GitHub Actions run、job、artifact、commit 构建时间时，最终说明必须使用北京时间 `UTC+8`。
- 如果接口返回 UTC 时间，必须换算成北京时间后再回复，并明确标注“北京时间”。
- 涉及排查对比时，可以附带原始 UTC，但北京时间必须优先出现。
