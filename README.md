# @raoxxxwq/pi-codebuddy-sdk

Pi extension that registers **CodeBuddy** as a model provider. You keep using Pi for the TUI, tools, skills, and extensions; CodeBuddy Agent SDK runs inference locally via the `codebuddy` CLI. No HTTP proxy and no changes to how you work in Pi beyond picking a model.

- Repository: `https://github.com/MuJianxuan/pi-codebuddy-sdk`
- Author: `raoxxxwq`

## What it does

- Exposes CodeBuddy models in Pi (`codebuddy/...` in `/model`)
- Bridges Pi tools to the SDK (Pi still executes tools; CodeBuddy only plans and calls them)
- Enforces one bridged tool call per assistant turn on the main Provider Path for stability
- Forwards Pi's effective system prompt and skills so the model acts as Pi—not as standalone CodeBuddy Code; Pi's `-nc` / `--no-context-files` opt-out is respected
- Supports session resume, compaction, streaming, thinking levels, and images
- Historical image tool results are represented textually during session rebuild/resume; current-turn user images retain their typed base64/mime data
- Learns runtime-served context windows over time and keeps Pi's registered model metadata conservatively aligned with observed reality
- Optional **AskCodebuddy** tool to delegate a focused sub-task to another CodeBuddy call

## Install

```bash
pi install npm:@raoxxxwq/pi-codebuddy-sdk
```

Restart `pi` if it was already running.

## Requirements

- **`codebuddy` on your `PATH`** — the extension spawns the same CLI you use standalone. If `which codebuddy` fails, either add it to `PATH` or set `pathToCodebuddyCode` in `codebuddy-sdk.json` (see [Configuration](#configuration)).
- **CodeBuddy auth already working** — if `codebuddy` works in your terminal, you do not need extra setup for this extension.

## Quick start (already using CodeBuddy)

No `codebuddy-sdk.json` and no plugin-specific env vars are required.

1. `pi install npm:@raoxxxwq/pi-codebuddy-sdk`
2. Restart `pi`
3. `/model` → pick `codebuddy/...`

Optional: set `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` so you skip `/model` each time.

The first query after startup may take a few seconds while models are discovered from the SDK.

## Auth

The extension does not store credentials. The CodeBuddy CLI reads them from your machine. Use **one** of the following:

### 1. CLI login (recommended)

```bash
codebuddy login
```

Complete login in the browser. Credentials stay on your machine; Pi reuses them automatically.

### 2. API key

```bash
export CODEBUDDY_API_KEY="your-api-key"
```

Obtain the key from your CodeBuddy account. Do not commit it or store it in repo files.

### 3. Tencent iOA (internal network)

```bash
export CODEBUDDY_INTERNET_ENVIRONMENT=ioa
codebuddy login
```

Use this when CodeBuddy must run on the iOA network. Add `CODEBUDDY_API_KEY` as well if your environment requires it.

## Usage

```text
pi
/model
```

Pick any entry prefixed with `codebuddy/` (for example `codebuddy/hy3`).

Tools, skills, extensions, `/compact`, and steer behave the same as with other Pi providers.

### AskCodebuddy

When the AskCodebuddy tool is enabled (default), any provider can delegate a focused sub-task to a separate CodeBuddy call. This is the **Delegation Path** — unlike the main Provider Path, CodeBuddy runs its own native tools directly (not Pi-bridged MCP tools).

- `"read"` mode (default): codebase questions — review, analysis, explain.
- `"full"` mode: allows writing and bash execution (runs without feedback to Pi — use with care).
- `"none"` mode: general knowledge only (no file access).

AskCodebuddy is blocked automatically when the active provider is already `codebuddy/...` (prevents circular delegation).

## Configuration

**Optional.** Defaults work for most users.

Global file: `~/.pi/agent/codebuddy-sdk.json`

Project file: `.pi/codebuddy-sdk.json`

Global config is loaded when the extension starts. A project config is only read after you choose **Allow and remember** at `session_start`; the decision is stored by canonical project path in `~/.pi/agent/codebuddy-sdk-project-trust.json`. In modes without dialog UI, an unapproved project config is ignored with a warning.

Project `askCodebuddy` and `provider` sections override global values per key. Arrays replace the global array rather than being concatenated. `provider.pathToCodebuddyCode` is global-only: a project value is ignored with a warning even for an approved project. Run `/reload` after changing project config.
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

### AskCodebuddy options

| Option | Default | Meaning |
|--------|---------|---------|
| `askCodebuddy.enabled` | `true` | Register the AskCodebuddy delegation tool |
| `askCodebuddy.allowFullMode` | `true` | Allow write-capable (`"full"`) delegation mode |
| `askCodebuddy.defaultMode` | `"read"` | Default delegation mode: `"read"` (file access), `"full"` (write + bash), or `"none"` (general knowledge) |
| `askCodebuddy.defaultIsolated` | `false` | Default whether the delegation runs in a clean session (no conversation history) |
| `askCodebuddy.appendSkills` | `true` | Include Pi skills block in the delegation system prompt |
| `askCodebuddy.name` | `"AskCodebuddy"` | Tool name |
| `askCodebuddy.label` | `"Ask CodeBuddy"` | Tool label shown in the Pi TUI |
| `askCodebuddy.description` | auto | Tool description shown in Pi |

### Provider options

These control the main Provider Path (when you pick `codebuddy/...` in `/model`). Options marked **escape hatch** are not for everyday tuning — disable only for debugging or compatibility.

| Option | Default | Meaning |
|--------|---------|---------|
| `provider.appendSystemPrompt` | `true` | Use Pi's system prompt and Pi Tool Bridge guidance instead of CodeBuddy's default identity (**escape hatch** — disabling re-enables CodeBuddy filesystem settings) |
| `provider.settingSources` | `["user","project"]` | CodeBuddy filesystem settings to load; only used when `appendSystemPrompt=false` (**escape hatch**) |
| `provider.pathToCodebuddyCode` | auto | Global-only path to `codebuddy` when it is **not** on `PATH`; project values are ignored |

The main Provider Path always runs with strict MCP enabled, so only the Pi-bridged MCP server is visible to CodeBuddy in provider mode.

The provider registers each model with the conservative calibration `floor`. The cache also records `latest` and `max` observations for diagnostics, but a larger later observation never raises a previously proven floor.

## Privacy

- The extension does **not** send conversation data to this repository or any third-party telemetry endpoint.
- Credentials are handled entirely by the CodeBuddy CLI on your machine.
- AskCodebuddy action summaries store fixed execution verbs such as `Bash`; raw Bash/PowerShell/Terminal commands are not persisted in Pi tool results.
- Optional debug mode (`CODEBUDDY_SDK_DEBUG=1`) writes **local** logs under `~/.pi/agent/`; paths are redacted, prompts and tool payloads are not logged. Delete logs when finished.

## Troubleshooting

```bash
export CODEBUDDY_SDK_DEBUG=1
```

Default log: `~/.pi/agent/codebuddy-sdk.log`. See [CONTRIBUTING.md](CONTRIBUTING.md) for maintainer details.
Runtime calibration cache: `~/.pi/agent/codebuddy-sdk-model-calibration.json` stores observed model capability floors per runtime environment.
Project config trust store: `~/.pi/agent/codebuddy-sdk-project-trust.json` records allow/deny decisions by canonical project path. Remove the relevant entry to request confirmation again.

## Development

Maintainers: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

## Inspiration

Early MCP bridge patterns were inspired by [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge). This package is a separate codebase on [@tencent-ai/agent-sdk](https://www.npmjs.com/package/@tencent-ai/agent-sdk).
