# 更新日志

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

本项目的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [0.2.0] — 2026-10-29

把插件对齐到当前核心，并让它的声明可以被复跑验证。

### 变更

- **已对 DSH 0.2.1-rc.3 核对**（当前桌面版内置核心）。本插件立足的三处接缝都还在：`llm/stream`（waterfall，携带 `purpose`、`signal`、`reasoningEffort`）、`plugins.bundle.config`、以及卡片用来枚举模型的 `llm-pi-ai` 设置命名空间。README 的兼容性说明改为逐条列出核对对象，不再引用旧版本号。
- **新增 `npm test`。** 十个宿主半边用例跑在假的 `llm.stream` 上：非压缩用途放行、空主模型不生效、带 effort 的改写、兜底链、双双失败的结果、取消规则、重入保护、以及开关关闭。

### 说明

- 对已有安装无行为变化，无需迁移配置。

## [0.1.0] — 2026-09-27

首个版本。

### 新增

- **宿主半（`lib/index.js`）** —— 一个 `llm/stream` 瀑布监听器，**只对 `purpose === "compaction"` 的请求**：把目标改写成配置的主模型；该次尝试以终止性错误 chunk 结束时，在兜底模型上重试。以 `{ global: true, prepend: true }` 注册，因此它能包住所有内层中间件，并且对来自 agent preset 隔离领域的调用同样可见。用一个 `WeakSet` 标记它自己创建的调用，避免重复进入时拦截自己。
- **设置 schema** —— 五个 `volatile` 字段（`enabled`、`primary`、`fallback`、`effort`、`log`），使 Web 设置页可以编辑，宿主半在每次压缩时实时读取。
- **浏览器半（`client/client.js`）** —— 手写的惰性 bundle（无构建步骤），把配置卡片渲染进 `plugins.bundle.config`，以 bundle 的包名为 key。两个下拉框都由 profile 里实际安装的模型生成（数据来自 `llm-pi-ai` 设置命名空间），并显示每个模型的上下文窗口。
- **兜底有效性警告** —— 当兜底模型的上下文窗口不比主模型大，或两者是同一个模型时，卡片会给出警告；因为同尺寸的兜底救不回「装不下」的回放。

### 设计取舍

- **模型默认留空。** 在 schema 里写死某条路由，等于替另一个 profile 猜一个它可能没有的服务商。两个字段都留空时，全新安装不改变任何行为。
- **只有兜底、没有主模型时不路由。** 此时没有东西可以失败，而把兜底当主模型用会把压缩送到用户从未选择的地方。
- **只在终止性错误 chunk 上重试。** 中间件或调用方抛出的异常会原样上抛，与未装插件时一致。
