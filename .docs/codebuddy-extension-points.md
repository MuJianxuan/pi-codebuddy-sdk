# CodeBuddy Extension Points 盘点

## 结论摘要

这个仓库不是 VS Code extension。`package.json` 没有 `contributes`、`activationEvents`、VS Code `commands/menus/views/configuration`；实际形态是 Pi extension，通过 `package.json` 的 `pi.extensions` 加载 `./src/index.ts`。

这个 bridge 的目标也不应是把 Pi 变成 CodeBuddy CLI 的壳，而是实现 **Pi-Native Provider Experience**：Pi 仍然是主交互面，CodeBuddy 只增强模型推理和 tool call 能力。

推荐主线：

```text
Pi-Native Provider Experience
→ Provider Path
→ Tool Call Correctness
→ Provider Tool Guidance
```

第一优先级不是增加更多可配置项，而是把 Provider Path 的工具使用规则做成强默认：CodeBuddy 只计划和发起 tool calls，实际工具执行、权限边界、结果渲染和 session history 由 Pi 负责。

## 术语边界

**Extension Point**：Pi 宿主提供给扩展挂接能力的位置，例如 provider、tool、event、command、resource 或 UI renderer。

**Injection Point**：Pi CodeBuddy Bridge 可以传入 CodeBuddy Agent SDK 或 CodeBuddy CLI 的能力，例如 system prompt、MCP tools、permission、settings、session、model 或 thinking level。

**Smoothness Lever**：通过 Extension Point 或 Injection Point 改善 Pi 使用体验的具体抓手，例如减少配置、改善 Tool Call Correctness、降低权限摩擦、优化 compaction 或增强进度反馈。

**Provider Path**：用户在 Pi 中选择 `codebuddy/...` model 后，CodeBuddy 作为 Pi provider 直接驱动 Pi tools 的主路径。

**Delegation Path**：Pi 中的其他 provider 调用 AskCodebuddy tool，把一个聚焦任务委托给一次单独的 CodeBuddy 调用的辅助路径。

## 现有 Extension Points

### Pi Extension Manifest

证据：`package.json` 使用 `pi.extensions: ["./src/index.ts"]`，说明加载入口是 Pi extension entry，不是 VS Code manifest。

用途：安装后由 Pi extension runtime 加载这个 package。

### Extension Entry

证据：`src/index.ts` 导出 `export default function (pi: ExtensionAPI)`。

用途：所有 Pi-side 注册都从这里发生，包括 provider、tool 和 lifecycle event handlers。

### Provider Registry

证据：`registerCurrentProvider()` 调用 `pi.registerProvider(PROVIDER_ID, ...)`，注册 `CodeBuddy` provider，关键字段包括 `models`、`api: "codebuddy-sdk"` 和 `streamSimple`。

用途：这是 Provider Path 的核心 extension point。用户在 `/model` 选择 `codebuddy/...` 后，Pi 会通过 `streamSimple` 调用 CodeBuddy SDK。

### Tool Registry

证据：`pi.registerTool()` 注册 AskCodebuddy tool，参数包括 `prompt`、`mode`、`model`、`thinking`、`isolated`。

用途：这是 Delegation Path。它不是主 provider 体验，但可以让其他 provider 委托 CodeBuddy 做聚焦分析。

### Tool UI Hooks

证据：AskCodebuddy tool 提供 `renderCall` 和 `renderResult`。

用途：控制 Pi TUI 中 tool call/result 的展示，例如进度、耗时、action summary 和展开内容。

### Lifecycle Events

已使用事件：

- `session_start`
- `session_shutdown`
- `session_before_compact`
- `session_compact`
- `session_tree`

用途：维护 CodeBuddy shared session、处理 compaction takeover，并在 Pi history 变化后强制下一次 provider call rebuild CodeBuddy session。

### Config Injection

证据：`src/config.ts` 定义 `Config`，并从 `~/.pi/agent/codebuddy-sdk.json` 与项目 `.pi/codebuddy-sdk.json` 合并读取。

现有配置面：

- `askCodebuddy.enabled`
- `askCodebuddy.name`
- `askCodebuddy.label`
- `askCodebuddy.description`
- `askCodebuddy.defaultMode`
- `askCodebuddy.defaultIsolated`
- `askCodebuddy.allowFullMode`
- `askCodebuddy.appendSkills`
- `provider.appendSystemPrompt`
- `provider.settingSources`
- `provider.strictMcpConfig`
- `provider.pathToCodebuddyCode`

建议：`strictMcpConfig` 和 `appendSystemPrompt` 不应被文档表达成普通调优项。它们是 Provider Path 正确性的边界保护；保留 escape hatch，但语义应偏 debug/compat。

### MCP Tool Bridge

证据：`resolveMcpTools()` 从 `context.tools` 生成 MCP-visible tools；`buildMcpServers()` 调用 `createSdkMcpServer()`；query options 传入 `mcpServers`。

用途：这是 Pi tools 借给 CodeBuddy 的主要 injection point。CodeBuddy 看到的是 MCP tools，实际执行仍回到 Pi。

### Stream / Message Bridge

