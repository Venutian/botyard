/**
 * A run's log read as a feed a person follows, the way a coding tool's own transcript reads: what the
 * bot said, what it thought where the tool shows it, each tool it ran with its input and a short
 * result, and what went wrong. Works on a log that is still being written.
 *
 * The engine's log is JSON lines of `{ chunk, seq, stream, ts }`: the tool's own stdout and stderr in
 * pieces. Stdout is each tool's own JSON events: Claude Code's stream-json, Codex's `exec --json`,
 * OpenCode's `run --format json` and the engine's own client for Gemini (`acp-run.mjs`). Each event
 * is known by its shape, so the feed needs no word on which tool wrote it. Text that is not JSON (the
 * engine's own notes, a launcher's words) is a note.
 */

const SECRET = /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b|(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g

/** A key or token in a run's words, hidden: a run's log is shown on the map and on the phone. */
export const scrub = (text) => String(text ?? '').replace(SECRET, (m, key, bearer) => (bearer ? `${bearer}[hidden]` : '[hidden]'))

/** What a tool call did, in a few words: the command, the file or the search. */
export function toolLine(name, input = {}) {
  return `${name}${toolWhat(input) ? `: ${toolWhat(input)}` : ''}`
}

function toolWhat(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : ''
  return String(input.command || input.cmd || input.file_path || input.filePath || input.path || input.pattern || input.query || input.url || input.description || input.prompt || input.skill || '')
}

/** How much of each kind of text the feed keeps. A tool's output keeps its head and its tail. */
export const FEED_LIMITS = { said: 6000, thinking: 4000, input: 3000, output: 3000, note: 600, summary: 160, items: 400 }

const oneLine = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** Long text kept to `max` characters: the start and the end, which is where a command's news is. */
export function keepEnds(text, max) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (s.length <= max) return s
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${s.slice(0, head)}\n… ${s.length - max} characters left out …\n${s.slice(-tail)}`
}

/** A tool's input as text a person reads: a lone command or a short object as itself, else JSON. */
function inputText(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const keys = Object.keys(input)
  if (keys.length === 1 && typeof input[keys[0]] === 'string') return input[keys[0]]
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

/** What a tool gave back, as text: Claude's results come as a string or a list of parts. */
function outputText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : p?.type === 'image' ? '[a picture]' : p?.text || '')).filter(Boolean).join('\n')
  }
  if (typeof content === 'object') {
    if (Array.isArray(content.content)) return outputText(content.content)
    if (typeof content.text === 'string') return content.text
    try { return JSON.stringify(content, null, 2) } catch { return '' }
  }
  return String(content)
}

/** The tool's own name, as a person reads it: an MCP tool's long name keeps its last two parts. */
function toolName(name) {
  const n = String(name || 'Tool')
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n)
  return mcp ? `${mcp[1].replace(/_/g, ' ')}: ${mcp[2].replace(/_/g, ' ')}` : n
}

/**
 * Read a run's log (or the end of it) into a feed.
 * @param {string} content the log's JSON lines; read from the middle of the file, the first line is a fragment
 * @param {{ fromStart?: boolean }} [opts] `fromStart` when the content is the whole log
 * @returns {{ items: Array<object>, cut: number }} the feed, oldest first; `cut` counts items dropped at its start
 */
export function runFeed(content, { fromStart = true, cwd = '' } = {}) {
  const items = []
  // The run's own folder, left out of a tool's one line: `cd <it> && ` and `<it>/` say nothing new.
  const home = String(cwd || '').replace(/\/+$/, '')
  const inFolder = (text) => (home.length > 1 ? text.split(`cd ${home} && `).join('').split(`cd "${home}" && `).join('').split(`${home}/`).join('') : text)
  const tools = new Map()
  let n = 0
  const key = () => `i${n++}`
  const last = () => items[items.length - 1]

  const push = (item) => { items.push({ key: key(), ...item }); return items[items.length - 1] }
  const say = (kind, text, extra = {}) => {
    const max = FEED_LIMITS[kind] || FEED_LIMITS.note
    const t = kind === 'note' ? oneLine(scrub(text), max) : keepEnds(scrub(text).trim(), max)
    if (!t) return
    const before = last()
    // A tool's closing result often repeats its last words: say them once.
    if (before && before.kind === kind && before.text === t) return
    push({ kind, text: t, ...extra })
  }
  const toolStart = (id, name, input, extra = {}) => {
    const had = id && tools.get(id)
    const inText = keepEnds(scrub(inputText(input)), FEED_LIMITS.input)
    if (had) {
      if (inText && !had.input) { had.input = inText; had.summary = oneLine(inFolder(scrub(toolWhat(input))), FEED_LIMITS.summary) }
      Object.assign(had, extra)
      return had
    }
    const item = push({ kind: 'tool', id: id || '', name: toolName(name), summary: oneLine(inFolder(scrub(toolWhat(input) || (typeof input === 'string' ? input : ''))), FEED_LIMITS.summary), input: inText, output: '', state: 'running', ...extra })
    if (id) tools.set(id, item)
    return item
  }
  const toolEnd = (id, output, failed, name = '') => {
    let item = id && tools.get(id)
    // Its start was before the part of the log that was read: the result stands alone.
    if (!item) item = toolStart(id, name || 'Tool', null)
    const out = keepEnds(scrub(outputText(output)), FEED_LIMITS.output)
    if (out) item.output = out
    item.state = failed ? 'failed' : 'done'
    return item
  }

  const claude = (e) => {
    const depth = e.parent_tool_use_id ? 1 : 0
    const extra = depth ? { depth } : {}
    if (e.type === 'system') {
      if (e.subtype === 'init') say('note', `Started${e.model ? ` on ${e.model}` : ''}${e.cwd ? ` in ${e.cwd}` : ''}`)
      else if (e.subtype === 'task_started' && e.description) say('note', `Background task: ${e.description}`)
      else if (e.subtype === 'compact_boundary') say('note', 'The conversation was compacted to make room')
      else if (e.subtype === 'api_retry' || e.subtype === 'api_error') say('error', e.error?.message || e.message || 'The model did not answer; retrying')
      return
    }
    if (e.type === 'assistant') {
      for (const part of e.message?.content || []) {
        if (part.type === 'text') say('said', part.text, extra)
        else if (part.type === 'thinking' && part.thinking?.trim()) say('thinking', part.thinking, extra)
        else if (part.type === 'redacted_thinking') continue
        else if (part.type === 'tool_use' || part.type === 'server_tool_use' || part.type === 'mcp_tool_use') toolStart(part.id, part.name, part.input, extra)
      }
      if (e.error) say('error', typeof e.error === 'string' ? e.error : e.error.message || 'The model reported an error')
      return
    }
    if (e.type === 'user') {
      const content = e.message?.content
      if (!Array.isArray(content)) return
      for (const part of content) if (part.type === 'tool_result') toolEnd(part.tool_use_id, part.content, part.is_error === true)
      return
    }
    if (e.type === 'result') {
      if (e.is_error || (e.subtype && e.subtype !== 'success')) {
        say('error', e.subtype === 'error_max_turns' ? 'It reached its turn limit before finishing' : typeof e.result === 'string' && e.result ? e.result : e.error || e.subtype || 'The run ended on an error')
      } else if (typeof e.result === 'string') {
        // The closing result repeats the last thing said: shown only when it is new.
        const lastSaid = [...items].reverse().find((i) => i.kind === 'said')
        const t = keepEnds(scrub(e.result).trim(), FEED_LIMITS.said)
        if (t && lastSaid?.text !== t) say('said', e.result)
      }
    }
  }

  const codex = (e) => {
    if (e.type === 'error') return say('error', e.message || 'Codex reported an error')
    if (e.type === 'turn.failed') return say('error', e.error?.message || 'Codex could not finish its turn')
    const it = e.item
    if (!it || !/^item\./.test(e.type)) return
    const done = e.type === 'item.completed'
    const id = it.id ? `codex:${it.id}` : ''
    if (it.type === 'agent_message') { if (done) say('said', it.text) }
    else if (it.type === 'reasoning') { if (done && it.text?.trim()) say('thinking', it.text) }
    else if (it.type === 'command_execution') {
      toolStart(id, 'Shell', it.command)
      if (done || it.status === 'completed' || it.status === 'failed') toolEnd(id, it.aggregated_output, it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0))
    } else if (it.type === 'file_change') {
      const changes = (it.changes || []).map((c) => `${c.kind || 'change'} ${c.path}`).join('\n')
      toolStart(id, 'Edit files', changes)
      if (done) toolEnd(id, '', it.status === 'failed')
    } else if (it.type === 'mcp_tool_call') {
      toolStart(id, `${it.server || 'mcp'}: ${it.tool || 'tool'}`, it.arguments)
      if (done || it.status === 'completed' || it.status === 'failed') toolEnd(id, it.result ?? it.error, it.status === 'failed' || Boolean(it.error))
    } else if (it.type === 'web_search') {
      toolStart(id, 'Web search', it.query)
      if (done) toolEnd(id, '', false)
    } else if (it.type === 'todo_list') {
      if (done || e.type === 'item.started') say('note', `Plan: ${(it.items || []).map((t) => `${t.completed ? '✓' : '○'} ${t.text}`).join('; ')}`)
    } else if (it.type === 'error') say('error', it.message || 'Codex reported an error')
  }

  const opencode = (e) => {
    const p = e.part || {}
    if (e.type === 'error') return say('error', e.error?.data?.message || e.error?.message || e.error?.name || 'The model reported an error')
    if (e.type === 'text' && p.text) return say('said', p.text)
    if (e.type === 'reasoning' && p.text?.trim()) return say('thinking', p.text)
    if (e.type === 'tool_use' && p.tool) {
      const id = p.callID ? `oc:${p.callID}` : p.id ? `oc:${p.id}` : ''
      const st = p.state || {}
      toolStart(id, p.tool, st.input)
      if (st.status === 'completed' || st.status === 'error') toolEnd(id, st.status === 'error' ? st.error : st.output, st.status === 'error')
    }
  }

  const gemini = (e) => {
    // The engine's client prints a tool when it starts and again only when it fails: anything after it means it ended.
    const ran = items.filter((i) => i.kind === 'tool' && i.state === 'running' && i.gemini)
    if (!(e.type === 'tool' && e.status === 'failed')) for (const i of ran) i.state = 'done'
    if (e.type === 'session') return say('note', `Started${e.resumed ? ' (carrying on its last conversation)' : ''}${e.model ? ` on ${e.model}` : ''}`)
    if (e.type === 'text') return say('said', e.text)
    if (e.type === 'tool') {
      // It names a tool by its title and gives no id: a failure is the last one of that title.
      const title = String(e.title || 'tool')
      if (e.status === 'failed') {
        const open = [...items].reverse().find((i) => i.kind === 'tool' && i.gemini && i.input === keepEnds(scrub(title), FEED_LIMITS.input))
        const item = open || toolStart('', 'Tool', title, { gemini: true })
        item.state = 'failed'
        for (const i of ran) if (i !== item) i.state = 'done'
        return
      }
      const item = toolStart('', 'Tool', title, { gemini: true })
      if (e.status === 'completed') item.state = 'done'
      return
    }
    if (e.type === 'result') {
      if (e.failed) say('error', e.why || 'The tool did not finish its turn')
      else if (e.text && [...items].reverse().find((i) => i.kind === 'said')?.text !== keepEnds(scrub(e.text).trim(), FEED_LIMITS.said)) say('said', e.text)
      return
    }
    if (e.type === 'error') say('error', e.message || 'The tool reported an error')
  }

  /** One whole line of the tool's stdout. */
  const line = (text) => {
    if (!text.trim()) return
    if (text.trimStart().startsWith('{')) {
      let e
      try { e = JSON.parse(text) } catch { return } // a record cut in two by the read: nothing a person reads
      if (!e || typeof e !== 'object') return
      if (['system', 'assistant', 'user', 'result', 'rate_limit_event', 'tool_progress', 'stream_event'].includes(e.type) && (e.session_id || e.message || e.subtype || e.type === 'result')) {
        // Gemini's result has `sessionId` and `usage.inputTokens`: Claude's has `session_id`.
        if (e.type === 'result' && 'sessionId' in e && !('session_id' in e)) return gemini(e)
        return claude(e)
      }
      if (/^(thread|turn|item)\./.test(e.type) || (e.type === 'error' && !e.error && !('sessionID' in e))) return codex(e)
      if (e.part || 'sessionID' in e || e.type === 'step_start' || e.type === 'step_finish') return opencode(e)
      return gemini(e)
    }
    say('note', text.replace(/^\[engine\]\s*/, ''))
  }

  /** A line of the tool's stderr: an error if it reads like one, else a note. */
  const errLine = (text) => {
    if (!text.trim()) return
    say(/\b(error|failed|fatal|denied|refused|exception|traceback|cannot|could not|unable)\b/i.test(text) ? 'error' : 'note', text)
  }

  const pending = { stdout: '', stderr: '' }
  const rows = String(content || '').split('\n')
  for (const raw of fromStart ? rows : rows.slice(1)) {
    if (!raw.trim()) continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (typeof rec?.chunk !== 'string') continue
    const stream = rec.stream === 'stderr' ? 'stderr' : 'stdout'
    const parts = (pending[stream] + rec.chunk).split('\n')
    pending[stream] = parts.pop()
    for (const p of parts) (stream === 'stderr' ? errLine : line)(p)
  }
  // What is left has no newline yet: a run still going writes its next line here.
  if (pending.stderr) errLine(pending.stderr)
  if (pending.stdout && !pending.stdout.trimStart().startsWith('{')) line(pending.stdout)
  else if (pending.stdout) { try { JSON.parse(pending.stdout); line(pending.stdout) } catch { /* half a record: it comes whole on the next read */ } }

  const cut = Math.max(0, items.length - FEED_LIMITS.items)
  return { items: items.slice(cut), cut }
}
