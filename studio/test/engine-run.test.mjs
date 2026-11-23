/**
 * The engine's run side, end to end with a stand-in for the bot's tool: a job given to a bot is
 * started in its own worktree by a keeper that outlives the engine, the tool is handed the same
 * names the crew's scripts use, and when it ends the run is booked with its session and tokens.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { readOutput } from '../server/engine/adapters.mjs'
import { wakePrompt } from '../server/engine/prompt.mjs'
import { botEnv, cancelRun, tick, whoHolds } from '../server/engine/runner.mjs'
import { Refused, addComment, createCard, createJob, patchJob, putDocument, setPaused, settleCard, wake, openChat } from '../server/engine/write.mjs'

const COMPANY = 'co-1'
const NOW = Date.parse('2026-11-12T12:00:00Z')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A studio with one project (a real git repository) and two bots whose "tool" is a shell script. */
function studio({ script, timeoutSec = 30, limit = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-run-'))
  const repo = path.join(dir, 'game')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'a game\n')
  git('add', '.')
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'first')
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(tool, `#!/bin/sh\n${script || DONE}\n`)
  fs.chmodSync(tool, 0o755)
  const rules = path.join(dir, 'builder.md')
  fs.writeFileSync(rules, 'You are a builder. FINISH with a report.\n')
  const store = openStore(':memory:')
  store.put('company', { id: COMPANY, name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 700 })
  store.put('projects', { id: 'p-game', companyId: COMPANY, name: 'Game', primaryWorkspace: { cwd: repo } }, { position: 0 })
  const bot = (id, name, adapterType = 'claude_local') => store.put('agents', {
    id, companyId: COMPANY, name, title: 'Builds', status: 'idle', adapterType,
    adapterConfig: { command: tool, model: 'test-model', timeoutSec, graceSec: 1, instructionsFilePath: rules, env: { CREW_VAR: 'yes' }, extraArgs: ['--disallowedTools', 'Bash(git push:*)'] },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: limit } },
  })
  bot('bot-builder', 'Builder')
  bot('bot-free', 'Freelancer', 'opencode_local')
  return { dir, repo, store, dataDir: path.join(dir, 'data'), rules, opts: (now = Date.now()) => ({ dataDir: path.join(dir, 'data'), apiUrl: 'http://127.0.0.1:3210', now }) }
}

/** A tool that says what Claude Code says at the end of a good run, and notes what it was started with. */
const DONE = `cat > "$BOTYARD_SCRATCH_DIR/../prompt-$BOTYARD_RUN_ID.txt"
printf '%s\\n' "$@" > "$BOTYARD_SCRATCH_DIR/../args-$BOTYARD_RUN_ID.txt"
env | grep -E '^(BOTYARD_|CREW_VAR)' > "$BOTYARD_SCRATCH_DIR/../env-$BOTYARD_RUN_ID.txt"
pwd > "$BOTYARD_SCRATCH_DIR/../cwd-$BOTYARD_RUN_ID.txt"
echo '{"type":"system","subtype":"init","session_id":"0b0e7c7e-1111-4222-8333-444455556666","model":"test-model"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Built it. COMMIT abc123","session_id":"0b0e7c7e-1111-4222-8333-444455556666","usage":{"input_tokens":120,"cache_read_input_tokens":9000,"cache_creation_input_tokens":30,"output_tokens":45},"total_cost_usd":0.01}'`

async function until(s, check, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const report = await tick(s.store, s.opts())
    const found = check(report)
    if (found) return found
    if (Date.now() > end) throw new Error('the run did not end in time')
    await sleep(80)
  }
}

test('a job given to a bot runs in its own worktree, with the names the crew uses, and is booked when it ends', async () => {
  const s = studio()
  const job = createJob(s.store, COMPANY, { title: 'Fix the map crash', description: 'OUTCOME: the map loads.', projectId: 'p-game', assigneeAgentId: 'bot-builder' }, { now: NOW })
  assert.equal(job.identifier, 'LH-701', 'numbered on from the studio\'s last job')
  const started = (await tick(s.store, s.opts())).started
  assert.equal(started.length, 1)
  const run = started[0]
  assert.equal(s.store.object('SELECT raw FROM jobs WHERE id = ?', job.id).status, 'in_progress')
  const done = await until(s, (r) => r.finished.find((f) => f.id === run.id))
  assert.equal(done.status, 'succeeded')
  assert.equal(done.sessionIdAfter, '0b0e7c7e-1111-4222-8333-444455556666')
  assert.deepEqual([done.usageJson.inputTokens, done.usageJson.cachedInputTokens, done.usageJson.outputTokens], [150, 9000, 45])
  assert.match(done.resultJson.summary, /Built it/)
  assert.equal(s.store.row('SELECT status FROM wakes WHERE run_id = ?', run.id).status, 'completed')
  assert.equal(s.store.count('usage'), 1)

  const scratchUp = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`cwd-${run.id}`) || f === `cwd-${run.id}.txt`)
  const read = (kind) => fs.readFileSync(path.join(os.tmpdir(), `${kind}-${run.id}.txt`), 'utf8')
  void scratchUp
  // Its own worktree on its own branch, cut from the project.
  const cwd = read('cwd').trim()
  assert.equal(cwd, path.join(s.repo, '.botyard', 'worktrees', 'LH-701-fix-the-map-crash'))
  assert.equal(execFileSync('git', ['-C', cwd, 'branch', '--show-current']).toString().trim(), 'LH-701-fix-the-map-crash')
  // The command line Claude Code expects: the rules as a file, only the engine's own connectors, the crew's refusals.
  const args = read('args').split('\n')
  assert.deepEqual(args.slice(0, 4), ['--print', '--output-format', 'stream-json', '--verbose'])
  assert.equal(args[args.indexOf('--append-system-prompt-file') + 1], s.rules)
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(args.includes('Bash(git push:*)'))
  assert.ok(!args.includes('--resume'))
  // The names the crew's rules and scripts use.
  const env = Object.fromEntries(read('env').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  assert.equal(env.BOTYARD_API_URL, 'http://127.0.0.1:3210')
  assert.equal(env.BOTYARD_JOB_ID, job.id)
  assert.equal(env.BOTYARD_RUN_ID, run.id)
  assert.equal(env.BOTYARD_BOT_ID, 'bot-builder')
  assert.equal(env.CREW_VAR, 'yes')
  assert.match(env.BOTYARD_API_KEY, /^stu_/)
  assert.equal(whoHolds(s.store, env.BOTYARD_API_KEY), null, 'a finished run\'s pass no longer opens anything')
  const prompt = read('prompt')
  assert.match(prompt, /this job was given to you/)
  assert.match(prompt, /LH-701 Fix the map crash/)
  assert.match(prompt, /OUTCOME: the map loads\./)
  assert.match(prompt, /branch `LH-701-fix-the-map-crash`/)
  // The log is in the shape the crew's scripts already read.
  const first = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'run-logs', done.logRef), 'utf8').split('\n')[0])
  assert.deepEqual(Object.keys(first).sort(), ['chunk', 'seq', 'stream', 'ts'])
})

