/**
 * Every AI: a Codex bot and a Gemini bot are started the way each tool wants, with stand-ins for
 * the tools themselves, and what they print is read into the run: the session to carry on, the
 * tokens, the closing words and the errors. No real model is called here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADAPTER_TYPES, commandFor, readOutput, sessionIsGone, words } from '../server/engine/adapters.mjs'
import { startEngine } from '../server/engine/main.mjs'

const quiet = () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A studio with one project folder (no git: the job is worked in place) and a way to run a job to its end. */
async function studio(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ai-'))
  const work = path.join(dir, 'work')
  fs.mkdirSync(work)
  const engine = await startEngine({ dataDir: path.join(dir, 'data'), port: 0, runs: false, log: quiet })
  // Whatever a test finds, the port is closed after it.
  t.after(() => engine.stop())
  const ok = async (method, url, body) => {
    const out = await engine.handle({ method, url, body })
    assert.ok(out.status < 300, `${method} ${url} → ${out.status} ${JSON.stringify(out.body)}`)
    return out.body
  }
  const id = (await ok('GET', '/api/companies'))[0].id
  const project = await ok('POST', `/api/companies/${id}/projects`, { name: 'Work', workspace: { cwd: work } })
  const script = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); fs.chmodSync(file, 0o755); return file }
  /** Give the bot a job (or wake it on one it has) and wait for the run to be booked. */
  const runOn = async (bot, job) => {
    const before = engine.store.rows('SELECT id FROM runs WHERE job_id = ?', job.id).length
    for (let n = 0; n < 200; n++) {
      await engine.turn()
      const runs = engine.store.objects('SELECT raw FROM runs WHERE job_id = ? ORDER BY created_at', job.id)
      if (runs.length > before && !['running', 'queued'].includes(runs.at(-1).status)) return runs.at(-1)
      await sleep(50)
    }
    throw new Error('the run did not end')
  }
  return { dir, work, engine, ok, id, project, script, runOn, note: (name) => fs.readFileSync(path.join(dir, name), 'utf8') }
}

test('the engine starts Claude, Codex, Gemini and free-model bots, and no others', () => {
  assert.deepEqual([...ADAPTER_TYPES].sort(), ['claude_local', 'codex_local', 'gemini_local', 'opencode_local'])
  assert.throws(() => commandFor({ adapterType: 'telepathy' }, {}), /cannot start/)
  assert.deepEqual(words('/a/relay.py --flag "two words" \'three more words\' last'), ['/a/relay.py', '--flag', 'two words', 'three more words', 'last'])
})

test('Codex is started as one exec with the prompt on stdin, in its sandbox unless told otherwise, and a resumed run names its thread', () => {
  const bot = (adapterConfig) => ({ adapterType: 'codex_local', adapterConfig })
  const fresh = commandFor(bot({ command: '/opt/codex', model: 'gpt-5.5', modelReasoningEffort: 'high', extraArgs: ['--skip-git-repo-check'] }), { model: 'gpt-5.5', session: '' })
  assert.equal(fresh.command, '/opt/codex')
  assert.deepEqual(fresh.args, ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', '--skip-git-repo-check', '-'])
  const resumed = commandFor(bot({ model: 'gpt-5.5' }), { model: 'gpt-5.5', session: 'th-1' })
  assert.equal(resumed.command, 'codex')
  assert.deepEqual(resumed.args.slice(-3), ['resume', 'th-1', '-'])
  const open = commandFor(bot({ dangerouslyBypassApprovalsAndSandbox: true }), { model: '', session: '' })
  assert.deepEqual(open.args, ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-'])
  const own = commandFor(bot({ extraArgs: ['--sandbox', 'read-only'] }), { model: '', session: '' })
  assert.equal(own.args.includes('sandbox_mode="workspace-write"'), false, 'a bot that chooses its own sandbox keeps it')
})

test('what Codex prints is read: its thread, its last words, its tokens with the cached ones taken out of the input, and its errors', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"019a-thread"}',
    '{"type":"turn.started"}',
    'not json at all',
    '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Working on it."}}',
    '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Done. COMMIT abc123"}}',
    '{"type":"turn.completed","usage":{"input_tokens":12000,"cached_input_tokens":9000,"output_tokens":400}}',
  ]
  assert.deepEqual(readOutput('codex_local', lines), { session: '019a-thread', model: '', models: [], inputTokens: 3000, cachedInputTokens: 9000, outputTokens: 400, costUsd: null, said: 'Done. COMMIT abc123', failed: false, why: '' })
  const failed = readOutput('codex_local', ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}', '{"type":"error","message":"You have hit your usage limit. Try again at 9:00 PM."}', '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again at 9:00 PM."}}'])
  assert.equal(failed.failed, true)
  assert.match(failed.why, /usage limit/)
  assert.equal(sessionIsGone('Error: no rollout found for thread id 019a'), true)
  assert.equal(sessionIsGone('No conversation found with session ID: 0b0e'), true)
  assert.equal(sessionIsGone('The build failed: file not found'), false)
})