证据：`processStreamEvent()` 和 `processAssistantMessage()` 把 CodeBuddy SDK stream events / assistant messages 映射成 Pi `AssistantMessageEventStream`。

用途：把 CodeBuddy 的 text、thinking、tool_use、usage、stop reason 映射回 Pi 的消息模型。

### Runtime Model Discovery

证据：`discoverModels()` 通过 `query(...).supportedModels()` 获取 CodeBuddy SDK 支持的 models，然后重新注册 provider。

用途：让 Pi model list 动态反映 CodeBuddy runtime，而不是只依赖静态 fallback。

## 现有 Injection Points

### `systemPrompt`

当前用途：默认通过 `buildCodebuddySystemPrompt(context.systemPrompt)` 把 Pi system prompt、skills、AGENTS.md 和 Pi Tool Bridge Instruction 注入 CodeBuddy。

推荐：保持强默认。Provider Path 应优先保持 Pi identity，而不是回落到 CodeBuddy 默认身份。

### `mcpServers`

当前用途：把 Pi active tools 注入为 CodeBuddy SDK MCP server。

推荐：这是核心桥接点，应继续配合 Strict MCP Boundary 使用。

### `tools: []`

当前用途：关闭 CodeBuddy built-in tools。

推荐：保持强默认。Provider Path 中 CodeBuddy 不应绕过 Pi 直接执行 native tools。

### `strictMcpConfig`

当前用途：通过 extra args / SDK option 限制 CodeBuddy 只使用传入的 MCP config。

推荐：保持默认开启，并在文档中标为 debug/compat escape hatch。关闭它可能引入外部 MCP 或 CodeBuddy 原生工具，破坏 Pi-Executed Tooling。

### `settingSources`

当前用途：当 `appendSystemPrompt=true` 时不主动加载 CodeBuddy filesystem settings；当用户关闭 system prompt override 时，可读 user/project settings。

推荐：Provider Path 默认不应混入 CodeBuddy settings。需要加载 CodeBuddy user/project settings 的情况应被视作兼容模式。

### `permissionMode`

当前用途：provider query 使用 `permissionMode: "bypassPermissions"`，因为实际权限边界由 Pi tools 控制。

推荐：保持 Pi 作为权限边界。不要把 CodeBuddy permission prompt 引入主 Provider Path。

### `resume`

当前用途：通过 shared session 和 JSONL rebuild/reuse 机制把 Pi history 同步给 CodeBuddy。

推荐：继续作为 Provider Path 的内部实现细节，不暴露给普通用户配置。

### `effort`

当前用途：把 Pi reasoning levels 映射到 CodeBuddy SDK effort。

推荐：这是合理 injection point，但优先级低于 Tool Call Correctness。后续可以单独梳理 model/thinking 体验。

### `pathToCodebuddyCode`

当前用途：允许用户指定 CodeBuddy CLI 路径。

推荐：保留为安装/环境兼容配置，不属于主体验优化。

## Provider Path 推荐路线

### 1. Provider Tool Guidance 走强默认

Provider Tool Guidance 是 bridge 正确性的核心，不是偏好项。它应该默认注入，且不作为日常配置暴露。

已有 escape hatch：`provider.appendSystemPrompt=false`。这个入口足够用于 debug/compat，不应再增加面向普通用户的开关。

### 2. 保持 Pi-Executed Tooling

原则：

- CodeBuddy 只计划和发起 tool calls。
- Pi 负责实际工具执行。
- Pi 负责权限边界。
- Pi 负责 tool result 渲染。
- Pi 负责 session history。

对应实现：

- `tools: []`
- `mcpServers`
- `strictMcpConfig`
- Pi-side tool result extraction and delivery

### 3. 保持 Strict MCP Boundary

默认只暴露 Pi Tool Bridge 提供的 MCP tools。不要让 CodeBuddy 同时加载用户/项目 CodeBuddy MCP 配置，否则同一类动作可能绕过 Pi。

README 中 `provider.strictMcpConfig` 的语义建议调整为：默认开启，不建议关闭；关闭仅用于调试 CodeBuddy 原生 MCP/settings 兼容问题。

### 4. 采用 Layered Tool Guidance

Provider Tool Guidance 不应该只是固定写死，也不应该完全动态生成。

推荐结构：

- 固定核心规则：跨工具策略和 Pi/CodeBuddy 边界。
- 动态补充：根据当前 `context.tools` 中实际可用的 Pi tools 调整措辞。

例如：

- 如果 `edit` 可用：明确“修改现有文件默认 read → edit”。
- 如果 `edit` 不可用：不要强制模型使用不存在的 edit。
- 如果 `bash` 可用：说明 Bash Fallback Rule。
- 如果 `bash` 不可用：不要建议运行命令。

### 5. 不重复 Tool Descriptions

MCP tool description 已经随 tool schema 暴露给 CodeBuddy。Provider Tool Guidance 不应复制每个 active tool 的 description。

正确分工：

- MCP tool description：说明单个 tool 的用途和参数。
- Provider Tool Guidance：说明工具之间怎么选、怎么组合、Pi 和 CodeBuddy 的执行边界。

