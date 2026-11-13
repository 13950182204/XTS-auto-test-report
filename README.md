# xts-reporter-app · OpenHarmony XTS 报告上传（独立桌面应用）

DSH 插件 ohos-xts-auto-reporter「XTS报告上传」的独立 Windows 桌面版：功能一比一复刻，UI 全新设计（侧边栏多页）。

- **评测资料**：预检、五步保存到「未提交」；草稿支持解除关联与平台核验
- **XTS 自动测试**：串行 SSTS → HATS → DCTS(仅有屏+盒子) → ACTS，多设备并行、失败自动补测、逐轮归档
- **镜像固件上传**：同名跳过、进度实时
- **豁免资料**：识别 / 预检 / 批量保存草稿（绝不提交）

## 运行

```bash
npm install
npm run app        # 构建并启动
npm run build      # 仅构建（渲染进程 vite + 主进程 tsc）
```

前置：`python`（装好 xdevice，XTS 自动测试用）、`hdc` 在 PATH；测试样机与测试盒子经 hdc 连接本机。

## 架构

- **主进程**（`electron/`）：Electron 窗口 + `127.0.0.1` 随机端口本地 API 服务；数据面从插件 `phase2-routes.ts` 1:1 移植（RunState/testState 状态机、后台长任务、行协议解析）。脚本 spawn 用 `ELECTRON_RUN_AS_NODE=1`，无需单独装 Node。
- **脚本**（`scripts/`）：与插件仓库**原样复制**的业务脚本——argv + 环境变量入参、stdout 行协议出参。**上游是插件仓库 ohos-xts-auto-reporter，改动需双向同步。**
- **渲染进程**（`src/`）：Vite + React + TS，侧边栏多页（概览 / 评测资料 / XTS 自动测试 / 镜像上传 / 豁免资料 / 设置），深色主题。
- **设置**：`%APPDATA%/xts-reporter-app/settings.json`（0600）。
- **git**：仅本地仓库，无远程。

## 与插件的差异

- 无 DSH 宿主依赖；任务全部后台执行 + 2.5s 轮询（含评测资料/豁免批量，规避 HTTP 超时）。
- 旧版 settings.yaml 迁移、DSH settings 服务适配等历史包袱已去除。
