# dsh-kimi-code

把本机安装的 **Kimi Code CLI**（`kimi`）接成 DeepSeek Harness 的子 agent：一个 `kimi_code` 工具，让你在对话里说「让 kimi code 帮我开发」「kimi code 开子 agent 帮我 review」时，模型直接调用本机 kimi 干活。

- 无 npm 依赖，纯 Node 内置模块 + Host 服务（`tools` / `subprocess` / 可选 `workingDirectory`）。
- 只有一个 Host 工具，没有 UI、没有额外后台进程。
- 每次调用是**一条独立的 kimi 进程**（`kimi -p ... --output-format stream-json`），跑完把最终答复交回来。

[English README](./README.en.md)

## 前置条件

1. 已安装 Kimi Code CLI，且 `kimi` 可在 PATH 中找到（典型位置 `~/.kimi-code/bin/kimi`）。
2. 已登录：`kimi login`（非交互模式没有 TTY 可以完成登录，未登录会直接失败）。
3. kimi 版本支持 `--output-format stream-json`（2.x 即可，开发时用的是 2.4.1）。

## 安装

在 DeepSeek Harness 里让 agent 安装（推荐，会同时完成包安装与 bundle 注册）：

```
用 plugin_manager install_bundle 安装 /path/to/dsh-kimi-code
```

或手动两步：

```bash
dsh plugin --profile web add /path/to/dsh-kimi-code   # 或 git+https://github.com/kangseung/dsh-kimi-code.git
```

然后在 profile 的 `package.json` 里把 `dsh-kimi-code` 加进 `dsh.profile.bundles` 数组。

装完**重启 dsh**（Host 侧的 JavaScript 模块只在启动时加载一代）。重启后 `kimi_code` 工具即可用。

## 使用

模型会根据自然语言自行决定是否调用，无需记语法。典型说法：

- 「让 kimi code 帮我把 `src/parser.py` 的重试逻辑抽出来，并补测试」
- 「kimi code 开子 agent review 一下这次改动，只看正确性和边界」

工具参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 给 kimi 的完整任务说明。kimi **看不到当前对话**，路径、报错、验收标准都要写进去。 |
| `mode` | 否 | `develop`（默认）可改文件；`review` 只读并输出 `file:line` 形式的发现。 |
| `cwd` | 否 | kimi 的工作目录，绝对路径或相对会话目录；默认会话工作目录。 |
| `model` | 否 | kimi 模型别名（`kimi -m`），默认用 `~/.kimi-code/config.toml` 里的 `default_model`。 |

返回 `text`（kimi 最终答复）、`mode`、`cwd`、`sessionId`（可用 `kimi -r <id>` 续聊）、`toolCalls`、`toolNames`、`exitCode`、`durationMs`。

## 配置

在 profile patch 里给该行加配置：

```yaml
- id: dsh-kimi-code
  name: dsh-kimi-code
  config:
    model: kimi-code/k3.1-pro
    timeoutMs: 2700000
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `bin` | `kimi` | 可执行文件。解析顺序：本项 → 环境变量 `KIMI_CODE_BIN` → `~/.kimi-code/bin/kimi`。 |
| `model` | 不设 | 传给 kimi 的默认模型别名；工具参数 `model` 优先。 |
| `timeoutMs` | `2700000`（45 分钟） | 单次运行上限，超时会终止进程并报错。允许 1 分钟–6 小时。 |
| `maxOutputBytes` | `4194304`（4 MiB） | 捕获的 stdout 上限；超出会落盘 spill 并报错，不做静默截断。 |
| `extraArgs` | `[]` | 追加到 kimi 命令行的其它参数。 |

## 行为与边界

- **`review` 只是提示层只读**：kimi 收到「禁止修改文件」的指令，但不是内核沙箱。需要硬隔离就用 worktree 或只读沙箱后再调用。
- **不共享上下文**：kimi 是独立进程，看不到本会话历史，`prompt` 必须自包含。
- **失败即失败**：找不到 `kimi`、退出码非 0、输出不是合法 JSONL、没有最终答复、超时、输出超限，都会抛出带 stderr/stdout 尾部的错误，不会用空结果或默认值糊过去。
- **工具调用数**是 kimi「请求」的工具调用次数，不代表全部执行成功。

## 验证

工具逻辑（参数校验、命令行拼装、JSONL 解析、错误路径）用 Host 服务的 mock 覆盖，15 项检查全绿；端到端也实测过：

- `review` 模式对插件自身 `index.js` 做过一次真实评审，4 条有效发现已修（cwd 解析顺序、噪声静默丢弃、超时错误缺 stderr、`toolCalls` 措辞）。
- `develop` 模式在空目录里让 kimi 建包、写源码与 `node:test` 测试并跑绿。

## 卸载

```bash
dsh plugin --profile web remove dsh-kimi-code
```

再从 `dsh.profile.bundles` 里删掉对应项。

## 许可

MIT，见 [LICENSE](./LICENSE)。
