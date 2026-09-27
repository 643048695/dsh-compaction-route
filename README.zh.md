# dsh-compaction-route

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/643048695/dsh-compaction-route)](https://github.com/643048695/dsh-compaction-route/commits)
[![Stars](https://img.shields.io/github/stars/643048695/dsh-compaction-route)](https://github.com/643048695/dsh-compaction-route/stargazers)

[English](README.md) | [中文](README.zh.md)

在 Web 设置页里选择**会话压缩用的摘要模型**，并给它配一个**兜底模型**。

一个 [DeepSeek Harness](https://www.deepseek.com/harness/) 插件。

---

## 为什么需要它

DSH 的压缩引擎只解析**一个**摘要模型，而且**没有任何失败回退**。摘要调用被拒时它直接抛错，`/compact` 显示 *"Compaction could not produce a useful summary"*，然后就没有然后了。

问题在于：回放的历史是按 DSH 固定的 **字符数 ÷ 4** 估算的，而各个厂商对**同一段字节**的切分方式不同，输入上限也各自独立。于是**你正在聊天的模型装得下**的历史，可能**你挑的那个摘要模型装不下** —— 整次压缩就这样失败，没有任何东西接住它。

在一个真实的 950k 窗口会话上实测：

| 项 | 值 |
|---|---|
| DSH 对回放的估算 | 743,536 tokens |
| 聊天模型实际读到的 | 744,184 tokens |
| 摘要模型实际需要的 | **超过它的输入上限** → HTTP 400 |

估算器是按聊天模型的分词器校准的（误差 0.1%），所以它报「装得下」，而摘要模型其实已经超了。用**同一段内容**实测三条路由：

| 路由 | 同样字节的 token 数 |
|---|---|
| gemini-3.8-flash | 1,027,843 |
| opencode-go/deepseek-v4.1-flash | 939,469 |
| surplan/deepseek-v4.1-flash | 939,003 |

分词器相差约 **10%**，而**上限是同一个**（1,048,576）。所以光「换一个模型」并不够：**只有兜底模型的窗口比主模型更大时，才救得回「装不下」这种失败。** 你的选择救不了时，设置卡会明确警告。

## 它做什么

监听 `llm/stream` 瀑布 —— 每一次模型调用都经过的唯一接缝 —— 并且**只对 `purpose === "compaction"` 的请求**生效：

1. 把目标改写成你配置的**主模型**；
2. 该次尝试以终止性错误 chunk 结束时，在**兜底模型**上重试同一个请求；
3. 输出第一个成功的尝试，或最后一次尝试的结果。

其余所有请求 —— 正常对话、子代理、会话标题、联网搜索 —— **完全原样通过，不受影响**。

## 安装

**Web 界面：** *设置 → 插件 → 添加插件*，填入：

```
github:643048695/dsh-compaction-route
```

**命令行**（普通 profile；`desktop` profile 由 Electron 应用接管，CLI 会拒绝）：

```sh
dsh plugin --profile <profile> add github:643048695/dsh-compaction-route
```

安装器询问时启用该 bundle 即可。**没有构建步骤**，插件挂载**不需要重启应用**。它插入的行 id 是 `compaction-route`，同时也是设置命名空间。

## 配置

*设置 → 插件 → dsh-compaction-route → 配置。*

| 字段 | 含义 |
|---|---|
| **启用路由** | 关闭则引擎行为与装之前完全一致。 |
| **主模型** | 优先使用的摘要模型。 |
| **兜底模型** | 主模型出错后改用的模型。留空表示不用兜底。 |
| **推理强度** | 压缩调用的 reasoning effort；留空则跟随服务商默认。 |

两个下拉框都是从**你 profile 里实际安装的模型**里读出来的 —— 数据来自 `llm-pi-ai` 设置命名空间，装了哪些就能选哪些 —— 每个选项都显示它的上下文窗口。

**全新安装时两个模型都是空的，不会改变任何行为。** 不做任何猜测：在你选出主模型之前，压缩行为与之前完全一致。在发布出去的代码里写死某条路由，等于替别人的 profile 猜一个它可能没有的服务商；而**只有兜底、没有主模型**是没有意义的，所以它不会自作主张开始路由。

每个字段都是 `volatile`，所以改动**对下一次压缩即刻生效，无需重启**。

## 怎么选兜底模型

兜底只有在窗口**比主模型更大**时才能救回**装不下**这种失败。两个窗口一样大的路由，只会把同一次拒绝重演一遍。

当兜底窗口 **≤** 主模型窗口时，设置卡会给出警告；两者是同一个模型时也会警告。

## 工作原理

```
压缩调用 ──▶ llm/stream 瀑布
                │
                ├─ purpose 不是 "compaction"？ ──▶ 原样通过，不受影响
                │
                ├─ 主模型 ──成功──▶ 输出它的 chunks
                │        └──终止性错误──▶ 兜底模型 ──▶ 输出它返回的内容
                └─（本插件自己创建的调用永远不会被自己再次拦截）
```

**为什么是重新进入 `ctx.llm.stream()`，而不是调用 `next(newOptions)`。** cordis 把一个瀑布的 `next` 构建为对**原始参数数组**的闭包：

```js
const next = () => (cbs.shift() ?? inner)(...args)
```

所以 `next(modifiedOptions)` 会**静默忽略传进去的参数**，再次分发原来的 options。因此更换 provider/model 必须从链条顶部重新进入 `ctx.llm.stream()`；用一个 `WeakSet` 标记本插件自己创建的调用对象，避免它拦截自己。

## 说明与限制

- **只在终止性错误 chunk 上重试。** 中间件或调用方抛出的异常会**原样上抛**，与未装插件时一致 —— 这个接缝不会把它吞掉。
- **取消优先。** 已中止的调用绝不重试。
- **只动压缩调用。** 判别依据是 `purpose`，其余任何请求都不会被改道。
- **引擎自己的事件记录的仍是它配置的目标。** `compaction/summary` 里报告的是引擎的 `summarizationProvider` / `summarizationModel`，不是本插件的改写；兜底生效只会出现在本插件的日志行里。想让会话日志与之一致，就把引擎那一行也指向同一个主模型。
- **它不能代替「让历史变小」。** 如果回放超过了**你拥有的所有**窗口，任何兜底都救不了 —— 那是压缩策略的问题，不是路由的问题。

## 兼容性

支持 `@deepseek-ai/dsh` **0.1.7-rc.2**（已在其上实测），以及同一 node 序列的 `0.1.7`。

## 开发

两半都不需要构建步骤。

```
lib/index.js        宿主半 —— llm/stream 路由 + 设置 schema
client/client.js    浏览器半 —— 配置卡片
cordis.patch.yml    bundle 补丁：一行，id 为 "compaction-route"
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