/** A stand-in for Codex: notes how it was started, then prints what Codex prints. */
const CODEX = (dir) => `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/codex-args.txt"
cat > "${dir}/codex-stdin.txt"
env | grep -E '^(CODEX_HOME|OPENAI_API_KEY|BOTYARD_API_URL|BOTYARD_JOB_ID)=' | sort > "${dir}/codex-env.txt"
case "$*" in
  *"resume gone-thread"*) echo "Error: no rollout found for thread id gone-thread" >&2; exit 1;;
esac
echo '{"type":"thread.started","thread_id":"th-42"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Recorded it. OUTCOME: PASS"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":120}}'
`

test('a Codex bot runs a job: instructions and brief go in on stdin, its secret reaches it, and the run is booked with thread and tokens', async (t) => {
  const s = await studio(t)
  const tool = s.script('codex.sh', CODEX(s.dir))
  const bot = await s.ok('POST', `/api/companies/${s.id}/agents`, {
    name: 'Clerk', title: 'Record keeper', adapterType: 'codex_local', instructions: 'You are Clerk. Keep the record straight.\n',
    adapterConfig: { command: tool, model: 'gpt-5.5', modelReasoningEffort: 'medium', timeoutSec: 30, graceSec: 1, extraArgs: ['--skip-git-repo-check'], env: { CODEX_HOME: { type: 'plain', value: '/tmp/codex-safe' }, OPENAI_API_KEY: 'sk-codex-test' } },
  })
  const job = await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'Record the week', description: 'Write down what was done.', projectId: s.project.id, assigneeAgentId: bot.id })
  const run = await s.runOn(bot, job)
  assert.equal(run.status, 'succeeded', run.error || '')
  assert.equal(run.sessionIdAfter, 'th-42')
  assert.deepEqual([run.usageJson.inputTokens, run.usageJson.cachedInputTokens, run.usageJson.outputTokens], [1000, 4000, 120])
  assert.equal(run.resultJson.summary, 'Recorded it. OUTCOME: PASS')
  assert.deepEqual(s.note('codex-args.txt').trim().split('\n'), ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="medium"', '--skip-git-repo-check', '-'])
  const stdin = s.note('codex-stdin.txt')
  assert.match(stdin, /You are Clerk\. Keep the record straight\./)
  assert.match(stdin, /Record the week/)
  assert.match(stdin, /Write down what was done\./)
  const env = s.note('codex-env.txt')
  assert.match(env, /^CODEX_HOME=\/tmp\/codex-safe$/m)
  assert.match(env, /^OPENAI_API_KEY=sk-codex-test$/m, 'the secret is in the run, though no read gives it')
  assert.match(env, new RegExp(`^BOTYARD_API_URL=${s.engine.apiUrl}$`, 'm'))
  const usage = s.engine.store.rows('SELECT provider, model, input_tokens FROM usage')
  assert.deepEqual(usage.map((u) => [u.provider, u.model, u.input_tokens]), [['openai', 'gpt-5.5', 1000]])

  // A word from the owner wakes it in the same thread.
  await s.ok('POST', `/api/issues/${job.id}/comments`, { body: 'Add Friday too.' })
  const second = await s.runOn(bot, job)
  assert.equal(second.sessionIdBefore, 'th-42')
  assert.deepEqual(s.note('codex-args.txt').trim().split('\n').slice(-3), ['resume', 'th-42', '-'])
  assert.match(s.note('codex-stdin.txt'), /Add Friday too\./)
  assert.doesNotMatch(s.note('codex-stdin.txt'), /Keep the record straight/, 'a resumed thread already has its instructions')

  // A thread Codex no longer has: the run fails, and is tried once more from a fresh one by itself.
  const kept = s.engine.store.object('SELECT raw FROM sessions WHERE agent_id = ?', bot.id)
  s.engine.store.put('sessions', { ...kept, sessionParamsJson: { ...kept.sessionParamsJson, sessionId: 'gone-thread' } }, { position: 0 })
  await s.ok('POST', `/api/issues/${job.id}/comments`, { body: 'And Saturday.' })
  const retried = await s.runOn(bot, job)
  const lost = s.engine.store.object('SELECT raw FROM runs WHERE id = ?', retried.retryOfRunId || '')
  assert.equal(lost?.status, 'failed', 'the run on the lost thread failed')
  assert.match(lost.error, /no rollout found/)
  assert.equal(retried.status, 'succeeded')
  assert.equal(retried.sessionIdBefore, null)
  assert.equal(retried.retryOfRunId, lost.id)
  assert.equal(retried.sessionIdAfter, 'th-42')
})

