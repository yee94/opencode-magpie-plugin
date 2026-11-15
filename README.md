# Magpie Plugins Monorepo

[![CI](https://github.com/yee94/opencode-magpie-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/yee94/opencode-magpie-plugin/actions/workflows/ci.yml)

两个独立 npm 包，分别处理 OpenCode 客户端接入和 Magpie 服务端请求适配。
根目录是 **private workspace**，只放共享工具、测试与发布任务，不发布 npm 包。

| Package | 安装位置 | 职责与文档 |
| --- | --- | --- |
| [`opencode-magpie-plugin`](https://www.npmjs.com/package/opencode-magpie-plugin) | OpenCode 服务所在机器 | [模型发现、价格与网关连接](packages/opencode-magpie-plugin/README.md) |
| [`magpie-claude-opencode-adapter`](https://www.npmjs.com/package/magpie-claude-opencode-adapter) | Claude Code 订阅桥接所在的 Magpie 服务器 | [仅 Claude Code 订阅渠道的 OpenCode 请求适配](packages/magpie-claude-opencode-adapter/README.md) |

两包互不依赖，分别拥有 manifest、源码、测试、打包文件清单和版本；均无运行时 npm 依赖。安装其中一个不会自动安装或启用另一个。

## 结构

```text
packages/
  opencode-magpie-plugin/
    src/                  # 模型发现、连接、价格和工具
    tests/
    docs/
    tsconfig.json
    tsdown.config.ts
    package.json
    README.md
  magpie-claude-opencode-adapter/
    adapter.middleware.js # Magpie onProvider 中间件
    adapter.test.js
    package.json
    README.md
scripts/                  # 共享发布校验及其测试
docs/releasing.md
pnpm-workspace.yaml
package.json              # private，仅共享开发依赖和任务
```

## 安装

OpenCode 的 `opencode.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-magpie-plugin"]
}
```

可选 adapter 安装在 Magpie 服务器端，不放进 OpenCode 的插件列表：

```sh
magpie plugin add npm:magpie-claude-opencode-adapter@0.1.0
magpie plugin options magpie-claude-opencode-adapter '{"agents":["opencode"],"placement":"user","renameIdentity":true}'
```

**Adapter 只匹配 Claude Code 订阅渠道**：`ctx.provider.account === "claude"` 且协议为 Anthropic。Anthropic API Key、Cursor / WorkBuddy 上的 Claude 模型、Codex 和其他 provider 不会触发；不能只按模型名称判断。
链式 Magpie 的 `ctx.agent` 可能是 `magpie`，需按 [adapter 文档](packages/magpie-claude-opencode-adapter/README.md) 显式配置匹配范围。

它只移动调用方指令，不复制整份提示词，也不改工具或认证信息。角色变化可能影响指令优先级和缓存；不保证一定走 TUI、没有 `-p` 回退或节省某个比例的额度。

## 开发与 CI

```sh
pnpm install --frozen-lockfile
pnpm check                 # 共享校验及两个包各自的完整检查
pnpm check:opencode        # 只检查 OpenCode 包
pnpm check:adapter         # 只检查 adapter
pnpm build                 # 构建需要构建的包；adapter 是纯 JS
```

也可以使用 `pnpm --filter <包名> check` 在包边界独立运行。共享开发依赖和锁文件在根目录，运行时代码留在各自包内。
CI 分别检查两个包及共享发布工具；所有测试使用 Vitest，本机检查不调用模型，真实模型联调在获准的 SSH 服务器进行。

## CD：发布两个独立 npm 产物

在 GitHub Actions 的 **Release → Run workflow** 中选择 `all`，会读取两个包各自的版本，分别检查、打包、发布、核验 npm 并创建各自的 GitHub Release。
两个发布任务独立执行，一个包的权限或发布错误不会取消另一个包。

也可单独选择包，或推送其版本标签：

- `opencode-magpie-plugin/v<版本>`：仅发布 OpenCode 包；旧 `v<版本>` 标签仍兼容。
- `magpie-claude-opencode-adapter/v<版本>`：仅发布 adapter。

发布过的版本不可覆盖；改过的包需要升级自己的版本，未改包只在产物完全一致时跳过上传。
仓库 Secret `NPM_TOKEN` 必须有对应包的发布权限，首次创建新包也需要授权。**已有 OpenCode 包的发布权限不代表能创建 adapter。**
详细过程与完成标准见 [发布指南](docs/releasing.md)。

## 为什么路由图显示 `magpie`，不是 OpenCode？

路由图名称来自 Gateway Key、`User-Agent` 和转发元数据，不来自提示词。Adapter 不修改这些信息；将身份句中性化不会给路由图改名。
尤其在 Magpie → Magpie 的链路上，接收端可能识别为 `magpie`，而中间件 `ctx.agent` 与记录的原始转发来源也可能不同。
排查应检查实际连接和来源标签，不能仅凭显示名称判断 adapter 是否生效。客户端标签配置见 [Agent 标签与原生归属](packages/opencode-magpie-plugin/README.md#agent-标签与原生归属)。
