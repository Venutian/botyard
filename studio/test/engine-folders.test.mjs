/**
 * A run never starts in a folder that is not there, and never carries on a saved session whose folder is gone: a bot started in
 * the wrong folder worked on the wrong code, and one resumed in a folder that was cut again talked of files that were not there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { tick } from '../server/engine/runner.mjs'
import { addComment, createJob } from '../server/engine/write.mjs'

const COMPANY = 'co-1'
const SESSION = '0b0e7c7e-1111-4222-8333-444455556666'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DONE = `cat > "$BOTYARD_SCRATCH_DIR/../prompt-$BOTYARD_RUN_ID.txt"
printf '%s\\n' "$@" > "$BOTYARD_SCRATCH_DIR/../args-$BOTYARD_RUN_ID.txt"
echo '{"type":"system","subtype":"init","session_id":"${SESSION}","model":"m"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"${SESSION}","usage":{"input_tokens":1,"output_tokens":1}}'`

function studio({ projectCwd, agentCwd } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-folders-'))
  const repo = path.join(dir, 'game')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'a game\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first')
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(tool, `#!/bin/sh\n${DONE}\n`)
  fs.chmodSync(tool, 0o755)
  const rules = path.join(dir, 'rules.md')
  fs.writeFileSync(rules, 'You are a builder.\n')
  const store = openStore(':memory:')
  store.put('company', { id: COMPANY, name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 700 })
  store.put('projects', { id: 'p-game', companyId: COMPANY, name: 'Game', primaryWorkspace: { cwd: projectCwd || repo } }, { position: 0 })
  store.put('agents', {
    id: 'bot-builder', companyId: COMPANY, name: 'Builder', title: 'Builds', status: 'idle', adapterType: 'claude_local',
    adapterConfig: { command: tool, model: 'm', timeoutSec: 30, graceSec: 1, instructionsFilePath: rules, ...(agentCwd ? { cwd: agentCwd } : {}) },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
  })
  return { dir, repo, store, opts: () => ({ dataDir: path.join(dir, 'data'), apiUrl: 'http://127.0.0.1:3210', now: Date.now() }) }
}

async function finished(s, id) {
  const end = Date.now() + 8000
  for (;;) {
    const report = await tick(s.store, s.opts())
    const done = report.finished.find((f) => f.id === id)
    if (done) return done
    if (Date.now() > end) throw new Error('the run did not end in time')
    await sleep(80)
  }
}

test('a job whose project folder is gone does not start in the bot\'s own folder', async () => {
  const gone = path.join(os.tmpdir(), 'engine-folders-retired-project')
  const s = studio({ projectCwd: gone, agentCwd: os.tmpdir() })
  createJob(s.store, COMPANY, { title: 'Build it', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  const report = await tick(s.store, s.opts())
  assert.equal(report.started.length, 0)
  assert.match(report.skipped[0].why, /project's folder does not exist: .*engine-folders-retired-project/)
  assert.equal(s.store.rows('SELECT id FROM runs').length, 0, 'no run was made')
  assert.match(s.store.objects("SELECT raw FROM wakes WHERE status = 'failed'")[0].error, /does not exist/, 'the wake says why')
})

test('a job with no project does not start in a bot folder that is not there', async () => {
  const s = studio({ agentCwd: path.join(os.tmpdir(), 'engine-folders-retired-bot') })
  createJob(s.store, COMPANY, { title: 'Chat', assigneeAgentId: 'bot-builder' })
  const report = await tick(s.store, s.opts())
  assert.equal(report.started.length, 0)
  assert.match(report.skipped[0].why, /folder this run would start in does not exist/)
})

test('a saved session whose folder is gone is not resumed: a fresh one starts in the current folder, and the bot is told', async () => {
  const s = studio()
  const job = createJob(s.store, COMPANY, { title: 'Tune the score', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  const first = (await tick(s.store, s.opts())).started[0]
  await finished(s, first.id)
  const worktree = first.contextSnapshot.cwd
  assert.ok(fs.existsSync(worktree))
  // The folder is removed (a janitor, or by hand); the next run cuts it again.
  execFileSync('git', ['-C', s.repo, 'worktree', 'remove', '--force', worktree])
  addComment(s.store, job.id, { body: 'One more thing.' }, { actor: { user: 'local-board' } })
  const second = (await tick(s.store, s.opts())).started[0]
  assert.equal(second.sessionIdBefore, null)
  await finished(s, second.id)
  const args = fs.readFileSync(path.join(os.tmpdir(), `args-${second.id}.txt`), 'utf8').split('\n')
  assert.ok(!args.includes('--resume'), 'the session of a removed folder is not resumed')
  assert.ok(args.includes('--append-system-prompt-file'), 'a fresh session is given its rules again')
  const prompt = fs.readFileSync(path.join(os.tmpdir(), `prompt-${second.id}.txt`), 'utf8')
  assert.match(prompt, /your last session on this job was in .*, which is gone/)
  assert.doesNotMatch(prompt, /same session as your last run/)
  assert.ok(fs.existsSync(second.contextSnapshot.cwd), 'and it starts in a folder that is there')
})

test('a saved session whose folder is still there is resumed', async () => {
  const s = studio()
  const job = createJob(s.store, COMPANY, { title: 'Tune the score', projectId: 'p-game', assigneeAgentId: 'bot-builder' })
  const first = (await tick(s.store, s.opts())).started[0]
  await finished(s, first.id)
  addComment(s.store, job.id, { body: 'One more thing.' }, { actor: { user: 'local-board' } })
  const second = (await tick(s.store, s.opts())).started[0]
  await finished(s, second.id)
  const args = fs.readFileSync(path.join(os.tmpdir(), `args-${second.id}.txt`), 'utf8').split('\n')
  assert.equal(args[args.indexOf('--resume') + 1], SESSION)
})
