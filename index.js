/**
 * dsh-kimi-code — Host half of the Kimi Code bridge.
 *
 * Registers one model-facing tool, `kimi_code`, that runs the locally installed
 * Kimi Code CLI (`kimi -p ... --output-format stream-json`) as an independent
 * sub-agent for development work or code review, and returns its final answer.
 *
 * No npm dependencies: only Node built-ins and the Host services `tools` and
 * `subprocess` (plus the optional `workingDirectory` service).
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-kimi-code'
export const inject = ['tools', 'subprocess']

const DEFAULT_BIN = 'kimi'
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000
const MIN_TIMEOUT_MS = 60 * 1000
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const SPILL_MAX_BYTES = 64 * 1024 * 1024
const STDERR_MAX_BYTES = 256 * 1024
const STDERR_TAIL_CHARS = 2000
const GRACE_MS = 5000

const MODE_DEVELOP = 'develop'
const MODE_REVIEW = 'review'
const MODES = [MODE_DEVELOP, MODE_REVIEW]

const REVIEW_PREFIX = `Act as an independent code reviewer for the repository in the current working directory.

Rules:
- Read only. Do not create, modify, move, or delete any file.
- Ground every finding in code you actually read; never invent files or line numbers.

Report format:
1. Verdict: one line — blocking issues found, or no blocking issues.
2. Findings, most severe first. Each one: severity (blocker | major | minor | nit), file:line, what is wrong, why it matters, and the concrete fix.
3. What you checked, and what you deliberately did not check.

Review request:
`

const DESCRIPTION = [
  'Run the local Kimi Code CLI (`kimi`) as an independent sub-agent in this project.',
  'Use it when the user asks kimi (Kimi Code) to do work: "让 kimi code 帮我开发", "kimi code 开子 agent 帮我 review", "交给 kimi 实现/审查"。',
  'mode=develop lets kimi edit files in the working directory and report what it changed; mode=review is instructed to stay read-only and to return findings with file:line.',
  'Use this instead of `subagent` only when the user names kimi; otherwise prefer `subagent`.',
  'kimi does not see this conversation, so put every relevant path, symptom, and acceptance criterion into `prompt`.',
  'The call blocks until kimi exits, then returns its final message.',
].join(' ')

const PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'Self-contained task for kimi: what to build or fix (mode=develop), or what to review and against which criteria (mode=review). Include file paths and acceptance criteria; kimi cannot see this conversation.',
    },
    mode: {
      type: 'string',
      enum: MODES,
      description:
        'develop (default) edits files in the working directory; review is instructed to stay read-only and to report findings instead of changing code.',
    },
    cwd: {
      type: 'string',
      description:
        'Directory kimi works in. Absolute, or relative to the session working directory. Defaults to the session working directory.',
    },
    model: {
      type: 'string',
      description:
        'Kimi model alias for this run (kimi -m). Defaults to the model configured in Kimi Code (~/.kimi-code/config.toml).',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: "Kimi's final message." },
    mode: { type: 'string', enum: MODES },
    cwd: { type: 'string', description: 'Directory kimi ran in.' },
    sessionId: { type: 'string', description: 'Kimi session id, resumable with `kimi -r <id>`; empty when unknown.' },
    toolCalls: { type: 'number', description: 'How many tool calls kimi requested.' },
    toolNames: { type: 'array', items: { type: 'string' }, description: 'Distinct tools kimi used.' },
    exitCode: { type: 'number' },
    durationMs: { type: 'number' },
  },
  required: ['text', 'mode', 'cwd', 'sessionId', 'toolCalls', 'toolNames', 'exitCode', 'durationMs'],
  additionalProperties: false,
}

/**
 * Validate and normalize the row config once, at activation time.
 * @param {unknown} config the patch row's `config`
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-kimi-code: config must be an object')
  }
  const bin = raw.bin ?? DEFAULT_BIN
  if (typeof bin !== 'string' || bin.trim() === '') {
    throw new Error('dsh-kimi-code: config.bin must be a non-empty string')
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`dsh-kimi-code: config.timeoutMs must be a number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
  }
  const maxOutputBytes = raw.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (typeof maxOutputBytes !== 'number' || !Number.isFinite(maxOutputBytes) || maxOutputBytes < 1024) {
    throw new Error('dsh-kimi-code: config.maxOutputBytes must be a number of at least 1024')
  }
  const model = raw.model
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error('dsh-kimi-code: config.model must be a non-empty string when set')
  }
  const extraArgs = raw.extraArgs ?? []
  if (!Array.isArray(extraArgs) || extraArgs.some((item) => typeof item !== 'string')) {
    throw new Error('dsh-kimi-code: config.extraArgs must be an array of strings')
  }
  return {
    bin: bin.trim(),
    model: model === undefined ? undefined : model.trim(),
    timeoutMs,
    maxOutputBytes,
    extraArgs,
  }
}

/** Tail of a captured stream, for error messages. */
function tail(text, maxChars = STDERR_TAIL_CHARS) {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`
}

/**
 * Resolve the kimi executable, trying each candidate in order and failing with
 * every attempt listed when none resolves.
 */
async function resolveBin(ctx, configured) {
  const candidates = [configured, process.env.KIMI_CODE_BIN, join(homedir(), '.kimi-code', 'bin', 'kimi')].filter(
    (candidate) => typeof candidate === 'string' && candidate !== '',
  )
  const tried = []
  for (const candidate of candidates) {
    try {
      return await ctx.subprocess.resolveExecutable(candidate)
    } catch (error) {
      tried.push(`${candidate} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  throw new Error(
    `dsh-kimi-code: cannot find the kimi executable. Tried: ${tried.join('; ')}. ` +
      'Install Kimi Code CLI (https://moonshotai.github.io/kimi-code/) or set the "bin" option in this plugin\'s config.',
  )
}