/** A stand-in for a tool that speaks the Agent Client Protocol, the way Gemini's command line does. */
const ACP_AGENT = (dir) => `#!/usr/bin/env node
const fs = require('node:fs')
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const mode = process.env.ACP_STANDIN || 'good'
fs.writeFileSync('${dir}/acp-env.txt', 'GEMINI_MODEL=' + (process.env.GEMINI_MODEL || '') + '\\nAGY_MODELS=' + (process.env.AGY_MODELS || '') + '\\nargs=' + process.argv.slice(2).join(' ') + '\\n')
let buffer = ''
const asked = new Map()
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n'); buffer = lines.pop()
  for (const line of lines) if (line.trim()) on(JSON.parse(line))
})
process.stdin.on('end', () => { fs.appendFileSync('${dir}/acp-env.txt', 'closed\\n'); process.exit(0) })
function on(m) {
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
  if (m.method === 'session/new') { fs.appendFileSync('${dir}/acp-env.txt', 'new ' + JSON.stringify(m.params) + '\\n'); return send({ id: m.id, result: { sessionId: 'acp-7', models: { currentModelId: 'gemini-test' } } }) }
  if (m.method === 'session/load') {
    fs.appendFileSync('${dir}/acp-env.txt', 'load ' + m.params.sessionId + '\\n')
    if (m.params.sessionId === 'acp-lost') return send({ id: m.id, error: { code: -32002, message: 'Session not found' } })
    // The old conversation is played back: the client must not take it for this turn's words.
    send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD WORDS FROM LAST TIME' } } } })
    return send({ id: m.id, result: {} })
  }
  if (m.method === 'session/prompt') {
    fs.writeFileSync('${dir}/acp-prompt.txt', m.params.prompt.map((p) => p.text).join(''))
    const sid = m.params.sessionId
    const say = (text) => send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    if (mode === 'quota') return send({ id: m.id, error: { code: -32000, message: 'Antigravity quota reached on every model: resets at 21:00' } })
    if (mode === 'dies') { say('Starting'); return process.exit(3) }
    if (mode === 'hangs') { say('Starting a long build.'); send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', usage: { inputTokens: 900, outputTokens: 60, cachedReadTokens: 7000 } } } }); return }
    say('Let me look ')
    say('at the folder.')
    send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'write notes.txt', kind: 'edit', status: 'pending' } } })
    // It asks leave to write, then writes through its client: inside the job's folder, and outside it.
    asked.set(900, (r) => {
      fs.appendFileSync('${dir}/acp-env.txt', 'permission ' + JSON.stringify(r.result) + '\\n')
      send({ id: 901, method: 'fs/write_text_file', params: { sessionId: sid, path: 'notes.txt', content: 'written by the tool\\n' } })
    })
    asked.set(901, (r) => {
      fs.appendFileSync('${dir}/acp-env.txt', 'write-inside ' + (r.error ? 'refused' : 'ok') + '\\n')
      send({ id: 902, method: 'fs/write_text_file', params: { sessionId: sid, path: '/etc/studio-test-should-never-exist', content: 'x' } })
    })
    asked.set(902, (r) => {
      fs.appendFileSync('${dir}/acp-env.txt', 'write-outside ' + (r.error ? 'refused' : 'ok') + '\\n')
      send({ id: 903, method: 'fs/read_text_file', params: { sessionId: sid, path: 'notes.txt' } })
    })
    asked.set(903, (r) => {
      fs.appendFileSync('${dir}/acp-env.txt', 'read ' + JSON.stringify(r.result) + '\\n')
      say('Wrote the notes. ')
      say('OUTCOME: PASS')
      send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 700, outputTokens: 50, cachedReadTokens: 6000, cachedWriteTokens: 30, thoughtTokens: 20 } } })
    })
    return send({ id: 900, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 't1', kind: 'edit', title: 'write notes.txt' }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } })
  }
  if (m.id !== undefined && asked.has(m.id)) { const next = asked.get(m.id); asked.delete(m.id); return next(m) }
}
`

