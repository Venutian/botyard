/**
 * How each kind of bot is started, and how its output is read.
 *
 * The crew's own launchers stay what they are (a bot's `command` in its settings): the engine
 * builds the command line each tool expects around them. Each
 * adapter gives the arguments for a run and reads two things out of what the tool prints: the
 * session to resume next time, and the tokens the run used.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export class AdapterError extends Error {}

const list = (value) => (Array.isArray(value) ? value.map(String) : [])

/** Claude Code, through the crew's launcher. The prompt goes in on stdin. */
function claude(agent, { model, session, instructionsFile, mcpConfig, readDirs = [] }) {
  const c = agent.adapterConfig || {}
  return {
    command: c.command || 'claude',
    args: [
      '--print', '--output-format', 'stream-json', '--verbose',
      ...(session ? ['--resume', session] : []),
      ...(c.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...(model ? ['--model', model] : []),
      ...(c.effort ? ['--effort', String(c.effort)] : []),
      ...(c.maxTurnsPerRun ? ['--max-turns', String(c.maxTurnsPerRun)] : []),
      // A resumed session already carries its instructions.
      ...(!session && instructionsFile ? ['--append-system-prompt-file', instructionsFile] : []),
      // Only what the engine and Botyard's connectors give: never the owner's own connected apps.
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      ...(instructionsFile ? ['--add-dir', path.dirname(instructionsFile)] : []),
      // The files it was woken with (a screenshot sent in chat) sit in the run's own folder.
      ...readDirs.flatMap((dir) => ['--add-dir', dir]),
      ...list(c.extraArgs),
    ],
  }
}

/** OpenCode, through the crew's runner (which picks a free model that answers). */
function opencode(agent, { model, session, cwd }) {
  const c = agent.adapterConfig || {}
  return {
    command: c.command || 'opencode',
    args: [
      'run', '--format', 'json',
      ...(session ? ['--session', session] : []),
      ...(model ? ['--model', model] : []),
      ...(c.variant ? ['--variant', String(c.variant)] : []),
      '--dir', cwd,
      ...list(c.extraArgs),
    ],
  }
}

/** Whether the bot's own extra arguments already choose a sandbox for Codex. */
const choosesSandbox = (args) => args.some((a, i) => /^(-s|--sandbox|-p|--profile|--full-auto)$/.test(a) || /^--(sandbox|profile)=/.test(a) || (a === '-c' && /^sandbox_mode\s*=/.test(args[i + 1] || '')))

/**
 * Codex, as its own command line: one `exec` that prints JSON lines, the prompt on stdin. Unless
 * the bot is set to run with no sandbox it may write only in its work folder, and may reach the
 * network (it has to call this engine). A resumed run names its thread.
 */
function codex(agent, { model, session }) {
  const c = agent.adapterConfig || {}
  const extra = list(c.extraArgs)
  const bypass = c.dangerouslyBypassApprovalsAndSandbox === true
  return {
    command: c.command || 'codex',
    args: [
      'exec', '--json',
      ...(!bypass && !choosesSandbox(extra) ? ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'] : []),
      ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ...(model ? ['--model', model] : []),
      ...(c.modelReasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(String(c.modelReasoningEffort))}`] : []),
      ...extra,
      ...(session ? ['resume', session] : []),
      '-',
    ],
  }
}

/** A command line as its words: quotes keep a word with spaces whole. No shell reads it. */
export function words(line) {
  const out = []
  for (const m of String(line || '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3])
  return out
}

/**
 * Gemini, or any tool that speaks the Agent Client Protocol: the engine's own small client
 * (`acp-run.mjs`) starts the tool, opens or resumes a session, hands it the prompt through a pipe,
 * and prints what happened as JSON lines. `agentCommand` is the tool's command line (the crew's is
 * its relay); without one it is Gemini's own.
 */
function gemini(agent, { model, session, cwd, mayNot = [] }) {
  const c = agent.adapterConfig || {}
  const tool = words(c.agentCommand || (c.command ? `${c.command} --acp` : 'gemini --acp'))
  return {
    command: process.execPath,
    args: [path.join(here, 'acp-run.mjs'), '--cwd', cwd, ...(session ? ['--session', session] : []), ...(mayNot.length ? ['--may-not', mayNot.join(',')] : []), ...list(c.extraArgs), '--', ...tool],
    env: model ? { GEMINI_MODEL: model } : {},
  }
}

const ADAPTERS = { claude_local: claude, codex_local: codex, gemini_local: gemini, opencode_local: opencode }

/** The kinds of bot the engine can start. */
export const ADAPTER_TYPES = Object.keys(ADAPTERS)

export const canRun = (agent) => agent.adapterType in ADAPTERS

/** The command line for one run of this bot. */
export function commandFor(agent, run) {
  const build = ADAPTERS[agent.adapterType]
  if (!build) throw new AdapterError(`Botyard's engine cannot start a ${agent.adapterType} bot yet`)
  return build(agent, run)
}

/** Whether the prompt carries the bot's rules itself, or the tool is handed their file (Claude). */
export const inlinesInstructions = (agent) => agent.adapterType !== 'claude_local'

/** Who is billed for a run of this kind of bot, for the usage rows. */
export const providerOf = (adapterType) => ({ claude_local: 'anthropic', codex_local: 'openai', gemini_local: 'google', opencode_local: 'opencode' })[adapterType] || 'other'

const GONE_SESSION = /unknown (session|thread)|(session|thread|conversation) .{0,80}not found|no conversation found|missing rollout path for thread|state db (missing|returned stale) rollout path|no rollout found for thread id|session .{0,40}does not exist/i

/** Whether a failed run's own words say the session it was asked to carry on no longer exists. */
export const sessionIsGone = (text) => GONE_SESSION.test(String(text || ''))

const whole = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0)

/**
 * What a finished run printed, read once: the session it ended in, the tokens it used, the model
 * that answered, its last words, and whether the tool itself said it failed. `lines` are the tool's
 * own output lines (each a JSON object, or text that is skipped).
 */
export function readOutput(adapterType, lines) {
  const out = { session: '', model: '', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: null, said: '', failed: false, why: '' }
  // Claude's tokens message by message, for a run that ends without its closing line (cut at its time
  // limit, cancelled, crashed): the closing line is the only place the tool itself adds them up.
  const perMessage = new Map()
  let closed = false
  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (adapterType === 'claude_local') {
      if (e.type === 'system' && e.subtype === 'init') { out.session = e.session_id || out.session; out.model = e.model || out.model }
      if (e.type === 'assistant') {
        const text = (e.message?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim()
        if (text) out.said = text
        const u = e.message?.usage
        if (u && typeof u === 'object') {
          // One message comes as several lines (a line a part): the largest count of each kind is the message's.
          const id = e.message.id || `line-${perMessage.size}`
          const had = perMessage.get(id) || { input: 0, cached: 0, output: 0 }
          perMessage.set(id, { input: Math.max(had.input, whole(u.input_tokens) + whole(u.cache_creation_input_tokens)), cached: Math.max(had.cached, whole(u.cache_read_input_tokens)), output: Math.max(had.output, whole(u.output_tokens)) })
          if (!out.model && e.message.model) out.model = String(e.message.model)
        }
      }
      if (e.type === 'result') {
        closed = true
        out.session = e.session_id || out.session
        const u = e.usage || {}
        out.inputTokens = whole(u.input_tokens) + whole(u.cache_creation_input_tokens)
        out.cachedInputTokens = whole(u.cache_read_input_tokens)
        out.outputTokens = whole(u.output_tokens)
        out.costUsd = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null
        if (typeof e.result === 'string' && e.result.trim()) out.said = e.result.trim()
        if (e.is_error || (e.subtype && e.subtype !== 'success')) { out.failed = true; out.why = e.subtype === 'error_max_turns' ? 'It reached its turn limit before finishing' : String(e.result || e.subtype || 'The tool reported an error').slice(0, 400) }
      }
    } else if (adapterType === 'codex_local') {
      if (e.type === 'thread.started' && e.thread_id) out.session = String(e.thread_id)
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string' && e.item.text.trim()) out.said = e.item.text.trim()
      if (e.type === 'turn.started') { out.failed = false; out.why = '' }
      const u = ['turn.completed', 'turn.failed', 'error'].includes(e.type) ? e.usage : null
      if (u && typeof u === 'object') {
        // Codex counts what it read from its cache inside its input: they are told apart here.
        const cached = whole(u.cached_input_tokens)
        out.inputTokens = Math.max(0, whole(u.input_tokens) - cached)
        out.cachedInputTokens = cached
        out.outputTokens = whole(u.output_tokens)
      }
      if (e.type === 'error') { out.failed = true; out.why = String(e.message || 'Codex reported an error').slice(0, 400) }
      if (e.type === 'turn.failed') { out.failed = true; out.why = String(e.error?.message || 'Codex could not finish its turn').slice(0, 400) }
      if (e.model) out.model = String(e.model)
    } else if (adapterType === 'gemini_local') {
      // The engine's own client's lines (acp-run.mjs).
      if (e.type === 'session') { out.session = e.sessionId || out.session; out.model = e.model || out.model }
      if (e.type === 'text' && typeof e.text === 'string' && e.text.trim()) out.said = e.text.trim()
      if (e.type === 'tool') out.said = ''
      if (e.type === 'result') {
        out.session = e.sessionId || out.session
        out.model = e.model || out.model
        const u = e.usage || {}
        out.inputTokens = whole(u.inputTokens)
        out.cachedInputTokens = whole(u.cachedInputTokens)
        out.outputTokens = whole(u.outputTokens)
        if (typeof e.text === 'string' && e.text.trim()) out.said = e.text.trim()
        if (e.failed) { out.failed = true; out.why = String(e.why || 'The tool did not finish its turn').slice(0, 400) }
      }
      if (e.type === 'error') { out.failed = true; out.why = String(e.message || 'The tool reported an error').slice(0, 400) }
    } else {
      out.session = e.sessionID || e.part?.sessionID || out.session
      if (e.type === 'step_finish') {
        const t = e.part?.tokens || {}
        out.inputTokens += whole(t.input) + whole(t.cache?.write)
        out.cachedInputTokens += whole(t.cache?.read)
        out.outputTokens += whole(t.output) + whole(t.reasoning)
      }
      if (e.type === 'text' && e.part?.text) out.said = String(e.part.text).trim() || out.said
      if (e.type === 'error') { out.failed = true; out.why = String(e.error?.data?.message || e.error?.message || e.error?.name || 'The tool reported an error').slice(0, 400) }
      if (e.model || e.part?.model) out.model = e.model || e.part.model
    }
  }
  if (adapterType === 'claude_local' && !closed && perMessage.size) {
    for (const m of perMessage.values()) { out.inputTokens += m.input; out.cachedInputTokens += m.cached; out.outputTokens += m.output }
    out.partial = true
  }
  return out
}