## 第一版 Provider Tool Guidance 规则

### Tool Selection Order

默认顺序：

```text
read → edit → write/bash only when appropriate
```

具体规则：

- 先用 `read` 理解现有文件。
- 修改现有文件默认用 `edit` 做定点修改。
- `write` 只用于创建新文件或用户明确要求整文件替换。
- `bash` 只在 file tools 不足、需要搜索/测试/构建/git 信息，或用户明确要求命令执行时使用。

### Bash Fallback Rule

不要绝对禁止 bash。`bash` 是 fallback，不是 first choice。

合理 bash 场景：

- `rg` 搜索。
- 运行测试。
- 查看 git 状态。
- 执行构建或 lint。
- 用户明确要求执行命令。

不推荐 bash 场景：

- 用 `cat`/`sed` 代替 Pi `read` 阅读目标文件。
- 用 shell 重写文件内容来绕过 Pi `edit`/`write`。

### Edit Grounding Rule

修改现有文件前必须先 `read` 目标内容。

`edit` 的 `oldText` / `old_string` 必须精确匹配已读取的现有文本。不要做 approximate patch 或 blind edit。

### Write Boundary Rule

`write` 只用于：

- 创建新文件。
- 用户明确要求整文件替换。

修改现有文件的默认路径是先 `read` 再 `edit`。

## 可进一步注入但暂不优先

这些 CodeBuddy SDK options 可以成为未来 injection points，但不应抢占 Provider Tool Guidance 的优先级：

- `allowedTools` / `disallowedTools`：适合 Delegation Path 的 mode 控制；Provider Path 已通过 `tools: []` + MCP bridge 建立边界。
- `canUseTool`：理论上可接入 permission policy，但 Provider Path 当前应保持 Pi permission boundary。
- `hooks`：可能用于观测 CodeBuddy native lifecycle，但会增加两套 hook 心智模型。
- `agents`：可注入 CodeBuddy subagent definitions，但会偏离 Pi-native 主路径。
- `additionalDirectories`：可扩展 CodeBuddy 可访问目录，但需要和 Pi project trust / cwd 边界一起设计。
- `elicitation`：可接入交互确认，但 Provider Path 里应优先使用 Pi UI / tool permission 模型。
- `traceId` / `parentSpanId`：适合诊断链路，和用户顺滑体验间接相关。
- `sandbox`：可作为未来安全边界议题，但和当前 Pi tool bridge 的权限模型需要一起设计。

## 明确非目标或低优先级

### VS Code Extension Points

未发现：

- `contributes`
- `activationEvents`
- VS Code `commands`
- `menus`
- `views`
- `contributes.configuration`

当前无需围绕 VS Code API 设计。

### Webview / Message Bridge

未发现：

- `webview`
- `postMessage`
- `onDidReceiveMessage`
- `acquireVsCodeApi`

当前 UI extension point 是 Pi TUI tool renderer、status、message renderer 等，不是 VS Code webview。

### 通用 DI / Container

未发现框架式 DI，例如 `Container`、`inject`、`bind`。

当前注册机制是 Pi `ExtensionAPI` 和少量 module/global state，例如 provider re-registration guard。

### 正式 Public SDK

`package.json` 没有 `main`、`types`、`exports`。源码中存在若干 `export` helper，但更像测试或 deep import 使用，不应把这个 package 当作稳定 public SDK 设计。

## 验收建议

第一阶段以 unit tests 为主，因为 Provider Tool Guidance 本质是 prompt construction。

建议验收：

1. `buildCodebuddySystemPrompt()` 默认包含 Provider Tool Guidance。
2. 当 `context.tools` 包含 `read/edit/write/bash` 时，生成 Tool Selection Order、Bash Fallback Rule、Edit Grounding Rule、Write Boundary Rule。
3. 当某些 active tools 不存在时，guidance 不要求使用不存在的 tool。
4. guidance 不重复粘贴 active tool descriptions。
5. `provider.appendSystemPrompt=false` 时不注入 Provider Tool Guidance。
6. 保持现有 `strictMcpConfig` 默认行为。

第二阶段补一个窄 integration smoke：

- 准备一个 fixture 文件。
- 让 CodeBuddy provider 执行一个需要“先读再改”的任务。
- 观察 tool call 顺序至少包含 `read` 后再 `edit`。

不要把真实模型行为作为主要 correctness 断言；模型行为有随机性和外部依赖，适合 smoke，不适合作为核心单测。

## 推荐落地顺序

1. 把 `buildPiToolBridgeInstruction()` 扩展为 Layered Tool Guidance 的核心规则载体。
2. 让 provider query path 根据 `context.tools` 传入实际可用工具信息，动态生成可用性补充。
3. 保持 `enhancePiToolForCodebuddy()` 作为 per-tool 局部提示，不承担跨工具策略。
4. 更新 README 中 `strictMcpConfig` 和 `appendSystemPrompt` 的语义，标明它们是 debug/compat escape hatches。
5. 增加 unit tests 固定 prompt 输出边界。
6. 最后增加一个窄 integration smoke 验证 read → edit 的真实路径。