test('a Gemini bot runs a job over the Agent Client Protocol: session, prompt through a pipe, permissions, file writes kept to the job\'s folder, tokens', async (t) => {
  const s = await studio(t)
  const agent = s.script('acp-agent.js', ACP_AGENT(s.dir))
  const bot = await s.ok('POST', `/api/companies/${s.id}/agents`, {
    name: 'Gemma', title: 'Checks', adapterType: 'gemini_local', instructions: 'You are Gemma. Check the work.\n',
    adapterConfig: { agentCommand: `${agent} acp --quiet`, model: 'gemini-3.8-flash-high', timeoutSec: 30, graceSec: 1, env: { AGY_MODELS: { type: 'plain', value: 'a,b' } } },
  })
  // A brief far larger than fits on a command line goes through the pipe whole.
  const big = 'x'.repeat(190_000)
  const job = await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'Check the notes', description: `Look at the folder. ${big}`, projectId: s.project.id, assigneeAgentId: bot.id })
  const run = await s.runOn(bot, job)
  assert.equal(run.status, 'succeeded', `${run.error} ${run.stderrExcerpt}`)
  assert.equal(run.sessionIdAfter, 'acp-7')
  assert.deepEqual([run.usageJson.inputTokens, run.usageJson.cachedInputTokens, run.usageJson.outputTokens, run.usageJson.model], [730, 6000, 70, 'gemini-test'])
  assert.equal(run.resultJson.summary, 'Wrote the notes. OUTCOME: PASS', 'its closing words are what it said after its last tool')
  const seen = s.note('acp-env.txt')
  assert.match(seen, /^GEMINI_MODEL=gemini-3\.8-flash-high$/m)
  assert.match(seen, /^AGY_MODELS=a,b$/m)
  assert.match(seen, /^args=acp --quiet$/m)
  assert.match(seen, new RegExp(`^new \\{"cwd":"${s.work}","mcpServers":\\[\\]\\}$`, 'm'))
  assert.match(seen, /^permission \{"outcome":\{"outcome":"selected","optionId":"yes"\}\}$/m)
  assert.match(seen, /^write-inside ok$/m)
  assert.match(seen, /^write-outside refused$/m)
  assert.match(seen, /^read \{"content":"written by the tool\\n"\}$/m)
  assert.match(seen, /^closed$/m, 'the tool is told the conversation is over')
  assert.equal(fs.readFileSync(path.join(s.work, 'notes.txt'), 'utf8'), 'written by the tool\n')
  const prompt = s.note('acp-prompt.txt')
  assert.match(prompt, /You are Gemma\. Check the work\./)
  assert.ok(prompt.includes(big))
  assert.deepEqual(s.engine.store.rows('SELECT provider FROM usage').map((u) => u.provider), ['google'])

  // Woken again, it carries the same session on, and the played-back history is not taken for new words.
  await s.ok('POST', `/api/issues/${job.id}/comments`, { body: 'Check once more.' })
  const second = await s.runOn(bot, job)
  assert.equal(second.status, 'succeeded', second.error || '')
  assert.equal(second.sessionIdBefore, 'acp-7')
  assert.match(s.note('acp-env.txt'), /^load acp-7$/m)
  assert.equal(second.resultJson.summary, 'Wrote the notes. OUTCOME: PASS')
  const log = fs.readFileSync(path.join(s.engine.dataDir, 'run-logs', second.logRef), 'utf8')
  assert.equal(log.includes('OLD WORDS FROM LAST TIME'), false)

  // A session the tool no longer has is not an error: a fresh one is opened in the same run.
  const kept = s.engine.store.object('SELECT raw FROM sessions WHERE agent_id = ?', bot.id)
  s.engine.store.put('sessions', { ...kept, sessionParamsJson: { ...kept.sessionParamsJson, sessionId: 'acp-lost' } }, { position: 0 })
  await s.ok('POST', `/api/issues/${job.id}/comments`, { body: 'And again.' })
  const third = await s.runOn(bot, job)
  assert.equal(third.status, 'succeeded', third.error || '')
  assert.equal(third.sessionIdAfter, 'acp-7')
})