/** Resolve the directory kimi runs in: explicit arg, else this session's directory. */
async function resolveCwd(ctx, exec, requested) {
  if (requested === undefined) return await sessionCwd(ctx, exec)
  const target = isAbsolute(requested) ? requested : resolve(await sessionCwd(ctx, exec), requested)
  let stats
  try {
    stats = statSync(target)
  } catch (error) {
    throw new Error(`dsh-kimi-code: cwd "${target}" is not accessible: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stats.isDirectory()) throw new Error(`dsh-kimi-code: cwd "${target}" is not a directory`)
  return target
}

async function sessionCwd(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory', false)
  if (workingDirectory === undefined || exec.agent === undefined) {
    throw new Error('dsh-kimi-code: unable to resolve the session working directory; pass `cwd` explicitly')
  }
  return await workingDirectory.ensure(exec.agent, exec.signal)
}

/** Split kimi's stream-json stdout into the facts the tool reports. */
function parseKimiOutput(stdout) {
  const noise = []
  const toolNames = []
  let text = ''
  let sessionId = ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      noise.push(trimmed)
      continue
    }
    if (event === null || typeof event !== 'object') {
      noise.push(trimmed)
      continue
    }
    if (event.role === 'assistant') {
      const chunk = assistantText(event.content)
      if (chunk.trim() !== '') text = chunk
      if (Array.isArray(event.tool_calls)) {
        for (const call of event.tool_calls) {
          const toolName = call?.function?.name
          if (typeof toolName === 'string' && toolName !== '') toolNames.push(toolName)
        }
      }
      continue
    }
    if (event.role === 'meta' && event.type === 'session.resume_hint' && typeof event.session_id === 'string') {
      sessionId = event.session_id
    }
  }
  return { text, sessionId, toolNames, noise }
}

function assistantText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (typeof block?.text === 'string') text += block.text
  }
  return text
}

function buildPrompt(mode, prompt) {
  return mode === MODE_REVIEW ? `${REVIEW_PREFIX}${prompt}` : prompt
}

function requirePrompt(args) {
  const prompt = args?.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('dsh-kimi-code: "prompt" must be a non-empty string')
  }
  return prompt
}

function requireMode(args) {
  const mode = args?.mode
  if (mode === undefined) return MODE_DEVELOP
  if (!MODES.includes(mode)) throw new Error(`dsh-kimi-code: "mode" must be one of ${MODES.join(', ')}`)
  return mode
}

function optionalString(args, key) {
  const value = args?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`dsh-kimi-code: "${key}" must be a non-empty string when set`)
  return value.trim()
}

function renderResult(value) {
  const facts = [`kimi code · ${value.mode}`, `exit ${value.exitCode}`, `${Math.round(value.durationMs / 1000)}s`]
  if (value.toolCalls > 0) facts.push(`${value.toolCalls} tool call${value.toolCalls === 1 ? '' : 's'} (${value.toolNames.join(', ')})`)
  if (value.sessionId !== '') facts.push(`session ${value.sessionId}`)
  return `${value.text.trim()}\n\n[${facts.join(' · ')}]`
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  ctx.effect(() =>
    ctx.tools.register({
      name: 'kimi_code',
      description: DESCRIPTION,
      parameters: PARAMETERS,
      timeoutMs: cfg.timeoutMs + GRACE_MS + 5000,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `kimi code · ${requireMode(args)}`,
        kind: 'execute',
        rawInput: args,
      }),
      async execute(args, exec) {
        const prompt = requirePrompt(args)
        const mode = requireMode(args)
        const model = optionalString(args, 'model') ?? cfg.model
        const cwd = await resolveCwd(ctx, exec, optionalString(args, 'cwd'))
        const bin = await resolveBin(ctx, cfg.bin)

        const argv = [bin, '-p', buildPrompt(mode, prompt), '--output-format', 'stream-json']
        if (model !== undefined) argv.push('-m', model)
        argv.push(...cfg.extraArgs)

        const startedAt = Date.now()
        const handle = ctx.subprocess.spawn({
          argv,
          cwd,
          graceMs: GRACE_MS,
          signal: exec.signal,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: cfg.maxOutputBytes, spill: { maxBytes: SPILL_MAX_BYTES } },
            stderr: { maxBytes: STDERR_MAX_BYTES },
          },
        })

        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          handle.terminate()
        }, cfg.timeoutMs)

        let outcome
        try {
          outcome = await handle.done
        } finally {
          clearTimeout(timer)
        }
        const durationMs = Date.now() - startedAt

        const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
        const stderr = handle.collected.stderr?.readFrom(0) ?? { text: '', lossy: false }

        if (timedOut) {
          throw new Error(
            `dsh-kimi-code: kimi did not finish within ${Math.round(cfg.timeoutMs / 1000)}s and was terminated. ` +
              `stderr: ${tail(stderr.text) || '<empty>'}\nstdout tail: ${tail(stdout.text) || '<empty>'}`,
          )
        }
        if (exec.signal.aborted) throw new Error('dsh-kimi-code: kimi run aborted')
        if (outcome.exitCode !== 0) {
          throw new Error(
            `dsh-kimi-code: kimi exited with code ${outcome.exitCode}${outcome.signal === null ? '' : ` (signal ${outcome.signal})`}. ` +
              `stderr: ${tail(stderr.text) || '<empty>'}\nstdout tail: ${tail(stdout.text) || '<empty>'}`,
          )
        }
        if (stdout.lossy) {
          throw new Error(
            `dsh-kimi-code: kimi output exceeded ${cfg.maxOutputBytes} bytes and was truncated` +
              `${stdout.spillPath === undefined ? '' : ` (full stream: ${stdout.spillPath})`}; raise config.maxOutputBytes or split the task.`,
          )
        }

        const { text, sessionId, toolNames, noise } = parseKimiOutput(stdout.text)
        if (noise.length > 0) {
          throw new Error(
            `dsh-kimi-code: kimi wrote ${noise.length} non-JSON line(s) to stdout, so its stream-json result cannot be trusted: ` +
              `${tail(noise.join('\n'))}`,
          )
        }
        if (text.trim() === '') {
          throw new Error(
            'dsh-kimi-code: kimi finished without an assistant message. ' +
              `stderr: ${tail(stderr.text) || '<empty>'}\nstdout tail: ${tail(stdout.text) || '<empty>'}`,
          )
        }

        return {
          text,
          mode,
          cwd,
          sessionId,
          toolCalls: toolNames.length,
          toolNames: [...new Set(toolNames)],
          exitCode: outcome.exitCode,
          durationMs,
        }
      },
    }),
  )
}