test('a comment wakes the bot once, in the same session, and it is told what was said', async () => {
  const s = studio()
  const job = createJob(s.store, COMPANY, { title: 'Tune the score', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  const first = (await tick(s.store, s.opts())).started[0]
  await until(s, (r) => r.finished.find((f) => f.id === first.id))
  addComment(s.store, job.id, { body: 'Also cap it at 100.' }, { actor: { user: 'local-board' } })
  addComment(s.store, job.id, { body: 'And show it in gold.' }, { actor: { user: 'local-board' } })
  assert.equal(s.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 1, 'two comments, one wake')
  // The bot's own words wake nobody.
  addComment(s.store, job.id, { body: 'Noted.' }, { actor: { agent: 'bot-builder', run: first.id } })
  assert.equal(s.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 1)
  const second = (await tick(s.store, s.opts())).started[0]
  await until(s, (r) => r.finished.find((f) => f.id === second.id))
  const args = fs.readFileSync(path.join(os.tmpdir(), `args-${second.id}.txt`), 'utf8').split('\n')
  assert.equal(args[args.indexOf('--resume') + 1], '0b0e7c7e-1111-4222-8333-444455556666')
  assert.ok(!args.includes('--append-system-prompt-file'), 'a resumed session already has its rules')
  const prompt = fs.readFileSync(path.join(os.tmpdir(), `prompt-${second.id}.txt`), 'utf8')
  assert.match(prompt, /someone wrote on this job/)
  assert.match(prompt, /Also cap it at 100\./)
  assert.match(prompt, /And show it in gold\./)
  assert.doesNotMatch(prompt, /Noted\./)
})

test('a run past its time limit is stopped and said to have timed out; a cancelled one is cancelled', async () => {
  const s = studio({ script: 'sleep 30', timeoutSec: 1 })
  createJob(s.store, COMPANY, { title: 'Slow one', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  const run = (await tick(s.store, s.opts())).started[0]
  const done = await until(s, (r) => r.finished.find((f) => f.id === run.id), 12000)
  assert.equal(done.status, 'timed_out')
  assert.match(done.error, /time limit/)

  const c = studio({ script: 'sleep 30' })
  createJob(c.store, COMPANY, { title: 'Called off', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  const going = (await tick(c.store, c.opts())).started[0]
  await sleep(600)
  assert.equal(cancelRun(c.store, going.id, { dataDir: c.dataDir }), true)
  assert.equal((await until(c, (r) => r.finished.find((f) => f.id === going.id), 12000)).status, 'cancelled')
})

test('a bot runs one job at a time unless it has room, and a paused bot waits', async () => {
  const s = studio({ script: 'sleep 2; echo \'{"type":"result","subtype":"success","usage":{}}\'' })
  createJob(s.store, COMPANY, { title: 'One', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  createJob(s.store, COMPANY, { title: 'Two', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  assert.equal((await tick(s.store, s.opts())).started.length, 1, 'room for one')
  assert.equal((await tick(s.store, s.opts())).started.length, 0)
  setPaused(s.store, 'bot-free', true)
  createJob(s.store, COMPANY, { title: 'For the freelancer', projectId: 'p-game', assigneeAgentId: 'bot-free' })
  assert.equal((await tick(s.store, s.opts())).started.length, 0, 'paused: the wake waits')
  assert.equal(s.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 2)
  setPaused(s.store, 'bot-free', false)
  assert.equal((await tick(s.store, s.opts())).started.length, 1, 'resumed: its wake starts')
  await until(s, () => !s.store.rows("SELECT id FROM runs WHERE status = 'running'").length, 15000)
})

test('a free-model bot is started the way OpenCode wants, its rules inside the prompt, and its tokens are summed', () => {
  const s = studio()
  const agent = s.store.object("SELECT raw FROM agents WHERE id = 'bot-free'")
  const prompt = wakePrompt({ agent, company: { name: 'Lighthouse Works' }, job: { identifier: 'TRY-9', title: 'Check the story', status: 'in_progress', description: 'It must pass.' }, wake: { reason: 'issue_assigned' }, inline: true })
  assert.match(prompt, /^You are Freelancer, Builds at Lighthouse Works\./)
  assert.match(prompt, /You are a builder\. FINISH with a report\./)
  const read = readOutput('opencode_local', [
    '{"type":"step_start","sessionID":"ses_abc"}',
    '{"type":"step_finish","sessionID":"ses_abc","part":{"tokens":{"input":41472,"output":41,"reasoning":136,"cache":{"read":0,"write":0}}}}',
    '{"type":"step_finish","sessionID":"ses_abc","part":{"tokens":{"input":2230,"output":38,"reasoning":12,"cache":{"read":39456,"write":0}}}}',
    'not json at all',
  ])
  assert.equal(read.session, 'ses_abc')
  assert.deepEqual([read.inputTokens, read.cachedInputTokens, read.outputTokens], [43702, 39456, 227])
})

test('a free-model run that got past an error and ended its turn is not failed; one that ended on the error is', () => {
  const overflow = '{"type":"error","sessionID":"s","error":{"name":"ContextOverflowError","data":{"message":"Requested token count exceeds the model\'s maximum context length"}}}'
  const past = readOutput('opencode_local', ['{"type":"step_finish","sessionID":"s","part":{"reason":"tool-calls","tokens":{}}}', overflow, '{"type":"text","sessionID":"s","part":{"text":"Done."}}', '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{}}}'])
  assert.deepEqual([past.failed, past.why, past.said], [false, '', 'Done.'])
  const ended = readOutput('opencode_local', ['{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{}}}', overflow])
  assert.equal(ended.failed, true)
  assert.match(ended.why, /maximum context length/)
})

test('a free-model run is booked on the model the runner says it ran on, every one after a switch', () => {
  const step = '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{}}}'
  const one = readOutput('opencode_local', ['{"type":"model","model":"or/flint:free","sessionID":""}', step])
  assert.deepEqual([one.model, one.models, one.session], ['or/flint:free', ['or/flint:free'], 's'])
  const two = readOutput('opencode_local', ['{"type":"model","model":"nv/step-5","sessionID":""}', step, '{"type":"model","model":"kilo/nemotron:free","sessionID":""}', step])
  assert.deepEqual([two.model, two.models], ['kilo/nemotron:free', ['nv/step-5', 'kilo/nemotron:free']])
  assert.equal(readOutput('opencode_local', [step]).model, '', 'no line: the engine falls back to the set model')
})

test('a card is asked by a bot and answered by the owner, which wakes the bot; a document keeps its versions; a done job frees the one waiting on it', () => {
  const s = studio()
  const job = createJob(s.store, COMPANY, { title: 'Pick a map size', projectId: 'p-game', assigneeAgentId: 'bot-builder' }, { now: NOW })
  s.store.db.exec("UPDATE wakes SET status = 'completed'")
  const card = createCard(s.store, job.id, { kind: 'ask_user_questions', title: 'Which size ships?', payload: { questions: [{ id: 'size', prompt: 'Which size ships?', options: [{ id: 's', label: 'Small' }, { id: 'l', label: 'Large' }] }] } }, { now: NOW, actor: { agent: 'bot-builder', run: 'r1' } })
  assert.throws(() => settleCard(s.store, job.id, card.id, 'respond', { answers: [{ questionId: 'q', optionIds: ['a'] }] }, { actor: { agent: 'bot-builder' } }), /Only the owner/)
  const answered = settleCard(s.store, job.id, card.id, 'respond', { answers: [{ questionId: 'q', optionIds: ['a'] }] }, { now: NOW + 1000, actor: { user: 'local-board' } })
  assert.equal(answered.status, 'answered')
  assert.equal(s.store.object("SELECT raw FROM wakes WHERE status = 'queued'").reason, 'card_answered')
  assert.throws(() => settleCard(s.store, job.id, card.id, 'reject', {}, { actor: { user: 'local-board' } }), /already settled/)

  putDocument(s.store, job.id, 'plan', { title: 'Plan', body: 'v1' }, { now: NOW })
  const doc = putDocument(s.store, job.id, 'plan', { body: 'v2' }, { now: NOW + 5 })
  assert.equal(doc.latestRevisionNumber, 2)
  assert.equal(s.store.rows('SELECT id FROM document_versions WHERE document_id = ?', doc.id).length, 2)

  const later = createJob(s.store, COMPANY, { title: 'Ship the map', projectId: 'p-game', assigneeAgentId: 'bot-free', status: 'blocked' }, { now: NOW })
  patchJob(s.store, later.id, { blockedByIssueIds: [job.id] }, { now: NOW })
  assert.throws(() => patchJob(s.store, later.id, { blockedByIssueIds: [later.id] }), /wait on itself/)
  patchJob(s.store, job.id, { status: 'done', comment: 'Done: small map.' }, { now: NOW + 9000, actor: { agent: 'bot-builder', run: 'r1' } })
  const freed = s.store.object('SELECT raw FROM jobs WHERE id = ?', later.id)
  assert.equal(freed.status, 'todo')
  assert.deepEqual(freed.blockedBy, [])
  assert.ok(s.store.objects("SELECT raw FROM wakes WHERE status = 'queued'").some((w) => w.agentId === 'bot-free' && w.payload.issueId === later.id))
})

test('a bot finishes its own job through the engine with its run\'s pass, and the pass dies with the run', async () => {
  const http = await import('node:http')
  const { answer } = await import('../server/engine/api.mjs')
  // The tool does what the crew's FINISH script does: PATCH its job done with a comment, then ask who it is.
  const script = `cat > /dev/null
code=$(curl -s -o "$BOTYARD_SCRATCH_DIR/patch.json" -w '%{http_code}' -X PATCH "$BOTYARD_API_URL/api/issues/$BOTYARD_JOB_ID" -H "Authorization: Bearer $BOTYARD_API_KEY" -H 'Content-Type: application/json' -d '{"status":"done","comment":"OUTCOME: PASS. COMMIT abc123"}')
me=$(curl -s "$BOTYARD_API_URL/api/agents/me" -H "Authorization: Bearer $BOTYARD_API_KEY")
echo "$BOTYARD_API_KEY" > "$BOTYARD_SCRATCH_DIR/../pass-$BOTYARD_RUN_ID.txt"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"patched $code\\",\\"usage\\":{}}"`
  const s = studio({ script })
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const out = answer(s.store, { method: req.method, url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} }, { dataDir: s.dataDir })
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${server.address().port}`
  const ask = (method, url, body, pass) => fetch(apiUrl + url, { method, headers: { 'Content-Type': 'application/json', ...(pass ? { Authorization: `Bearer ${pass}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }))
  try {
    // The owner's side, with no pass: make the job through the same path the crew's scripts use.
    const made = await ask('POST', `/api/companies/${COMPANY}/issues`, { title: 'Finish through the door', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
    assert.equal(made.status, 201)
    const opts = () => ({ dataDir: s.dataDir, apiUrl })
    const run = (await tick(s.store, opts())).started[0]
    let done
    for (let i = 0; i < 100 && !done; i++) { done = (await tick(s.store, opts())).finished.find((f) => f.id === run.id); if (!done) await sleep(80) }
    assert.equal(done.status, 'succeeded')
    assert.match(done.resultJson.summary, /patched 200/)
    const job = (await ask('GET', `/api/issues/${made.body.id}`)).body
    assert.equal(job.status, 'done')
    const said = (await ask('GET', `/api/issues/${made.body.id}/comments`)).body
    assert.equal(said.at(-1).body, 'OUTCOME: PASS. COMMIT abc123')
    assert.equal(said.at(-1).authorAgentId, 'bot-builder')
    // Its own words did not wake it again.
    assert.equal(s.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 0)
    const pass = fs.readFileSync(path.join(os.tmpdir(), `pass-${run.id}.txt`), 'utf8').trim()
    assert.equal((await ask('PATCH', `/api/issues/${made.body.id}`, { status: 'todo' }, pass)).status, 401, 'the run is over: its pass opens nothing')
    assert.equal((await ask('GET', '/api/agents/me', null, 'stu_made_up')).status, 401)
    // The run's log is read through the door too.
    const log = await ask('GET', `/api/heartbeat-runs/${run.id}/log?offset=0&limitBytes=4096`)
    assert.match(log.body.content, /patched 200/)
    // Its end, as the file stands: what the map reads of a run still going, whose length is not booked yet.
    const end = await ask('GET', `/api/heartbeat-runs/${run.id}/log?tail=64`)
    assert.ok(end.body.content.length <= 64 && end.body.content.length > 0)
    assert.equal(end.body.offset + Buffer.byteLength(end.body.content), end.body.size)
    assert.equal((await ask('POST', `/api/heartbeat-runs/${run.id}/cancel`)).status, 409)
    assert.equal((await ask('DELETE', `/api/issues/${made.body.id}`)).status, 404)
  } finally {
    server.close()
  }
})

test('a bot\'s own variables are passed on, a hidden value is left out, and its PATH goes in front of the computer\'s', () => {
  const out = botEnv({ PATH: { type: 'plain', value: '/crew/bin:/usr/bin' }, BOTYARD_GIT_ALLOW: 'commit', GH_CONFIG_DIR: { type: 'plain', value: '***REDACTED***' } }, { PATH: '/usr/local/bin:/usr/bin:/bin' })
  assert.deepEqual(out, { PATH: '/crew/bin:/usr/bin:/usr/local/bin:/bin', BOTYARD_GIT_ALLOW: 'commit' })
})

test('a bot is written the way setup-bots.py writes it and its old settings are kept; a conversation is made once and a message in it wakes the bot', async () => {
  const { answer } = await import('../server/engine/api.mjs')
  const s = studio()
  const ask = (method, url, body) => answer(s.store, { method, url, body }, { dataDir: s.dataDir, now: NOW })
  const made = ask('POST', `/api/companies/${COMPANY}/agents`, { name: 'Reviewer', role: 'qa', title: 'Reviews', adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5', env: { A: '1' } }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, reportsTo: 'bot-builder' })
  assert.equal(made.status, 201)
  assert.equal(ask('POST', `/api/companies/${COMPANY}/agents`, { name: 'Reviewer' }).status, 409)
  const changed = ask('PATCH', `/api/agents/${made.body.id}`, { adapterConfig: { model: 'claude-fable-5-2' }, replaceAdapterConfig: true })
  assert.deepEqual(changed.body.adapterConfig, { model: 'claude-fable-5-2' }, 'replaced whole, as asked')
  assert.equal(changed.body.title, 'Reviews', 'what was not sent stays')
  const kept = s.store.objects('SELECT raw FROM agent_revisions WHERE agent_id = ?', made.body.id)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].beforeConfig.adapterConfig.model, 'claude-opus-5-5')

  const chat = ask('POST', `/api/companies/${COMPANY}/chats/bot-builder`, {})
  assert.equal(chat.body.conversationAgentId, 'bot-builder')
  assert.equal(ask('POST', `/api/companies/${COMPANY}/chats/bot-builder`, {}).body.id, chat.body.id, 'the same conversation the second time')
  assert.equal(ask('POST', `/api/issues/${chat.body.id}/comments`, { body: 'Status?', clientRequestId: 'r1' }).status, 201)
  assert.equal(ask('POST', `/api/issues/${chat.body.id}/comments`, { body: 'Status?', clientRequestId: 'r1' }).body.body, 'Status?')
  assert.equal(s.store.rows('SELECT id FROM comments WHERE job_id = ?', chat.body.id).length, 1, 'a message sent twice is kept once')
  const queued = s.store.objects("SELECT raw FROM wakes WHERE status = 'queued'")
  assert.equal(queued.length, 1)
  assert.equal(queued[0].reason, 'issue_commented')
})

test('a job from before this engine is changed like any other, and new jobs are numbered on from the last, stepping over a code already taken', () => {
  const s = studio()
  s.store.put('jobs', { id: 'old-job', companyId: COMPANY, identifier: 'LH-650', title: 'From before', status: 'todo', assigneeAgentId: 'bot-free' })
  s.store.put('jobs', { id: 'taken', companyId: COMPANY, identifier: 'LH-701', title: 'Numbered apart once', status: 'done' })
  assert.equal(patchJob(s.store, 'old-job', { priority: 'high' }).priority, 'high')
  assert.equal(createJob(s.store, COMPANY, { title: 'The next one' }).identifier, 'LH-702')
})

test('a file is attached to a job from an upload form, kept under the engine\'s own folder, and given back as it was', async () => {
  const { answer } = await import('../server/engine/api.mjs')
  const s = studio()
  const job = createJob(s.store, COMPANY, { title: 'With proof', projectId: 'p-game' })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 0x0d, 0x0a, 255])
  const form = Buffer.concat([Buffer.from('--XYZ\r\nContent-Disposition: form-data; name="file"; filename="shot one.png"\r\nContent-Type: image/png\r\n\r\n'), png, Buffer.from('\r\n--XYZ--\r\n')])
  const up = answer(s.store, { method: 'POST', url: `/api/companies/${COMPANY}/issues/${job.id}/attachments`, headers: { 'content-type': 'multipart/form-data; boundary=XYZ' }, raw: form }, { dataDir: s.dataDir })
  assert.equal(up.status, 201)
  assert.equal(up.body.originalFilename, 'shot one.png')
  assert.equal(up.body.contentType, 'image/png')
  assert.equal(up.body.byteSize, png.length)
  const listed = answer(s.store, { url: `/api/issues/${job.id}/attachments` }, { dataDir: s.dataDir }).body
  assert.equal(listed[0].id, up.body.id)
  const got = answer(s.store, { url: up.body.contentPath }, { dataDir: s.dataDir })
  assert.deepEqual(fs.readFileSync(got.file.path), png, 'byte for byte')
  assert.ok(got.file.path.startsWith(path.join(s.dataDir, 'files')))
  assert.equal(answer(s.store, { method: 'POST', url: `/api/companies/${COMPANY}/issues/${job.id}/attachments`, headers: { 'content-type': 'multipart/form-data; boundary=XYZ' }, raw: Buffer.from('--XYZ--\r\n') }, { dataDir: s.dataDir }).status, 400)
})

test('a run cut at its time limit is booked with the tokens its messages reported, marked as not the tool\'s own sum', async () => {
  // Claude Code says its tokens message by message and adds them up only in its closing line, which a cut run never prints.
  const said = [
    '{"type":"system","subtype":"init","session_id":"0b0e7c7e-1111-4222-8333-444455556666","model":"test-model"}',
    '{"type":"assistant","message":{"id":"msg_1","model":"test-model","content":[{"type":"text","text":"Looking."}],"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":5000,"output_tokens":3}}}',
    // The same message again as its next part: counted once, with its larger count.
    '{"type":"assistant","message":{"id":"msg_1","model":"test-model","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":5000,"output_tokens":40}}}',
    '{"type":"assistant","message":{"id":"msg_2","model":"test-model","content":[{"type":"text","text":"Waiting for the build."}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":5200,"output_tokens":12}}}',
  ]
  const s = studio({ script: `cat > /dev/null\n${said.map((line) => `echo '${line}'`).join('\n')}\nsleep 30`, timeoutSec: 1 })
  const job = createJob(s.store, COMPANY, { title: 'A long one', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  await tick(s.store, s.opts())
  const run = await until(s, () => s.store.objects('SELECT raw FROM runs WHERE job_id = ?', job.id).find((r) => r.status !== 'running'), 15000)
  assert.equal(run.status, 'timed_out')
  assert.deepEqual([run.usageJson.inputTokens, run.usageJson.cachedInputTokens, run.usageJson.outputTokens, run.usageJson.partial], [130, 10200, 52, true])
  assert.equal(run.usageJson.model, 'test-model')
  assert.equal(run.sessionIdAfter, '0b0e7c7e-1111-4222-8333-444455556666', 'so the next run carries the same session on')
  assert.deepEqual(s.store.rows('SELECT input_tokens, cached_input_tokens, output_tokens FROM usage WHERE run_id = ?', run.id).map((u) => [u.input_tokens, u.cached_input_tokens, u.output_tokens]), [[130, 10200, 52]], 'and it shows in what the studio spent')
  // A run that did close is booked from the tool's own sum, as before, and is not marked.
  const whole = readOutput('claude_local', [...said, '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"s","usage":{"input_tokens":7,"cache_read_input_tokens":8,"cache_creation_input_tokens":1,"output_tokens":9}}'])
  assert.deepEqual([whole.inputTokens, whole.cachedInputTokens, whole.outputTokens, whole.partial], [8, 8, 9, undefined])
})

test('a job told a commit to start from has its branch cut there, not from the main line; a commit the repository lacks is said to the bot', async () => {
  const s = studio()
  const git = (...args) => execFileSync('git', ['-C', s.repo, ...args], { stdio: 'pipe' }).toString().trim()
  // The build's own commit, on a branch of its own; the main line has moved on since.
  git('checkout', '-q', '-b', 'LH-650-the-build')
  fs.writeFileSync(path.join(s.repo, 'built.txt'), 'the build\n')
  git('add', '.')
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'the build')
  const built = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  fs.writeFileSync(path.join(s.repo, 'later.txt'), 'main moved on\n')
  git('add', '.')
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'later on main')

  // As the pipeline sends a fix round, and as a brief may name it plainly.
  const fix = createJob(s.store, COMPANY, { title: 'Fix 1 of the build', projectId: 'p-game', assigneeAgentId: 'bot-builder', executionWorkspaceSettings: { mode: 'isolated_workspace', workspaceStrategy: { type: 'git_worktree', baseRef: built } } })
  assert.equal(fix.startFrom, built)
  await tick(s.store, s.opts())
  const run = await until(s, () => s.store.objects('SELECT raw FROM runs WHERE job_id = ?', fix.id).find((r) => r.status !== 'running'))
  const cwd = run.contextSnapshot.cwd
  const promptOf = (made) => fs.readFileSync(path.join(s.dataDir, 'runs', made.id, 'prompt.txt'), 'utf8')
  assert.equal(execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD']).toString().trim(), built, 'the fix goes on from the build\'s commit')
  assert.ok(fs.existsSync(path.join(cwd, 'built.txt')))
  assert.equal(fs.existsSync(path.join(cwd, 'later.txt')), false, 'not from the main line')
  const prompt = promptOf(run)
  assert.match(prompt, new RegExp(`branch was cut from ${built}`))
  assert.equal(s.store.object('SELECT raw FROM workspaces WHERE job_id = ?', fix.id).baseRef, built.slice(0, 7))

  // By a branch's name, in the plain field.
  const next = createJob(s.store, COMPANY, { title: 'Go on from the branch', projectId: 'p-game', assigneeAgentId: 'bot-free', baseRef: 'LH-650-the-build' })
  await tick(s.store, s.opts())
  const second = await until(s, () => s.store.objects('SELECT raw FROM runs WHERE job_id = ?', next.id).find((r) => r.status !== 'running'))
  assert.equal(execFileSync('git', ['-C', second.contextSnapshot.cwd, 'rev-parse', 'HEAD']).toString().trim(), built)

  // A commit this repository does not have: the run still starts, from the main line, and the bot is told so.
  const lost = createJob(s.store, COMPANY, { title: 'From a commit that is not here', projectId: 'p-game', assigneeAgentId: 'bot-builder', baseRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
  await until(s, () => !s.store.rows("SELECT id FROM runs WHERE status = 'running'").length)
  await tick(s.store, s.opts())
  const third = await until(s, () => s.store.objects('SELECT raw FROM runs WHERE job_id = ?', lost.id).find((r) => r.status !== 'running'))
  assert.equal(execFileSync('git', ['-C', third.contextSnapshot.cwd, 'rev-parse', 'HEAD']).toString().trim(), git('rev-parse', 'main'))
  assert.match(promptOf(third), /start from deadbeef[0-9a-f]+, but this repository has no such commit/)
  // A job with nothing said starts from the main line as always; and a name git would read as an option is refused.
  assert.equal(createJob(s.store, COMPANY, { title: 'Plain' }).startFrom, null)
  assert.throws(() => createJob(s.store, COMPANY, { title: 'Bad', baseRef: '--upload-pack=x' }), (err) => err instanceof Refused && err.status === 400)
})

test('in a chat, what the bot says at the end of its run is posted as its answer, once, and not where it already wrote', async () => {
  const { answer } = await import('../server/engine/api.mjs')
  const s = studio()
  const ask = (method, url, body) => answer(s.store, { method, url, body }, { dataDir: s.dataDir, now: NOW })
  const chat = ask('POST', `/api/companies/${COMPANY}/chats/bot-builder`, {}).body
  ask('POST', `/api/issues/${chat.id}/comments`, { body: 'Status?' })
  await until(s, (r) => r.finished?.length)
  const said = s.store.objects('SELECT raw FROM comments WHERE job_id = ? ORDER BY position', chat.id)
  assert.equal(said.length, 2, 'the question and its answer')
  assert.equal(said[1].authorAgentId, 'bot-builder')
  assert.equal(said[1].body, 'Built it. COMMIT abc123', 'the run\'s last words, as the tool gave them')
  assert.equal(s.store.objects("SELECT raw FROM wakes WHERE status = 'queued'").length, 0, 'its own answer does not wake it again')

  // A job that is not a chat gets no such message: there the bot reports in its own words.
  const job = createJob(s.store, COMPANY, { title: 'Fix the map crash', projectId: 'p-game', assigneeAgentId: 'bot-builder' }, { now: NOW })
  await until(s, (r) => r.finished?.length)
  assert.equal(s.store.rows('SELECT id FROM comments WHERE job_id = ?', job.id).length, 0)
})

test('a chat is never closed: a bot closing it leaves it open, and a closed one is opened by the next word', () => {
  const s = studio()
  const chat = openChat(s.store, COMPANY, 'bot-builder')
  // The bot ends its run by closing its job, as it does with any job.
  assert.equal(patchJob(s.store, chat.id, { status: 'done' }, { actor: { agent: 'bot-builder', run: 'r1' } }).status, 'in_progress')
  // A chat closed before this rule is opened again by the owner's next message, which wakes the bot.
  s.store.put('jobs', { ...s.store.object('SELECT raw FROM jobs WHERE id = ?', chat.id), status: 'done', completedAt: new Date(NOW).toISOString() })
  s.store.remove('wakes', 'agent_id', 'bot-builder')
  addComment(s.store, chat.id, { body: 'Are you there?' }, { actor: { user: 'local-board' } })
  assert.equal(s.store.object('SELECT raw FROM jobs WHERE id = ?', chat.id).status, 'in_progress')
  assert.equal(s.store.rows("SELECT id FROM wakes WHERE status = 'queued' AND agent_id = 'bot-builder'").length, 1)
  // An ordinary closed job still wakes nobody.
  const job = createJob(s.store, COMPANY, { title: 'Old work', status: 'done', assigneeAgentId: 'bot-builder' })
  s.store.remove('wakes', 'agent_id', 'bot-builder')
  addComment(s.store, job.id, { body: 'Thanks.' }, { actor: { user: 'local-board' } })
  assert.equal(s.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 0)
})

test('a picture sent with a chat message reaches the bot: tied to the message, copied into its run, named in its prompt, readable by Claude', async () => {
  const { attach } = await import('../server/engine/files.mjs')
  const s = studio()
  const chat = openChat(s.store, COMPANY, 'bot-builder')
  s.store.remove('wakes', 'agent_id', 'bot-builder')
  const bytes = Buffer.from('\x89PNG\r\n\x1a\nnot really a picture')
  const file = attach(s.store, COMPANY, chat.id, { name: 'map crash.png', type: 'image/png', bytes }, { actor: { user: 'local-board' }, dataDir: s.dataDir })
  const said = addComment(s.store, chat.id, { body: 'What do you see here?', attachmentIds: [file.id] }, { actor: { user: 'local-board' } })
  assert.equal(s.store.object('SELECT raw FROM attachments WHERE id = ?', file.id).issueCommentId, said.id)
  assert.equal(s.store.row('SELECT comment_id FROM attachments WHERE id = ?', file.id).comment_id, said.id)

  const run = (await tick(s.store, s.opts())).started[0]
  await until(s, (r) => r.finished.find((f) => f.id === run.id))
  const read = (kind) => fs.readFileSync(path.join(os.tmpdir(), `${kind}-${run.id}.txt`), 'utf8')
  const prompt = read('prompt')
  const place = /picture attached: (\S+) \(image\/png, sent as "map crash.png"\)/.exec(prompt)?.[1]
  assert.ok(place, prompt)
  assert.ok(prompt.indexOf('What do you see here?') < prompt.indexOf(place), 'shown under the words it came with')
  assert.match(prompt, /Open each file above with your file-reading tool/)
  assert.deepEqual(fs.readFileSync(place), bytes, 'the run has its own copy of the bytes')
  const args = read('args').split('\n')
  assert.equal(args[args.lastIndexOf('--add-dir') + 1], path.dirname(place), 'Claude may read the folder the picture is in')

  // The next run is not shown the same picture again.
  addComment(s.store, chat.id, { body: 'Thanks.' }, { actor: { user: 'local-board' } })
  const next = (await tick(s.store, s.opts())).started[0]
  await until(s, (r) => r.finished.find((f) => f.id === next.id))
  const later = fs.readFileSync(path.join(os.tmpdir(), `prompt-${next.id}.txt`), 'utf8')
  assert.doesNotMatch(later, /picture attached/)
  assert.ok(!fs.readFileSync(path.join(os.tmpdir(), `args-${next.id}.txt`), 'utf8').split('\n').some((a, i, all) => a === '--add-dir' && all[i + 1].endsWith('/files')))
})

test('a picture alone is a message; a message cannot take a file of another job, one already sent, or too many', async () => {
  const { attach } = await import('../server/engine/files.mjs')
  const s = studio()
  const chat = openChat(s.store, COMPANY, 'bot-builder')
  const job = createJob(s.store, COMPANY, { title: 'Other work', assigneeAgentId: 'bot-builder' })
  const put = (on) => attach(s.store, COMPANY, on, { name: 'shot.png', type: 'image/png', bytes: Buffer.from('png') }, { dataDir: s.dataDir })
  const owner = { actor: { user: 'local-board' } }
  const alone = addComment(s.store, chat.id, { body: '', attachmentIds: [put(chat.id).id] }, owner)
  assert.equal(alone.body, '')
  assert.throws(() => addComment(s.store, chat.id, { body: '' }, owner), (e) => e instanceof Refused && e.status === 400)
  assert.throws(() => addComment(s.store, chat.id, { body: 'Look', attachmentIds: [put(job.id).id] }, owner), (e) => e instanceof Refused && e.status === 400)
  const sent = s.store.objects('SELECT raw FROM attachments WHERE job_id = ?', chat.id)[0]
  assert.throws(() => addComment(s.store, chat.id, { body: 'Again', attachmentIds: [sent.id] }, owner), (e) => e instanceof Refused && e.status === 409)
  const many = Array.from({ length: 7 }, () => put(chat.id).id)
  assert.throws(() => addComment(s.store, chat.id, { body: 'All', attachmentIds: many }, owner), /at most 6/)
  assert.throws(() => addComment(s.store, chat.id, { body: 'Odd', attachmentIds: 'x' }, owner), /list of file ids/)
  // A refused message ties nothing.
  assert.equal(s.store.objects('SELECT raw FROM attachments WHERE job_id = ?', chat.id).filter((a) => a.issueCommentId).length, 1)
})

test('a job moved to another project loses its workspace, and its next run works in the new repo', async () => {
  const s = studio()
  const repoB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-run-')), 'other')
  fs.mkdirSync(repoB)
  const gitB = (...args) => execFileSync('git', ['-C', repoB, ...args], { stdio: 'pipe' })
  gitB('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repoB, 'README.md'), 'another game\n')
  gitB('add', '.')
  gitB('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'first')
  s.store.put('projects', { id: 'p-other', companyId: COMPANY, name: 'Other', primaryWorkspace: { cwd: repoB } }, { position: 1 })

  const job = createJob(s.store, COMPANY, { title: 'Move me to the other project', projectId: 'p-game', assigneeAgentId: 'bot-builder' }, { now: NOW })
  const first = (await tick(s.store, s.opts())).started[0]
  await until(s, (r) => r.finished.find((f) => f.id === first.id))
  assert.ok(s.store.object('SELECT raw FROM jobs WHERE id = ?', job.id).executionWorkspaceId, 'it was worked in p-game\'s worktree')
  const oldCwd = first.contextSnapshot.cwd

  // No run is on it: moving projects clears the workspace.
  patchJob(s.store, job.id, { projectId: 'p-other' })
  assert.equal(s.store.object('SELECT raw FROM jobs WHERE id = ?', job.id).executionWorkspaceId, null)

  // Its next run cuts a fresh worktree in the new project's repo.
  addComment(s.store, job.id, { body: 'Now in the other project.' }, { actor: { user: 'local-board' }, now: NOW + 1000 })
  const second = (await tick(s.store, s.opts())).started[0]
  await until(s, (r) => r.finished.find((f) => f.id === second.id))
  const cwd = second.contextSnapshot.cwd
  assert.ok(cwd.startsWith(repoB), 'a fresh worktree in the new repo: ' + cwd)
  assert.notEqual(cwd, oldCwd)
  assert.equal(execFileSync('git', ['-C', cwd, 'branch', '--show-current']).toString().trim(), 'LH-701-move-me-to-the-other-project')
})

test('a run going on a job keeps its workspace when the job moves projects', async () => {
  const s = studio({ script: 'sleep 20' })
  const repoB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-run-')), 'other')
  fs.mkdirSync(repoB)
  const gitB = (...args) => execFileSync('git', ['-C', repoB, ...args], { stdio: 'pipe' })
  gitB('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repoB, 'README.md'), 'another game\n')
  gitB('add', '.')
  gitB('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'first')
  s.store.put('projects', { id: 'p-other', companyId: COMPANY, name: 'Other', primaryWorkspace: { cwd: repoB } }, { position: 1 })

  const job = createJob(s.store, COMPANY, { title: 'Keep working', projectId: 'p-game', assigneeAgentId: 'bot-builder' }, { now: NOW })
  const run = (await tick(s.store, s.opts())).started[0]
  assert.ok(s.store.object('SELECT raw FROM jobs WHERE id = ?', job.id).executionWorkspaceId)

  // A run is on it: the move changes the project but leaves the workspace alone.
  patchJob(s.store, job.id, { projectId: 'p-other' })
  const moved = s.store.object('SELECT raw FROM jobs WHERE id = ?', job.id)
  assert.equal(moved.projectId, 'p-other')
  assert.ok(moved.executionWorkspaceId, 'kept while a run is active')

  const done = await until(s, (r) => r.finished.find((f) => f.id === run.id), 30000)
  assert.equal(done.status, 'succeeded')
})

test('the owner\'s message to a bot goes ahead of the jobs queued for it', async () => {
  const s = studio({ script: 'sleep 1; echo \'{"type":"result","subtype":"success","usage":{}}\'' })
  // A run is going, and two crew jobs queue behind it.
  createJob(s.store, COMPANY, { title: 'Busy', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  assert.equal((await tick(s.store, s.opts())).started.length, 1)
  createJob(s.store, COMPANY, { title: 'Queued one', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  createJob(s.store, COMPANY, { title: 'Queued two', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  // Then the owner writes in the chat: that wake is the newest.
  const chat = openChat(s.store, COMPANY, 'bot-builder', { actor: { user: 'local-board' } })
  addComment(s.store, chat.id, { body: 'Why no reply?' }, { actor: { user: 'local-board' } })
  // The first run started once the busy one ends is the chat's, though its wake came last.
  await until(s, () => s.store.rows('SELECT id FROM runs').length >= 2, 15000)
  const runs = s.store.objects('SELECT raw FROM runs ORDER BY created_at')
  assert.equal(runs[1].issueId, chat.id, 'the chat runs before the queued jobs')
  await until(s, () => s.store.rows('SELECT id FROM runs').length >= 4 && !s.store.rows("SELECT id FROM runs WHERE status = 'running'").length, 20000)
})