test('a Gemini run that the tool refuses, or that dies in the middle, is a failed run with the tool\'s own reason', async (t) => {
  const s = await studio(t)
  const agent = s.script('acp-agent.js', ACP_AGENT(s.dir))
  const make = (name, mode) => s.ok('POST', `/api/companies/${s.id}/agents`, { name, adapterType: 'gemini_local', adapterConfig: { agentCommand: agent, timeoutSec: 30, graceSec: 1, env: { ACP_STANDIN: mode } } })
  const out = await make('Out Of Allowance', 'quota')
  const job = await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'Try', projectId: s.project.id, assigneeAgentId: out.id })
  const run = await s.runOn(out, job)
  assert.equal(run.status, 'failed')
  assert.match(run.error, /quota reached on every model: resets at 21:00/)

  const dies = await make('Dies Halfway', 'dies')
  const other = await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'Try too', projectId: s.project.id, assigneeAgentId: dies.id })
  const dead = await s.runOn(dies, other)
  assert.equal(dead.status, 'failed')
  assert.match(dead.error, /stopped before the turn ended/)

  const missing = await s.ok('POST', `/api/companies/${s.id}/agents`, { name: 'No Tool', adapterType: 'gemini_local', adapterConfig: { agentCommand: path.join(s.dir, 'not-installed'), timeoutSec: 30, graceSec: 1 } })
  const third = await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'Try three', projectId: s.project.id, assigneeAgentId: missing.id })
  const none = await s.runOn(missing, third)
  assert.equal(none.status, 'failed')
  assert.match(none.error, /not-installed is not installed on this computer.*Setup page/)
})

test('a bot that is kept from pushing, committing or editing is refused by a guard in front of git, whatever AI runs it', async (t) => {
  const s = await studio(t)
  const tool = s.script('tool.sh', `#!/bin/sh
cat > /dev/null
cd "${s.work}"
try() { "$@" > /dev/null 2>> "${s.dir}/guard-said.txt"; echo "$* -> $?" >> "${s.dir}/guard.txt"; }
try git init -q .
try git -C "${s.work}" -c user.name=t status
try git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m first
try git push origin main
try git -C "${s.work}" push
try gh pr create --fill
echo "may not: [$BOTYARD_MAY_NOT]" >> "${s.dir}/guard.txt"
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s-1","usage":{"input_tokens":1,"output_tokens":1}}'
`)
  const make = (name, mayNot) => s.ok('POST', `/api/companies/${s.id}/agents`, { name, adapterType: 'claude_local', adapterConfig: { command: tool, timeoutSec: 30, graceSec: 1, ...(mayNot ? { mayNot } : {}) } })
  const run = async (bot, title) => {
    for (const kept of ['guard.txt', 'guard-said.txt']) fs.rmSync(path.join(s.dir, kept), { force: true })
    fs.rmSync(path.join(s.work, '.git'), { recursive: true, force: true })
    const done = await s.runOn(bot, await s.ok('POST', `/api/companies/${s.id}/issues`, { title, projectId: s.project.id, assigneeAgentId: bot.id }))
    assert.equal(done.status, 'succeeded', done.error || '')
    return Object.fromEntries(s.note('guard.txt').trim().split('\n').map((line) => line.split(/ -> |: /)))
  }
  // A builder: commits, never pushes, never touches GitHub.
  const built = await run(await make('Builder', ['push']), 'Build')
  assert.equal(built['git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m first'], '0')
  assert.equal(built[`git -C ${s.work} -c user.name=t status`], '0', 'everything else goes to the real git')
  assert.equal(built['git push origin main'], '1')
  assert.equal(built[`git -C ${s.work} push`], '1', 'the command is found behind git\'s own options')
  assert.equal(built['gh pr create --fill'], '1')
  assert.equal(built['may not'], '[push]')
  assert.match(s.note('guard-said.txt'), /this bot may not run git push/)
  // A reviewer: no commit either.
  const reviewed = await run(await make('Reviewer', ['edit', 'push', 'nonsense']), 'Review')
  assert.equal(reviewed['git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m first'], '1')
  assert.equal(reviewed['git push origin main'], '1')
  assert.equal(reviewed['may not'], '[push,edit]', 'only the words Botyard knows, in its own order')
  // A bot with nothing set is started as before, with no guard in front of anything.
  const free = await run(await make('As Before'), 'As before')
  assert.equal(free['git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m first'], '0')
  assert.equal(free['may not'], '[]')
  assert.doesNotMatch(s.note('guard-said.txt'), /Botyard: this bot may not/, 'its push fails because there is nowhere to push, not because a guard refused it')
})

