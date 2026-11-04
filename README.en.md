# dsh-kimi-code

Bridges the locally installed **Kimi Code CLI** (`kimi`) into DeepSeek Harness as a sub-agent: one `kimi_code` tool so that "let kimi code implement this" or "have kimi code review my diff" makes the model actually run your local kimi.

- No npm dependencies — Node built-ins plus the Host services `tools`, `subprocess`, and the optional `workingDirectory`.
- One Host tool. No UI, no background process, no extra state.
- Each call is **one independent kimi process** (`kimi -p ... --output-format stream-json`) that returns its final message.

[中文说明](./README.md)　｜　Repo: <https://github.com/kangseung/dsh-kimi-code>

## Requirements

1. Kimi Code CLI installed and `kimi` on PATH (usually `~/.kimi-code/bin/kimi`).
2. Logged in: `kimi login`. Prompt mode has no TTY for an interactive login, so an unauthenticated run fails.
3. A kimi version that supports `--output-format stream-json` (any 2.x; developed against 2.4.1).

## Install

Ask the DSH agent to install it (does both package install and bundle selection):

```
install the bundle at https://github.com/kangseung/dsh-kimi-code.git with plugin_manager install_bundle
```

Or manually:

```bash
dsh plugin --profile web add git+https://github.com/kangseung/dsh-kimi-code.git
# hacking on it locally? add the directory instead: dsh plugin --profile web add /path/to/dsh-kimi-code
```

then add `dsh-kimi-code` to `dsh.profile.bundles` in the profile's `package.json`.

Restart dsh afterwards: Host JavaScript modules are loaded once per process. A directory install is a symlink, so source edits also need a restart to load the new module generation.

## Usage

The model decides when to call it; you just talk.

| Argument | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | Complete task for kimi. It cannot see this conversation, so include paths, symptoms, and acceptance criteria. |
| `mode` | no | `develop` (default) may edit files; `review` is instructed to stay read-only and to report `file:line` findings. |
| `cwd` | no | Directory kimi works in: absolute, or relative to the session directory. |
| `model` | no | kimi model alias (`kimi -m`); defaults to `default_model` in `~/.kimi-code/config.toml`. |

The result carries `text`, `mode`, `cwd`, `sessionId` (resumable with `kimi -r <id>`), `toolCalls`, `toolNames`, `exitCode`, and `durationMs`.

## Config

```yaml
- id: dsh-kimi-code
  name: dsh-kimi-code
  config:
    model: kimi-code/k3.1-pro
    timeoutMs: 2700000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `bin` | `kimi` | Resolved in order: this value → `KIMI_CODE_BIN` → `~/.kimi-code/bin/kimi`. |
| `model` | unset | Default kimi model alias; the tool argument wins. |
| `timeoutMs` | `2700000` | Per-run wall clock (1 minute – 6 hours); the process is terminated on expiry. |
| `maxOutputBytes` | `4194304` | Captured stdout limit; overflow spills to disk and fails loudly instead of truncating silently. |
| `extraArgs` | `[]` | Extra argv appended to the kimi command. |

## Behaviour and limits

- **`review` is prompt-level read-only**, not a kernel sandbox. For hard isolation, run inside a git worktree or a read-only sandbox.
- **No shared context**: kimi is a separate process; `prompt` must be self-contained.
- **Fail fast**: missing executable, non-zero exit, non-JSON stdout, no final message, timeout, and output overflow all throw with stderr/stdout tails — no empty results and no silent defaults.
- **`toolCalls`** counts tool calls kimi *requested*, not completed executions.

## Verification

Tool logic (argument validation, argv assembly, JSONL parsing, error paths) is covered by a mock-Host harness: 15/15 checks pass. End to end:

- `review` produced a real review of this plugin's own `index.js`; four findings (cwd resolution order, silently dropped stdout noise, timeout error missing stderr, `toolCalls` wording) were fixed.
- `develop` built a small package with `node:test` tests from an empty directory and got them green.

## Uninstall

```bash
dsh plugin --profile web remove dsh-kimi-code
```

then drop the entry from `dsh.profile.bundles`.

## License

MIT — see [LICENSE](./LICENSE).
