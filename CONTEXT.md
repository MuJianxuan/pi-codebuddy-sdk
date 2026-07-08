# Pi CodeBuddy Bridge

This context describes the pi-codebuddy-sdk extension as a bridge between Pi and the CodeBuddy Agent SDK. It captures the project-specific language we use when reasoning about model capability reporting and tool execution behavior.

## Language

**Registered Context Window**:
The context window value that this extension registers with Pi for a model. Pi uses this value for user-visible capability reporting and context-management behavior.
_Avoid_: advertised window, guessed window, Pi-side window

**Served Context Window**:
The context window value that the CodeBuddy runtime actually serves for a model during execution. This is the runtime truth, even when it differs from what Pi was told at registration time.
_Avoid_: real size, actual guess, backend estimate

**Window Drift**:
A mismatch between the Registered Context Window and the Served Context Window for the same model. Window drift means Pi is making decisions from stale or inaccurate model metadata.
_Avoid_: context bug, memory issue, token loss

**Conservative Registration**:
A registration strategy that never advertises a model context window larger than what the runtime has proven it can serve. Conservative registration prefers under-reporting over over-reporting.
_Avoid_: optimistic registration, doc-sized registration

**Runtime Calibration**:
A correction step that updates model capability metadata after observing real runtime values from the provider. Runtime calibration exists to eliminate Window Drift over time.
_Avoid_: post-hoc guess, lazy estimate

**User-Level Calibration Cache**:
A user-scoped cache that stores runtime-observed model capability values for reuse across Pi sessions on the same machine. This cache belongs to the user environment, not to any single repository.
_Avoid_: project cache, session-only cache, shared repo metadata

**Environment-Scoped Cache Key**:
A cache-keying strategy that stores calibration records by model id plus runtime environment signals that can change the effective served capability. This strategy reduces cross-environment drift without requiring stable account identity APIs.
_Avoid_: model-only key, project-scoped key, session-only key

**Best-Effort Live Refresh**:
A runtime calibration policy that treats the persisted cache as authoritative while attempting to refresh the current Pi provider registration only when it is safe to do so. If the live refresh fails, the next session still benefits from the cached calibration.
_Avoid_: forced immediate re-register, cache-only refresh

**Family-Bounded Conservative Default**:
An initial registration strategy for uncalibrated models that assigns a conservative lower-bound capability based on the model family rather than a single universal default or an optimistic guess. This reduces first-run Window Drift without overstating capability.
_Avoid_: universal tiny default, optimistic heuristic, doc-claimed default

**Tool Call Correctness**:
CodeBuddy 在 Pi Tool Bridge 中选择正确 tool、生成符合 Pi schema 的参数、按正确顺序调用并正确理解 tool result 的能力。
_Avoid_: 工具不稳定, tool flaky, retry problem

**Tool Selection Order**:
Provider Tool Guidance 中对 Pi tools 使用顺序的约束：先 read 理解现有文件，再用 edit 做定点修改，write 只用于新文件或明确整文件替换，bash 只在文件工具不够或用户要求命令时使用。
_Avoid_: tool preference, tool style, arbitrary tool ranking

**Bash Fallback Rule**:
Provider Tool Guidance 中对 bash 的约束：优先使用 Pi file tools 读写仓库文件，但当 file tools 不足、需要搜索/测试/构建/git 信息，或用户明确要求命令执行时，可以使用 bash。
_Avoid_: bash ban, shell-first workflow, command-only bridge

**Edit Grounding Rule**:
Provider Tool Guidance 中对 edit 的约束：修改现有文件前必须先 read 目标内容，并且 edit 的 `oldText`/`old_string` 必须精确匹配已读取的现有文本。
_Avoid_: blind edit, approximate patch, write-first edit

**Write Boundary Rule**:
Provider Tool Guidance 中对 write 的约束：write 只用于创建新文件，或在用户明确要求整文件替换时使用；修改现有文件的默认路径是先 read 再 edit。
_Avoid_: overwrite edit, full-file rewrite, broad replacement

**Pi Tool Bridge Instruction**:
注入给 CodeBuddy 的工具使用约定，说明 Pi tools 通过 MCP 暴露，以及 read/edit/write/bash 等工具的选择、参数和调用顺序规则。
_Avoid_: generic system prompt, tool hint, retry prompt

**Provider Tool Guidance**:
Provider Path 中注入给 CodeBuddy 的工具使用指导，目标是让 CodeBuddy 把 MCP 暴露的 Pi tools 当作 Pi 原生工具来选择、调用和理解结果。
_Avoid_: generic prompt guidance, AskCodebuddy prompt, model personality

**Layered Tool Guidance**:
Provider Tool Guidance 的组织方式：固定注入核心工具原则，同时根据当前 `context.tools` 中实际可用的 Pi tools 动态补充或弱化具体措辞。
_Avoid_: hardcoded-only guidance, fully dynamic guidance, tool list dump

**Tool Description Boundary**:
MCP tool description 负责说明单个 tool 的用途和参数；Provider Tool Guidance 负责说明跨工具选择、组合顺序和 Pi/CodeBuddy 执行边界，不重复粘贴每个 active tool 的 description。
_Avoid_: duplicated tool docs, prompt tool catalog, description copy

**Extension Point**:
Pi 宿主提供给扩展挂接能力的位置，例如 provider、tool、event、command、resource 或 UI renderer。
_Avoid_: injection point, SDK option, generic plugin feature

**Injection Point**:
Pi CodeBuddy Bridge 可以传入 CodeBuddy Agent SDK 或 CodeBuddy CLI 的能力，例如 system prompt、MCP tools、permission、settings、session、model 或 thinking level。
_Avoid_: extension point, Pi hook, public SDK

**Smoothness Lever**:
通过 Extension Point 或 Injection Point 改善 Pi 使用体验的具体抓手，例如减少配置、改善 tool call correctness、降低权限摩擦、优化 compaction 或增强进度反馈。
_Avoid_: nice-to-have, generic polish, vague UX improvement

**Pi-Native Provider Experience**:
Pi 仍然是主交互面，CodeBuddy 只增强模型推理和工具调用；用户不需要理解或切换到第二套 CodeBuddy 心智模型。
_Avoid_: CodeBuddy wrapper, CLI passthrough, second agent UI

**Pi-Executed Tooling**:
Provider Path 中 CodeBuddy 只计划和发起 tool calls，实际工具执行、权限边界、结果渲染和 session history 由 Pi 负责。
_Avoid_: CodeBuddy-executed tooling, native CLI tools, external MCP execution

**Strict MCP Boundary**:
Provider Path 默认只把 Pi Tool Bridge 提供的 MCP tools 暴露给 CodeBuddy，避免 CodeBuddy 加载外部 MCP 或原生工具后绕过 Pi 的权限、渲染和 session history。
_Avoid_: optional MCP tuning, mixed tool execution, external tool leakage

**Provider Path**:
用户在 Pi 中选择 `codebuddy/...` model 后，CodeBuddy 作为 Pi provider 直接驱动 Pi tools 的主路径。
_Avoid_: AskCodebuddy path, sidecar delegation, standalone CodeBuddy run

**Delegation Path**:
Pi 中的其他 provider 调用 AskCodebuddy tool，把一个聚焦任务委托给一次单独的 CodeBuddy 调用的辅助路径。
_Avoid_: provider path, primary model path, native provider flow