test('a Gemini bot that may not edit is refused the write it asks leave for, and the write itself', async (t) => {
  const s = await studio(t)
  const agent = s.script('acp-agent.js', ACP_AGENT(s.dir))
  const bot = await s.ok('POST', `/api/companies/${s.id}/agents`, { name: 'Reader', adapterType: 'gemini_local', adapterConfig: { agentCommand: agent, timeoutSec: 30, graceSec: 1, mayNot: ['push', 'edit'] } })
  const run = await s.runOn(bot, await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'Read only', projectId: s.project.id, assigneeAgentId: bot.id }))
  const seen = s.note('acp-env.txt')
  assert.match(seen, /^permission \{"outcome":\{"outcome":"selected","optionId":"no"\}\}$/m)
  assert.match(seen, /^write-inside refused$/m)
  assert.equal(fs.existsSync(path.join(s.work, 'notes.txt')), false)
  assert.match(run.stderrExcerpt, /Refused, because this bot may not push, edit: write notes\.txt/)
})

test('a free-model bot\'s run is handed the provider keys pasted on the setup page; other bots are not, and a bot\'s own value wins', async (t) => {
  const s = await studio(t)
  const keys = path.join(s.engine.dataDir, 'keys')
  fs.mkdirSync(keys, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(keys, 'openrouter.key'), 'or-pasted-key\n', { mode: 0o600 })
  fs.writeFileSync(path.join(keys, 'nvidia.key'), 'nv-pasted-key\n', { mode: 0o600 })
  const tool = s.script('tool.sh', `#!/bin/sh
cat > /dev/null
echo "$1 or=$OPENROUTER_API_KEY nv=$NVIDIA_API_KEY" >> "${s.dir}/keys-seen.txt"
case "$1" in
  run) echo '{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":1,"output":1}}}';;
  *) echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s-1","usage":{"input_tokens":1,"output_tokens":1}}';;
esac
`)
  const make = (name, adapterType, env) => s.ok('POST', `/api/companies/${s.id}/agents`, { name, adapterType, adapterConfig: { command: tool, timeoutSec: 30, graceSec: 1, ...(env ? { env } : {}) } })
  const go = async (bot) => { const done = await s.runOn(bot, await s.ok('POST', `/api/companies/${s.id}/issues`, { title: `For ${bot.name}`, projectId: s.project.id, assigneeAgentId: bot.id })); assert.equal(done.status, 'succeeded', done.error || '') }
  await go(await make('Free', 'opencode_local'))
  await go(await make('Free With Its Own', 'opencode_local', { OPENROUTER_API_KEY: 'or-own-key' }))
  await go(await make('Paid', 'claude_local'))
  assert.deepEqual(s.note('keys-seen.txt').trim().split('\n'), ['run or=or-pasted-key nv=nv-pasted-key', 'run or=or-own-key nv=nv-pasted-key', '--print or= nv='])
  // Nothing the API gives has a pasted key in it.
  assert.equal(JSON.stringify((await s.engine.handle({ url: `/api/companies/${s.id}/agents` })).body).includes('pasted-key'), false)
})

test('a Gemini run cut at its time limit still says what it used until then', async (t) => {
  const s = await studio(t)
  const agent = s.script('acp-agent.js', ACP_AGENT(s.dir))
  const bot = await s.ok('POST', `/api/companies/${s.id}/agents`, { name: 'Slow One', adapterType: 'gemini_local', adapterConfig: { agentCommand: agent, timeoutSec: 2, graceSec: 3, env: { ACP_STANDIN: 'hangs' } } })
  const run = await s.runOn(bot, await s.ok('POST', `/api/companies/${s.id}/issues`, { title: 'A long build', projectId: s.project.id, assigneeAgentId: bot.id }))
  assert.equal(run.status, 'timed_out')
  assert.deepEqual([run.usageJson.inputTokens, run.usageJson.cachedInputTokens, run.usageJson.outputTokens], [900, 7000, 60])
  assert.equal(run.sessionIdAfter, 'acp-7')
})
