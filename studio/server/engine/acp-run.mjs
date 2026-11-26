#!/usr/bin/env node
/**
 * One turn with a tool that speaks the Agent Client Protocol (Gemini's own command line, or the
 * crew's relay in front of another): start the tool, open a session or carry one on, hand it the
 * prompt read from stdin, answer what it asks while it works, and print what happened as JSON
 * lines, which the run's keeper writes to the log and the engine reads when the run ends.
 *
 * Usage: node acp-run.mjs --cwd <folder> [--session <id>] [--may-not push,commit,edit] [--handshake-sec N] -- <tool> [args…]
 *
 * Lines printed (one JSON object each):
 *   { type: 'session', sessionId, resumed, model }      once the session is open
 *   { type: 'text', text }                              what the tool said, a passage at a time
 *   { type: 'tool', title, status }                     a tool it started or finished
 *   { type: 'result', sessionId, stopReason, usage: { inputTokens, cachedInputTokens, outputTokens }, text, failed, why }
 *   { type: 'error', message }                          it could not be started, or the turn broke
 * Ends with code 0 when the turn ended by itself, 1 otherwise.
 *
 * The tool may read any file and write files inside the work folder and the temp folder through
 * this client; it is given no terminal (it runs commands itself). A permission it asks for is
 * granted once, unless it is one of the things this bot is kept from (`--may-not`): then it is
 * refused, and so is a file write when the bot may not edit.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchable, notStarted } from './start-tool.mjs'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const own = split === -1 ? argv : argv.slice(0, split)
const tool = split === -1 ? [] : argv.slice(split + 1)
const option = (name, fallback = '') => { const i = own.indexOf(name); return i !== -1 && own[i + 1] !== undefined ? own[i + 1] : fallback }
const cwd = path.resolve(option('--cwd', process.cwd()))
const wanted = option('--session')
const mayNot = option('--may-not').split(',').filter(Boolean)
const handshakeMs = Math.max(1, Number(option('--handshake-sec', '60')) || 60) * 1000

const print = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)
const whole = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0)

let child = null
let done = false
function end(code) {
  if (done) return
  done = true
  if (!child || child.exitCode !== null) return process.exit(code)
  // Closing its input is how the tool is told the conversation is over; then it is made to go.
  try { child.stdin.end() } catch { /* already closed */ }
  const term = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* gone */ } }, 2000)
  const kill = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }, 5000)
  child.once('exit', () => { clearTimeout(term); clearTimeout(kill); process.exit(code) })
}
const fail = (message) => { print({ type: 'error', message: String(message).slice(0, 600) }); end(1) }

if (!tool.length) fail('No tool was named to talk to')

// ── what the tool said so far ───────────────────────────────────────────────────────

let passage = ''
let last = ''
let replaying = false
const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, seen: false }
function flush() {
  if (passage.trim()) { last = passage.trim(); print({ type: 'text', text: last }) }
  passage = ''
}
function takeUsage(u) {
  if (!u || typeof u !== 'object') return
  const input = u.inputTokens ?? u.input_tokens
  const output = u.outputTokens ?? u.output_tokens
  if (input === undefined && output === undefined) return
  usage.seen = true
  usage.inputTokens = whole(input) + whole(u.cachedWriteTokens ?? u.cached_write_tokens)
  usage.cachedInputTokens = whole(u.cachedReadTokens ?? u.cached_read_tokens)
  usage.outputTokens = whole(output) + whole(u.thoughtTokens ?? u.thought_tokens)
}

// ── the wire: one JSON-RPC message a line, both ways ────────────────────────────────

let nextId = 1
const waiting = new Map()
const send = (message) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) } catch { /* the tool is gone: its exit is reported */ } }
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  waiting.set(id, { resolve, reject, method })
  send({ id, method, params })
})

