# @raoxxxwq/pi-codebuddy-sdk

Pi 扩展：把 **CodeBuddy** 注册为 Pi 的模型提供商。你继续使用 Pi 的 TUI、工具、技能和扩展；CodeBuddy 通过 `codebuddy` CLI 在本地跑推理。除了选个模型，你在 Pi 里的使用方式完全不变。

- 仓库：`https://github.com/MuJianxuan/pi-codebuddy-sdk`
- 作者：`raoxxxwq`

## 它能做什么

- 在 Pi 中暴露 CodeBuddy 模型（`/model` 里以 `codebuddy/...` 出现）
- 把 Pi 的工具桥接给 SDK（工具仍由 Pi 执行；CodeBuddy 只负责规划和调用）
- 在主 Provider Path 上**强制每轮只发起一个桥接工具调用**以保证稳定
- 转发 Pi 生效中的 system prompt 和技能，让模型"像 Pi 一样行动"而非独立运行的 CodeBuddy Code；Pi 的 `-nc` / `--no-context-files` 退出选项被尊重
- 支持会话恢复（resume）、压缩（compaction）、流式输出、thinking 级别和图片
- 会话重建/恢复时对历史图片工具结果做文本化表示；当前轮次的用户图片保留其带类型的 base64/mime 数据
- 随时间学习任务实际服务的上下文窗口，并把 Pi 注册的模型元信息保守地对齐到观测到的真实值
- 可选的 **AskCodebuddy** 工具，把聚焦子任务委派给另一次 CodeBuddy 调用

## 安装

```bash
pi install npm:@raoxxxwq/pi-codebuddy-sdk
```

如果 Pi 已在运行，请重启。

## 要求

