# magpie-remote-claude-code

Magpie 插件：把另一台电脑上的 Remote Magpie（其中代理了 Claude Code 订阅）当作一个 **Claude Code** provider 来用。使用 Claude 图标。

Magpie 自带的 Remote Magpie provider 没有账号，所以“窗口重置时预热”“每日定时预热”这类 Claude Code 设置无法挂在它上面。本插件把这些设置放到插件自己的 provider 上，并通过 Remote Magpie 的接口完成。

## 配置

登录时只需填两项：

- **Remote Magpie URL**：如 `http://host:3425`（带不带 `/v1` 都行）。
- **Gateway API key**：远端 Gateway 页面里创建的 key。

远端需开启“在局域网共享”。

**预热设置：**在支持插件页面和供应商菜单操作的官方 Magpie 中，打开「供应商 → 右键 Remote CC → Remote CC 预热设置」，也可以从侧栏的「Remote CC 预热」进入。页面随 npm 包安装，不需要修改 Magpie 本体。

## 能力

- **转发请求**：模型列表读自远端 `/v1/models`（只保留 Claude 模型），请求发到远端的 Anthropic Messages API。
- **多账号分流**：`claude/<模型 ID>` 和同名的裸 Claude ID 合并为一个模型；选中账号后仍按该网关返回的原始 ID 发送。不同版本保留为不同模型。
- **用量**：读取远端的 Claude Code 额度卡（5 小时、7 天、分模型窗口、Usage credits），并按 `refreshEvery` 秒（默认 120）让远端重新读取一次。
- **预热**：在插件自带的预热设置页配置。
  - 窗口重置时预热：关闭、每周、每周和 5 小时。
  - 每日定时预热：可添加、修改或移除开始时间，默认 `06:00`。时间以运行 Magpie 的机器为准。
  - 账号默认设置：设定一套每日时间和一个全局「错峰间隔」，默认 120 分钟，`0` 表示不自动错峰。例如基准 `06:00`，两个账号实际为 `06:00`、`08:00`。错峰只影响每日定时，不影响窗口重置。已有账号专属设置仍保留。

预热发送一个 `max_tokens: 1` 的请求，经远端的 Claude Code 发出；它会计入 Usage（kind 为 `warmup`）。重置预热的重试间隔与 Magpie 内置预热一致：15 分钟起，每次翻倍，最长 4 小时；每日预热错过超过 1 小时则放弃当天。

## 选项（Plugins › Options）

```json
{ "warmAts": ["06:00"], "warmModel": "", "claudeUser": "", "refreshEvery": 120 }
```

- `warmAts`：每日预热时刻，可多个。
- `warmModel`：预热用的模型，默认远端列表里的 Haiku。
- `claudeUser`：远端有多个 Claude 账号时，只读此账号的卡片（邮箱）。
- `refreshEvery`：让远端刷新用量的最小间隔，30–3600 秒。

## 注意

- 预热和用量刷新由运行 Magpie 的这台电脑上的插件驱动；这台电脑关机则不执行。
- 调度按 Magpie 中的 Remote CC 登录区分。若一个网关登录能看到多张 Claude 额度卡，插件仍只选择其中一张，可通过 `claudeUser` 指定。
- 官方 Magpie 暂无后台账号枚举接口；插件在本机只读 `plugin-auth.json` 中的 Remote CC 登录，不修改登录文件，不把凭据交给设置页。
- 多台电脑同时装本插件并开启预热会各自发送。