const inside = (file, folder) => { const rel = path.relative(folder, file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
const writable = (file) => [cwd, os.tmpdir(), process.env.TMPDIR || ''].filter(Boolean).some((folder) => inside(file, path.resolve(folder)))

/** Whether what the tool asks leave for is something this bot is kept from. */
function keptFrom(toolCall = {}) {
  if (!mayNot.length) return false
  if (mayNot.includes('edit') && ['edit', 'delete', 'move'].includes(toolCall.kind)) return true
  const said = [toolCall.title, toolCall.rawInput?.command, toolCall.rawInput?.cmd, ...(Array.isArray(toolCall.rawInput?.args) ? toolCall.rawInput.args : [])].filter((v) => typeof v === 'string').join(' ')
  const noCommit = mayNot.includes('commit') || mayNot.includes('edit')
  if (new RegExp(`\\bgit\\b[^|;&\\n]*\\b(push${noCommit ? '|commit' : ''})\\b`).test(said)) return true
  return /(^|[\s;&|(])gh\s+(?!pr (view|list|diff|checks|status)\b|issue (view|list)\b|repo view\b|run (view|list)\b|auth status\b)/.test(said)
}

/** What the tool asks of its client. */
function serve(method, params = {}) {
  if (method === 'session/request_permission') {
    const options = Array.isArray(params.options) ? params.options : []
    if (keptFrom(params.toolCall)) {
      const no = options.find((o) => o.kind === 'reject_once') || options.find((o) => String(o.kind || '').startsWith('reject'))
      process.stderr.write(`Refused, because this bot may not ${mayNot.join(', ')}: ${String(params.toolCall?.title || params.toolCall?.kind || 'a tool').slice(0, 200)}\n`)
      return no ? { outcome: { outcome: 'selected', optionId: no.optionId } } : { outcome: { outcome: 'cancelled' } }
    }
    const pick = options.find((o) => o.kind === 'allow_once') || options.find((o) => o.kind === 'allow_always') || options.find((o) => String(o.kind || '').startsWith('allow'))
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  if (method === 'fs/read_text_file') {
    const file = path.resolve(cwd, String(params.path || ''))
    let content = fs.readFileSync(file, 'utf8')
    if (params.line || params.limit) {
      const lines = content.split('\n')
      const from = Math.max(0, (Number(params.line) || 1) - 1)
      content = lines.slice(from, params.limit ? from + Number(params.limit) : undefined).join('\n')
    }
    return { content }
  }
  if (method === 'fs/write_text_file') {
    const file = path.resolve(cwd, String(params.path || ''))
    if (mayNot.includes('edit')) throw Object.assign(new Error('This bot may not change files'), { code: -32000 })
    if (!writable(file)) throw Object.assign(new Error('Files are written only inside the job\'s own folder'), { code: -32000 })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(params.content ?? ''))
    return null
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

function update(params = {}) {
  if (replaying) return
  const u = params.update || {}
  const kind = u.sessionUpdate
  if (kind === 'agent_message_chunk') {
    if (u.content?.type === 'text' && typeof u.content.text === 'string') passage += u.content.text
    if (passage.length > 4000 && passage.endsWith('\n')) flush()
  } else if (kind === 'tool_call') {
    flush()
    print({ type: 'tool', title: String(u.title || u.kind || 'tool').slice(0, 300), status: u.status || 'pending' })
  } else if (kind === 'tool_call_update') {
    if (u.status === 'failed') print({ type: 'tool', title: String(u.title || u.toolCallId || 'tool').slice(0, 300), status: 'failed' })
  } else if (kind === 'usage_update') {
    takeUsage(u.usage || u._meta?.usage || u)
  }
}

function onLine(line) {
  let m
  try { m = JSON.parse(line) } catch { return process.stderr.write(`${line}\n`) }
  if (!m || typeof m !== 'object') return
  if (m.method && m.id !== undefined && m.id !== null) {
    try { send({ id: m.id, result: serve(m.method, m.params) }) } catch (err) { send({ id: m.id, error: { code: err.code || -32000, message: String(err.message).slice(0, 300) } }) }
    return
  }
  if (m.method) { if (m.method === 'session/update') update(m.params); return }
  const asked = waiting.get(m.id)
  if (!asked) return
  waiting.delete(m.id)
  if (m.error) asked.reject(Object.assign(new Error(String(m.error.message || `The tool refused ${asked.method}`)), { code: m.error.code, data: m.error.data }))
  else asked.resolve(m.result ?? {})
}

// ── the turn ────────────────────────────────────────────────────────────────────────

async function turn(prompt) {
  const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms).unref())])
  const hello = await within(call('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'botyard', version: '1' },
  }), handshakeMs, 'The tool did not answer when it was started')
  const can = hello.agentCapabilities || {}
  let sessionId = ''
  let resumed = false
  let opened = {}
  if (wanted && (can.sessionCapabilities?.resume || can.loadSession)) {
    try {
      // A loaded session is played back from its start: that is history, not this turn.
      replaying = true
      opened = await within(call(can.sessionCapabilities?.resume ? 'session/resume' : 'session/load', { sessionId: wanted, cwd, mcpServers: [] }), handshakeMs, 'The tool did not open the earlier session')
      sessionId = wanted
      resumed = true
    } catch (err) {
      process.stderr.write(`The earlier session could not be carried on (${String(err.message).slice(0, 200)}): starting a fresh one.\n`)
    }
    replaying = false
    passage = ''
  }
  if (!sessionId) {
    try {
      opened = await within(call('session/new', { cwd, mcpServers: [] }), handshakeMs, 'The tool did not open a session')
    } catch (err) {
      if (err.code === -32000 && /auth/i.test(String(err.message)) || (hello.authMethods || []).length && /auth|sign|log ?in|api key|credential/i.test(String(err.message))) throw new Error(`The tool is not signed in on this computer: ${err.message}`)
      throw err
    }
    sessionId = String(opened.sessionId || '')
    if (!sessionId) throw new Error('The tool opened no session')
  }
  print({ type: 'session', sessionId, resumed, model: opened.models?.currentModelId || process.env.GEMINI_MODEL || '' })
  const result = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
  flush()
  takeUsage(result.usage || result._meta?.usage)
  const stopReason = String(result.stopReason || 'end_turn')
  const failed = stopReason === 'cancelled' || stopReason === 'refusal'
  print({
    type: 'result', sessionId, stopReason, model: opened.models?.currentModelId || process.env.GEMINI_MODEL || '',
    usage: { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens },
    text: last, failed, why: failed ? (stopReason === 'cancelled' ? 'The turn was cancelled' : 'The model refused to go on') : '',
  })
  end(failed ? 1 : 0)
}

