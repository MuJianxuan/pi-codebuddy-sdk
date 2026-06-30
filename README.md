# pi-codebuddy-sdk

回退到 `@tencent-ai/agent-sdk` 的 Pi provider 扩展。无反向代理，直接使用本地 CodeBuddy CLI，合规安全。

## 安装

### 方式 1：全局安装（日常使用）

```bash
ln -s ~/Desktop/pi-codebuddy/src ~/.pi/agent/extensions/pi-codebuddy
cd ~/Desktop/pi-codebuddy && npm install
```

重启 Pi 即可自动发现。

### 方式 2：临时加载（测试）

```bash
pi -e ~/Desktop/pi-codebuddy/src/index.ts --provider codebuddy --model <model>
```

## 认证

CodeBuddy SDK 从本地环境读取凭证，优先级：

### 1. 已通过 CLI 登录（自动，无需配置）

```bash
# 如果已登录 CodeBuddy CLI，SDK 自动复用凭证
codebuddy login
```

### 2. API Key（手动设置）

```bash
# 国际版
export CODEBUDDY_API_KEY="your-key"

# 中国版
export CODEBUDDY_API_KEY="your-key"
export CODEBUDDY_INTERNET_ENVIRONMENT=internal

# iOA 版（企业内）
export CODEBUDDY_API_KEY="your-key"
export CODEBUDDY_INTERNET_ENVIRONMENT=ioa
```

**获取 API Key：**

| 版本 | 地址 |
|------|------|
| 国际版 | https://www.codebuddy.ai/profile/keys |
| 中国版 | https://copilot.tencent.com/profile/ |
| iOA | https://tencent.sso.copilot.tencent.com/profile/keys |

## 使用

```bash
# 列出 codebuddy 所有模型
pi --list-models

# 使用指定模型
pi --provider codebuddy --model claude-sonnet-4.6

# 或进入 Pi 后切换
/model codebuddy/claude-sonnet-4.6
```

### 推荐模型

| 模型 | 说明 |
|------|------|
| `claude-sonnet-4.6` | Claude Sonnet 4.6，支持 thinking |
| `claude-opus-4.8` | Claude Opus 4.8，支持 thinking + image |
| `gemini-3.1-pro` | Gemini 3.1 Pro，支持 thinking + image |
| `gpt-5.5` | GPT-5.5，支持 thinking + image |
| `hy3-preview-agent-ioa` | 混元 3 Preview，iOA 内免费无限额度 |

## 特性

| 特性 | 说明 |
|------|------|
| **动态模型发现** | 启动时从 CodeBuddy SDK 拉取 29 个模型，自动标注 thinking/image 能力 |
| **Session 池复用** | 多轮对话复用同一 CodeBuddy CLI 进程，首轮后每轮省 ~6s 启动 |
| **Thinking 控制** | Pi 的 thinking level 映射到 CodeBuddy 的 thinking/effort 参数 |
| **Image 输入** | 原生支持 Claude/Gemini/GPT 的多模态图片输入 |
| **Abort 处理** | Esc 取消 → CodeBuddy `interrupt()`，干净终止 |
| **Token 统计** | 包含 cache_read / cache_write / total_cost_usd |
| **YOLO 模式** | `bypassPermissions`，所有工具自动批准（与 pi-cursor-sdk 一致） |

## FAQ

**Q: 和 pi-cursor-sdk 有什么区别？**

pi-cursor-sdk 需要自建 MCP bridge 桥接 Cursor SDK 工具，pi-codebuddy SDK 原生处理工具执行，代码量减少 60%+。

**Q: 怎么查看当前用了多少 tokens？**

每次回复后 Pi 会显示 usage，包含 input/output/cache/total 及费用。

**Q: maxTurns 限制？**

100（安全上限）。CodeBuddy agent 完成任务会自动停止，不会循环满。

**Q: 支持哪些 CodeBuddy 版本？**

CodeBuddy CLI ≥ 2.x（`@tencent-ai/agent-sdk` ≥ 0.3.0）。
