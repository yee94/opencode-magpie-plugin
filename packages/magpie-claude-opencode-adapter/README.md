# Magpie Claude OpenCode Adapter

Magpie 网关中间件，使用 `onProvider` 处理 Claude 订阅桥接前的 Anthropic 请求。
纯 JavaScript，无运行时依赖、网络调用或 Node API，可以直接交给 Magpie 的 moejs 加载。

这是独立 npm 包，不导入或依赖 `opencode-magpie-plugin`，也不会被它自动启用。
本包只负责 Claude Code 订阅渠道对 OpenCode 请求的适配，不绑定任何第三方 UI 品牌；模型发现和其他 provider 的处理不属于本包。

## 行为

- 默认仅处理 `ctx.agent` 为 `opencode`、`ctx.protocol` 为 `anthropic`、`ctx.provider.account` 为 `claude` 的请求。服务 ID 可以任意命名，其他调用方可通过 `agents` 显式配置。
- 渠道判定使用 Claude Code 订阅类型，不使用 provider 名称或 Claude 模型名。Anthropic API Key、Cursor / WorkBuddy 提供的 Claude 模型、Codex 和其他 provider 原样通过。路由重试时，每个 provider 从原请求独立转换，不污染下一次尝试。
- 把固定身份句 `You are an AI agent running in OpenCode, a coding agent harness.` 改为中性描述 `You are an AI coding agent.`，不声称自己是官方 Claude Code。不是全文替换：路径、URL、包名、工具定义和历史内容均保留。
- 默认将调用方 system 文本块按原顺序前置到第一条 user 消息，保留块元数据。Claude Code 原生 system 仍由 Magpie 管理。
- 转换不修改输入，输出确定；重复处理已搬移请求不会重复插入。工具调用和结果不重命名。
- 未识别的 system 块、缺少 user 消息或历史以 tool_result 开始时原样通过，避免丢内容或破坏工具调用配对。

将 system 搬到 user 会改变指令优先级。此包不保证请求被接受，也不保证额度消耗或 TUI 模式；以服务器实际日志为准。

## 安装到服务器

推荐从公开 npm 安装。在实际运行 Claude 订阅桥接的服务器上执行：

```sh
magpie plugin add npm:magpie-claude-opencode-adapter@0.1.0
magpie plugin options magpie-claude-opencode-adapter '{"agents":["opencode"],"placement":"user","renameIdentity":true}'
```

这是 Magpie 插件，不要放进 OpenCode 的 `plugins` 数组。OpenCode 端的模型发现仍由独立的 `opencode-magpie-plugin` 负责；adapter 不处理登录、OAuth、模型发现或服务启动。

若已安装此前测试用的 `*.middleware.js`，先用 `magpie plugin off <旧文件完整路径>` 停用，或用 `magpie plugin rm <旧文件完整路径>` 移除，然后安装 npm 包。

也可将本目录复制到目标服务器，以单文件方式安装：

```sh
magpie plugin add /absolute/path/to/magpie-claude-opencode-adapter/adapter.middleware.js
magpie plugin options /absolute/path/to/magpie-claude-opencode-adapter/adapter.middleware.js '{"agents":["opencode"],"placement":"user","renameIdentity":true}'
```

单文件安装使用完整路径作为插件标识，设置选项、启停和删除时使用同一路径；
不要假定文件名短名可用。可在 Magpie 已安装插件列表确认标识。
不需要构建，不安装 OpenCode 的另一套 OAuth 插件。

## 选项

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时原样通过 |
| `agents` | `["opencode"]` | 匹配实际调用方标识 |
| `placement` | `"user"` | `"system"` 仅修改身份句，适合对照实验 |
| `renameIdentity` | `true` | 将固定身份句中性化；`false` 保留原身份句 |

选项中的 provider 判断基于订阅类型，不依赖模型名。当前仅实现 Anthropic 请求格式。
中间件不记录提示词、凭据或工具内容。检查 Magpie 插件调用/失败统计及服务日志确认是否命中。

### 经过另一层 Magpie 的请求

实测中，远端中间件的 `ctx.agent` 可以是 `magpie`，即使最初客户端是 OpenCode。
此时默认匹配不会生效，需根据实际调用方选择：

```sh
magpie plugin options magpie-claude-opencode-adapter '{"agents":["opencode","magpie"],"placement":"user","renameIdentity":true}'
```

仅在确认需要时加入 `magpie`：这会影响所有匹配该标识的 Claude 订阅请求，而不只是 OpenCode。
中间件不会修改 `ctx.agent`、`User-Agent`、`X-Magpie-Agent` 或 Gateway Key；修改身份句不会给 Magpie 路由图重命名。

### 开关与对照

```sh
# 暂时关闭（保留安装及选项）
magpie plugin off magpie-claude-opencode-adapter
magpie plugin on magpie-claude-opencode-adapter

# 保留原 system 位置，只替换身份句
magpie plugin options magpie-claude-opencode-adapter '{"placement":"system","renameIdentity":true}'

# 搬移但不替换身份句
magpie plugin options magpie-claude-opencode-adapter '{"placement":"user","renameIdentity":false}'

# 卸载
magpie plugin rm magpie-claude-opencode-adapter
```

每次设置 options 都应提交完整的所需配置；例如链式网关测试时须同时保留 `agents`。
单文件安装时，把上述包名替换为旧文件的完整路径。插件不修改 `claudePrintMode`，TUI / print 默认值仍由 Magpie 自身设置决定。

## Token 和缓存

移动后的指令不在 system 中重复保留，不增加包装提示词；工具定义保持原样。
因此不是多发一份提示词。固定身份句中性化会缩短文本，但字符差不等于固定数量的 Token。

移动角色可能改变底层编码和缓存边界，切换后的首轮可能需要重建缓存。
长对话也需验证指令遵循和工具调用稳定性。没有同请求用量对照时，不能声称精确增加 0 Token，或承诺节省某个比例的订阅额度。

## 验证

在仓库根目录运行 `pnpm check:adapter`，或在本包目录运行 `pnpm check`，独立执行本包 lint、测试与语法检查；不需要构建 OpenCode 包。仓库根目录 `pnpm check` 则检查两个包。本机检查不调用模型。
真实请求、工具回传、TUI / `-p` 和缓存对照应在获准的 SSH 服务器执行。

2026-11-15 早期原型的服务器联调观察到：真实 OpenCode 请求约 47K 字符 system、18 个工具，经转换后启动 `interactive mode`，检查时未出现 `-p` 回退。此前未命中 adapter 的请求则出现了回退。本版改用中性身份句，尚未重新进行真实模型联调，不能直接继承旧原型的实测结论。
这是单次链路观察，**不是完整工具任务、长对话、缓存或额度对照通过的证明**；自动化 OpenCode 工具任务测试曾超时，未完成验收。

Magpie 日志中：

- `started, a run ... (interactive mode)`：启动 TUI。
- `asked again as claude -p (#4503)` 或 `not the interactive mode`：发生回退。
- 不能仅凭有一条 TUI 启动日志就判定整轮成功，需检查完整请求的后续日志。

本包以 `magpie-claude-opencode-adapter/v<本包版本>` 标签独立发布，例如 `magpie-claude-opencode-adapter/v0.1.0`，也可在 Release 工作流单独选择本包。
工作流选择 `all` 时会同时发布两个独立 npm 包，各自执行检查、打包、上传、校验和 GitHub Release 创建。
根目录是 private workspace，不再作为业务包发布。详见 [发布流程](../../docs/releasing.md)。