if (tool.length) {
  const chunks = []
  process.stdin.on('data', (chunk) => chunks.push(chunk))
  process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks).toString('utf8')
    try {
      const start = launchable(tool[0], tool.slice(1), process.env)
      if (!start.found) throw Object.assign(new Error(`spawn ${tool[0]} ENOENT`), { code: 'ENOENT' })
      child = spawn(start.command, start.args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, ...start.options })
    } catch (err) {
      return fail(notStarted(tool[0], err))
    }
    child.on('error', (err) => fail(notStarted(tool[0], err)))
    child.on('exit', (code, signal) => { if (!done) fail(`The tool stopped before the turn ended (${signal || `code ${code}`})`) })
    child.stdin.on('error', () => { /* the tool closed its input */ })
    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) if (line.trim()) onLine(line)
    })
    turn(prompt).catch((err) => fail(err.message))
  })
  // Stopped from outside (its time limit, a cancel): what the turn used so far is still said, so a cut run is not a run that cost nothing.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (!done) { flush(); print({ type: 'result', sessionId: '', stopReason: 'stopped', usage: { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens }, text: last, failed: true, why: 'It was stopped before its turn ended' }) }
    try { child?.kill('SIGTERM') } catch { /* gone */ }
    setTimeout(() => process.exit(1), 1500).unref()
  })
}
