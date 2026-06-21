# 项目全局约束

## Pine Boot / Magisk 修补

- 后续所有 pine boot 构建产物必须先保持为 GitHub Actions 下载的 clean boot artifact。
- 需要 root/Magisk 版本时，必须使用手机 `/sdcard/Download/` 目录中官方 Magisk APK 自带的修补程序进行修补。
- 不要手工拼接 Magisk ramdisk、不要自行改写 `skip_initramfs`/`want_initramfs`、不要自行 padding/truncate 成 64M 后当作修补结果交付。
- 修补后的 boot 只以官方 Magisk 修补输出为准；交付或刷写前必须校验文件路径、大小、SHA256、目标设备属性 `device=pine`。

## 时间表达

- 查询 GitHub Actions run、job、artifact、commit 构建时间时，最终说明必须使用北京时间 `UTC+8`。
- 如果接口返回 UTC 时间，必须换算成北京时间后再回复，并明确标注“北京时间”。
- 涉及排查对比时，可以附带原始 UTC，但北京时间必须优先出现。
