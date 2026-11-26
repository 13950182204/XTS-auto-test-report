# 项目约定（xts-reporter-app）

## xdevice 版本：ssts 是旧版，其余是新版（硬事实，2026-11-25 实测）

| 套件 | `tools/xdevice-*.tar.gz` 里的 `_core/report/result_reporter.py` | 报告产物 |
| --- | --- | --- |
| `ssts` | 只有 `_generate_vision_reports()` | **旧版**：`details_report.html` / `failures_report.html` / `passes_report.html` |
| `acts` / `acts-validator` / `hats` / `dcts` | 有 `_generate_test_report()` | **新版**：`static/`（Vue 页）+ `summary_report.html`，无旧三件套 |

- 这是上游套件包自带的差异，**不是 bug，不要试图统一**。ssts 出旧报告是正常的。
- `scripts/xts_run_test.mjs` 的 `ensureXdeviceReady` 按套件解包 tar 比对指纹，不一致就整套重装该套件
  （`xdevice` + `xdevice_ohos` + `xdevice_devicetest`）。
- **只装 `xdevice` 主包会让插件错配**：`ohos` 插件里 `DeviceTestType.validator_test` 会报
  `AttributeError`。必须整套装。
- 所以自检 probe 是 `import xdevice, pkg_resources, ohos`，不是只 `import xdevice`。

## 资源安装 bat（dcts_resource.bat 等）

- **禁止**用 `hdc.cmd` shim 注入 PATH 来绑定设备：批处理里裸调用 `.cmd`（无 `call`）时 cmd 会把控制权
  交给 shim 且不返回，`dcts_resource.bat` 第一行就终止，退出码仍是 0（2026-11-25 实测，DCTS 6 个
  SoftBus 模块连续失败 3 轮，设备上根本没有 `dsoftbusTest` / `test.wav`）。
- 正确做法：把 `resource/` 整目录复制到工作区，把副本里所有 `.bat` 的裸 `hdc` 改写成
  `"<hdc.exe>" -t <sn>`，再跑副本入口。`@start xxx.bat` 拉起的子窗口 cwd 继承副本目录，同样生效。
- bat 结尾的 `pause`、中间的 `timeout` 在 `stdio: ['ignore', ...]` 下 EOF 放行，不会卡住。

## 其它

- 路径输入一律走系统对话框（主进程 `dialog.showOpenDialog`，`POST /dialog/pick`），不手填。
- 平台表单会吃掉 `<` `>`，填之前在 `sanitizeForPlatform` 里换成全角。
- 批量豁免前校验测评编号与设备资料一致（读设备目录下 `OpenHarmony兼容性批量结果_*/result.json`）。

## 发版：必须由用户显式要求（硬规则，2026-11-26 用户要求）

- **禁止**自行创建 GitHub Release、禁止自行打 tag、禁止自行改 `package.json` 的 `version`。
- 允许的操作：本地 `npm run dist` 打包、本地验证 exe、准备发版说明草稿。
- 只有用户明确说「发版 / 发布 / 出个 release」时，才执行：
  `改 version → 打包 → 打 tag → 建 Release → 上传 exe`，并在完成后回报 tag 与资产 URL。
- 已发布过的 Release 不覆盖资产；修正走新版本号。