- **`codebuddy` 在 `PATH` 上** —— 扩展会拉起和你独立使用时同一个 CLI。若 `which codebuddy` 失败，要么把它加入 `PATH`，要么在 `codebuddy-sdk.json` 里设置 `pathToCodebuddyCode`（见[配置](#配置)）。
- **CodeBuddy 鉴权已可用** —— 只要 `codebuddy` 在你的终端能用，本扩展无需额外设置。

## 快速开始（已经在用 CodeBuddy）

不需要 `codebuddy-sdk.json`，也不需插件专属环境变量。

1. `pi install npm:@raoxxxwq/pi-codebuddy-sdk`
2. 重启 `pi`
3. `/model` → 选 `codebuddy/...`

可选：在 `~/.pi/agent/settings.json` 里设置 `defaultProvider` / `defaultModel`，省去每次 `/model`。

启动后第一次查询可能要等几秒，因为模型要从 SDK 发现。

## 鉴权

扩展不存储凭据。CodeBuddy CLI 从你的机器读取。使用**以下任一**：

### 1. CLI 登录（推荐）

```bash
codebuddy login
```

在浏览器完成登录。凭据留在你机器上；Pi 自动复用。

### 2. API Key

```bash
export CODEBUDDY_API_KEY="your-api-key"
```

从你的 CodeBuddy 账户获取 key。不要提交它，也不要存进仓库文件。

### 3. 腾讯 iOA（内网）

```bash
export CODEBUDDY_INTERNET_ENVIRONMENT=ioa
codebuddy login
```

当 CodeBuddy 必须跑在 iOA 网络时使用。若你的环境还要求，附上 `CODEBUDDY_API_KEY`。

## 使用

```text
pi
/model
```

挑任意以 `codebuddy/` 开头的一项（例如 `codebuddy/hy3`）。

工具、技能、扩展、`/compact` 和 steer 的行为与其他 Pi 提供商一致。

### AskCodebuddy

当 AskCodebuddy 工具启用（默认），任何提供商都能把聚焦子任务委派给一次独立的 CodeBuddy 调用。这就是 **Delegation Path** —— 与主 Provider Path 不同，CodeBuddy 在这里直接跑它自己的原生工具（而非 Pi 桥接的 MCP 工具）。

- `"read"` 模式（默认）：代码库相关问题 —— 审查、分析、解释。
- `"full"` 模式：允许写文件和执行 bash（无反馈地运行 —— 谨慎使用）。
- `"none"` 模式：仅通用知识（无文件访问）。

当当前活跃提供商已是 `codebuddy/...` 时，AskCodebuddy 会被自动屏蔽（防止循环委派）。

## 工作原理

### 两条路径

- **Provider Path（主路径）**：在 Pi 中选 `codebuddy/...` 模型后，CodeBuddy 作为 Pi 的 provider 直接驱动 Pi 工具。
- **Delegation Path（委派路径）**：Pi 中的其他 provider 调用 AskCodebuddy 工具，把聚焦任务委派给一次独立的 CodeBuddy 调用。

### Pi 执行工具（Pi-Executed Tooling）

Provider Path 中，CodeBuddy 只计划和发起 tool call；实际的工具执行、权限边界、结果渲染和会话历史都由 Pi 负责。

### 严格 MCP 边界（Strict MCP Boundary）

Provider Path 默认只把 Pi Tool Bridge 提供的 MCP 工具暴露给 CodeBuddy，避免 CodeBuddy 加载外部 MCP 或原生工具后绕过 Pi 的权限、渲染与会话历史。严格 MCP 模式已**默认启用**，不再有可关闭的配置项。

### 会话同步（REUSE / REBUILD）

桥接层维护 Pi 与 CodeBuddy 会话之间的同步。当 Pi 历史与缓存会话一致时复用（`REUSE`，保持 prompt cache 热）；当历史出现分歧（如 `/compact`、会话树导航、fork、其他 provider 接过一轮）时整体重建（`REBUILD`）。

### 工具调用正确性保障（Tool Call Correctness）

针对 CodeBuddy 经 MCP 调用 Pi 工具时容易出现的选错工具、参数 schema 不符、并行批处理时参数被丢弃等问题，桥接层做了多层保障：

- **工具名映射**：`mcp__custom_tools__read` ↔ `read` 双向翻译。
- **参数重命名**：`file_path → path`、`old_string → oldText`、`new_string → newText` 等。
- **并行 arg-dropping 防护**：检测被丢弃的空参数并延迟补齐，防止用空参数执行工具导致校验失败。
- **Provider Tool Guidance**：注入工具使用顺序约定（先 `read` 理解，再 `edit` 定点修改，`write` 只用于新建/全量替换，`bash` 仅在文件工具不足或用户要求命令时使用），并强制**每轮至多一个工具调用**。单工具调用现已强制，不再有 `serialToolCalls` 配置项。
- **串行协调**：运行时通过串行槽与 `canUseTool` 预校验，拦截并行调用与空必填参数。

### 运行时校准（Runtime Calibration）

扩展会学习每个模型运行时实际服务的上下文窗口（Served Context Window），并以**保守注册**策略消除"窗口漂移"（Window Drift）：绝不宣传比运行时已证明能服务的更大窗口。校准记录按环境信号键控，存于用户级缓存，跨 Pi 会话复用。

### 项目信任系统

全局配置在扩展启动时加载。项目配置只在 `session_start` 时你选择 **Allow and remember** 后才会读取；该决策按规范化的项目路径记录于 `~/.pi/agent/codebuddy-sdk-project-trust.json`。在无对话框 UI 的模式下，未获批准的项目配置会被忽略并告警。

## 配置

**可选。** 默认值对多数用户已够用。

全局文件：`~/.pi/agent/codebuddy-sdk.json`

项目文件：`.pi/codebuddy-sdk.json`

全局配置在扩展启动时加载。项目配置只在 `session_start` 选择 **Allow and remember** 后读取；决策存于 `~/.pi/agent/codebuddy-sdk-project-trust.json`。无对话框 UI 的模式下，未批准的项目配置会被忽略并告警。

项目 `askCodebuddy` 与 `provider` 段按 key 覆盖全局值；数组替换全局数组而非拼接。`provider.pathToCodebuddyCode` 仅全局有效：即便对已批准的项目，项目值也会被忽略并告警。改完项目配置后运行 `/reload`。

```json
{
  "askCodebuddy": {
    "enabled": true,
    "allowFullMode": true,
    "defaultMode": "read"
  },
  "provider": {
    "appendSystemPrompt": true,
    "pathToCodebuddyCode": "/path/to/codebuddy"
  }
}
```

### AskCodebuddy 选项

| 选项 | 默认 | 含义 |
|--------|---------|---------|
| `askCodebuddy.enabled` | `true` | 注册 AskCodebuddy 委派工具 |
| `askCodebuddy.allowFullMode` | `true` | 允许写能力的（`"full"`）委派模式 |
| `askCodebuddy.defaultMode` | `"read"` | 默认委派模式：`"read"`（文件访问）、`"full"`（写 + bash）或 `"none"`（仅通用知识） |
| `askCodebuddy.defaultIsolated` | `false` | 委派是否运行在干净会话（无对话历史）中 |
| `askCodebuddy.appendSkills` | `true` | 在委派 system prompt 中包含 Pi 技能块 |
| `askCodebuddy.name` | `"AskCodebuddy"` | 工具名 |
| `askCodebuddy.label` | `"Ask CodeBuddy"` | Pi TUI 中显示的工具标签 |
| `askCodebuddy.description` | 自动 | 在 Pi 中显示的工具描述 |

### Provider 选项

这些控制主 Provider Path（在 `/model` 中选 `codebuddy/...` 时）。标注 **escape hatch** 的不是日常调优项 —— 仅用于调试或兼容性时关闭。

| 选项 | 默认 | 含义 |
|--------|---------|---------|
| `provider.appendSystemPrompt` | `true` | 使用 Pi 的 system prompt 和 Pi Tool Bridge 指导，而非 CodeBuddy 默认身份（**escape hatch** —— 关闭会重新启用 CodeBuddy 文件系统设置） |
| `provider.settingSources` | `["user","project"]` | 要加载的 CodeBuddy 文件系统设置；仅当 `appendSystemPrompt=false` 时使用（**escape hatch**） |
| `provider.pathToCodebuddyCode` | 自动 | 全局专用；当 `codebuddy` 不在 `PATH` 时指定其路径；项目值被忽略 |

主 Provider Path 始终以严格 MCP 模式运行，因此在 provider 模式下 CodeBuddy 只可见 Pi 桥接的 MCP server。

provider 以保守校准 `floor` 注册每个模型。缓存同时记录 `latest` 和 `max` 观测值用于诊断，但后续更大的观测值永远不会抬高先前已证明的 floor。

## 隐私

- 扩展**不**向本仓库或任何第三方遥测端点发送对话数据。
- 凭据完全由你机器上的 CodeBuddy CLI 处理。
- AskCodebuddy 动作摘要只存固定执行动词（如 `Bash`）；原始 Bash/PowerShell/Terminal 命令不持久化进 Pi 工具结果。
- 可选调试模式（`CODEBUDDY_SDK_DEBUG=1`）在 `~/.pi/agent/` 下写**本地**日志；路径已脱敏，prompt 和工具载荷不会被记录。用完请删除日志。

## 排错

```bash
export CODEBUDDY_SDK_DEBUG=1
```

默认日志：`~/.pi/agent/codebuddy-sdk.log`。维护者细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

运行时校准缓存：`~/.pi/agent/codebuddy-sdk-model-calibration.json` 按运行时环境存储观测到的模型能力 floor。

项目配置信任存储：`~/.pi/agent/codebuddy-sdk-project-trust.json` 按规范化项目路径记录允许/拒绝决策。删除相关条目可重新请求确认。

## 开发

维护者：见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT

## 灵感来源

早期的 MCP 桥接模式受 [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 启发。本包是基于 [@tencent-ai/agent-sdk](https://www.npmjs.com/package/@tencent-ai/agent-sdk) 的独立代码库。
